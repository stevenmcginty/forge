# Forge Mobile — the once-only setup

This is the whole of it. Twenty minutes, most of it waiting for downloads, and
then Forge Mobile connects to this desktop from anywhere in the world with
nothing to type ever again.

`docs/MOBILE.md` explains *why* every part is shaped the way it is. This file
only tells you what to do.

---

## What "always connected" actually means here

Two halves, and it is worth knowing which one does what, because when something
breaks it will be one of them and not both.

**The address never changes.** A free ngrok account is permanently allocated one
domain. Forge runs the ngrok agent itself, as a supervised child process: it
starts when the phone link starts, restarts itself with backoff when the network
drops, and gives up only on failures that retrying cannot fix. So the phone is
paired once, to one `wss://…` address, and that address is still correct next
year.

**Neither end has to be reachable.** ngrok dials *out* from this machine. There
is no port forwarding, no firewall rule, no VPN on the phone, and nothing that
cares whether you are behind CGNAT in a hotel.

What it cannot do: **wake a sleeping PC.** Forge holds a power-save blocker
while a phone is connected, so the machine will not suspend mid-session — but a
desktop that was already asleep before you reached for your phone stays asleep.
That is the one real limit, and no transport fixes it.

---

## 1. ngrok — the account

1. Sign up free at **https://dashboard.ngrok.com/signup**.
2. Copy your **authtoken** from
   **https://dashboard.ngrok.com/get-started/your-authtoken**.
3. Find your **permanent domain** in the dashboard's **Domains** section. You do
   not invent this and you cannot choose it — every free account is assigned
   one, shaped like `something-something.ngrok-free.app` (some accounts get
   `.ngrok-free.dev`). If Domains is empty, the getting-started page offers to
   create your free static domain.

Copy both. That is everything ngrok needs from you, forever.

### The free tier, honestly

- **1 GB of data transfer a month.** Terminal output is the payload. Typing,
  reading and driving an agent are nowhere near it; leaving a redrawing TUI or a
  streaming build log running for hours is how you would find it.
- 20,000 HTTP requests a month, which is irrelevant here — a WebSocket is one
  request that then stays open.
- 3 concurrent agent sessions, so a stranded `ngrok.exe` from a previous run
  does not lock you out the way a single-session limit would.
- Opening the ngrok URL in **phone Chrome** shows ngrok's interstitial warning
  page first. The APK never sees it, because it carries its own assets and only
  opens the socket.

---

## 2. Forge — two fields

**Settings › Forge Mobile.**

1. **The link** → turn **Allow phones to connect** on.
2. **Reach it from anywhere** → paste the **ngrok authtoken** and **Your ngrok
   domain**, then turn **Keep the tunnel up** on.

The first start downloads the ngrok agent (~12 MB) into
`%APPDATA%\Forge\bin\`. After that it is local.

When the chip says **Live**, the **Desktop address** row shows your permanent
`wss://…` URL with a Copy button — the same name the phone's pairing form uses,
because it is the same value. That URL is the only address you will ever give
the phone, and the pairing QR carries it for you.

### Optional, and worth doing

Set `mobileBindHost` to `127.0.0.1` in `%APPDATA%\Forge\settings.json` (with
Forge closed — it rewrites that file on exit). Left at `0.0.0.0`, the tunnel
works fine but the LAN can still reach the port directly. Setting it to
loopback makes the tunnel the *only* door.

---

## 3. The phone

The APK lives at
**https://github.com/stevenmcginty/forge-mobile-releases/releases/latest**.

1. Open that page in the phone's browser and download `forge-mobile.apk`.
2. Tap the download. Android will refuse the first time and offer a settings
   screen — allow your browser to install unknown apps, then tap it again. This
   is the normal price of an app that does not come from a store.
3. On the desktop, **Settings › Forge Mobile**, flick **Accept new phones**.
4. Open **Forge** on the phone and tap **Connect**. It shows two words, large —
   say, `OTTER RIVER`.
5. Your desktop asks whether to allow a phone that *should be showing those two
   words*. Check they match, then **Allow**.

Nothing is typed and nothing is read off a screen, because the APK was built on
this machine and ships already knowing this desktop's address.

**Compare the words.** That is the whole check. The desktop is on the public
internet while the tunnel is up, so anyone who found the address could ring the
doorbell — but only the phone in your hand knows which words it is showing. A
prompt whose words do not match yours is somebody else, and the answer is Deny.

**"Accept new phones" disarms itself after ten minutes**, and is off the rest of
the time. Unarmed, a stranger's request is refused exactly like any other
unpaired phone — no prompt appears at all, so there is nothing to mis-tap.

### If that does not suit

Both older routes are still there, under **Other ways to connect** on the phone:

- **Scan a QR** — the desktop's *Pair a phone* button shows one carrying the
  address and a single-use code. This is the answer for a second desktop, or an
  APK built somewhere else.
- **Type it** — the **Desktop address** and the code, printed under the QR.

Either way, that is the last time the phone is told an address. It stores a
256-bit device token, and reconnects on its own from then on.

### Updating it afterwards

**From build 10 onwards the app updates itself.** On being brought to the front
(at most every 30 minutes) it checks the release manifest; if a newer build
exists it downloads it in the background, **verifies the download's SHA-256
against the manifest**, and raises Android's install confirmation. A hash
mismatch deletes the file and refuses — that check is not decorative, this app
holds a key to a shell.

The one tap that cannot be removed is Android's own. A sideloaded package always
goes through the system installer's confirm dialog; there is no way past it
short of being device owner, so "automatic" here means nothing to find and
nothing to fetch by hand. That dialog is only raised while the app is actually
in front, and at most once an hour, so declining it is not a decision you are
asked to make repeatedly.

Two cases still need the version chip in the status strip (or its twin on the
connect screen, for when the desktop is unreachable):

- **Android has not been told Forge may install packages.** The flow stops at
  "downloaded and verified" rather than dragging you into a settings screen
  unasked; the chip says *Update*, and Install asks for the grant. After that
  it is automatic forever.
- **Builds 9 and earlier**, which have no automatic path at all — one tap of the
  chip, once, and the copy it installs takes over.

---

## 4. Back up the signing key. Now, not later.

```
%APPDATA%\Forge\android\forge-release.jks
%APPDATA%\Forge\android\keystore.properties
```

Android will only install an update signed with the **same key** as the copy
already on the phone. Those two files are therefore the only things in existence
that can ever ship an update to any installed copy of Forge Mobile. Lose them
and the only route back is uninstalling the app from every phone that has it.

They are deliberately outside the repo and `.gitignore` refuses the whole class,
so no commit will ever carry them off this machine for you. Copy them somewhere
you would still have after this disk died.

---

## 5. Shipping a new version

```
npm run apk:ship                # bump, build, sign, hash, publish — one command
npm run apk:ship -- --bump minor --notes "What changed"
```

That is the whole of it: every installed copy finds the release by itself. The
two steps underneath are still there for the times one of them is all you want:

```
npm run apk:build -- --bump     # stamps mobile/version.json, gradle and the
                                # Vite defines from one source, signs, hashes
npm run apk:release             # creates the GitHub release, uploads the APK
                                # and latest.json
```

`apk:ship` bumps by default, which is the difference between it and `apk:build`.
Versions are immutable: `apk:release` refuses a tag that already exists, because
a reused tag means two different binaries claiming one version and phones with
no way to tell which they have. A build that is never published is the quieter
version of the same problem — the phone polls a release that does not exist and
truthfully reports itself up to date — and one command is how neither happens.

Releases are cut **from this machine, never from CI** — signing in GitHub
Actions would mean putting that keystore into repository secrets, and it is the
one thing that must not leave here.

---

## When it does not work

| What you see | What it is |
| --- | --- |
| Tunnel chip stuck on **error**, mentioning the authtoken | Paste a fresh authtoken. Forge stops rather than retrying — a rejected token is not a network blip. |
| **error** mentioning agent sessions | A stranded `ngrok.exe` is holding a session slot. End it in Task Manager and toggle the tunnel. |
| Tunnel **Live**, phone will not connect | Check the phone used the whole `wss://…` URL with **no port on the end**. A tunnel is reached on the implicit 443; appending `:8420` produces an address nothing is listening on. |
| Phone connects, then drops repeatedly | Expected on a bad connection — subscriptions are re-sent on reconnect and each is answered with the replay buffer, so the terminal repaints rather than going dead. Persistent refusal means the desktop said no; revoke and re-pair. |
| Install fails with a signature error | That phone has a copy signed with a different key. Uninstall it first. |
| Everything is fine and the phone still cannot reach it | The desktop is asleep or Forge is not running. Nothing here can fix either. |

Checks that prove the parts a script can:

```
npm run tunnel:check    # the ngrok supervisor, against a scripted fake agent
npm run apk:check       # the APK half: versions, manifest, hashing, key hygiene
npm run mobile:smoke    # the server, auth, protocol and a real PTY
```
