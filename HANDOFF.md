# Handoff

## Relay comet is back (2026-09-24)

- **Cause:** the comet only fired from the bar's own send-to-pane. Since 1322260 the bar asks the main agent by default, and the agent's `typeIntoPane` / `VoiceAgent.sendPrompt` never fired one. `pane_send` never told the renderer at all.
- **Fix:** `src/lib/relayComet.ts` flies from the sending pane (or the bar) to the target's on-screen `.pane`, `.mtile` or `.wstrip__tile`. Called from Composer, `typeIntoPane`, `sendPrompt`, new agent pane briefs (`relayFrom`), handoff, and a new optional main→renderer `pty:relay` event after `pane_send`.
- **Checked:** typecheck, hub, voice-hotkey, share-link, dictation checks; live in a throwaway Forge, Full screen and Wall. Not live-tested: a real LLM brain call, handoff, a strip-only target.

## Dictate key is Right Alt; every app key is in Settings › Shortcuts (2026-09-24)

- **Cause:** UK layout. Windows sends Right Alt as AltGr: a fake Left Ctrl goes down first, then Right Alt, and the fake Ctrl auto-repeats beside it while held (proved with real SendInput in a probe window). `KeyRecorder.tsx` saw "Left Ctrl + another key" and recorded nothing. `stt-gesture.ts` treated each fake-Ctrl repeat as a new combo key, so a hold ended at ~0.5 s.
- **Fix:** the recorder drops a Left Ctrl that is followed by Right Alt; the gesture ignores other keys' auto-repeats. Right Alt is never swallowed, so AltGr characters still type.
- **Default:** Dictate is now Right Alt. A one-time move (`forge.dictateKey.altRight`) changes a profile still on Right Ctrl.
- **Rebindable now:** `bar.palette` (Ctrl+K) and `bar.saveDraft` (Ctrl+S), new scope `bar`, read by Composer; `app.devtools` (F12), read in main from keymap.json so it works on a blank window. Left as-is: carousel Esc/arrows/Enter, OpenCode scroll keys, dev-only Ctrl+Shift+R.
- **Checked:** voice-hotkey:check (new AltGr cases fail on the old code), dictation, hub, canvas, typecheck. Live in a throwaway Forge with the recorded key sequence: move to Right Alt, record F9 then Right Alt in Settings, hold talks (listening) and release stops (idle), Left Alt does nothing.
- **Not changed:** Forge Web still uses Right Ctrl for D.

## Settings › Shortcuts rebinding (2026-09-24, uncommitted)

- **Cause:** the talk-key listener (`src/lib/stt-gesture.ts`, window capture phase) ignored `suspendShortcuts()`. While the key recorder listened, a non-modifier talk key was swallowed before the field saw it, and Right Ctrl started dictation, whose typed text took focus and cancelled the recorder.
- **Fix:** `shortcutsSuspended()` in `src/lib/keymapRegistry.ts`; the talk key stands down while it is true. `escapeIsOurs` (`src/state/VoiceAgent.tsx`) leaves Esc to the recorder (`.krec`), so Esc cancels the rebind without ending a voice chat.
- **Checked** in a throwaway instance: rebind shows, old combo dead, new combo live, survives relaunch (`keymap.json`). Typecheck, hub:check, dictation:check and voice-hotkey:check pass.
- **Not reproduced:** Steve's exact case (Right Ctrl talk key + left-hand combos) worked before the fix. If it still fails, find out which keys he pressed.

## Forge Web: Listen switch and voice-bar grip removed (2026-09-24, b44df5b, pushed, CI green)

- **Decided (Steve):** in the browser, Listen did nothing useful next to D, so it goes. D (Right Ctrl) is the browser's dictation. The drag grip on the voice bar goes too. The bar stays at the bottom by default; the "…" menu still moves it.
- **Code:** `web/src/deck/ListenSwitch.tsx` deleted; `VoiceBar.tsx` has no grip or drop zone. Web only, nothing in `src/`. The phone face is unchanged.
- **Left open (low):** typing `/voice` in the deck composer still starts a recording, and a click elsewhere can hide the composer while it records (`web/src/deck/Deck.tsx:294`).
- `scripts/web-deck-check.mjs` already failed before this change (`.dk-seg`, `.dk-prow*`, missing `web/src/deck/PanesSheet.tsx`). Still to fix.

## Top wall strip + full review fixes (2026-09-24, uncommitted, not yet QA'd live)

- **Decided (Steve):** no terminal tab strip and no Tabs|Wall switch. Terminals are either **Wall** (grid fills the stage, X close top-right on each tile) or **Full screen** (one terminal). In Full screen and over Browser/Board, a live **wall strip** of all terminals sits at the top of the stage. Browser/Board are full width below it; no more side-by-side. Data values stay `'mosaic'`/`'tabs'` (Wall/Full screen), so `set_view` and voice are unchanged.
- **Code:** `src/components/shell/WallStrip.tsx/.css` (new), `src/App.tsx` (stage column), `TerminalGrid.tsx` (Wall/Full/Beside), `MosaicView.tsx` (zoom removed; click opens Full screen; `useCloseTerminal` with a busy-agent confirm, `src/components/CloseConfirm.tsx`), `TitleBar.tsx` ("N agents" + a + button). Projects sheet restyled (`ProjectRail.*`, `rail/*.css`, `Dock.css`).
- **Review:** five read-only audits (browser, Board, inter-agent, voice, visual), findings in the session scratchpad `review/*.md`. The High and Medium items are fixed:
  - agents: pane opens in the caller's project; brief delivery is idempotent (`src/lib/briefDelivery.ts`); never pastes into a bare shell; closing a pane stops its Foreman
  - browser: hides under the … menu and prompts (`browser/overlays.ts`); app keys pass through (`appKeys.ts`); right-click menu; password values redacted from `browser_read`; hides on renderer reload
  - Board: strip tiles accept drops; lazy `forge-artifact:` loading (CSP updated in `index.html`); size limits aligned; artifact frames sandboxed; two-press delete
  - voice: late start torn down (V1); silent reply after interrupt (V2); 30 s no-reply watchdog; mic errors mapped; switching brain stops the old live session; Wall/Full screen wording
  - visual: contrast ≥ 4.5:1, Paper lime-on-lime, unified menus, dead CSS
- **Checks:** typecheck and lint are clean. `npm test` fast lane: 49 passed. realtime, brain-adapters, gemini-live, voice-hotkey, agent-bar and agent-pane are now in the fast lane.
  - Pre-existing failures in `test:all` that are not ours: apk:check, bridge:smoke (Gemini 403), packaged:check.
- **Left open:**
  - A6: a Foreman hire in a project that is not on screen starts when that project is opened.
  - A9: voice brains get the answer from dispatch time (fix: await `outcome.pending` in `src/lib/realtime/tools-main.ts`).
  - Cross-origin iframe reading, and auto-closing page `alert()`s.
  - The Low findings.
  - Tab reorder and drag-tab-to-Wall are gone; the dead `TAB_DRAG_TYPE` handler is left in `MosaicView.tsx`.
  - `state.mosaicZoom` has no UI now.
- **Next:** Steve QA at restart, then commit.

## Gemini Live main-agent brain: mic went deaf (fixed, uncommitted)

- **Cause:** `src/lib/realtime/pcm-worklet.js`. After `postMessage(..., [out.buffer])`, the buffer is detached, so `out.length` was 0. The next chunk was sized 0 and never filled. The mic sent one chunk in total, and it arrived before `setupComplete`, so it was dropped. The socket, auth, model id, setup message and tool schema were all fine.
- **Scope:** Gemini only. The GPT Realtime brains send the mic over WebRTC (`src/lib/realtime/openai.ts`), not this worklet.
- **Fix:** read the size before the transfer. A regression check is in `scripts/realtime-check.mjs`, and it passes (22 checks).
- **Verify at restart:** pick Gemini Live, press Listen, then check dev.log. You should see `[realtime] mic chunks=… sent=…` climbing at about 10/s, then `[hub] phase=thinking` or `phase=speaking` with `live=gemini-live`.

## Still open

- **Quiet live session:** partly done. A 30 s no-reply watchdog after a tool call now ends the session with the reason "no reply". There is still no general "socket open, no audio" watchdog.
- **Brain switch during a live session:** the old session now stops. The new brain does not start on its own.
- **Phase two, not started:** one realtime-adapter interface, so a new live model is one adapter plus one `AGENT_BRAINS` entry, and a real self-test per brain (key works, session opens, round trip comes back). Audit notes: session scratchpad `realtime-audit.md`.
  - `RealtimeSession` (`src/lib/realtime/session.ts`) already fits.
  - The blockers are the per-id switches in `VoiceHubController.createSession` and `electron/agent-brain-test.ts`, the vendor facts centralised in `shared/realtime.ts`, and the vendor voice lists and copy in the Settings UI.
- **Unblocked:** the other session committed its realtime and tool edits (372265c). Phase two can start.

## Listen switch redesign (done, f4f6c7a)

- `ListenToggle` in `src/components/hub/VoicePill.tsx/.css`: off is a hollow knob, on is a lit track, and the knob mark shows the phase. Steve chose to ship it as is.
- **Known and accepted:** in the muted and starting states the knob edge is below 3:1 contrast.
- **Check at restart:** the live Waveform, the animations, and the four themes that were not previewed.

## Forge Web desktop face = the deck (2026-09-24)

- **Decision (Steve):** a desktop browser should look like the new desktop deck. The phone face stays unchanged. It is built here on `desktop-redesign`, so it ships when Dev merges; it is not on master. The only web setting is the theme.
- **Done:** `389b1e8` (not pushed). The code is in `web/src/deck/*`, with small hooks in `Workspace.tsx`, `SessionComposer.tsx`, `Composer.tsx`, `Panes.tsx` and `lib/term.ts`.
  - Deck tokens and CSS are imported live from `src/`: `deck-tokens.css`, `deck.css` and `VoicePill.css`.
  - `node scripts/web-deck-check.mjs` guards drift.
  - The phone was checked pixel-identical at 390×844.
- **Next:**
  1. Re-sync `web/src/deck/DeckTopBar.*` when Steve's top-bar redesign lands. It is minimal on purpose, and the pane tabs live in the panes sheet.
  2. Update `scripts/web-e2e.mjs`. It expects `.tabstrip__new` and `.prow` to be visible at 1440, and they are now inside sheets.
  3. Risk: those three `src/` CSS files also load on the phone. Keep their rules scoped under `.deck` and add no bare `:root` variable names, or extend the drift check to enforce this.
  4. Phase 2 is the voice agent in the browser. The desktop mints the Gemini Live or GPT Realtime token over a new wire message, and the Claude brain goes through the desktop. It waits for the voice work to settle.
