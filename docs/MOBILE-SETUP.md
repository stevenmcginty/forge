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
3. Open **Forge** on the phone.
4. On the desktop, **Settings › Forge Mobile › Pair a phone**. It shows a QR
   that carries the address and the code together — scan it from the phone.
   No camera? The same two values are printed under the QR: type the
   **Desktop address** and the pairing code into the phone's two fields.

Either way, that is the last time the phone is told an address. It stores a
256-bit device token and the URL, and reconnects on its own from then on.

### Updating it afterwards

There is a version chip in the app's status strip, and a link on the connect
screen for when the desktop is unreachable. Tapping it checks the release
manifest, and if there is something newer it shows the version and notes,
downloads it with a progress bar, **verifies the download's SHA-256 against the
manifest**, and hands it to Android to install. A hash mismatch deletes the file
and refuses — that check is not decorative, this app holds a key to a shell.

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
npm run apk:build -- --bump     # stamps mobile/version.json, gradle and the
                                # Vite defines from one source, signs, hashes
npm run apk:release             # creates the GitHub release, uploads the APK
                                # and latest.json
```

Versions are immutable: `apk:release` refuses a tag that already exists, because
a reused tag means two different binaries claiming one version and phones with
no way to tell which they have.

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
