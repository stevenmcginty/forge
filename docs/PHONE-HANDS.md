# Phone hands

Forge agents on the PC can operate Steve's Android phone (his Pixel): any app on it, and Chrome or its web browser. Steve types "book me an Uber to X" or "reply to Y on WhatsApp saying Z" into a pane agent, Forge Brain, Telegram, the voice agent or Claude Live, and the agent does it on the phone with the `phone_*` tools.

## How it fits together

- **Phone half** (Forge Mobile APK, native Kotlin in `mobile/native/`): an accessibility service, a notification listener and a socket. The socket dials the desk's normal mobile link with `role: "hands"`.
- **Desk half**:
  - `electron/mobile/server.ts` accepts hands sockets with the paired device token, keeps them in their own registry (they never displace the phone's app socket, never get pushes, and may only send `ping`, `hands:res`, `hands:status`), and sends `hands:req` frames down them (`sendHands`).
  - `electron/phone-hands.ts` turns one tool call into one request by id over the most recently connected hands socket, waits 15 s, keeps the last `hands:status`, and answers in plain words.
  - `shared/phone-hands-spec.mjs` is the one copy of the 13 tools (names, descriptions, arguments) and the agent rules.
  - Pane agents: `bridge/phone-tools.mjs` (forge-bridge) → the pane pipe → `APP_LINK_OPS` / `PHONE_LINK_OPS` (`electron/browser-panes/service.ts`) → `phoneLinkOp` (`electron/browser-panes/ipc.ts`).
  - Forge Brain, Telegram, the CLI brains, the voice agent and the Conductor: `phoneBrainTools()` in `forgeToolDefs()` (`electron/voice-agent/host.ts`), allowed by name in `allowedTools`, not gated.
  - Persona: `PHONE_HANDS_RULES` (`shared/brain-persona.ts`) in the voice, Conductor and Forge Brain prompts; `PHONE_INSTRUCTION_LINE` in forge-bridge's instructions. The realtime brains (Gemini Live, GPT Realtime) have no phone tools and are not told about them.
  - Settings → Forge Mobile shows "Phone hands: connected / not connected" with accessibility, notifications and the switch, from the last `hands:status`.

The wire carries `t` as the frame name everywhere else; the contract below writes `type`. The desk sends both on `hands:req` and accepts either on frames from a hands socket.

## Wire contract

### Phone hands: wire contract (fixed; both halves build to this)

Feature: Forge agents on the PC operate Steve's Pixel 10 Pro XL. The phone half is native Kotlin
inside the Forge Mobile APK (com.forge.mobile). The desk half is Forge's Electron main process.
The phone dials out to the desk's existing mobile socket; the desk sends requests down it.

### Transport
- Same socket server Forge Mobile uses: `electron/mobile/server.ts`, path `/link` (MOBILE_WS_PATH),
  port 8420 on LAN, or `wss://cure-task-legroom.ngrok-free.dev/link` remotely (Steve's static ngrok
  domain; settings `mobileTunnel = ngrok`). Tailscale 100.64/10 is also accepted by the server.
- The phone reads the desk address and token the WebView app already saved, from Capacitor
  Preferences (Android SharedPreferences file `CapacitorStorage`): `forge.origin`, `forge.deviceToken`,
  `forge.desktopName` (keys in `mobile/src/lib/secure.ts:30-42`). Convert the origin to
  ws(s)://host[:port]/link. Send header `ngrok-skip-browser-warning: 1`. The server checks Origin
  matches host (`server.ts:468`): send an Origin header that passes that check.
- Hello: the SAME hello frame the WebView sends (`mobile/src/lib/link.ts:546-567`; read it for the
  exact fields, proto = MOBILE_PROTO), using the saved device token, PLUS `"role": "hands"`.
- A `role:"hands"` socket must NOT displace or log out the same device's normal app socket. It gets
  no pushes (no replay/data/state/foreman/handoff/desktop/mirror frames). It may send only:
  `ping`, `hands:res`, `hands:status`. Anything else from it is ignored.

### Frames
desk -> phone:
  {"type":"hands:req","id":"<uuid>","op":"<op>","args":{...}}
phone -> desk:
  {"type":"hands:res","id":"<uuid>","ok":true,"text":"<plain words>","image":"<base64 jpeg, optional>","mime":"image/jpeg"}
  {"type":"hands:res","id":"<uuid>","ok":false,"error":"<plain words Steve can read>"}
  {"type":"hands:status","accessibility":bool,"notifications":bool,"contacts":bool,"enabled":bool,
   "screenOn":bool,"locked":bool,"app":"<foreground package or empty>","version":"<versionName>"}
   (sent right after hello-ok, then on any change, at most once per 2 s)
- Whole frame must stay under the server's 1 MB maxPayload: screenshots are JPEG, long side
  <= 1400 px, quality stepped down until base64 < 700 KB.
- Desk waits 15 s per request, then answers the agent "The phone did not answer in 15 s."

### Ops (phone side implements all; desk exposes each as a tool)
| op | args | result |
|---|---|---|
| status | {} | text: permissions on/off, enabled switch, screen on, locked, foreground app label+package |
| look | {} | image (screenshot via AccessibilityService.takeScreenshot) + text "App: <label> (<pkg>)" |
| read | {} | text: first line "App: <label> (<pkg>)", then one line per useful on-screen node: `[n] <role> "<text or content-desc>" (clickable, editable, scrollable, checked, selected)`. Numbers stay valid until the next read. Max ~150 lines; skip empty, invisible, zero-size nodes. |
| tap | {n?:int} or {x:number,y:number} (fractions 0..1 of the screen), long?:bool | ACTION_CLICK on node n (or nearest clickable parent); else a gesture at x,y; long=true does a long press |
| type | {text:string, n?:int, enter?:bool} | ACTION_SET_TEXT on node n or the focused editable; enter=true then sends IME enter (ACTION_IME_ENTER, API 30+) |
| scroll | {direction:"up"\|"down"\|"left"\|"right", n?:int} | scroll node n, or the largest scrollable, or a swipe gesture |
| key | {key:"back"\|"home"\|"recents"\|"notifications"\|"quick_settings"} | performGlobalAction |
| open_app | {name?:string, package?:string} | launches the app (match by label, case-insensitive, best match) |
| open_link | {url:string} | ACTION_VIEW intent, FLAG_ACTIVITY_NEW_TASK (used for uber://... and https://wa.me/...) |
| apps | {query?:string} | text list of launchable apps "<label> (<package>)", filtered by query |
| notifications | {app?:string} | text: `[n] <app label> - <title>: <text> (can reply)`; numbers valid until the next notifications call |
| reply | {n:int, text:string} | fills the notification's reply RemoteInput and fires its PendingIntent; error if it has no reply action |
| find_contact | {name:string} | text list of matching contacts with numbers, best first; numbers also in international digits-only form for wa.me (UK: 07... -> 447...) |

Every op that needs the screen first wakes it if off. If the keyguard is locked, screen ops answer
ok:false "The phone is locked. Ask Steve to unlock it, then try again." `notifications`, `reply`,
`find_contact`, `apps`, `status`, `open_link` do not need the screen.

### Safety (phone side enforces; desk tool text repeats it)
- Master switch "Let Forge use this phone", stored natively, default OFF. Off = every op answers
  ok:false "Phone hands are switched off on the phone." (status still answers.)
- Blocked apps: while the foreground app is blocked, look/read/tap/type/scroll answer ok:false
  "That app is blocked for Forge." Notifications from blocked apps are never listed or replied to.
  Block list: any package containing "bank" or "authenticator", plus: co.uk.getmondo,
  com.starlingbank.android, com.revolut.revolut, uk.co.hsbc.hsbcukmobilebanking,
  com.barclays.android.barclaysmobilebanking, com.grppl.android.shell.CMBlloydsTSB73,
  com.rbs.mobile.android.natwest, uk.co.santander.santanderUK, com.nationwide.mobile.android.nationwide,
  uk.co.tsb.newmobilebank, com.paypal.android.p2pmobile, com.google.android.apps.walletnfcrel,
  com.x8bit.bitwarden, com.lastpass.lpandroid, com.onepassword.android, com.coinbase.android,
  com.google.android.gms (Google sign-in sheets), com.android.vending (Play purchases).
- The ongoing notification ("Forge can use this phone") has a Stop action that turns the switch off.
- Agent rules (desk tool descriptions + brain persona): before the final tap that books a ride,
  pays, buys, or sends a message whose words Steve did not give word for word, tell Steve what will
  happen (e.g. "UberX, GBP 14.20, 4 min away - book it?") and wait for yes. If Steve dictated the
  exact message, send it without asking. If Steve said "just book it", skip the price check.

### Recipes (for persona / tool text)
- Uber: phone_open_link `uber://?action=setPickup&pickup=my_location&dropoff[formatted_address]=<url-encoded address>`;
  phone_read; if the dropoff did not fill, phone_open_app "Uber", tap "Where to?", phone_type the
  place, tap the right suggestion. Read the ride options, tell Steve product + price + ETA, wait for
  yes, then tap choose/confirm and "Confirm pickup". Packages: com.ubercab (confirm with `apps`).
- WhatsApp reply: phone_notifications app "WhatsApp" -> if the person has a notification with
  (can reply), phone_reply n text. Otherwise phone_find_contact name -> phone_open_link
  `https://wa.me/<digits>?text=<url-encoded text>` -> phone_read -> tap the Send button.
  Package com.whatsapp.

## How to test

- `npm run phone-hands:check` (fast lane, in `npm test`): a real `MobileServer` on loopback, a fake app socket and a fake hands socket with the same device token. Checks the app socket stays open, the hands socket gets no pushes, text and image round trips, the phone's errors pass through, the timeout and not-connected sentences, that stray frames from a hands socket are ignored, and that the three tool lists agree.
- A desk for a real phone or an emulator:

  ```
  node scripts/phone-hands-check.mjs --serve 8490 [--token <device token>]
  ```

  Listens on `0.0.0.0:8490` (`ws://10.0.2.2:8490/link` from the Android emulator), prints a device token and a one-use pairing code. Call an op by typing a line on stdin (`read`, `tap {"n":3}`), or over HTTP on `127.0.0.1:8491`: `POST /op {"op":"read","args":{}}`, `GET /status`, `GET /pair` (a new pairing code). Pictures are saved and their path printed.

## Steve's setup

1. Open Forge Mobile and pair it with the desk as normal. The hands use the same saved address and token.
2. In the status strip, tap Hands and turn on "Let Forge use this phone".
3. Tap Accessibility and turn on Forge. If Android says "Restricted setting": on the card, tap Open App info → the three-dot menu → Allow restricted settings, then try again.
4. Tap Notification access and turn on Forge (the same restricted-setting step if Android asks).
5. Tap Contacts → Allow. Tap Notifications → Allow. Tap Battery → set Unrestricted.
6. Check that Desk link shows Connected. The ongoing "Forge phone hands" notification has a Stop button that turns the switch off at any time.

## End-to-end result (emulator, 6 Nov 2026)

The real desk half (`--serve` above: the real `MobileServer`, `auth.ts` and `PhoneHands`) against the real phone half (debug APK on an Android 35 emulator, `ws://10.0.2.2:8490/link`), with a normal app socket on the same device token held open the whole time (it stayed connected and got no hands frames):

- All ops answered through the real link: `status`, `apps` (with and without a query), `open_app "Settings"`, `read`, `tap n`, `type` (with enter), `scroll`, `key back` / `notifications`, `look` (JPEG, 33–151 K base64 chars, far under the 1 MB frame), `notifications` (all, and by app), `find_contact` (07700900123 → wa.me 447700900123), `open_link`, and `reply` on a notification with no reply box ("That notification has no reply box.").
- Web: `open_link https://example.com` → `read` lists the page (WebView "Example Domain", the body text in each language); the page's "Learn more" link is below the fold, so `scroll` then `read` shows `View "Learn more" (clickable)`; `tap` on it lands on iana.org/help/example-domains ("Example Domains"). Note: `button "Open the home page"` in a Chrome read is Chrome's own toolbar Home button, not a page link.
- Switched off: with the service running, every op but `status` answers "Phone hands are switched off on the phone." The notification's Stop also closes the hands socket, so the desk then answers its not-connected sentence (which names the switch).
- Locked (PIN set, screen off): screen ops wake the screen and answer "The phone is locked. Ask Steve to unlock it, then try again."; `find_contact`, `notifications`, `status`, `open_link` still work.
- `phoneLinkOp` (the pane-bridge function) against the real phone: `phone_status`, `phone_read`, `phone_look` (picture saved to a file), and its errors.
- Not tested end to end: `reply` that actually sends (no app on the emulator posts a RemoteInput reply action).
- Fixed on the way: the keyboard and the system UI no longer count as "the app in front" (a read showed "App: Gboard" over Settings, which would let a blocked app be read while its keyboard is up), the app in front is known from the moment the service connects, and an empty `apps` / `notifications` list now says so instead of reaching the agent as "The phone did that."
