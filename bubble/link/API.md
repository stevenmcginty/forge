# com.forge.bubble.link — what the app uses

A pure Kotlin/JVM library (no `android.*`): sign-in, the socket to the Forge
desktop over the Forge Web wire (`bubble/docs/wire-spec.md`), and the Claude
Live voice lane. The app talks to one class, `BubbleEngine`.

## What the app provides

| Piece | What | Android side |
|---|---|---|
| `LinkConfig` | `apiKey`, `databaseUrl` (public Forge Web config), `clientName` ("forge-bubble/1.0"), `deviceName` ("Forge Bubble (Pixel 8)"). `directUrl` + `staticIdToken` only for tests / the dev server. | from BuildConfig |
| `KeyValueStore` | `get / put / remove` strings. Holds the Firebase refresh token, uid, email, the device id, and the PIN while "remember" is on. | private (encrypted) SharedPreferences |
| `ClipPlayer` | `suspend fun play(audio: ByteArray, mime: String)` returns when the clip ends; `fun stop()` cuts it. `mime` is `audio/wav` (PCM16 mono, 24 kHz for OpenAI voices) or `audio/mpeg`. Must suspend, not block: it runs on the engine's thread. | AudioTrack / MediaPlayer |
| mic frames | `micFrame(pcm, level)`: 100 ms = 1600 samples of 16 kHz mono PCM16, and the frame's RMS in 0..1 (`Vad.rms(pcm)` computes it). Feed them while listening. | AudioRecord, VOICE_COMMUNICATION |

## BubbleEngine

```kotlin
val engine = BubbleEngine(config, store, player)
engine.start()                          // connect; reconnects by itself
engine.state.collect { s -> draw(s) }   // StateFlow<EngineState>
```

Every method may be called from any thread; work runs on one private thread.

| Call | Does |
|---|---|
| `suspend signIn(email, password): String?` | Firebase email/password sign-in. `null` = signed in; else a sentence for the screen. Never creates an account. |
| `submitPin(pin, remember): Boolean` | The desktop's PIN (4-12 digits; `false` if not). With `remember` it is stored after the desktop accepts it. |
| `signOut()` | Forget the account and the PIN; drop the socket. |
| `start()` / `stop()` | Connect / drop the socket and stop reconnecting (credentials and a remembered PIN stay). |
| `dispose()` | Release the engine's thread; the engine is dead after. |
| `setListening(on)` | Mic on/off. Off drops speech in progress. |
| `micFrame(pcm, level)` | Feeds end-of-speech detection; speech is uploaded while it runs, and at its end the desktop's heard text is sent as a turn. Ignored while not listening and while a clip plays (half-duplex). |
| `sayText(text)` | A typed turn. |
| `interrupt()` | A tap: stop speaking now, drop queued clips, cancel the turn (jobs run on). |
| `cardAction(cardId, action)` | `CardAction.YES / NO` on a confirm card answers Forge Brain (`brain-confirm`); `STOP` stops a Conductor job; `DISMISS` hides the card until the job moves again. |
| `speakNews: Boolean` | Say Claude Live's news at a gap (default on). Off: news only makes cards. |

### EngineState

| Field | Meaning |
|---|---|
| `link` | `SIGNED_OUT`, `NEED_PIN`, `CONNECTING`, `ONLINE`, `OFFLINE`, `LOCKED`, `STOPPED` |
| `linkReason` | A plain sentence for OFFLINE / STOPPED / NEED_PIN ("Wrong PIN", "The desktop is off", ...) |
| `lockedUntil` | Epoch ms the desktop said to come back (LOCKED). The engine waits that long by itself. |
| `pinWrong` | The last PIN was refused. |
| `talk` | `IDLE` (mic off), `LISTENING` (mic on), `THINKING` (heard, waiting for the reply), `SPEAKING` (a clip playing or queued) |
| `hearing` | Speech is being detected right now. |
| `heard` / `reply` | The last heard text / the reply so far. |
| `cards` | Confirms (Yes/No), then needs-you (newest first, one per pane), then done/failed jobs of the last 30 min. Each `Card` has `title`, `line`, `state` (one word), `actions`. |
| `working` / `needsYou` | Jobs running or queued / needs-you cards plus confirms. |
| `desktopName`, `notice`, `email` | The desktop's name; the last thing that went wrong ("" if nothing); the signed-in email. |

## Rules the engine keeps (do not re-implement in the app)

- PIN safety: `pin-invalid` forgets the PIN (RAM and store) and the engine does not dial again until `submitPin`; `busy` waits exactly `retryAfterMs` (state LOCKED). A PIN is never invented or replayed. The lockout is per account and also locks the desktop owner's PWA.
- No `Origin` header, so no resume tickets: the remembered PIN is re-sent on reconnect.
- The `voice-claude` lane (`agent: "claude-live"`) is opened after every `hello-ok` and stays open while connected (cards and news come through it), not only while listening.
- Hearing is the PCM path only (`append` / `done`); no WebRTC.

## Dev server

`node scripts/bubble-dev-server.mjs [--port 8493] [--pin 1234] [--confirm]` runs the real Forge Web server with a scripted Claude Live and prints `READY ws://...`, `TOKEN ...`, `CONTROL http://...`. `BubbleEngine.forDev(url, token, store, player)` connects to it (an emulator should reach it as `ws://10.0.2.2:8493/web` with cleartext allowed for that host; not verified here). `node scripts/bubble-link-check.mjs` runs the module's tests against it.
