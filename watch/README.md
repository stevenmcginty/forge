# Forge Watch

Wear OS companion for Forge. Two modules, two APKs:

- **`:app`** (`com.forge.watch`) — Kotlin app. Talk to Forge from the wrist.
  - `DictationActivity` — the voice screen. One **Talk** button, a status
    line (desktop · project · tab), the words so far, and a **Send** button
    that appears once there is a draft. Starts listening the moment it opens.
    Keeps its old class name because the watch face's tap target names it.
  - `ForgeDictationService` — the microphone as a foreground service, so
    listening survives the screen going dark. The recogniser restart loop is
    DictationMic's engine (its `:core` `DictationService`), carried over
    without notes or cloud sync. Each finished phrase goes to
    `VoiceController`.
  - `VoiceCommands` — the grammar (see below). Pure functions, unit-tested.
  - `VoiceController` — turns phrases into desktop actions and keeps the
    draft prompt. Lives in the process, so a wrist-drop mid-sentence does not
    lose the words.
  - `ForgeLink` — the Forge Web wire (`shared/web.ts`) in Kotlin: Firebase
    sign-in → Realtime Database rendezvous → `wss://<host>/web` → `hello`.
  - `ForgeAuth` — email/password against Firebase over REST, the same two
    endpoints `web/src/lib/auth.ts` uses.
  - `CellularWarmupService` / `BluetoothReceiver` — LTE warm-up, unchanged.
- **`:watchface`** (`com.forge.watch.face`) — Watch Face Format v2 face, no
  code. Dark digital clock with a microphone shortcut that launches
  `DictationActivity` via a `Launch` tap target.

## What you say

Every command is a phrase said on its own, with a pause after it. A phrase
that is not a command is prompt text.

| Say | It does |
| --- | --- |
| `open forge` / `switch to car harness` | Picks the project. Fuzzy match on the name. |
| `new tab` / `new tab with codex` | Opens a tab in that project, waits for the agent's banner, then says "Ready. Talk." |
| `tab two` / `next tab` / `tab login fix` | Brings a tab to the front. |
| `close tab` / `close tab two` / `close other tabs` | Closes the active tab, a specific tab, or all other tabs in the project. |
| *(anything else)* | Adds to the draft prompt. |
| `send it` / `go ahead` | Types the draft into the pane and presses Enter. Also works at the end of a sentence: "fix the login bug, send it". |
| `cancel` / `scrap that` | Throws the draft away. |
| `enter` / `yes` | Presses Enter on its own (answer a prompt). Only when the draft is empty. |
| `escape` / `interrupt` | Sends Escape to the agent. Only when the draft is empty. |
| `stop listening` | Stops the microphone. The draft stays on screen. |

Project and tab commands are only honoured before the prompt starts, so
"open the settings page and…" mid-sentence is a sentence. Send, cancel and
stop work any time.

The words go to **the active pane of the active tab of the project you
opened**. The watch never sends a size, so typing from it never reshapes a
pane on the desk.

## Sign-in

First open asks for the Forge Web email and password through Wear's
full-screen input (scribble, keyboard or voice). The refresh token is kept;
the password is not. The desktop then asks for its **PIN** on every fresh
connection, exactly as it asks a browser; the watch holds the PIN in memory
for the life of the app process and never writes it down.

The Firebase project comes from `local.properties` (git-ignored):

```
forge.web.apiKey=<apiKey from web/public/config.json>
forge.web.databaseUrl=<databaseUrl from web/public/config.json>
```

Without them the app says "Not configured".

## Build

```sh
cd watch
./gradlew assembleDebug
./gradlew :app:testDebugUnitTest   # the grammar tests
```

Needs an Android SDK (`local.properties` with `sdk.dir`, same as
`mobile/android`).

## Install (sideload over adb)

Pair the watch for adb (Settings → Developer options → Wireless debugging),
then:

```sh
adb install app/build/outputs/apk/debug/app-debug.apk
adb install watchface/build/outputs/apk/debug/watchface-debug.apk
```

Long-press the current watch face and pick **Forge** from the picker.

## Notes

- Open the app once first: it requests `RECORD_AUDIO`, `BLUETOOTH_CONNECT`
  and notification permissions, which the receiver and dictation flow need.
- `adb logcat -s ForgeWatch` tells the story of a session: every phrase heard,
  what it parsed to, and every refusal from the desktop.
- "New tab" waits for the pane to say something and then go quiet before it
  calls the tab ready. A pane that is still PowerShell would *run* whatever is
  pasted into it, so if the agent never speaks the watch says so and does not
  type.
- The warm-up service trades battery for latency. It is meant to run while a
  Forge session is live or briefly around phone loss — not permanently.
- The watch face XML is hand-written and unvalidated; run Google's
  [WFF validator](https://github.com/google/watchface) over
  `watchface/src/main/res/raw/watchface.xml` after edits, and verify the
  `Launch` target and the date `Template` expressions render on a real watch.
- Not yet: reading the agent's reply back on the wrist. Forge Web's
  `transcript-watch` frames would carry it; the screen is the problem.
