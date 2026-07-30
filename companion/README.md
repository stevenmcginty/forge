# Forge Companion

Steve's Forge projects, from his phone. See what's open, push a photo straight
into a project's screenshot tray, and talk to the voice agent — replies come
back.

It is **off by default**. Nothing in this folder or in `electron/companion-*.ts`
makes a network call, reads a credential, or starts a thread until
`companionEnabled` is switched on *and* an account has been signed in.

```
phone (PWA)                    Firebase RTDB                     Forge (desktop)
─────────────                  ─────────────                     ───────────────
project list      ◀──── users/<uid>/projects   ◀────  publishes name/colour/status
photo, message    ────▶ users/<uid>/inbox      ────▶  saves to the tray / emits
                                                       companion:utterance
agent replies     ◀──── users/<uid>/outbox     ◀────  companionReply(id, text)
```

---

## Contents

| Path                     | What it is                                                    |
| ------------------------ | ------------------------------------------------------------- |
| `web/`                   | The phone PWA. Plain HTML/CSS/ES modules, no build step.       |
| `firebase.json`          | Hosting + database rules + emulator ports.                     |
| `database.rules.json`    | Per-user isolation. The only thing keeping anyone else out.    |
| `.firebaserc.example`    | Copy to `.firebaserc` once the real project exists.            |
| `GO-LIVE.md`             | The exact commands Steve runs to make this real.               |

On the desktop side:

| Path                            | What it is                                            |
| ------------------------------- | ----------------------------------------------------- |
| `electron/companion/protocol.ts`| Every path, record shape and limit. Dependency-free.  |
| `electron/companion/rest.ts`    | Firebase over REST + SSE. Electron-free, dep-free.    |
| `electron/companion-sync.ts`    | The service. Electron-free — everything is injected.  |
| `electron/companion-host.ts`    | The Electron wiring: settings, shots shelf, IPC.      |
| `scripts/companion-smoke.mjs`   | End-to-end against the real Firebase emulator suite.  |
| `scripts/companion-serve.mjs`   | Serve `web/` on localhost.                            |
| `scripts/companion-icons.mjs`   | Regenerate the PWA icons.                             |

**Nothing in `companion/` is packaged into the app.** `electron-builder.yml`
ships `out/**/*` and `package.json` and nothing else, so the PWA travels to
Steve's phone via Firebase Hosting and never inside `Forge-setup.exe`. The
desktop half rides in the normal main-process bundle and, because it is REST
rather than the Firebase SDK, adds no dependency for the packaging milestone to
carry.

---

## Database schema

Everything hangs off `users/<uid>/`, which is the one subtree the rules let a
signed-in account touch. There are exactly four paths, and they are built in
exactly two places — `paths` in `electron/companion/protocol.ts` and `paths` in
`companion/web/js/rtdb.js`. Nothing else may concatenate one.

`<projectId>` is Forge's own project id with RTDB's forbidden key characters
(`. $ # [ ] /`) replaced by `_` — see `safeKey()`.

`<itemId>` is a client-generated, time-ordered id: base36 epoch, padded, plus 8
random characters. Client-generated rather than an RTDB push id because a PATCH
with a known key is **idempotent**, which is what lets the phone's offline queue
retry the same write forever without ever producing a second copy of a message.
The timestamp prefix keeps `orderByKey` (and a plain string sort) useful anyway.

### `users/<uid>/presence`

Written by Forge on every publish tick, so the phone can tell "the desktop is
running" from "the desktop published this an hour ago".

| Field    | Type              | Notes                       |
| -------- | ----------------- | --------------------------- |
| `device` | string            | Always `"forge"` for now.   |
| `at`     | server timestamp  | `{".sv":"timestamp"}`       |

### `users/<uid>/projects/<projectId>`

**Forge writes, the phone reads.** Republished whole (a `PUT` on the map) every
30 s and on demand, because deleting a project on the desktop has to delete it
on the phone and a PATCH cannot express "and nothing else".

| Field          | Type             | Notes                                                |
| -------------- | ---------------- | ---------------------------------------------------- |
| `name`         | string           | As shown in the rail.                                |
| `color`        | string           | The rail's dot colour, so the two lists match.       |
| `status`       | string           | One short line: `"3 panes · 2 tabs"`, `"Idle"`.      |
| `panes`        | number           | Live PTY sessions whose cwd is this project.         |
| `tabs`         | number           | Tabs in the saved workspace layout.                  |
| `lastActivity` | number           | Epoch ms. Newest session start, or the layout mtime. |
| `updatedAt`    | server timestamp |                                                      |

**Not published:** the project's folder path. The phone has no use for
`C:\Users\steve\Desktop\…` and there is no reason to put Steve's disk layout in
a cloud database.

### `users/<uid>/inbox/<projectId>/<itemId>`

**The phone writes, Forge consumes and acks.** `pending` is the only status the
phone ever writes.

| Field         | Type             | Kind      | Notes                                                       |
| ------------- | ---------------- | --------- | ----------------------------------------------------------- |
| `kind`        | `image`\|`message` | both    |                                                             |
| `createdAt`   | server timestamp | both      | Server-side, so the stale check can't be fooled by a phone clock. |
| `origin`      | `"phone"`        | both      |                                                             |
| `status`      | `pending`\|`done`\|`failed`\|`stale` | both |                                       |
| `text`        | string           | message   | ≤ 8000 chars.                                               |
| `name`        | string           | image     | Original file name; becomes the file on disk.               |
| `mime`        | string           | image     | `image/png` \| `image/jpeg` \| `image/webp` \| `image/gif`  |
| `data`        | string           | image     | Full `data:<mime>;base64,…` URL. Payload ≤ **200 KB**.      |
| `storagePath` | string           | image     | **Reserved, not implemented** — see Known gaps.             |
| `result`      | string           | both      | Written by Forge. A sentence the phone shows under the item.|
| `doneAt`      | server timestamp | both      | Written by Forge.                                           |

There is **no separate ack collection**: Forge PATCHes `status`/`result`/`doneAt`
onto the same node, and the phone's live stream re-renders the row. Fewer
moving parts, and no way for an item and its ack to disagree about existing.

### `users/<uid>/outbox/<projectId>/<itemId>`

**Forge writes, the phone reads and acks.** Pruned to the newest 40 per project.

| Field       | Type             | Notes                                                        |
| ----------- | ---------------- | ------------------------------------------------------------ |
| `kind`      | `reply`\|`note`  | `note` is an unprompted message; `reply` answers an inbox item. |
| `text`      | string           | ≤ 4000 chars written, ≤ 8000 allowed.                        |
| `createdAt` | server timestamp |                                                              |
| `origin`    | `"forge"`        |                                                              |
| `replyTo`   | string           | The inbox `<itemId>` this answers.                           |
| `seenAt`    | number           | **Delivery ack.** Client ms, written by the phone once the reply has actually been painted. Forge never writes it — that is what makes it an ack rather than a second copy of `createdAt`. |

### Limits, and where they come from

| Constant             | Value  | Why                                                                    |
| -------------------- | ------ | ---------------------------------------------------------------------- |
| `MAX_INLINE_BASE64`  | 200 KB | Not a technical limit (RTDB allows 10 MB/write) — a *bill* limit. Every image is stored, streamed back, and paid for. |
| `STALE_MS`           | 10 min | Stops a desktop that has been asleep replaying forty messages at the voice agent at once. |
| `PURGE_AGE_MS`       | 24 h   | Finished inbox items are deleted once per link.                        |
| `OUTBOX_KEEP`        | 40     | It is a feed, not an archive.                                          |

---

## The voice hookup — the contract

**This milestone deliberately does not touch the voice pipeline.** `VoicePanel`
belongs to another milestone. All the Companion promises is one event and one
function, and both are already wired end to end and covered by the smoke test.

### 1. Listen

```ts
import type { CompanionUtteranceEvent } from '@shared/types'

// In the renderer (the preload bridge is already wired):
const off = window.forge.companion.onUtterance((e: CompanionUtteranceEvent) => {
  // e.projectId    Forge's own Project.id — NOT the RTDB key
  // e.projectName  for display
  // e.itemId       opaque; hand it straight back to reply()
  // e.text         what Steve typed or dictated on his phone
})
```

IPC channel: `companion:utterance` (`IPC.companionUtterance`). It is a
main→renderer `send`, broadcast to every window.

The main process can listen too — import the service and pass a host whose
`emit` you own — but in practice the renderer route is the one to use, because
that is where the voice agent lives.

### 2. Reply

```ts
await window.forge.companion.reply(e.itemId, 'Ran them — two failed.')
```

or from the main process:

```ts
import { companionReply } from './companion-host'
await companionReply(itemId, text)
```

Passing an `itemId` the service has never seen returns `false` rather than
throwing. For an **unprompted** message (a notification, not an answer), pass
the project id as the third argument and any id you like as the first:

```ts
await window.forge.companion.reply('', 'Build finished.', project.id)
```

### 3. What Forge guarantees

- The event fires **once** per message. An item is claimed before any work is
  done, so a stream reconnect that re-delivers the pending snapshot cannot run
  it twice.
- A message older than `STALE_MS` never fires the event at all — it is marked
  `stale` on the phone instead.
- By the time the event fires, the inbox item has been (or is about to be)
  acked `done`. The voice pipeline is not responsible for acking.
- `reply()` is fire-and-forget from the caller's point of view; it returns
  `false` if the link is down, and there is no retry queue on the desktop side.
  (See Known gaps.)

---

## Why REST and SSE, not the `firebase` npm SDK

Three reasons, in order of weight.

1. **Restoring a session from a refresh token is not a public API.** Forge is a
   desktop app that gets closed and reopened; it stores a refresh token and has
   to come back signed in without asking again. The modular SDK does that
   through a `Persistence` implementation whose interface is internal
   (`_get`/`_set`/`_addListener`) — exactly the kind of thing that breaks on a
   minor bump. `securetoken.googleapis.com/v1/token` is a documented, stable,
   two-field POST.
2. **This shape is already proven on Steve's phone.** DictationMic has run REST
   + SSE against `dictationmic-sync` for months, including all the ugly parts:
   token rotation, `auth_revoked`, and EventSource's refusal to re-authenticate
   on reconnect. Reimplementing those bugs in a different library would be a
   downgrade.
3. **It costs nothing.** No dependency to bundle, nothing for the packaging
   milestone to unpack out of the asar, and the PWA runs the identical logic
   with no build step and no CDN script tag.

The price is that the protocol lives in two files that must be kept in step:
`electron/companion/protocol.ts` and `companion/web/js/rtdb.js`. They are short,
and the smoke test asserts the paths they both use.

## Why an IndexedDB outbox, not "RTDB's built-in persistence"

The Realtime Database's **web** SDK has no on-disk persistence. It queues writes
in memory while offline and replays them when the connection returns, which
covers a tunnel but not the thing that actually happens: you photograph
something in a car park with no signal, the phone locks, Chrome evicts the tab,
and the write is gone. Disk-backed offline persistence is an Android/iOS-SDK
feature. So `web/js/outbox.js` writes every send to IndexedDB *first* and only
removes it once the server has acknowledged it — which survives a force-quit,
the only test that counts.

---

## Testing

### The end-to-end suite

```
npm run companion:smoke
```

Spawns `firebase emulators:exec` (real Auth + real RTDB + the real
`database.rules.json`), then re-runs itself inside them and drives the actual
`CompanionSync` class and the actual `ShotShelf` over real HTTP. No mock
Firebase anywhere. Eleven checks, listed at the top of the script.

Needs Java (the RTDB emulator is a JVM process) and `firebase-tools`. Both are
already on this machine; `firebase-tools` is also a devDependency, so the local
copy is preferred over the global one.

### Looking at the phone app

```
firebase emulators:start --only auth,database --project demo-forge-sync --config companion/firebase.json
npm run companion:serve
```

then open, on one line:

```
http://127.0.0.1:5055/?apiKey=demo-forge-sync-key&db=http%3A%2F%2F127.0.0.1%3A9000%3Fns%3Ddemo-forge-sync-default-rtdb&authBase=http%3A%2F%2F127.0.0.1%3A9099%2Fidentitytoolkit.googleapis.com%2Fv1&tokenBase=http%3A%2F%2F127.0.0.1%3A9099%2Fsecuretoken.googleapis.com%2Fv1
```

The query-parameter override is **fenced to localhost** (`config.js`). On a real
phone, a link must not be able to re-point the app at another database — not
because the rules would let anyone in, but because a page that silently
re-targets on a link click is a phishing primitive, and this one has a password
box on it.

---

## Known gaps

Honest list. None of these block the scaffold; all of them are real.

1. **No Firebase Storage path for large images.** Anything over 200 KB of base64
   is refused on the phone (with a sentence) and refused again on the desktop if
   it somehow arrives. The record already carries a reserved `storagePath`
   field; wiring it needs a Storage bucket, a rules file, and an upload/download
   pair on both sides.
2. **The voice pipeline is not connected.** By design — see the contract above.
   Today a message from the phone lands as an event nobody is listening to, and
   nothing replies. Wiring it is a `useEffect` in whoever owns `VoicePanel`.
3. **`reply()` has no retry queue.** The phone's sends are durable; the
   desktop's replies are not. If the link is down when the agent answers, the
   reply is lost. Fix: the same IndexedDB-outbox pattern, backed by a JSON file
   in the data dir.
4. **No Settings UI.** The fields exist in `Settings` (`companionEnabled`,
   `companionApiKey`, `companionDatabaseURL`, …) and the IPC surface exists
   (`window.forge.companion.*`), but the panel that edits them belongs to the
   Settings milestone. Until then, edit `%APPDATA%\Forge\settings.json` by hand
   and restart, or call the IPC from DevTools.
5. **Status is derived, not pushed.** Pane counts come from matching each live
   PTY session's `cwd` against each project's folder, which is correct today
   because a pane's cwd *is* its project. If panes ever get their own working
   directories, the count needs a real snapshot from the renderer — the IPC
   channel (`companion:publish`) is already there to hang it on.
6. **One device.** `presence` has room for more, but nothing distinguishes two
   phones, and two desktops on the same account would both consume the inbox.
7. **The protocol lives in two files.** `protocol.ts` and `web/js/rtdb.js` are
   hand-kept mirrors. The smoke test covers the paths; it cannot police a field
   only one side reads.
8. **No push notifications.** The phone only sees a reply while the PWA is open.
   FCM would need a service-account key on the desktop, which is a bigger
   security decision than this milestone should make on its own.
