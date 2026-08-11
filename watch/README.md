# Forge Watch

Wear OS companion for Forge. Two modules, two APKs:

- **`:app`** (`com.forge.watch`) — Kotlin app.
  - `DictationActivity` — full-screen speech-to-text, starts listening on
    launch. TODO: forward the final transcript to Forge over the web relay.
  - `CellularWarmupService` — foreground service that holds a
    `TRANSPORT_CELLULAR` network request so the LTE modem attaches immediately
    instead of after the OS's ~1 minute Bluetooth-loss failover.
  - `BluetoothReceiver` — starts the warm-up when the phone's Bluetooth link
    drops and releases it on reconnect (toggleable in the app; currently reacts
    to any ACL event, filtering to the companion phone is a TODO).
- **`:watchface`** (`com.forge.watch.face`) — Watch Face Format v2 face, no
  code. Dark digital clock with a microphone shortcut that launches
  `DictationActivity` via a `Launch` tap target.

## Build

```sh
cd watch
./gradlew assembleDebug
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
- The warm-up service trades battery for latency. It is meant to run while a
  Forge session is live or briefly around phone loss — not permanently.
- The watch face XML is hand-written and unvalidated; run Google's
  [WFF validator](https://github.com/google/watchface) over
  `watchface/src/main/res/raw/watchface.xml` after edits, and verify the
  `Launch` target and the date `Template` expressions render on a real watch.
