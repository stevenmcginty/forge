# Handoff

## Gemini Live main-agent brain: mic went deaf (fixed, uncommitted)

- **Cause:** `src/lib/realtime/pcm-worklet.js`. After `postMessage(..., [out.buffer])`, the buffer is detached, so `out.length` was 0. The next chunk was sized 0 and never filled. The mic sent one chunk in total, and it arrived before `setupComplete`, so it was dropped. The socket, auth, model id, setup message and tool schema were all fine.
- **Scope:** Gemini only. The GPT Realtime brains send the mic over WebRTC (`src/lib/realtime/openai.ts`), not this worklet.
- **Fix:** read the size before the transfer. A regression check is in `scripts/realtime-check.mjs`, and it passes (22 checks).
- **Verify at restart:** pick Gemini Live, press Listen, then check dev.log. You should see `[realtime] mic chunks=… sent=…` climbing at about 10/s, then `[hub] phase=thinking` or `phase=speaking` with `live=gemini-live`.

## Still open

- **No spoken or visible error when a live session goes quiet.** There is no watchdog for "socket open but no audio or reply". This was not done because another session was editing `gemini.ts` at the same time.
- **Switching the brain during a live session leaves that session running** (`brain=claude … live=gemini-live`).
- **Phase two, not started:** one realtime-adapter interface, so a new live model is one adapter plus one `AGENT_BRAINS` entry, and a real self-test per brain (key works, session opens, round trip comes back). Audit notes: session scratchpad `realtime-audit.md`.
  - `RealtimeSession` (`src/lib/realtime/session.ts`) already fits.
  - The blockers are the per-id switches in `VoiceHubController.createSession` and `electron/agent-brain-test.ts`, the vendor facts centralised in `shared/realtime.ts`, and the vendor voice lists and copy in the Settings UI.
  - The `realtime:check` and `brain-adapters:check` scripts are not in `scripts/run-checks.mjs`.
- **Unblocked:** the other session committed its realtime and tool edits (372265c). Phase two can start.

## Listen switch redesign (done, f4f6c7a)

- `ListenToggle` in `src/components/hub/VoicePill.tsx/.css`: off is a hollow knob, on is a lit track, and the knob mark shows the phase. Steve chose to ship it as is.
- **Known and accepted:** in the muted and starting states the knob edge is below 3:1 contrast.
- **Check at restart:** the live Waveform, the animations, and the four themes that were not previewed.
