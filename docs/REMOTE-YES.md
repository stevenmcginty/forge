# Remote Yes — press the Windows admin box from your phone

Windows draws its administrator (UAC) prompt on the **secure desktop**, a
separate desktop object that only a process running as SYSTEM with the right
privilege may draw on or read. Nothing running as Steve — not Forge, not a
screen capture, not a synthesised click, not any remote-control tool running
in his session — can see that prompt or press anything on it. The screen goes
dark for about two minutes and the prompt times out as a No.

Remote Yes is the fix: Settings installs [RustDesk](https://rustdesk.com) as a
Windows *service*, which runs as SYSTEM in session 0 and is allowed onto the
secure desktop. From then on, the moment Windows asks for admin, a card
appears on the phone and pressing it opens RustDesk showing the real prompt.

## Why RustDesk, and not Forge's own screen share

Forge already drives this PC's session from a phone (`docs/MOBILE.md`). That
socket runs as Steve, in his desktop — which is exactly the thing that cannot
reach the secure desktop, no matter how it is built. Only a SYSTEM service can
draw on that desktop, so the feature needs a service, and RustDesk is AGPL —
Forge cannot bundle GPL/AGPL code into its own installer without relicensing
itself. So Forge downloads the official signed installer from GitHub at the
moment Set up is pressed, verifies it, and runs its own silent install. Forge
never ships a copy of RustDesk itself.

## Files this feature touches

| Path | What it is |
| --- | --- |
| `electron/remote-yes.ts` | Electron-free logic: the Tailscale/tasklist/GitHub-release parsers, password generation and redaction, the elevated PowerShell script builder, and `UacWatcher`, the poll that detects a prompt rising and falling. |
| `electron/remote-yes-host.ts` | The Electron wiring: status/report/broadcast, the GitHub download with its MZ and Authenticode checks, the one `-Verb RunAs` elevated call, read-back verification of every RustDesk option, the settings writes, the desktop notification, and the five IPC handlers. |
| `scripts/remote-yes-check.mjs` | The fast-lane check (`npm run remote-yes:check`) — bundles and drives the real parsers and watcher with a scripted `exec` and clock. |
| `scripts/fixtures/remote-yes-entry.ts` | The entry point that check bundles with esbuild. |
| `src/components/settings/RemoteYesSection.tsx` | The Settings › Remote Yes section: status chip, Set up / Switch off, the QR code, and the "show the admin box" test. |
| `src/components/settings/SettingsPage.tsx` | Renders `RemoteYesSection` for the `remoteYes` settings tab. |
| `src/components/settings/SettingsPage.css` | The `.ryes-scan` / `.ryes-qr` styling for the QR block. |
| `src/state/AppState.tsx` | The `remoteYes` settings section id and the four `remoteYes*` field defaults. |
| `shared/types.ts` | The four `remoteYes*` `Settings` fields and the `RemoteYesStatus` shape. |
| `shared/ipc.ts` | The five `remoteYes*` IPC channel constants. |
| `shared/api.ts` | `ForgeApi.remoteYes` — the renderer-facing surface (`status`, `onStatus`, `setup`, `disable`, `test`). |
| `electron/preload.ts` | Exposes `window.forge.remoteYes` over the five IPC channels. |
| `electron/store.ts` | Settings defaults and normalisation for the four fields; `remoteYesPassword` is in `SECRET_FIELDS` so it is encrypted at rest. |
| `electron/main.ts` | Registers the IPC handlers and `applyRemoteYesSettings()` at boot, disposes the watcher on quit, and lists all four `remoteYes*` fields in `MAIN_OWNED_SETTINGS` so a stale renderer copy can never overwrite what setup just wrote. |
| `shared/mobile.ts` | `RemoteYesInfo` and `RemoteYesFrame` (`t: 'remote-yes'`), part of the `ServerFrame` union sent to phones. |
| `electron/mobile/server.ts` | `pushRemoteYes` — sends the frame to connected phones and replays it after `hello-ok`. |
| `electron/mobile-host.ts` | `publishRemoteYes` — the entry point `remote-yes-host.ts` calls to fan a status change out to every phone. |
| `mobile/src/lib/link.ts` | `remoteYes` on `LinkPicture`, and `case 'remote-yes'` — the only place the incoming frame is validated (`shared/mobile.ts`'s `parseFrame` only decodes phone→desktop frames). |
| `mobile/src/lib/update.ts` | `openRustDesk(address)` — opens the `rustdesk://` deep link, or reports why it could not. |
| `mobile/src/App.tsx` | The "Windows is asking for admin" warning card shown while a prompt is up. |
| `mobile/src/components/Browser.tsx` | The quiet "Remote Yes · ready" row shown once configured but no prompt is active. |
| `mobile/src/styles.css` | `.bar-actions`, `.remote-yes*` styling for both of the above. |
| `scripts/apk-init.mjs` | Idempotently patches `<queries>` in the Android manifest so the app can see whether RustDesk is installed. |
| `mobile/android/app/src/main/AndroidManifest.xml` | Carries `<package android:name="com.carriez.flutter_hbb" />` — the RustDesk Android app's package, in `<queries>`. |
| `shared/web.ts` | `WebRemoteYesFrame` (`type: 'remote-yes'`), part of the `WebServerFrame` union sent to browsers. |
| `electron/web/server.ts` | `pushRemoteYes` — sends the frame to every connected browser and replays it after `hello-ok`. |
| `electron/web-host.ts` | `publishRemoteYes` — the browser-side entry point `remote-yes-host.ts` calls alongside the phone one. |
| `web/src/lib/client.ts` | `case 'remote-yes'` — validates the incoming frame; `onRemoteYes` on the handlers. |
| `web/src/state.tsx` | `remoteYes` on the page state, reset to off on every `hello-ok`. |
| `web/src/components/Workspace.tsx` | `RemoteYesBanner` — the "asking for admin" strip with the Open RustDesk link, above every other strip; `rustDeskLink`. |
| `web/src/components/TopBar.tsx` | The quiet key button shown while Remote Yes is on and nothing is asking. |
| `web/src/styles.css` | `.offline[data-link='remote-yes']` and `.remote-yes__open`. |
| `scripts/web-smoke.mjs` | Section "6e. remote yes, to a browser" — the push and the replay after `hello-ok`. |
| `scripts/mobile-smoke.mjs` | Section "10e. remote yes" — proves a UAC prompt published on the desktop reaches a connected phone as a `remote-yes` frame, including replay after reconnect. |

## Setup walkthrough

1. **Settings → Remote Yes → Set up.** The button is disabled until Tailscale
   is installed and signed in on this PC — Remote Yes only ever listens on the
   tailnet.
2. Forge downloads the latest signed RustDesk installer from GitHub, verifies
   its size, its `MZ` header and its Authenticode signature, then runs
   **one** `-Verb RunAs` elevated PowerShell script. That script installs
   RustDesk silently, sets every required option, sets the password, restarts
   the service, and reads every value back. **This is the only UAC prompt
   Remote Yes ever raises**, and it is the only time Forge has ever asked for
   administrator rights at all.
3. Install RustDesk on the phone — Play Store, or the GitHub APK if the phone
   cannot reach the Play Store.
4. Enter this PC's Tailscale address into RustDesk (Settings shows it, and
   offers a QR code with the same address baked into a `rustdesk://` deep
   link — no password in the QR, since the phone already has one).
5. Tick **Remember password** in RustDesk once, using the password Settings
   shows. After that the phone never has to type it again.

## Security posture

- **Tailscale-only whitelist.** RustDesk is configured with
  `whitelist 100.64.0.0/10` — Tailscale's own CGNAT range — and
  `direct-server Y` with a fixed direct-access port (21118). Nothing outside
  the tailnet can reach it, and it is never relayed through RustDesk's public
  rendezvous servers.
- **Permanent password, generated and encrypted.** Forge generates a 20‑character
  password from a look-alike-free alphabet with `crypto.randomBytes`, sets it
  as RustDesk's permanent password, and stores it in `settings.json` encrypted
  (`remoteYesPassword` is in `SECRET_FIELDS`). The phone is told it once, when
  Remember password is ticked.
- **No relay.** Direct connection only, over the tailnet — never through a
  third party server.
- **Switching off leaves RustDesk installed.** Turning Remote Yes off in
  Settings stops the UAC watcher and tells the phone it is off, but does not
  uninstall RustDesk or its service — removing a service would need another
  admin prompt, and switching off a notification is not a reason to ask for
  one. Uninstall it from Windows Settings → Apps if it should be gone.

## Known behaviour

- **RustDesk drops the session when UAC opens.** The secure desktop takes over
  the screen, which disconnects whatever was watching it a moment before;
  reconnect once the prompt is up.
- **The prompt waits about two minutes.** That is Windows' own UAC timeout,
  not something Remote Yes controls — press Yes before it lapses or the
  action it was guarding is cancelled.

## Not yet

- **Push to a closed phone** needs Google push messaging (FCM) to wake the app
  when it is not open; Remote Yes today only reaches a phone or browser tab that already
  has a live connection to the desktop. Planned.
- **Passkeys and sleeping PCs cannot be done.** A passkey prompt, like UAC,
  needs a live human gesture on the secure desktop, and there is no way around
  that from a phone. A PC that is asleep is not running RustDesk's service (or
  Forge) at all, and nothing here can wake it.
