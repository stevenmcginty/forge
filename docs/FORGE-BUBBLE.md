# Forge Bubble (the "Forge" phone app)

An Android app, package `com.forge.bubble` (source in `bubble/`). It opens Forge
Web in a Trusted Web Activity. It also keeps a small bubble floating over other
apps. Tap the bubble and a panel opens. In the panel you talk (or type) to the
desktop's voice agent, Claude Live, and you answer its cards (Forge Brain
confirms, panes that need you, finished jobs). Every state has a word and a
shape, never colour alone.

## Setup on the phone, in order

1. Install `dist-apk/forge-bubble.apk` (sideload; allow installs from the file app).
2. Open Forge. Step 1: sign in with the Forge Web email and password.
3. Step 2: enter the desktop's Forge Web PIN. Leave "Remember PIN" on. A wrong
   PIN shows "Wrong PIN" once and asks again; the app never retries by itself.
   Too many wrong PINs lock the account for a while (the PWA too); the screen
   counts down.
4. Step 3: "Display over other apps" on. If the switch is greyed out
   ("Restricted setting"): App info for Forge, the ⋮ menu top right, "Allow
   restricted settings", then come back and turn it on.
5. Step 4: allow the microphone. Step 5: allow notifications.
6. Step 6: battery "Unrestricted", so the bubble survives idle.
7. Step 7: Bubble on. Then "Open Forge".

## Using it

- Bubble faces: Idle, Listening, Thinking, Speaking, Working n, Needs you n,
  Offline (with the reason; "Sign in needed" / "PIN needed" open setup on tap).
- The panel listens while it is open, never while Forge speaks, and closes
  after 20 s of quiet with no cards open. Tap the mic while Forge speaks to
  cut it off. "Open" on a card opens Forge Web.
- Long-press the bubble: Hide, Mute voice (captions still show), Open Forge,
  Settings. Drag it to the X to hide it for an hour or until the next unlock.
- The link connects on screen-on / unlock and drops 2 minutes after screen-off.

## Build and test

```
npm run bubble:build        # signed release APK -> dist-apk/forge-bubble.apk (+ -v<version>), sha256 printed
npm run bubble:link-check   # the link module's tests against the real Forge Web server
npm run bubble:dev-server   # a dev desktop: READY ws://..., TOKEN ..., CONTROL http://...
```

`bubble:build` needs the Forge release keystore (see `scripts/apk-lib.mjs`) and
`web/public/config.json` (git-ignored). Without the config the APK still builds
but says "This build has no Forge Web config" instead of signing in. The build
checks that the signer matches `web/public/well-known/assetlinks.json`.

Debug builds take a dev override from adb (see `bubble/app/src/debug/.../DebugActivity.kt`):
`--es devWs ws://10.0.2.2:8493/web --es devToken <jwt> [--es devPin 1234]`, and
`--es devSay "<text>"` for a typed turn. Logcat tag: `ForgeBubble`.

## Where things are

- Wire spec: `bubble/docs/wire-spec.md`. Engine API: `bubble/link/API.md`.
- App shell: `bubble/app/` (`engine/Engine.kt`, `bubble/BubbleService.kt`,
  `talk/LiveDriver.kt`, `setup/RealAccount.kt`).

## Known limits

- Hearing is tested only with silence (emulator); real speech on a phone is
  not yet verified. Typed turns are verified end to end on the emulator.
- The mic runs only while the panel is on screen (Android rule); there is no
  hands-free listening with the panel closed.
- No WebRTC; speech goes up as PCM. The PIN is re-sent on each reconnect (no
  resume tickets).
- The panel has no "Open Forge" button yet (the driver supports it; the
  designer adds it). Card state words reach the panel as `CardUi.state` but are
  not drawn yet.
