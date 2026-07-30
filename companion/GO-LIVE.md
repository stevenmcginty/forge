# Forge Companion — go live

Everything below is for **you** to run, Steve. Nothing in this repo has created
a Firebase project, deployed anything, or touched your Google account — the code
was built and tested entirely against the local emulator suite.

Verified against the `firebase` CLI on this machine: **15.4.0 global, 15.25.0 in
the worktree** (`firebase --version`). Every flag below was checked against
`--help` on that version.

Two of the steps **cannot** be done from the CLI and are marked
**[console]** — Firebase has no command for turning on a sign-in provider or for
reading back a web app's API key config in a way worth scripting.

Run everything from the repo root unless a step says otherwise.

---

## 0. Preflight

```powershell
firebase --version
firebase login
```

`firebase login` opens a browser. If it says you are already logged in as
`stevenmcginty@gmail.com`, you are done with this step.

---

## 1. Create the project

Firebase project IDs are **globally unique**, so plain `forge-sync` may well be
taken. Try it; if it is rejected, add a suffix and use that everywhere below.

```powershell
firebase projects:create forge-sync --display-name "Forge Sync"
```

If that fails with "requested entity already exists", pick another:

```powershell
firebase projects:create forge-sync-rc --display-name "Forge Sync"
```

Then pin it for this folder:

```powershell
cd companion
firebase use --alias default forge-sync
```

That writes `companion/.firebaserc`. There is a `.firebaserc.example` next to it
showing the shape.

> **Everything from here assumes `forge-sync`.** If you used a different id,
> substitute it in every command *and* in the two config values in step 5.

---

## 2. Create the Realtime Database

`europe-west1` to match `dictationmic-sync` — same region, same latency from the
house, and one less thing that differs between the two apps.

```powershell
firebase database:instances:create forge-sync-default-rtdb --location europe-west1 --project forge-sync
```

If that errors (the CLI is fussy about creating the *default* instance on a
brand-new project), do it in the console instead — it is two clicks:

**[console]** https://console.firebase.google.com/project/forge-sync/database →
**Create Database** → location **europe-west1** → **Start in locked mode**.

Locked mode is right: step 4 deploys the real rules over the top, and until then
you want the database shut.

Confirm the instance name:

```powershell
firebase database:instances:list --project forge-sync
```

The URL you need is `https://forge-sync-default-rtdb.europe-west1.firebasedatabase.app`.

---

## 3. **[console]** Turn on email/password sign-in

https://console.firebase.google.com/project/forge-sync/authentication/providers

→ **Get started** → **Email/Password** → **Enable** (leave "Email link" off) →
**Save**.

There is no CLI for this. If you skip it, sign-in fails with
"Email sign-in is switched off for this Firebase project" — the app says exactly
that, so you will know.

---

## 4. Deploy the security rules

**Before** anything can write. From `companion/`:

```powershell
cd companion
firebase deploy --only database --project forge-sync
```

`database.rules.json` is what makes the whole thing private: a signed-in user can
read and write `users/<their own uid>` and nothing else. The smoke test proves
these rules actually bite (`npm run companion:smoke`, checks 7–8).

---

## 5. Register the web app and fill in the config

```powershell
firebase apps:create WEB "Forge Companion" --project forge-sync
firebase apps:sdkconfig WEB --project forge-sync
```

The second command prints a config block. You need exactly two values from it:
`apiKey` and `databaseURL`.

> Both are **public identifiers, not secrets.** The API key names the project;
> it authorises nothing. The rules from step 4 are what authorise. DictationMic
> ships the same two values in the clear for the same reason.

Put them in **`companion/web/config.js`**:

```js
export const FIREBASE = {
  apiKey: 'AIza…',                                                          // from apps:sdkconfig
  databaseURL: 'https://forge-sync-default-rtdb.europe-west1.firebasedatabase.app',
  authBase: '',   // leave blank — these are the emulator escape hatches
  tokenBase: ''
}
```

---

## 6. Deploy the phone app

```powershell
cd companion
firebase deploy --only hosting --project forge-sync
```

It lands at **https://forge-sync.web.app**.

**Bump the service worker cache name first**, every time. `companion/web/sw.js`
line 15:

```js
const CACHE = 'forge-companion-v2'   // v1 -> v2 -> v3 …
```

Forget this and the phone keeps serving the previous deploy's JavaScript out of
its cache. (DictationMic's GitHub workflow stamps this from the commit SHA; if
this app starts getting deployed often, steal that.)

---

## 7. Point Forge at it

The Settings panel for this belongs to another milestone, so for now edit the
file directly. **Close Forge first** — it writes this file on exit and will
overwrite you.

`%APPDATA%\Forge\settings.json`:

```json
{
  "companionEnabled": true,
  "companionApiKey": "AIza…",
  "companionDatabaseURL": "https://forge-sync-default-rtdb.europe-west1.firebasedatabase.app",
  "companionAuthBase": "",
  "companionTokenBase": "",
  "companionEmail": "",
  "companionRefreshToken": "",
  "companionUid": ""
}
```

Leave the last three blank — signing in fills them.

Reopen Forge. Nothing will connect yet: it is enabled but has no session.

---

## 8. Sign in — phone first

On your phone, open **https://forge-sync.web.app**, enter
`stevenmcginty@gmail.com` and a password you have not used anywhere else.
**Typing a new email creates the account**, so this first sign-in is also the
sign-up. Then: Chrome menu → **Add to Home screen**.

Now sign the desktop into the *same* account. Until the Settings panel exists,
from Forge's DevTools console (F12):

```js
await window.forge.companion.signIn('stevenmcginty@gmail.com', 'the-password-you-just-used')
// -> { ok: true, uid: '…', created: false }
await window.forge.companion.status()
// -> { state: 'live', … }
```

`created: false` is the confirmation that it joined the account the phone made,
rather than quietly creating a second one.

The password is used for that one HTTPS POST and then dropped. What lands in
`settings.json` is `companionRefreshToken` — revocable from the Firebase console
without changing any password you use elsewhere.

---

## 9. Verify

1. Your projects appear on the phone within ~30s, with a status line each.
2. Open one, send a photo → it appears in Forge's screenshot tray, and on disk
   in `<project>\assets\inbox\`.
3. Send a message → it fires `companion:utterance`. **Nothing answers it yet** —
   the voice-pipeline hookup is another milestone (see README.md, "The voice
   hookup"). To prove the return leg works, from Forge's DevTools:

   ```js
   await window.forge.companion.reply('', 'Hello from the desktop.', '<projectId>')
   ```

   It should appear on the phone within a second.

---

## 10. If you want it off again

Softest first.

```js
// In Forge's DevTools — drops the session, keeps the config:
await window.forge.companion.signOut()
```

Or set `"companionEnabled": false` in `settings.json` and restart.

To revoke everything from the outside:

**[console]** https://console.firebase.google.com/project/forge-sync/authentication/users
→ delete the user. Every refresh token dies with it, on both devices, within an
hour.

To make the data unreachable regardless of who holds a token, redeploy the rules
with `".read": false, ".write": false` at the root and nothing else.

---

## Costs

Spark (free) covers this comfortably: RTDB free tier is 1 GB stored and 10 GB/mo
downloaded. The whole design is built around not testing that — images are
capped at 200 KB, finished inbox items are purged after a day, and the outbox
keeps the newest 40 per project. A photo a day for a year is about 70 MB.

Hosting free tier is 10 GB stored, 360 MB/day transferred. The app is roughly
60 KB and cached by a service worker.

---

## Quick reference

| What                | Command                                                              |
| ------------------- | -------------------------------------------------------------------- |
| Deploy rules        | `cd companion; firebase deploy --only database --project forge-sync`  |
| Deploy the PWA      | `cd companion; firebase deploy --only hosting --project forge-sync`   |
| Both                | `cd companion; firebase deploy --project forge-sync`                  |
| Emulators (no deploy) | `firebase emulators:start --only auth,database --project demo-forge-sync --config companion/firebase.json` |
| End-to-end test     | `npm run companion:smoke`                                             |
| Look at the PWA     | `npm run companion:serve`                                             |
| Regenerate icons    | `npm run companion:icons`                                             |
