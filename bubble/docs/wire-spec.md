# Forge Web wire spec for a native Android voice bubble (agent `claude-live`)

Paths are relative to C:\Users\steve\Desktop\forge. `path:line` beside every fact. Anything not proven by a line is marked UNVERIFIED.
Nothing was run or edited. Abbreviations: W = shared/web.ts, S = electron/web/server.ts, A = electron/web/auth.ts, H = electron/web-host.ts,
C = web/src/lib/client.ts, LV = web/src/deck/liveVoice.ts, LE = web/src/deck/live-ears.ts, LW = web/src/deck/live-words.ts,
FL = watch/app/src/main/java/com/forge/watch/ForgeLink.kt, FA = same dir ForgeAuth.kt.

## 1. Connect + auth for a non-browser client

### 1.1 Order
Firebase sign-in -> RTDB host GET -> WebSocket wss://HOST/web with subprotocol -> hello -> hello-ok (or refused + close). (FL:29-43,187-209)

### 1.2 Firebase REST (no SDK)
- Sign in: POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=APIKEY, JSON {"email","password","returnSecureToken":true};
  use reply idToken, refreshToken, localId (= uid), expiresIn, email. (web/src/lib/auth.ts:96,115-122; FA:33,75-92)
- Refresh: POST https://securetoken.googleapis.com/v1/token?key=APIKEY, form grant_type=refresh_token&refresh_token=RT; reply id_token,
  refresh_token (ROTATES, store it), expires_in. (auth.ts:158-182; FA:34,106-136). Both clients treat a token as stale 5 min early (FA:31).
- Permanent refusal (HTTP 400 TOKEN_EXPIRED / USER_DISABLED / USER_NOT_FOUND / INVALID_REFRESH_TOKEN) = sign out; anything else = network, keep credentials (FA:120-126).
- The PWA auto-creates an account on EMAIL_NOT_FOUND (auth.ts:99-113); a bubble should not.
- apiKey and databaseUrl are public web config: the PWA loads /config.json from its own origin (web/src/config.ts:50; fields config.ts:20-47, "Public" :21);
  the watch bakes them from local.properties keys forge.web.apiKey and forge.web.databaseUrl (watch/app/build.gradle:26-27). Values not reproduced here.

### 1.3 RTDB host lookup
- GET DATABASEURL/users/UID/host.json?auth=URLENCODED_IDTOKEN, 8 s timeout (web/src/lib/rendezvous.ts:41-48; path builder W:210-213; FL:214).
- Reply {host, proto, app, name, at} (W:258-268) or null.
- Rules: host -> bare lowercase hostname, regex ^[a-z0-9]([a-z0-9-]{0,62})?(\.[a-z0-9]([a-z0-9-]{0,62})?)+$ after stripping scheme/path/port (W:281-291; FL:238-245);
  proto must equal 2 (W:386; FL:227); now - at < 180000 ms (HOST_STALE_MS = 3 x HOST_HEARTBEAT_MS 60000, W:216,246; FL:49,232). Otherwise the desktop is "absent": do not dial.
  401/403 from RTDB = rules/auth problem, not "desktop off" (rendezvous.ts:57-60; FL:219).
- The PWA re-looks-up the host before every retry after the first failure (C:1847-1864) because quick-tunnel hostnames change.

### 1.4 Upgrade
- URL wss://HOST/web (W:167,328-343; FL:251). Path must be exactly /web (S:1143-1147).
- MUST send header Sec-WebSocket-Protocol: forge-web.v2, else HTTP 400 "Unsupported subprotocol" (S:1127,1148-1155; W:180).
- No Origin header = admitted (S:4310-4318). An Origin that IS sent must be in the desktop allow-list (https://NAME.web.app and .firebaseapp.com for NAME in webSiteId/webProjectId, H:503-515)
  else HTTP 403 "Origin not allowed" (S:1156-1163). The watch sends none (FL:250-253).
- HTTP 403 also for wrong path or a source address outside loopback / 10/8 / 172.16/12 / 192.168/16 / 169.254 / 100.64/10 / fc,fd (S:1143-1147,4587-4599). A tunnel arrives from loopback.
- permessage-deflate is offered by the server; OkHttp negotiates it itself (S:1128-1137). Inbound (client->server) max message 192 KiB (W:439; S:1126).

### 1.5 hello frame (W:837-894; sent at C:1950-1964, FL:257-265)
{"type":"hello","proto":2,"idToken":"JWT","client":"forge-bubble/1.0","deviceId":"STABLE-ID","deviceName":"Forge Bubble (Pixel 8)","pin":"1234","resume":"TICKET"}

| field | required | rule |
|---|---|---|
| type | yes | "hello" |
| proto | yes | Number(proto)===2, else refused(proto) + close 4002 before the token is read (S:2439-2455) |
| idToken | yes | Firebase JWT <= 8192 chars (S:2461). Verified: RS256, kid in Google cert set, aud = project id, iss = https://securetoken.google.com/PROJECT, sub = the desktop's uid, iat/auth_time not > 60 s in future, exp + 60 s not passed (A:1423-1505) |
| client | no | only logged, wireString(client,32) (S:2511) |
| deviceId | yes, non-blank | blank -> refused(not-approved) (A:727-733); <= 128 chars; not a credential; PWA = 16 random bytes hex in localStorage (web/src/lib/device.ts:19-36); watch = persisted UUID (FL:114-119) |
| deviceName | no | default "Browser", <= 64 chars, display only (A:726) |
| pin | only if desktop has a PIN | 4..12 digits (W:591-597). Missing on a PIN desktop -> pin-required (NOT a strike) |
| passkey | no | skip |
| resume | no | ticket <= 64 chars; only read when pin and passkey are both empty (A:744-747; S:2473) |

- Only one hello per socket is processed (S:2433). No hello within 10 s, or any other / unparsable frame first: closed with 4001 (S:1664-1666,1671-1677,1764-1772; W:548).

### 1.6 hello-ok (W:1733-1815; built S:2512-2547)
Fields: type, proto, appVersion, desktopName, projects[], profiles[], workspaces{}, sessions[]; optional projectsRoot, pushKey, foreman[], brain, handoff[], features[], resume.
A bubble needs desktopName and resume (next ticket). features (passkey, dictate-stream, files, project-remove, usage, speech-key, chat/browser/board mirror; W:668-711, S:2500-2510)
gate nothing in Live. Claude Live support is discovered by sending voice-claude open (3.1). The frame is large; parse leniently.

### 1.7 refused (then the server closes) (W:1826-1911; S:2617-2638)
{"type":"refused","reason":"pin-required","message":"..","retryAfterMs":58000,"passkey":{},"appVersion":"..","proto":2}  (retryAfterMs / passkey / appVersion / proto optional)
reason is one of bad-token | wrong-account | not-approved | proto | busy | pin-required | pin-invalid. Close code 4001 (4002 for proto) (S:285-286,2453,2477).

| reason | do (PWA table C:468-493,2392-2475; watch FL:378-414) |
|---|---|
| pin-required | ask the human for the PIN, redial with pin. Not a strike |
| pin-invalid | STRIKE. Forget the stored PIN, ask the human again, never auto-replay (C:2419-2423; FL:383-386) |
| bad-token | force-refresh the token, redial once silently; a second in a row = sign in again (C:2443-2458). Never a strike |
| wrong-account | stop (C:474) |
| not-approved | stop; blank deviceId (C:479) |
| proto | stop; message says which side is old (W:1904-1910) |
| busy | wait exactly retryAfterMs; dialling early is how a strike is earned (C:2460-2470; FL:176-179). Also used when the desktop has no project/uid configured: retryAfterMs 60000 (A:1431-1436) |

### 1.8 auth refresh frame (W:906-910; S:2591-2606; C:2633-2648)
{"type":"auth","rid":"a7","idToken":"FRESH-JWT"} every 50 min (TOKEN_REFRESH_MS, W:559; FL:50,288-296).
Success: {"type":"result","rid":"a7","body":{"kind":"ok"}}. Failure: refused frame then close. No PIN or deviceId in it. A locked-out account is refused here too (A:1113-1116).
If the client-side refresh itself fails the PWA does nothing and lets the next bad-token refusal re-authenticate (C:2644-2646).

### 1.9 Resume ticket life cycle (W:609-630,886-893; A:744-801,888-1020)
- Issued in hello-ok.resume only if ALL: a PIN is set on the desktop; the hello was unlocked by pin/passkey/ticket; AND the upgrade carried a non-empty Origin header (unlock && origin, A:792-794).
  => a client with no Origin (the watch) never gets one. To get tickets a bubble must send Origin = the PWA origin AND that origin must be allow-listed (H:503-515).
  UNVERIFIED: that https://forge-web-aadafc.web.app is in this desktop's allow-list (depends on settings webSiteId/webProjectId).
- 32 random bytes base64url (43 chars); the desktop stores only SHA-256 in web-remembered.json (W:614-619; A:356,904).
- Bound to uid + deviceId + Origin string + PIN digest; any mismatch -> treated as no credential (pin-required, never struck) and the entry is deleted (A:953-962; W:622-626).
- Single-use, rotating, with a stand-in: each use returns a successor in the new hello-ok; the spent ticket stays as a stand-in until the successor is heard from, so a lost hello-ok can be retried once
  with the OLD ticket (A:923-978; "heard from" = first non-hello frame, S:1776-1779).
  Client rule: keep what you sent until hello-ok; store hello-ok.resume; if none comes, delete the spent one (C:2051-2053).
- Idle life 7 days counted from the socket's close (RESUME_IDLE_MS W:630; A:811-817,957-958); max 8 per device, 256 total, LRU evicted (A:574,582,898-902). A PIN change voids all (W:627).
- Tickets are per (uid, deviceId, origin). The PWA and a bubble with its own deviceId have independent chains and may be connected at once (clients is a Set, S:1654). Do NOT share a deviceId with the PWA.
- Check order in authenticate: token -> blank deviceId -> account lockout -> ticket / passkey / PIN (A:714-785). During a lockout even a good ticket gets busy (A:738-739).
- A ticket carries "passkey rights" (cannot enrol a passkey); irrelevant to a bubble (A:748-755).

### 1.10 Keepalive
- Server native WebSocket ping every 20 s, drops the socket (4008 "Heartbeat lost") if no pong in 10 s (W:547-548; S:4242-4255); first ping is scheduled at connect (S:1750). Any normal WS stack answers automatically.
- App-level {"type":"ping"} -> {"type":"pong"}, only after hello-ok (S:1795-1797; W:1006-1008,2540). PWA sends one every 5 s (C:250,1494-1500) and hangs up (4010) if nothing at all arrives within 3 s (C:119,197-198).
  Optional for a bubble; the watch relies on OkHttp pingInterval 30 s (FL:86). NEVER send ping before hello-ok (S:1764-1772 closes the socket). Any received frame counts as liveness (C:2009-2017).

### 1.11 Close codes
Server: 4001 not let in / refused / no hello / garbage before hello; 4002 proto; 4008 heartbeat lost; 1001 socket error; 1011 accept error (S:285-288,1171,1748).
A shutdown frame may precede the close: {"type":"shutdown","reason":"quit|sleep|restart|disabled","message":"..","retryAfterMs":0}; "disabled" = do not reconnect (W:2481-2501). Close reason max 123 bytes (S:4487-4491).

### 1.12 Reconnect
PWA: 500,1000,2000,4000,8000,15000 ms by attempt, capped to 8 s when the UI is visible; a desktop-issued retryAfterMs is never shortened (C:77,2482-2500); dial deadline 8 s (C:188); attempt resets on hello-ok (C:2044).
Watch: 1 s doubling to 30 s; absent desktop every 30 s (FL:155-185,53). After ANY reconnect re-send voice-claude open (the session dies with the socket: S:1725,4161-4169) and restart the events loop.

### 1.13 Lockout: 5 strikes / 60 s
- AUTH_MAX_FAILURES=5, AUTH_LOCKOUT_MS=60000 (shared/mobile.ts:203-204). ONLY a wrong PIN or failed passkey is a strike; bad/expired tokens, blank deviceId, pin-required, bad tickets and wrong-account are not (A:692-707,769,782,1615-1631).
- The bucket is per ACCOUNT "uid:UID" (A:1654-1656): a bubble looping on a wrong PIN locks the PWA out too. Each strike pushes the window to now+60 s (A:1627); success clears nothing (A:1610-1613).
  Locked => refused{busy, retryAfterMs, "Too many failed attempts - try again in Ns."} (A:1584-1599); it also blocks the auth refresh (A:1113-1115).
- NEVER: auto-replay a PIN after pin-invalid; retry PINs in a reconnect loop; redial before retryAfterMs on busy; invent a PIN on pin-required.
  Re-sending a still-correct PIN on a plain reconnect is fine and is what both clients do (C:1262-1280; FL:264).

### 1.14 Rate limit
120 frames per second per socket after hello, except attach/detach; excess dropped with one {"type":"error","code":"limit"} per second (W:419; S:2394-2427).

## 2. Request / result framing

### 2.1 Request (W:995-999; S:1940-1941)
{"type":"request","rid":"r17","body":{"kind":"voice-claude","op":"open","agent":"claude-live"}}
- rid: any string; server does wireString(rid,128) (trim, cut at 128) and echoes it verbatim (S:1941,2652-2653; W:986-988). PWA: "r"+counter (C:1768-1769); watch: UUIDs (FL:498). Must be unique per outstanding request.
- Non-object body -> failed/bad-frame (S:2656-2659). Unknown kind -> failed/unsupported (S:3859-3865).
- Every request is answered exactly once on its rid, failures included (whole handler in try/catch, S:2646-2650). The one that is deliberately slow: events, parked up to 20 s (3.5).

### 2.2 Result (W:2233-2238)
{"type":"result","rid":"r17","body":{"kind":"ok"}}
{"type":"result","rid":"r18","body":{"kind":"failed","code":"failed","message":"Claude is not listening for this browser - turn Listen on again."}}
- body.kind used by this agent: ok | failed | voice-heard | voice-claude-events | voice-speech | voice-connect (W:2240-2344). Tolerate unknown kinds (W:989-993).
- failed.code is one of bad-frame | unknown-session | unknown-project | limit | no-window | unsupported | failed (W:2512-2530). Only message is meant for people.
- Separate unsolicited error frame with no rid: {"type":"error","code":"..","message":"..","sessionId":".."} for unreadable frames, rate limit, writes to dead panes (W:2532-2538; S:1672,2420).
- Result timeout: PWA 30 s (C:88,1771-1774). The watch's request() uses 15 s (FL:52,505), SHORTER than the 20 s events hold: do not reuse it for events.

### 2.3 Feature flags
Only hello-ok.features (1.6); nothing in the voice-claude path is gated by one. Capability is per op: failed/unsupported "This Forge cannot run Claude as a voice agent for a browser."
when the host lacks voiceClaudeOpen / voiceSpeak / transcribeAudio (S:3943-3949).

### 2.4 Unknown server frames
WebServerFrame is a large union (W:2544-2574). Ignore types you do not know (the watch does, FL:312-375).

## 3. The Claude Live phone flow (voice-claude, agent claude-live)

Every call is {"type":"request","rid":R,"body":{"kind":"voice-claude","op":OP,...}} (W:1660-1671). Server handler S:3936-4132. Host side for claude-live H:815-895.

### 3.0 What the PWA sends, in order (LV, web/src/deck/voiceAgent.ts)
1. (optional for a bubble) {"kind":"voice-setup","provider":"claude"} (voiceAgent.ts:663-666). It asks the desktop renderer for a bundle (H:1722) and fails with "No speech-to-text key" when neither Groq nor Gemini key exists (H:1713-1715).
   The server's open does NOT require it (S:3951-3960). Skip it.
2. open (3.1).  3. Start the events loop at once; keep exactly one outstanding (LV:232,505-526).
4. Open ears: try ears (OpenAI/WebRTC); on failed fall back to PCM append/done (LV:334-360).
5. Pre-fetch ack clips with speak: "Okay." "Sure." "One sec." "Let me check." (LV:487-501; LW:14).
6. Per utterance: heard text -> say (own turnId) -> events -> speak per clause -> play.  7. Barge-in: interrupt. Per finished turn: latency. Card taps: job. Listen off: close.

### 3.1 open
Request {"kind":"voice-claude","op":"open","agent":"claude-live"} (W:1660). Result {"kind":"ok"} (S:3958).
- A prior session on the SAME socket is closed first (S:3952).
- claude-live is a LANE onto the desktop's single Live brain, not an exclusive session: several sockets may hold one; each gets only its own say/turn-end, all get news, ledger, status
  (H:815-854; scripts/web-check.mjs:2057-2081). The other agents (claude, claude-voice) are exclusive: the older holder hears {"type":"closed"} (W:1612-1614).
- Side effects: ensureLiveStarted() starts the Live brains if not running; warms Kokoro if claudeVoiceSound is kokoro (H:816-817).
- Events queued at once: one status and (if a ledger exists) one ledger (H:856-858), so the first events call returns immediately.
- An OLD desktop that does not know claude-live opens plain Claude; the PWA detects it by ears failing with code bad-frame + message matching /not a voice-claude op/ (LV:338-344,353).
- Any op except open/close/events on a socket with no live session -> failed, code failed, "Claude is not listening for this browser - turn Listen on again." (S:3982-3986).

### 3.2 Hearing: who transcribes, how the PWA chooses
The PWA ALWAYS tries OpenAI first, then falls back (LV:334-360).

A. ears = OpenAI realtime transcription over WebRTC (needs a WebRTC stack on the client)
   Request {"kind":"voice-claude","op":"ears","sdp":"v=0 ... full SDP offer text"} (SDP must start with "v=", <= 64 KiB, NOT trimmed, keep the final CRLF; S:4081-4091,243).
   Result {"kind":"voice-connect","sdp":"OPENAI-SDP-ANSWER","expiresAt":1760000000000} (expiresAt may be null) (S:4097; W:2328).
   Refusals (all failed): Settings liveEars is parakeet -> "Settings picked the local ears for Claude Live."; no OpenAI key -> "No OpenAI key is set - add one in Settings -> Models and APIs" (H:884-891);
   unsupported "Only Claude Live opens its own ears." (S:4082-4085); bad-frame "That is not an SDP offer." (S:4088-4090).
   Desktop mints the client secret with ITS key (key never leaves): session type transcription, model gpt-4o-mini-transcribe, language en, noise_reduction near_field, turn_detection semantic_vad eagerness auto
   (electron/realtime/tokens.ts:178,197-210,219-231). The client streams mic audio to OpenAI over WebRTC and reads JSON from the data channel named oai-events (LE:153). Events used (LE:239-275):
   - input_audio_buffer.speech_started {item_id}: user began (barge-in cue)
   - input_audio_buffer.speech_stopped {item_id}: end-of-speech timestamp
   - conversation.item.input_audio_transcription.delta {item_id, delta}: append to partial caption
   - conversation.item.input_audio_transcription.completed {item_id, transcript}: the heard text; THEN the client says it
   - conversation.item.input_audio_transcription.failed: tell the user it was not caught
   - error {error.message}
   Mic constraints (LE:97-99): echoCancellation, noiseSuppression, autoGainControl, mono. PWA opens a fresh call at 55 min (OPENAI_ROLLOVER_AT_MS, shared/realtime.ts:47; LE:209-212), retries a dropped call once (LE:214-222), 20 s data-channel timeout (LE:65).
   The heard text NEVER travels over the Forge wire in this path.

B. PCM append / done = the desktop transcribes (no WebRTC; used when A is refused)
   Who: desktop transcribeAudio: Groq whisper-large-v3-turbo if a Groq key is set, else Gemini; neither -> failed "No speech-to-text key. Add a Groq or Gemini key in Settings -> Keys on the desktop."
   (electron/voice-bridge.ts:393,405-416; H:1701).
   Audio (S:249-257,4001-4037; W:1618-1621; LE:284-296,413-418; web/src/deck/claudeVoice.ts:118-142):
   - raw PCM, signed 16-bit LITTLE-endian, 16000 Hz, mono, NO header (server adds the WAV header, S:4415-4431)
   - PWA frame = 100 ms = 1600 samples = 3200 bytes; one append = 10 frames = 1 s = 32000 raw bytes (SLICE_FRAMES = min(10, floor(65536/3200)), LE:291). Hard caps per slice: raw <= 64 KiB (MAX_FILE_CHUNK_BYTES, W:462),
     base64 string <= 96 KiB (MAX_FILE_CHUNK_BASE64, W:467; S:3996)
   - base64 = STANDARD alphabet with = padding, no newlines, no data-URI; server regex ^[A-Za-z0-9+/]+=*$ after trim (S:3991,3996). On Android use Base64.NO_WRAP.
   - turnId string <= 64 chars, any unique id (PWA "lt"+base36 time+"-"+n, LE:408); seq integer 0..399 (VOICE_TURN_MAX_SLICES = 400, S:257,3992)
   - whole turn <= 4 MiB raw (MAX_DICTATION_BYTES, W:475; S:4004) -> failed/limit "That turn is too long to send." (about 131 s; PWA caps a turn at 600 frames = 60 s, LE:290)
   - a NEW turnId on append discards any turn not yet done (S:4000; W:1620-1621)
   Requests / results:
   {"kind":"voice-claude","op":"append","turnId":"t1","seq":0,"data":"BASE64"}  ->  {"kind":"ok"}
   {"kind":"voice-claude","op":"done","turnId":"t1","chunks":3}               ->  {"kind":"voice-heard","text":"what is Zeb doing"}
   {"kind":"voice-claude","op":"cancel","turnId":"t1"}                        ->  {"kind":"ok"}
   done rules (S:4013-4044): chunks integer 1..400; slices 0..chunks-1 must ALL be present else failed/bad-frame "Missing slice i of n"; unknown turnId -> failed "That turn is not held here.";
   < 2 bytes PCM -> voice-heard with text ""; transcription error -> failed with the provider's sentence; text is trimmed.
   done does NOT send the words to Claude (W:1622-1625): the client must follow with say (3.3).
   So YES: a client can use only append/done with no WebRTC; the heard text is voice-heard.text (empty string = nothing heard).
   PWA sequence: upload slices while talking, then when speech ends send the last partial slice, wait for ALL append results (any failed aborts, LE:437-444), then done with chunks = number of slices sent (LE:445).
   PWA VAD, only if you want to mimic it (LE:284-296,373-411): start when level >= max(0.02, floor*3) for 2 frames (3 frames and threshold x2.5 while Forge is speaking); end after 800 ms below 0.6 x start level or 600 frames;
   needs >= 3 voiced frames else cancel; 3-frame pre-roll. Echo guard: drop a heard text that mostly repeats what Forge just said (isEcho, LV:385; src/lib/speech.ts:119).

### 3.3 say
Request {"kind":"voice-claude","op":"say","text":"what is Zeb doing","turnId":"lv9k2-1"} (W:1664). Result {"kind":"ok"} as soon as the turn is handed over; the reply comes through events (S:4050-4060; H:860-868).
- text trimmed, cut to 8000 chars; empty -> failed/bad-frame "There was nothing to say." (S:4051-4055,260).
- turnId (<= 64 chars) ties reply pieces to this turn. If omitted the host invents web<lane>-<time> (H:861) and you cannot match the reply. ALWAYS send one. PWA: "lv"+base36 time+"-"+n (LV:435).
- The host prefixes a bracketed note to the first turn ("Steve is talking to you through Forge Web ...") and a short tag to later ones (H:797-799,864); the client adds nothing.
- Starting a turn while another is in flight: the PWA first barges in (stops playback, sends interrupt) and holds the next say until the interrupt was sent (LV:428-452,651). Server side, the API brain cancels the previous active turn on a new ask (electron/live/voice-brain.ts:410-415).
- Errors come as a failed result, or as event turn-end{ok:false,error} (electron/live/index.ts:166-179).

### 3.4 interrupt
{"kind":"voice-claude","op":"interrupt"} -> {"kind":"ok"} (S:4076-4080). Cancels this lane's turn in flight and any web-lane TTS the page fetched ahead (cancelKokoro web, liveCancel(current), H:869-873); jobs keep running (W:1642).
The client must also stop its own playback and discard queued clips (LV:644-656). UNVERIFIED: whether a turn-end still follows a cancelled turn (not traced); the PWA ignores events for any turn that is not its current one (LV:540,559).

### 3.5 events: there is NO push frame; it is a LONG POLL
{"kind":"voice-claude","op":"events"} -> {"kind":"voice-claude-events","events":[ ... ],"open":true} (W:2340; S:3967-3981).
- Events already queued, or session dead: answered immediately with everything queued, in order (S:3972-3975).
- Otherwise the request is parked and answered the instant the next event is pushed (S:3978,4140-4149), or with events:[] and open:true after VOICE_CLAUDE_POLL_MS = 20000 ms (W:2370; S:3979).
- One parked wait per socket: a second events call while one is parked answers the OLDER one with events:[] at once (S:3976-3978). Keep exactly one in flight and re-issue the instant a reply arrives (LV:505-526).
- Queue cap 2000; the oldest are dropped past it (S:260,4143).
- No session on the socket -> {"kind":"voice-claude-events","events":[],"open":false} (S:3968-3971). open:false = session gone: stop polling and treat Live as closed (LV:521-524).
- Request deadline must exceed 20 s: PWA 30 s (C:88; W:2366-2369).

### 3.6 latency, close, cancel
latency: {"kind":"voice-claude","op":"latency","sample":{"turnId":"lv9k2-1","eosToSendMs":310,"sendToFirstTextMs":900,"firstTextToAudioMs":700,"eosToAudioMs":1650,"ack":true}} -> {"kind":"ok"}.
turnId (<= 64) and eosToSendMs (finite, 0..<3600000) required; other ms fields optional; ack boolean; bad sample -> failed/bad-frame "That is not a latency sample." (S:4462-4478,4119-4128; shared/live.ts:38).
Logged on the desktop as "[live] web latency ..." (electron/live/index.ts:200-217). Optional; harmless to skip.
close: {"kind":"voice-claude","op":"close"} -> {"kind":"ok"} also when there was no session (S:3961-3965); cancels this lane's reply only; Conductor jobs run on (H:874-882).
cancel (PCM turn drop, 3.2B) is not the reply cancel.

### 3.7 One turn, end to end (PWA behaviour to copy)
1 ears give text H. 2 say{text:H,turnId:T} -> ok. 3 events: say{turnId:T,text:piece,final:false} ... say{...,final:true}, then turn-end{turnId:T,ok:true}. 4 per completed clause call speak and play in FIFO order.
5 if nothing has sounded 600 ms after end-of-speech, play a cached ack once (ACK_AFTER_MS = 600, src/lib/live/turns.ts:20,166-169; LV:461-478). 6 after the last clip send latency.

## 4. Events (WebVoiceClaudeEvent)

Type: VoiceAgentEvent | {type:closed,reason:string} | {type:live,event:LiveEvent} (W:2358).
For claude-live the host emits ONLY {type:live,...} (openWebLive never emits closed, H:815-895; UNVERIFIED that nothing else can, since pushVoiceClaude accepts any). VoiceAgentEvent (shared/types.ts) belongs to the other Claude agents; ignore.
Wire form: {"type":"live","event":{...}}. LiveEvent (shared/live.ts:27-33):

| event.type | fields | meaning / delivery |
|---|---|---|
| say | turnId, text, final | streamed PIECE of the reply to YOUR turn. DELTA, not cumulative: pieces arrive as written (Sure / , I will / check), join as-is, fold a double space at the seam (src/lib/live/turns.ts:30-41). final:true on the last piece (text may be empty). Only for turnIds this lane said (H:831-833) |
| turn-end | turnId, ok, error? | your turn finished; once per turn; ok:false carries error (e.g. "Claude Live is not running on the desktop.", electron/live/index.ts:170). Only for own turns (H:834-837) |
| news | id, jobId?, text, urgency | urgency = needs-you, done or info. Speak at the next gap, never over the user. Sent to EVERY lane (and the desk) |
| ledger | snapshot {jobs: LiveJob[], seq} | job list, PHONE-TRIMMED (6.1), throttled to at most 1 per 400 ms (WEB_LIVE_LEDGER_GAP_MS, H:802,838-846); first one at open |
| status | status: LiveStatus | Live health; one at open, more on change. LiveStatus = {ready, voiceModel, conductorModel, voiceRoute (api or subscription), hasApiKey, conductorBusy, error?} (shared/live.ts:34-37; electron/live/index.ts:98-111) |
| show | target, note? | never sent to browsers: dropped by the host (H:847-849). Tolerate anyway (LV:597) |

- Heard text is NOT an event: it is the done result (PCM path) or the OpenAI data channel (ears path) (3.2).
- Speech is NOT an event: pull it with speak (5).
- Needs-you arrives as (a) news with urgency needs-you, (b) a ledger job with state needs-you (6), (c) the broadcast attention frame (7).
- Error: turn-end{ok:false,error} for a turn; failed results for ops; status.error for Live itself; {type:closed,reason} plus open:false = session ended, treated as fatal by the PWA (LV:528-533).
- PWA handling (LV:536-599): ignore say/turn-end whose turnId is not the current turn; buffer pieces and cut clauses with takeClauses (5.3); flush the tail on final or turn-end; news queued by id (same id = one item; newer news about the same job replaces the older, turns.ts:99-116),
  spoken only at a gap: not hearing, not speaking, no turn busy, and >= 1000 ms after the user stopped (NEWS_GAP_MS); one needs-you alone first, else up to 3 lines joined with spaces (turns.ts:18,26,118-150); retry every 500 ms (LV:70).
- Timing summary: events long poll hold 20 s (W:2370); ledger throttle 400 ms (H:802); ack after 600 ms (turns.ts:20); barge duck-then-stop 150 ms (turns.ts:22); news gap 1000 ms (turns.ts:18); request timeout 30 s (C:88).

## 5. Speech (speak)

### 5.1 Request / result
{"kind":"voice-claude","op":"speak","text":"Sure, I will check."} (W:1666)  ->  {"kind":"voice-speech","audio":"BASE64","mime":"audio/wav"} (W:2342; S:4062-4074)
- text trimmed, cut to 900 chars (S:258,4063); empty -> failed/bad-frame "There was nothing to speak." (S:4064-4067).
- Failure -> {"kind":"failed","code":"failed","message":REASON}; a TTS cancelled by interrupt also comes back as a failure (H:1779,1796). On any failed the PWA falls back to the browser's own speech synthesis for that clip (LV:674-684,729-737); a bubble can use Android TTS.
- The wire does not order replies (requests are independent); the client keeps order itself (5.3).

### 5.2 Encoding and engine for claude-live
- S:4068 passes engine kokoro for every agent except plain claude, so claude-live always takes the host kokoro branch (H:1774-1803), which then follows the desktop setting claudeVoiceSound:
  1. openai (DEFAULT; electron/store.ts:306, validated :914; shared/types.ts:1946-1954): OpenAI TTS model gpt-4o-mini-tts (electron/openai-tts.ts:4,37), voice = setting openaiTtsVoice (cedar default, or marin; store.ts:307,915; openai-tts.ts:39,87), key = openaiKey.
     Raw PCM16 mono 24000 Hz (openai-tts.ts:38,50) wrapped in a WAV header by pcm16Wav (electron/kokoro-tts.ts:481) and returned as base64 with mime audio/wav (H:1776-1778). Text limit 1500 chars (openai-tts.ts:41). Lane web, so interrupt can abort it.
  2. If OpenAI fails (no key, bad key, network) and the setting is not kokoro: Forge Brain's Edge voice, setting brainVoice (default en-GB-RyanNeural, shared/brain.ts:195; store.ts:361), tried twice then BRAIN_VOICE_FALLBACKS; Edge returns MP3, mime audio/mpeg (electron/edge-tts.ts:53,72,430; H:1782-1792).
  3. claudeVoiceSound brain skips OpenAI and goes straight to 2.
  4. claudeVoiceSound kokoro: Kokoro voice kokoroVoice as audio/wav (H:1793-1797); if Kokoro fails it falls through to Edge with voiceEdgeVoice (H:1799-1802).
- So the client must read mime and decode audio/wav (PCM16 mono; 24 kHz for OpenAI) or audio/mpeg. Both are decodable by Android MediaPlayer/AudioTrack after base64 decode. The comments at S:644-651 and W:1631-1632 describe an older Edge/MP3-only world; H:1774-1803 is current.
  UNVERIFIED: the Kokoro WAV sample rate (kokoro-tts.ts returns its own sampleRate, default 24000 at :423).
- Controlled by the desktop settings claudeVoiceSound (openai, kokoro or brain), openaiTtsVoice, brainVoice, kokoroVoice, voiceEdgeVoice (shared/types.ts:1946-1956). The phone has no say.

### 5.3 Clipping, order, interrupt (LW:1-58; LV:660-768)
- Text arrives as deltas. Buffer them. takeClauses(buffer, firstClause) (LW:37-58):
  - a sentence end cuts a chunk: a . ! or ? optionally followed by one closing quote/bracket, then whitespace (LW:16);
  - for the FIRST chunk of a reply only (turn.chunks == 0), it may instead cut at a clause boundary: a comma, semicolon or colon, or a spaced dash, then whitespace (LW:17,19-28), when the text before it has >= 4 words (LW:12) and the cut is earlier than the sentence end and <= 220 chars;
  - if no cut is found and the rest is > CHUNK_MAX = 220 chars, cut at the last comma-space, semicolon-space or space inside the first 220 (LW:10,47-52);
  - the unfinished tail stays in the buffer; on final or turn-end the trimmed tail is spoken (LV:555,561,603-610).
- Each chunk goes through speakable() before speak (src/lib/speech.ts:86-100): drops code fences, strips backticks, leading # - *, bold markers, replaces URLs with "a link", collapses whitespace, caps at 340 chars (cut at the last sentence end if past 80).
- Playback is a FIFO of lines {text, kind reply/ack/news, turnId}. Audio for the first SPEECH_AHEAD = 2 lines is requested ahead (LV:66,668-672); line 0 plays when its audio resolves, then the next (pump, LV:686-738). One at a time; the next clip is fetched while this one plays.
- Ack lines jump the queue (unshift, LV:476). News is queued as kind news, at a gap only.
- Barge-in (LV:412-420,643-656,749-767): user voice while speaking -> duck gain to 0.15 at once (BARGE_DUCK_LEVEL); if still speaking BARGE_STOP_MS = 150 ms later -> stop the current clip, drop all queued lines, bump a generation counter so late speak results are discarded,
  send interrupt, clear the turn so later say/turn-end for it are ignored. Late speak replies still arrive and must be dropped by the generation check. A new user turn while busy barges in first (LV:431).

## 6. Jobs, cards, needs-you

### 6.1 Shapes (shared/live.ts:17-25,122-141)
LiveJobState = queued | running | needs-you | done | failed | stopped
LiveJob = { id: string; title: string; project?: string; paneId?: string; paneName?: string; owner: conductor | pane | operator; state: LiveJobState; steps: {at: number; text: string}[]; createdAt: number; updatedAt: number; summary?: string }
LiveLedgerSnapshot = { jobs: LiveJob[]; seq: number }
Phone-trimmed ledger (liveLedgerForPhone, live.ts:134-141): open jobs plus finished jobs updated within 2 h (LIVE_PHONE_KEEP_DONE_MS), newest updatedAt first, at most 12 (LIVE_PHONE_JOBS_MAX), each with only its NEWEST step (steps.slice(-1)), seq passed through.
Each ledger event is the WHOLE list: replace, do not merge. Step text <= 200 chars (live.ts:18,64). UI words: Waiting / Working / Needs you / Done / Failed / Stopped (live.ts:97-111). Pane ids and job ids are opaque strings.

### 6.2 Which jobs are cards on the PWA (LW:60-72; LV:94-100)
Cards = jobs in needs-you (newest first) then done/failed updated within 30 min (LIVE_CARD_DONE_MS = 30*60_000, LW:61), minus those the user dismissed. Dismiss key = id + ":" + updatedAt, so a job that moves again reappears (LV:88,118-121).
Working count = jobs running or queued (LV:97). At most 3 cards drawn, rest counted (web/src/components/LiveCards.tsx:23,40-41). Line shown = summary, else the last step text (LiveCards.tsx:75).
The desktop's separate pop-up card (shared/live-card.ts) fades done cards after 12 s (live-card.ts:47) and is an Electron IPC feature, not on the wire.

### 6.3 job op
{"kind":"voice-claude","op":"job","jobId":"j-7","action":"stop"} -> {"kind":"ok"} (W:1670; S:4100-4118).
- action is ONLY stop or show (LiveJobAction, shared/live.ts:46); anything else -> failed/bad-frame "That is not a job action." jobId <= 128 chars. Unknown job -> failed "No such job" (scripts/web-check.mjs:2031-2034).
- Host: liveJobAction (electron/live/index.ts:190-193). stop = stop a Conductor job. show = make the DESK show the job's pane (moves the desktop, not the phone).
- PWA wiring (LiveCards.tsx:43-60,86-105): Open (job has paneId) navigates the phone to that pane, else falls back to job show; Stop only when state is needs-you and owner is conductor; OK / Later only dismisses locally.

### 6.4 How a pane question reaches the phone and how yes / no is sent
- There is NO yes/no op in voice-claude: the op list is closed (W:1660-1671; S:3987-4131). The PWA cards offer Open / Stop / OK-Later only (LiveCards.tsx:86-105).
- Signals that something is waiting: news with urgency needs-you (jobId optional), a ledger job with state needs-you (paneId / paneName say which crew member), and the broadcast attention frame
  {"type":"attention","sessionId":"PANE-ID","asking":true,"prompt":"one-line question"} (prompt optional; W:2001-2012). Attention is sent to all authenticated sockets (S:1299-1303) and replayed for panes already asking right after hello-ok (S:2553-2562); asking:false when it stops.
- Ways to answer:
  1. Same as the desktop's Push it: say the line "Yes, WHO can go ahead." where WHO = job.paneName, else "Operator" (owner operator), "Forge" (owner conductor) or the job title (livePushLine and liveCardWho, shared/live-card.ts:50-56,95-98).
     The desk sends it as a typed turn to the voice brain (src/state/live/LiveController.tsx:734-737). Desk card buttons: Push it only for needs-you with a jobId, Show me if the job has a pane, Later always (live-card.ts:87-93).
     UNVERIFIED: that the brain acts on it identically when it arrives from a web lane (not traced).
  2. Any spoken turn ("yes go ahead"): the voice brain owns the Conductor.
  3. Keystrokes into the pane, as the PWA AnswerCard does: frame {"type":"write","sessionId":"PANE-ID","data":"y"} then, 120 ms later, a second write whose data is the single carriage-return character (0x0D).
     Plain yes = keys [y or yes, CR], plain no = [n or no, CR] (plainReplies, web/src/components/AnswerCard.tsx:52-58). Menus: arrow keys (ESC [ A / ESC [ B) or digits, then CR (answerKeys, web/src/lib/answer-options.ts:413-421). Gap before the final Enter 120 ms (answer-options.ts:406,423-429);
     Enter must be its own write. A menu with no No row is answered with Esc (0x1B) (answer-send.ts:35-42). A write is <= 8192 chars (W:406); a dead pane returns {"type":"error","code":"unknown-session"} (S:1912-1919). Pane id = PTY session id = split-tree leaf id (FL:480).
     No attach is needed to write (S:1888-1920). The PWA reads the pane screen first to pick keys (readPaneAsk); a bubble that has not attached cannot see the menu, so use way 1 or 2 except for a plain yes/no. UNVERIFIED which prompts accept y or yes (isYesNo, answer-options.ts:237).
- Desktop card answers (LiveCardAnswer {id, jobId?, choice push/show/later}, live-card.ts:31-37) are Electron IPC, not wire.

## 7. Frames that arrive unasked after hello-ok

No subscription is needed for any of these. The server broadcasts to every authenticated socket (S:1595-1599) and sends a short catch-up straight after hello-ok.
- Inside hello-ok: projects, profiles, workspaces, sessions (S:2512-2547).
- Immediately after hello-ok (S:2552-2579): remote-yes if a UAC prompt is up; one attention{sessionId,asking:true,prompt?} per pane currently asking; one busy{sessionId,busy:true} per busy pane; the newest usage frame per live pane.
- Later broadcasts, no ask: sessions (the whole list, S:1284-1287), session-started, attention (S:1299-1303), busy, usage (at most 1 per pane per 2 s, W:2032-2036), foreman, brain, brain-says, handoff, desktop {state recovering or ready}, remote-yes, projects, workspace, git (S:1284-1416; W:2544-2574).
- Per-subscription, NOT unsolicited: replay and data need attach; transcript needs transcript-watch; chat:*, browser:*, board:* and mirror need their own subscribe/start frames (S:1802-1886,2015-2019).
- visibility: request {"kind":"visibility","visible":true} -> {"kind":"ok","sessions":[...]}. It only affects data delivery: a socket that said visible:false is sent no PTY bytes (S:1250-1259,3706-3729). A socket that never says gets data anyway. A bubble that never attaches panes can ignore it.
  PWA re-states it every 5 s beat, the watch once after hello-ok (C:2108,2550; FL:331-332).
- For a Live-only bubble: you need attention (and optionally sessions for pane names) beyond the voice-claude results; ignore the rest.

## 8. Test harness; running a server for an emulator

### 8.1 What the scripts do
- package.json: web:check -> scripts/web-check.mjs (:119), web:smoke -> scripts/web-smoke.mjs (:109), web:e2e -> scripts/web-e2e.mjs (:120), live:check -> scripts/live-check.mjs (:44).
- scripts/web-smoke.mjs bundles the REAL electron/web/server.ts and auth.ts with esbuild from scripts/fixtures/web-smoke-entry.ts (exports WebServer, WebAuth, hashPin and constants; web-smoke-entry.ts:8-40), imports the bundle (web-smoke.mjs:169-227) and drives it over a real ws WebSocket (:255-279).
  No mock server, no fake auth class: auth is real, only Google key fetching is faked.
- scripts/web-check.mjs drives the whole real electron/web-host.ts with electron stubbed (web-check.mjs:1-60). It has the only Claude Live phase, "Claude Live from a browser" (web-check.mjs:2005-2082): open, ears refused, job refused, latency, say + turn-end, news and ledger trimming (12 jobs, one step each), close.
- scripts/live-check.mjs is not a wire test (it greps sources, e.g. :519).

### 8.2 What is faked, and how (copy these)
- Token verification: real WebAuth with fetchJwks returning { body: JSON of {KID: PEM-CERT}, cacheControl: public max-age=21600 }, projectId: () => PROJECT, uid: () => UID (web-smoke.mjs:429-440; WebAuthHost fields A:330-359).
  The cert is a self-signed X.509 built by hand-rolled DER from a generated RSA-2048 key (web-smoke.mjs:80-148,229-230). Mint tokens: header {alg RS256, kid, typ JWT}, claims {aud: PROJECT, iss: https://securetoken.google.com/PROJECT, sub: UID, auth_time: now-300, iat: now-60, exp: now+3600}, signed RSA-SHA256 (web-smoke.mjs:234-248; checks A:1423-1505).
  A bubble in test mode just sends such a JWT as idToken and skips Firebase.
- PIN: omit pinHash for no PIN: hello is admitted on the token alone (A:341-343,1144-1145; web-smoke.mjs:434-438). To test PIN/resume pass pinHash: () => hashPin("1234") (exported, web-smoke-entry.ts:19-22). No PIN means no resume tickets ever (A:792), and a no-Origin socket never gets one even with a PIN.
- Origin: allowedOrigins: () => [...]; connect with no Origin header or an allowed one (the smoke uses https://forge-web.web.app, web-smoke.mjs:58).
- Voice host (needed for Live, else failed/unsupported, S:3943-3949): voiceClaudeOpen(onEvent, agent) returning a VoiceClaudeLink {say, interrupt, close, ears?, job?, latency?} (S:848-859), voiceSpeak(text, engine) returning {ok:true, audio:BASE64, mime}, transcribeAudio(bytes, mime) returning {ok:true, text} (S:511,642-651).
  The fake pushes {type:live,event:{...}} through the onEvent callback to simulate say / turn-end / news / ledger / status.
- Other REQUIRED WebServerHost members: auth, appVersion, desktopName, allowedOrigins, sessions, replay, write, resize, snapshot, layout (S:301-391). Minimal: sessions: () => [], replay: () => "", write: () => false, resize: () => true, snapshot: () => ({projects: [], profiles: [], workspaces: {}}), layout: async () => null.
  Heartbeat can be shortened with heartbeatMs / heartbeatGraceMs (S:818-820).
- Start: await server.start({ host: "127.0.0.1", port: PORT }) (web-smoke.mjs:676; S:1099,824-827). The scripts use ports 8481 (smoke) and 8479 (check).

### 8.3 Could a small script serve an emulator at ws://10.0.2.2:PORT/web ?
Yes in principle: model it on web-smoke.mjs:169-229 + 429-503 + 676 with the fakes above (roughly 100 lines): bundle the exports, start on host 127.0.0.1 (the emulator alias 10.0.2.2 is the host loopback, an Android platform fact: UNVERIFIED from this repo) or 0.0.0.0.
The source-address filter accepts loopback and all RFC1918 (S:4587-4599), so either address the connection appears from is allowed. The subprotocol header is mandatory (S:1148); no Origin header is fine (S:4318).
The server speaks plain ws:// (it is an http.createServer upgrade, S:1105-1189), so the Kotlin client needs a dev override that dials ws://10.0.2.2:PORT/web directly instead of RTDB + wss. The PWA dev escape hatch (webSocketUrl allowLoopback, W:293-343; web/src/config.ts:40-47) only accepts localhost / 127.0.0.1, so it does not help Kotlin.
Android cleartext (ws://) permission is an Android platform requirement: UNVERIFIED here. Do NOT use npm run web:check (starts the whole host, port 8479, temp data dirs) or web:build for this.

## 9. Gaps: watch/ ForgeLink.kt and ForgeAuth.kt versus the PWA

Same as the PWA: PROTO 2 (FL:46), subprotocol (FL:47,252), /web (FL:48), host staleness 3 min (FL:49), token refresh every 50 min via auth (FL:50,288-296), deviceId persisted (FL:114-119), PIN in RAM only and cleared on pin-invalid (FL:94,383-386),
busy honours retryAfterMs (FL:396-400), identical Firebase REST endpoints (FA:33-34).
Differences and lacks (all read directly):
1. No resume ticket: hello never sends resume (FL:257-265) and hello-ok.resume is never read (FL:314-333). It also sends no Origin (FL:250-253), so the desktop would not issue one anyway (A:792). The PIN must be re-supplied after every process start (FL:37-38).
2. Never reads hello-ok.features (FL:314-333). Not needed for Live.
3. request() timeout is 15 s (FL:52,505-506): too short for the 20 s events hold. Needs a per-call timeout of 25-30 s or a dedicated path.
4. No voice-claude code at all: no WebRTC, no audio capture or playback, no base64 audio, no events loop, no TTS decode.
5. The auth refresh reply is ignored (no pending entry), which is fine (FL:361-364).
6. Sends visibility once after hello-ok only (FL:331-332); the PWA re-states it each 5 s beat (C:2519-2560). Fine for a bubble that never attaches panes.
7. Liveness relies solely on OkHttp pingInterval 30 s (FL:86); no app ping/probe, no attach-replay audit (C:236,2519). The server pings at 20 s (W:547).
8. Reconnect: 1 s doubling to 30 s (FL:156,181) versus PWA 0.5 s to 15 s, capped 8 s when visible (C:77,2490). Absent desktop retried every 30 s (FL:53,174).
9. bad-token: sets FINDING and force-refreshes in the background (FL:391-395); no "second bad-token means sign in again" rule (C:2443-2458). not-approved and wrong-account land in REFUSED and stop (FL:401-412); the PWA stops on both too (C:474-480).
10. shutdown only changes the status text and the loop reconnects (FL:366-372); the PWA treats disabled as stop (W:2488). The desktop frame is handled as text only (FL:373).
11. deviceName "Forge Watch (MODEL)" (FL:263); client "forge-watch/VERSION" (FL:51).
12. Does not handle attention, busy, usage, brain, foreman, handoff, git, transcript; data/replay are only counted by length (FL:344-351).
13. ForgeAuth has no account auto-create (good) and signs out only on a permanent refresh refusal (FA:120-125); the PWA signs out on ANY non-OK refresh (web/src/lib/auth.ts:171-174).
14. readTimeout(0) for the long-lived socket, connect timeout 8 s (FL:84-85), same as the PWA dial deadline (C:188).
