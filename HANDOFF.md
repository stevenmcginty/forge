# Handoff

## Terminal scroll lost after a reload; New button stands out (2026-09-25, not committed)

- **Asked (Steve):** can't scroll Elia (Claude Code) on the Wall or in Full screen; "+ New" on the title bar should stand out a little.
- **Cause (proven on a throwaway Forge):** `noteWidth` in `electron/pty-host.ts` replaced the replay buffer with a clear-screen on every PTY width change (Wall<->Full, growPeek). Claude Code does not reprint history after a resize, so a renderer reload (HMR on any src/ edit) rebuilt xterm with baseY 0. Claude Code clearing scrollback, mouse tracking and overlays were ruled out.
- **Built:** pty-host keeps a per-width segment log (`deskLog`, same 192 KB cap) sent as `segments` on the desktop reload replay only; `writeReplay` in `src/lib/terminals.ts` replays each segment at its own width then fits. `PtyReplaySegment` in `shared/types.ts`. `getReplay` (phone, web, share, foreman) unchanged. New button: hairline rim, brighter text, accent plus (`src/components/shell/DeckBar.css`).
- **Checked:** typecheck, lint:hooks, mosaic:check 113; repro after fix: baseY 253/276 after reload, wheel scrolls in peek, typing and Full screen.
- **Needs:** a Forge restart (main process). Panes that already lost history stay empty. Not tested: Forge Web/phone (path unchanged), a busy turn filling 192 KB with spinner redraws.

## Project folder on the title bar and the Wall (2026-09-25, 1139472, pushed)

- **Asked (Steve):** show the project folder in more places than the bottom-left pill; picked A (title bar chip) and D (big name on the Wall) from a Board mockup.
- **Built (designer):** `ProjectChip` in `src/components/TitleBar.tsx` (folder, name, branch, opens the project sheet, path tooltip; shrinks at 1200/1100/1000px, hidden at <=1024px with the voice bar on Top on the Wall). `WallName` in `src/components/MosaicView.tsx` (faint watermark + label bottom-left, hidden while a tile covers it). CSS in `DeckBar.css`, `MosaicView.css`.
- **Known:** on the Grid the bottom-left cell always has a tile, so the Wall label and most of the watermark only show in Free or a shortened grid. The sheet still opens from the bottom dock when the bar is at the bottom.
- **Checked:** typecheck, lint:hooks, mosaic:check 113; designer screenshots in a throwaway Forge at 960-1600px, dark and paper.

## Wall tile grows its terminal; Hide on the Forge reply box (2026-09-25, ae783df, not pushed)

- **Asked (Steve):** text stays small when a tile goes from small to large; the Forge reply box above the bar sticks with no way to close it.
- **Cause:** a life-size tile read its pane's geometry once per mount and only cropped; a pane born in a crowded wall (never shown Full screen) kept its small grid forever. The reply box shows a non-final caption with no time limit.
- **Built:** `terminalHost.growPeek` (`src/lib/terminals.ts`) + PeekStage in `src/components/MosaicView.tsx`: a life-size tile bigger than its terminal grows it (grow only, smaller still crops). `CaptionRail` in `src/components/hub/Composer.tsx`: "Hide" button (hides until something newer), non-final captions expire after 60 s.
- **Checked:** typecheck, lint:hooks, mosaic:check 113. Not seen live. Scaled mode (`mosaicText: 'scaled'`) unchanged.

## Wall: Grid | Free switch, header drag reorders on the grid (2026-09-24 17:44, merged to master, not pushed)

- **Asked (Steve):** the Wall was a mess of overlapping tiles. Freeform may stay, but there must be an obvious way into a tidy, symmetrical mode.
- **Cause:** ca3eed3/ad373e3 only helped the auto grid; Steve's wall was already freeform, and any header drag (or fit double-click) turned the wall freeform with no visible way back.
- **Built (fb02d43, 8dd31b9):** `WallLayoutSwitch` (Grid | Free) in the title bar right after "+ New", only while the Wall shows, plus a copy in the "…" menu's Tools; "Fit" chip when the grid has a dragged size. On the grid a header drag moves the tile to the slot under the pointer (`MosaicState.order`, CSS `order`, dashed target box); fit double-click no longer turns the wall freeform. Free seeds from the grid or restores saved boxes. "Reset to grid" and `resetMosaicLayout` are gone.
- **Checked:** typecheck, lint:hooks, mosaic-check 113, layout-engine-check 56; throwaway Forge: 5 overlapping tiles → Grid gives 0 overlaps, reorder keeps Grid; title-bar shots at 1599/959px. Not checked: narrow window with the voice bar on Top.

## Wall: an edge on the grid resizes every tile together (2026-09-24, merged to master, not pushed)

- **Asked:** uniform tile sizes on the Wall, resizable by the user, kept organized.
- **Built:** on the auto grid, a tile's side edge picks the column count (1-6) and its bottom edge sets every row's height; the wall scrolls past the window. A label by the pointer says "3 columns · 320 px rows". Double-click an edge, or the menu's new "Fit to window", clears it. Header drag still goes freeform, where an edge resizes one tile as before. Stored as `MosaicState.grid` (`shared/types.ts`), `actions.setMosaicGrid`, helpers `gridFromDrag`/`wallColumns`/`gridLabel` in `src/lib/mosaicLayout.ts`.
- **Checked:** typecheck, lint:hooks, mosaic:check 89. Not tried live. Forge Web's Wall (`web/src/deck/Deck.tsx`) still uses `columnsFor` only; it could read `mosaic.grid` later.

## Agent audio bar redesign & terminal human naming rule (2026-09-24)

- **Asked (Steve):**
  1. Redesign the agent audio bar at the bottom of Forge. Merge the agent selection pop-up and the listening toggle into a single, cohesive on/off microphone button with a built-in synthesizer indicator that actively shows when it is listening. Keep the remainder of the bar as is, ensuring it is compact to save space for typing.
  2. Implement a new rule for terminal creation: every newly opened terminal must automatically be assigned a generic human name (such as Trevor, Mike, or Zelda) by default to facilitate easy reference. Descriptive names or path-based names should not be used automatically, although users and agents may still rename them manually afterward.
- **Built:**
  - **Single cohesive microphone button (`.vunit` in `src/components/hub/VoicePill.css`, `VoicePill.tsx`, `BrainPicker.css`):** Merged the listening toggle and the agent selection pop-up into a unified capsule button (~85px total, saving ~200px of bar width). Left segment is the on/off microphone toggle; right segment is the active agent mark (`BrainMark`) with a subtle dropdown chevron opening `BrainMenu`. The remainder of the bar layout is preserved as is.
  - **Built-in Synthesizer Indicator (`src/components/hub/SynthesizerIndicator.tsx`):** High-DPI canvas-rendered 5-bar audio synthesizer equalizer integrated directly inside the microphone toggle. When listening is ON, the bars actively undulate with an organic breathing rhythm and dynamically bounce to microphone voice input (`hub.readLevels().mic`). Also responds to agent speech (`levels.out`), thinking sweep wave, and connecting states.
  - **Terminal generic human naming rule (`shared/agents.ts`, `shared/workspace.ts`, `src/state/AppState.tsx`):**
    - Enriched `TAB_NAME_POOL` in `shared/agents.ts` with friendly human names including "Trevor", "Mike", and "Zelda" (preserving "Ada" at index 0 for test compatibility).
    - Added `isDescriptiveOrPathName()` in `shared/workspace.ts` to detect path separators/drive letters (`C:\...`, `/...`), shell names (`powershell`, `pwsh`, `bash`), and action prefixes (`update: ...`, `install: ...`, `task: ...`).
    - Updated `newTabName()` so any attempt to auto-assign a descriptive or path-based name falls back to the next generic human name from `TAB_NAME_POOL`.
    - Added `pooled: true` to `actions.openToolPane` in `src/state/AppState.tsx` so tool/update panes receive human names automatically.
    - Manual renaming by users and agents is preserved as requested.
- **Checked:** `npm run typecheck`, `npm run lint:hooks`, `node scripts/agent-bar-check.mjs` (41/41 passed), `npm run voice:check`, `npm run dictation:check`, `npm run realtime:check` (28 checks passed), node naming assertions suite.

## Wall click-to-type + Expand; voice bar mic/send; real logos on every terminal (2026-09-24 17:05, merged to master, not pushed)

- **Wall (Steve):** a click on a tile's terminal now enters in-place typing (was: opened Full screen). Always-visible Expand button beside the X opens Full screen. The terminal-icon button shows only while typing, as "Stop typing". Esc or a click on empty Wall leaves typing. Enter on the arrow-key ring alone still opens Full screen. `src/components/MosaicView.tsx`, `.css`.
- **Wall tile scroll ("can't scroll in the Wall"):** still unexplained. The debugger could not reproduce it: the wheel scrolled scaled and life-size tiles, pwsh and Claude Code, on Steve's real layout. The WallStrip lead is dead: `WallStrip` is not mounted since 5c1ac5d (its new wheel code in `src/components/shell/WallStrip.tsx` is inert). Remaining lead: after a renderer reload the xterm is rebuilt from the 192 KB pty-host replay (`electron/pty-host.ts:53,288`), so `baseY` can be ~0 and `scrollPeek` returns false. Next step: in the live renderer, read `term.buffer.active.baseY` for a tile that won't scroll.
- **Voice bar:** one disc at the right end of the desktop bar: mic when empty (dictation toggle, same as D), Send with text, stop square while recording. Old "Ask ⏎" button gone. `src/components/hub/DictateButton.*`, `Composer.*`. Rebased over the other session's Listen+picker unit (8a146d5). Dead rule left: `Dock.css:781` `.comp__send`.
- **Logos:** `AgentBadge` draws the real brand logo (Simple Icons CC0 / LobeHub MIT paths in `shared/agent-logos.ts`); shells get `>_`; unknown agents keep letters. Web uses the same component; reaches Forge Web on push. Next: `src/components/hub/BrainMark.tsx` (invented marks) should switch to `shared/agent-logos.ts`.
- **Checked:** typecheck, lint:hooks, mosaic-check 60; throwaway-Forge checks for click-to-type and the bar states; badge screenshots. Dev renderer hot-updated cleanly after each merge.

## Desktop voice bar: Listen + voice agent as one unit (2026-09-24, merged to master, not pushed)

- **Asked (Steve):** the desktop bar's Listen toggle and agent picker were "not very good"; redesign like the desktop's other icon pickers, but better.
- **Built (designer, worktree, merged 16:56):** Listen and the picker share one rim; the brain is named once (on the chip). New `src/components/hub/BrainMark.tsx` gives each brain a mark. Menu rows: mark tile, name, a second line, status as glyph + word ("✓ IN USE", "● READY", "! NOT LOGGED IN", "◇ NEEDS KEY"); unpickable rows have dashed tiles. At ~900px the chip shrinks to its mark. `src/components/shell/Dock.css` rules moved to the new classes. Behaviour unchanged (keys, probes, `brainSwitchWaits`, aria).
- **Checked:** typecheck + build in the worktree; screenshots dark and paper, 1400 and 900, in the session scratchpad `voicebar/`. Live dev renderer hot-updated cleanly. Keyboard path and Right Shift not re-tested (code unchanged).
- **Known:** while a live session waits for a switch, the chip names the newly picked brain, not the one still talking. At 900px a fallback shows only mark + diamond.
- **Next:** BrainMark uses invented marks. Steve wants real company logos everywhere (memory `terminal-badge-is-company-logo`): swap BrainMark and `AgentBadge` (desktop + web) to one real-logo set. Research: `AgentProfile` has no icon field; web gets full profiles already, so no wire change; no icon package installed. Findings in the session scratchpad `agent-icons/findings.md`.

## Forge Web: desktop terminal status row on Full screen and Wall (2026-09-24, uncommitted)

- **Asked (Steve):** bring the desktop pane status display to the web: agent icon, status indicator, terminal name, current agent, live.
- **Built:** row = badge · output pulse · tab name · agent name · state chip. Full screen header (`web/src/components/PaneView.tsx` when `fullScreen`) and Wall tiles (`TileLabel`, `web/src/deck/Deck.tsx`). State glyphs and words ported from `src/components/shell/StateChip.tsx` into `web/src/deck/agents.tsx`, because that desktop file imports `terminalHost`. New states done (tick) and reconnecting. `OutputPulse` listens to `actions.onData` and reuses `src/components/ActivityDot.css`. `usePaneDone` in `web/src/lib/pane-status.ts` uses the desktop "Done" rule. No wire change and no desktop restart.
- **Gaps:** no starting/exited/failed on the web (no source); dormant says "Not running"; no "Working 12m" timer; `AgentStatus.tsx` strip dot is still colour-only; Wall shows the tab name even with one tab.
- **Known nit:** `useAgentState` checks offline/reconnecting before asking, so a pane waiting for input shows "Reconnecting"/"Frozen", not "Needs you", while the link is down.
- **Checked:** typecheck, lint:hooks, vite build to scratch (web/dist untouched); refuter confirmed. Not seen in a browser; ~400px fit unverified. `scripts/web-deck-check.mjs` was already broken (reads the deleted `web/src/deck/PanesSheet.tsx`).

## One name per terminal; voice agent picker in the desktop bar; Wall wheel scroll (2026-09-24)

- **One name (Steve, option A):** the tab name ("Zeb") is a terminal's only name. A split pane is "Zeb 2". Call-signs ("Atlas") are removed (pool, hub-store, IPC, preload). `shared/terminal-names.ts` (`terminalName`, `resolveTerminal`, `listTerminals`) serves every resolver: appactions, hubnav, the realtime tools, and main's `share-link.ts`. Both brain snapshots print `Zeb · Claude Code · state`. Misses list `Zeb (Claude Code), …`. `open_agent_pane` takes `name` again (reverses ee35b79); a taken name gets " 2". Known, not fixed: `useHandoffFlow` finds its tab by title (broken since ee35b79). Two Claude panes in one folder share one FORGE_SHARE_AGENT.
- **Colours (e05b937):** tab-name chips tinted in the agent colour, agent names in the agent colour, project pill stands out. Follow-up: the CC/AG badges fade on the paper theme (`src/components/AgentBadge.css`).
- **Voice agent picker (0f9fd4c, 9d19d09):** `src/components/hub/BrainPicker.tsx` is a chip beside Listen with a menu of every brain and its status word. Unavailable brains are disabled. It writes `agentBrain` the same way Settings does, and the status logic is shared (`src/lib/brainStatus.ts`, `src/hooks/useBrainStatus.ts`). With a live session, a switch reads "Starts next time you press Listen".
- **Wall wheel (9428ebb):** `scrollPeek` (`src/lib/terminals.ts`) sent the wheel over full-screen (alternate screen) programs to the Wall. It now sends PageUp/PageDown or SGR wheel to the program with no focus or grid claim. The Claude Code tile already scrolled in the debugger's repro, so if Steve's Claude tiles still don't scroll, there is a second cause.
- **Needs:** desktop restart (main, preload and renderer changed). Not live-tested by Steve yet.

## Forge Web dock no longer covers the bottom panes; agent tabs take pool names (2026-09-24)

- **Asked (Steve):** the chat box at the bottom merged with terminal four; agent-made tab names like "UI Fix" should follow the normal names.
- **Dock:** the stage reserved a fixed 96px guess, but the dock grows to 134px (keys row, voice line, a draft left in the box). `useDockClearance` in `web/src/deck/Deck.tsx` measures the dock's resting height into `--dk-dock-h`; `--dk-dock-clear` in `deck.css` uses it. Growth while typing (picks row, extra lines) floats instead, so terminals are not refitted on every focus. Shots: session scratchpad `dock/{before,after}`.
- **Names:** `open_agent_pane` lost its `name` argument (`shared/brain-tools.ts`, `bridge/forge-app-tools.mjs`); `openAgentPane` now sends `pooled: true`, and `openToolPane` names the tab with `nextTabName` and moves the cursor. Needs a desktop restart.
- **Checked:** typecheck, webclient tsc, before/after screenshots. "Overlap inside the input box" was not reproduced; likely the status strip over terminal rows, which is fixed.

## Forge Web: Close button (X) on Full screen and Wall tiles with confirmation prompt (2026-09-24)

- **Asked (Steve):** in the web browser, have an X in the corner whether it's on full screen or the walled view, and get a prompt asking if sure we want to close/delete it, to easily close down windows.
- **Fix:**
  - Added close (X) button in top-right corner of Wall tiles (`dk-tile__close` in `TileLabel`, `web/src/deck/Deck.tsx`).
  - Added close (X) button in top-right corner of Full screen pane header (`pane__close` in `PaneView.tsx`, passed via `onClose` from `DeckStage`).
  - Anchored `Popover` confirmation prompt appears upon clicking X: asks "Are you sure you want to close “[title]”?", explains that running processes in the window will be stopped, with Cancel and danger-styled auto-focused Close button (pressing Enter or clicking Close immediately closes). Escape or clicking outside dismisses cleanly.
  - Safe close logic: closes the tab if the pane is alone in the tab (`op: 'close-tab'`), or closes the pane (`op: 'close-pane'`). Refusal notice shown if any error is reported.
  - Styled with hover danger tint, disabled state when offline/reconnecting, and proper keyboard focus rings.
- **Checked:** `npm run typecheck`, `npm run lint:hooks`, `npm run web:build`.

## Forge Web deck: voice bar as symbols, smart mic/send, agent names, view switch (2026-09-24)

- **Asked (Steve):** project pill and voice-agent chip looked alike; symbols not words; shortcut keys listed in settings; the bar must name the agent pane (tab name, e.g. Wanda); send button smart like the phone's; stuck in Cards/Chat with no way back; wheel scroll in Chat/Cards snapped back.
- **Voice bar (`web/src/deck/VoiceBar.tsx`, `voicebar.css`):** one voice-agent control (person+waves toggles Listen; agent mark + chevron opens the picker). Every state is its own shape. D button removed; D key still works. Project pill has a folder glyph.
- **Smart mic/send (`Composer.tsx` `micPrimary` now also for `bar`):** mic when the box is empty, Send with text; runs `toggleDeckDictation`, the same flow as D. Empty-box Enter lives in the key row.
- **Names:** placeholder "Message Claude Code · Wanda · forge"; shell says "Not an agent"; the strip (`AgentStatus` `tab` prop) shows the tab name.
- **Settings:** `ShortcutKeys` (was `DictationKeySetting`) at the top of the … menu.
- **View switch (c7a7318):** `FaceSwitch` in `web/src/deck/Deck.tsx` on every Claude pane (Full screen header, Wall tile). Cause: the only switch was in the composer strip, hidden while typing. Wheel scroll fix in `ChatView.tsx` and `src/components/Feed.tsx`.
- **Checked:** typecheck, web vite build to scratch, voice-hotkey:check 73. Not live-tested.

## Forge Web: tab name in Full screen, bold on the Wall (2026-09-24)

- **Asked (Steve):** Full screen said only "Claude Code"; the Wall also shows the tab name ("Wanda") but faint.
- **Fix:** `PaneView` takes an optional `tabTitle`; the deck's Full screen header shows "Claude Code · Wanda" at the same 15px bold. The Wall tile's tab name is now 12px bold, full contrast, like the pane name. Hidden when the tab name equals the pane name.
- **Checked:** typecheck. Not viewed on screen.

## Forge Web: Listen key (Right Shift) in the browser (2026-09-24)

- **Asked (Steve):** the browser had no key to talk to the voice agent, only D's key.
- **Fix:** `web/src/deck/VoiceBar.tsx` `DeckKeys` wires Right Shift to Listen, same gesture as the desktop HubLayer: tap on/off, hold turns it on and stays hands-free, Shift+letter takes back a hold's start. Skipped if D's key is set to Right Shift. Not rebindable in the browser yet. Listen's tooltip names the key.
- **Checked:** typecheck (all four), voice-hotkey:check. Not live-tested.

## Wall → Full screen fix merged; New beside Wall; Full screen names the pane in the browser (2026-09-24 13:30)

- **Cause of "I thought you fixed it":** the Wall → Full screen scaling fix (ad8950f, "Full screen claims the pane's grid") and 4 sibling commits were built in worktree branch `worktree-agent-ab599473cfdab9e9b` but never merged. Now merged (a8c32af), conflicts with bfa0040's agent picker resolved; the agent chip sits in the AAA voice bar.
- **Decided (Steve, reverses c6da229):** a New button (plus + "New") right beside the Wall switch, desktop (`src/components/TitleBar.tsx`, Ctrl+T anchors on `[data-new-agent]`) and browser (`web/src/deck/DeckTopBar.tsx`, logic copied from AgentsMenu).
- **Browser Full screen:** PaneView's header shows again in Full screen only, styled like desktop PaneName (bold 15px, pill + bar). Wall unchanged.
- **Old desktop message** now names the agent: "Update the desktop app to use Claude here".
- **Claude voice "not working":** the running desktop started 11:27, before bfa0040 (12:46). Needs a desktop restart.
- **Checked:** typecheck, webclient tsc, web:build, build, realtime:check 27 (in a scratch worktree). Name bar NOT viewed on screen.
- **Open:** with Claude picked, Listen's navigation moves the desktop's view, not the browser's (Claude's tools run on the desktop). `scripts/web-deck-check.mjs` still crashes on the deleted PanesSheet.tsx.

## Forge Web: agent switcher — Gemini Live, ChatGPT, Claude (2026-09-24, uncommitted)

- **Decided (Steve):** in the laptop browser, flip the main voice agent between Gemini Live, ChatGPT (GPT Realtime) and Claude (Opus).
- **UI:** an agent chip in the browser voice bar names the agent; click opens a 3-row sheet, the one in use shows a tick and "in use". Choice kept in browser localStorage, default Gemini. Desktop `agentBrain` is not changed.
- **ChatGPT:** `OpenAIRealtimeSession` in the browser; its SDP offer goes over a new `voice-connect` op, main exchanges it via `connectOpenAI`. Key and secret stay in main.
- **Claude:** `web/src/deck/claudeVoice.ts` — energy end-of-speech (800 ms) → desktop transcribes (`transcribeAudio`) → a second browser-only `VoiceAgentHost` (`electron/voice-agent/ipc.ts`, always Claude) → reply spoken with desktop Edge TTS (`voiceSpeak`), browser `speechSynthesis` only if a sentence fails. Barge-in interrupts. Events by long-poll (`events` op, 20 s).
- **Checked:** typecheck, lint:hooks, realtime:check 26, dictation:check 31, web:build, build. Nothing live-tested (no real mic for GPT or Claude, no live flip). Needs a desktop restart (main changed) and a web deploy.
- **Known limits:** browser Claude runs in the home folder, not the active project. Sentence splitter copied into `claudeVoice.ts`. `web/src/deck/DeckTopBar.css` has big-window hunks from a parallel session, not this job.

## Forge Web deck top bar tidy (2026-09-24, uncommitted)

- **Fixed (CSS only, `web/src/deck/DeckTopBar.css`):** voice capsule now truly centred (grid `minmax(max-content,1fr) minmax(0,auto) minmax(max-content,1fr)`); Skills/Commands lost the desktop tab-strip margins that sat them 2px high; Wall button no longer changes width on/off; wider name caps for project pill and agent name on big screens.
- **Checked:** web-client tsc, web:build, before/after screenshots 960–2560px from a local harness (session scratchpad `topbar/shoot.mjs`). Full `npm run typecheck` was blocked by another session's in-progress `electron/web-host.ts`.
- **Open:** at ≤860px Skills and Commands are hidden with no other way in.

## Send tag + bigger agent names (2026-09-24, uncommitted)

- **Send tag:** every relay comet into a pane now also shows a chip under the target's header: a paper plane + "Sending" with pulsing dots while the comet flies, then a tick + "Sent", then it fades (`sendTag` in `src/lib/relayComet.ts`, CSS `.send-tag` at the end of `src/components/shell/deck.css`). Word and shape, not colour only. `fireComet` got an optional `onLand` callback (`src/lib/motion.ts`); a 1.2 s fallback lands the tag if the comet is cancelled.
- **Names bigger:** Full screen pane name 12.5 → 15px (`deck.css` `.deck .pane__title`), Wall tile 12.5 → 15px (`.mtile__title`), live strip 11.5 → 13px (`.wstrip__name`).
- **Checked:** typecheck, build. Not live-tested; Steve tests.

## Forge Web (laptop browser): Gemini Live agent + D uses the phone flow (2026-09-24)

- **Decided (Steve):** the deck face gets the main voice agent, starting with Gemini Live. Claude next, then GPT Realtime. D in a laptop browser acts like the phone: spoken commands, review countdown with Undo, auto-send.
- **How:** the browser runs the same `GeminiLiveSession`. The desktop mints a single-use token (`voice-token`, raw key stays in main). Setup, context and tool calls go over new authenticated WebRequests, answered by the renderer (`src/lib/realtime/web-bridge.ts`, `src/components/WebVoiceBridge.tsx`). Browser sessions get a `WEB_VOICE_NOTE` ("WHERE YOU ARE"). An old desktop makes Listen say "Update the desktop app to use voice here". D drives the deck's SessionComposer via `web/src/lib/dictation-seat.ts`; a live session's mic is held shut while D records.
- **Checked:** typecheck, lint:hooks, web:build, realtime:check 26, dictation:check 31. Nothing live-tested; Steve tests.
- **Loose ends:** browser tool calls do not show in the desktop's recent-actions list. `insertAtCaret` / `dictateIntoComposer` in `web/src/deck/composer.ts` are now unused.
- **Claude in the browser (next):** no live voice mode. Browser records → desktop Groq STT → desktop Claude agent → reply spoken in the browser.

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
