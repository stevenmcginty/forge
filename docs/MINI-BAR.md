# Forge mini bar: a floating desktop bar while Forge is minimised

Status: SPEC ONLY, nothing built. Written 2026-10-08 against master c74e589.
Evidence notes (path:line) came from four read-only research passes over the code.

## 1. What Steve asked

1. When the main Forge window is minimised, the bottom agent bar detaches and stays on the desktop as a small floating bar, always on top of other apps, so he can still see his desktop and other apps.
2. The bar works fully: talk to every active coding agent, start agent actions, dictate.
3. Keyboard shortcuts work in that state: projects, dictation, the rest.
4. Screen captures still pop up at the top right (of the desktop) and then go away.
5. A clear close button on the bar quits Forge completely.
6. State moves seamlessly between the big window and the bar.
7. (Added later the same day.) The bar is wider and more dynamic, with more pop-ups.
8. It tells Steve when agents are done (and when they ask something).
9. He can look at what an agent said, reply to it, chat to Forge, dictate, open Forge, maximise it, or keep it minimised, all from the bar.
10. "Talk to the agent and it could just tell us things": Forge speaks answers and speaks up on its own when an agent finishes.

## 2. The design in one paragraph

The mini bar is a remote control, like the phone. The main window's renderer keeps running while minimised (`backgroundThrottling:false`, `electron/main.ts:367`) and stays the only "brain": AppState, `terminalHost`, the dictation engine, the voice hub and the keymap all stay there. Two new small windows are thin views. The **mini bar** window shows state and sends commands. The **shot card** window shows a new screen capture at the top right. A main-process relay carries state one way and commands the other way. A native keyboard hook, live only while Forge is minimised, carries the Dictate key, the Listen key and one "summon" key from any app. An announcer in the host turns the existing pane signals (done, asking, stopped) into toasts on the bar and short spoken lines, through the same voice Forge already answers with.

```
 mini bar window (#minibar)            shot card window (#shotcard)
   view + local typing                   view, never takes focus
      | calls, key intents   ^ state        ^ shotcard:show
      v                      |              |
 ---------- main process: electron/minibar-window.ts relay ----------------
      | forward              ^ publish      ^ new shot while minimised
      v                      |              |   (electron/shots-watcher.ts)
 main window renderer = HOST (src/state/MiniBarHost.tsx)
   AppState . terminalHost . dictation engine . voice hub . keymap
      |
      v
 pty-host / stt sidecar / store   (unchanged)

 electron/global-keys.ts (native hook, only while minimised)
   talk keys + summon  ------------------------------------------> HOST
```

**Why not a second full renderer:** the bar's send path uses `terminalHost.paste` / `submit` (`src/lib/terminals.ts:2036`, `:2104`), whose xterm map exists only in the main window. STT phrase events go to one window only (`electron/stt-sidecar.ts:119-126`). Dictation must run exactly once (`src/hooks/useDictation.ts` header). A second copy would have an empty `terminalHost` and a second dictation engine. The phone already works the "remote control" way: its commands run inside the desktop renderer (`window.forge.web.onCommand`, `src/state/AppState.tsx:2506`).

## 3. Facts the design rests on

| Fact | Where |
|---|---|
| Main window keeps running while minimised (`backgroundThrottling:false`). Whether `document.hidden` turns true on minimise is UNVERIFIED. | `electron/main.ts:367` |
| Today minimise/restore/hide/show only call `syncPresence`; nothing reaches the renderer. | `electron/main.ts:~425-440` |
| No close-to-tray: the window X always quits. | `electron/tray.ts:280` |
| `before-quit` deletes the heartbeat file, so the watchdog restarts Forge at once, unless `dataRoot/watchdog.pause` holds a future expiry (epoch ms). Only tray Quit writes it (30 min). | `electron/heartbeat.ts:49`, `electron/watchdog-host.ts:105`, `scripts/watchdog.mjs` `check()` ~406, `electron/main.ts:~1555` |
| quit-guard shows a native "N panes are still running" dialog only when `confirmOnQuit` and live sessions exist; `allowClose()` bypasses it. | `electron/quit-guard.ts:36`, `:40-44` |
| Precedent window: `overlay-window.ts` is frameless, transparent, `skipTaskbar`, always on top at `'screen-saver'`, visible on all workspaces, re-asserts topmost on blur, shows with `showInactive()`, uses the same preload, loads `index.html#overlay`, clamps to the work area, and talks through an opaque relay. Its host `src/state/OverlayHost.tsx` is no longer mounted. | `electron/overlay-window.ts:64-72`, `:87-105`, `:145-241`, `:257-283`; `shared/ipc.ts:881-917`; `src/main.tsx:140-156` |
| No `globalShortcut` and no native hook exist. Every shortcut is a `window` keydown in the main renderer, so it fires only while the main window has focus. | `src/hooks/useShortcuts.ts:220`; talk keys `src/lib/stt-gesture.ts:316-321` via `src/hooks/useDictation.ts:566-576` |
| Talk keys: code defaults Dictate = Right Alt, Listen = Right Shift (`shortcutCommands.ts:134`, `:143`). Steve's own keymap has them swapped. Always use the configured keys. | `src/lib/shortcutCommands.ts` |
| AltGr (UK): Right Alt sends a fake Left Ctrl first and repeats it while held. | `src/lib/stt-gesture.ts:242-248`, `src/components/hub/KeyRecorder.tsx:71`, `:107` |
| The external DictationMic app owns Right Ctrl system-wide. Never bind Right Ctrl. | `src/hooks/useDictation.ts:28-32` |
| Dictation audio is captured by the Python sidecar, not the renderer, so focus does not matter for capture. | `stt/stt_service.py` ~208, `electron/stt-sidecar.ts:271` |
| The bar is `Composer` in `Dock` with `ProjectPill` as its lead. It aims at the active pane ("-> Name" chip) or at Forge (the brain). The bar mic fills the text box, runs a 1.5 s "Sending..." countdown with Undo, then sends. | `src/components/hub/Composer.tsx:145-166`, `src/components/shell/Dock.tsx:16-37`, `src/components/hub/barMode.ts:50-70` |
| Screen captures: a clipboard poll every 700 ms that keeps running while minimised; `shots:updated` goes to every window; the card is `ShotPop` (10 s, hover pauses, X closes, click copies and pastes the path into the active pane, drag is a real file drag). | `electron/shots-watcher.ts:20`, `:96-102`, `:129`, `:184`; `src/components/ShotPop.tsx`; `src/components/ScreenshotTray.tsx:263-290` |
| Presence = any Forge window focused and not minimised. A focused mini bar keeps phone pushes quiet; an unfocused one does not. No change needed. | `electron/main.ts:303` |
| Pane state is computed in the host renderer: busy after 600 ms of output, quiet after 1.2 s; `settle()` marks "asking" when `looksLikeWaiting`, else "done" when the busy stretch was at least 8 s. Readers: `isBusy`, `isAttention`, `attentionPrompt`, `subscribeBusy/Attention`; `src/lib/paneActivity.ts` `activityOf()` folds them. It keeps running while minimised. | `src/lib/terminals.ts:272-286`, `:792-847`, `:924-953` |
| There is no desktop toast or OS notification for done or asking today. Only phone push (`web-host.ts:2283`) and an exit chime when unfocused (`terminalExitChime`). | `electron/web/push.ts:443`, `src/lib/terminals.ts:662` |
| Peek sources: `terminalHost.snapshotText(paneId, lines)` (raw screen text, any pane, sync in the renderer); for Claude panes the clean last reply from the session JSONL (`readTail`, last 512 KB, sync, and `paneWords().lastWords`), main-side and module-private, no IPC yet. | `src/lib/terminals.ts:1272`; `electron/brain/host.ts:251`, `:1268-1282`; `electron/brain/home.ts:296` |
| Forge's answers show in `CaptionRail` (last "You" and "Forge" lines, fade after 9 s). Speech: `sayBrain` (Edge, `brainVoice`) gated by `voiceReplyMode !== 'text'`; `spokenBrainReply` speaks the first paragraph, at most 2 sentences, code stripped. Main can make Forge say any line: `brainSays(text, true)` -> `IPC.brainSays` -> `hearBrain` (caption + speech; into a live realtime session as context). | `src/components/hub/Composer.tsx:658`, `:893`, `:918`; `src/state/VoiceAgent.tsx:268`, `:629`, `:939`, `:2476`; `electron/brain/host.ts:1393`; `src/state/VoiceHubController.tsx:283-300` |
| Spoken report-back on finish exists only for panes the Brain itself opened, Claude only, while the Brain runs, after a 20 s wait, worded by a Brain model turn. Panes Steve opens get nothing. | `electron/brain/host.ts:391`, `:705`, `:929`, `:1333-1354`; `electron/brain/home.ts:227`, `:336` |

## 4. What Steve sees and does

### 4.1 When the bar shows and hides

- **Shows** when the main window is minimised by any route (title-bar button, taskbar click, Win+Down) and the setting is on. It shows without taking focus (`showInactive`), so the app Steve switches to keeps the keyboard.
- **Hides** when the main window is restored, shown or focused (taskbar, the bar's Open Forge button, tray, a second launch, double-clicking a .md). The draft goes back to the big bar.
- **Never shows** while Forge is quitting, when the setting is off, or when there is no main window.
- **Position:** where Steve last dragged it, per display. Default: bottom centre of the work area of the display the main window was on, 12 px above the taskbar. Re-clamped when displays, DPI or the taskbar change.
- **Win+D (show desktop):** the bar must stay visible. UNVERIFIED; live test.

### 4.2 Layout

Two layers: the **bar** (one row, always there) and a **stage** above it, where pop-ups open. The window grows upward to fit the stage; the bar's bottom edge never moves.

- **Width:** wide by default: 70% of the display's work area, at most 1240 px (the big bar's own cap, `Composer.css:29`), at least 640 px. Drag either end to resize; saved per display.
- **Height:** 52 px for the bar. The stage adds up to 60% of the work area height.
- Same glass look and theme tokens as `Composer` (`Composer.css`), same theme as Forge.

```
          +------------------ stage: one panel at a time (Peek, Chat, Activity, lists) ------+
          | Peek - Jonah (Claude) - Done, 4 min                            [Open]  [Close]   |
          | I fixed the login redirect. Tests pass (42/42). Next I would ...                 |
          | -------------------------------------------------------------------------------- |
          | Reply to Jonah...                                                  (mic) (Send)  |
          +----------------------------------------------------------------------------------+
                                                         +- toast --------------------------+
                                                         | (tick) Ruth is done - api - 2 min|
                                                         | "Added the rate limiter."        |
                                                         | [Peek] [Reply] [Open]        [x] |
                                                         +----------------------------------+
+--------------------------------------------------------------------------------------------------------------+
| ::  [forge v]  [Jonah (tick) Done] [Ruth ? Asking] [Ivy (ring) Working] [+] | Type to Forge...  (clip) (mic) (Listen) (Send) | (bell 2) (speaker) | [_] [Open v] [X] |
+--------------------------------------------------------------------------------------------------------------+
```

- **Grip** (`::`): drag to move.
- **Project pill:** current project. Click: a list of projects with the number of running agents. Pick one to switch.
- **Agent chips:** every agent pane in the current project. Each shows the agent's brand logo, the pane name, and its state as a word plus a shape: Working, Waiting, Asking, Idle, Starting. Never colour alone (Steve is red-green colourblind). Click a chip to make it the send target and open its Peek (4.10). The list's last entry, "All agents", shows every agent in every project, grouped by project, each with its state and its last line; picking one switches project and target. When chips do not fit, the extra ones fold into "+3 more".
- **+ (New agent):** a new agent in the current project, the same as Ctrl+T.
- **Text box:** placeholder "Type to Jonah..." (or "Ask Forge..."). Enter sends, Shift+Enter makes a new line. It grows to the big bar's maximum (114 px). The window grows upward; the bottom edge stays put.
- **Paperclip:** a file picker parented to the mini bar window; picked paths go into the box quoted. Dropping files on the bar does the same.
- **Mic (Dictate):** the same as the big bar's mic.
- **Listen:** turns the voice agent on and off. Shows the words Listening, Speaking or Muted.
- **Send:** becomes **Stop** (a square) while the target agent is working and the box is empty.
- **Bell:** opens Activity (4.9). Its badge counts unseen events, as a number.
- **Speaker:** "Speak updates" on or off (4.11). Off shows a slash and the word "Quiet" in its tooltip.
- **Tuck (`_`):** shrinks the bar to a pill (4.12).
- **Open:** restores the main window as it was. Its small menu also has "Open maximised".
- **X (Quit Forge):** see 4.6. It sits at the far right, after a gap, so a miss on Open does not hit it.

Only one stage panel is open at a time (Peek, Chat, Activity, project list, All agents, quit confirm). Esc or its Close button shuts it. Toasts stack at the right of the stage, up to 3, and do not block the open panel.

### 4.3 Talking to agents

- Target rules are the big bar's rules: a pane, or Forge (the brain). The starting target is the big bar's target at the moment of minimising.
- Send uses the same code path as `Composer.send` (route, paste, wait for the echo, submit). A pane that is not ready yet (a brand-new agent) waits on `terminalHost.readiness` and never pastes into PowerShell.
- An agent in the Asking state shows "Asking ?" on its chip. Clicking it opens its Peek with the question and answer buttons (4.10).
- Stop sends the same interrupt the phone's Stop sends.
- Typing from the mini bar counts as the desktop typing, for pane ownership (the terminal grid follows the typist).

### 4.4 Dictation and Listen

- Capture is unchanged (sidecar). It works whether the bar or another app has focus.
- While the bar shows, **all dictation goes into the mini bar's text box**, from the key or the mic button, because the box is the only cursor Steve can see. Then the big bar's mic flow runs: "Sending..." for 1.5 s with Undo, then send to the target. The `dictateAutoSend` setting keeps its current meaning.
- Forge never types into other apps. (That stays DictationMic's job.)
- The bar shows a level meter while dictating, and the words Listening, Writing... and "Sending... Undo".
- Listen is unchanged (`hub.start` / `hub.stop`). Ctrl+Shift+M (mute) and Ctrl+Shift+. (interrupt) work.

### 4.5 Keyboard shortcuts

Three scopes:

| Keyboard focus is in... | Keys that work |
|---|---|
| The main window | Everything, unchanged |
| The mini bar (clicked, or summoned) | Every shortcut that makes sense without the big window (list below) |
| Any other app or the desktop, while Forge is minimised | Dictate key, Listen key, summon key. Nothing else (D1, decided 2026-10-08) |

Why only three keys outside Forge: a system-wide Ctrl+Shift+PageDown or Ctrl+T would also act in the app Steve is using (Chrome would open a tab and Forge a new agent). The talk keys are lone modifier keys that do nothing on their own in other apps.

With the mini bar focused:

- **Projects:** Ctrl+Shift+PageDown / PageUp (next / previous project), Ctrl+Shift+B (opens the bar's project list).
- **Agents:** Alt+1..9, Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+1..9, Ctrl+PageDown / PageUp. They switch the active tab or panel as today, and the target follows.
- **New agent:** Ctrl+T, and the per-profile new-agent keys.
- **Bar:** Ctrl+K (command list), saved-prompt keys, Ctrl+Shift+G (focus the box), Enter, Shift+Enter, Esc (clears the box; a second Esc leaves it).
- **Voice:** the Dictate key, the Listen key, Ctrl+Shift+Space, Ctrl+Shift+M, Ctrl+Shift+. .
- **Need the big window:** Ctrl+, (Settings), Ctrl+Shift+/ (cheat sheet), Ctrl+G (Wall), Ctrl+Shift+K (Board), F12. These restore Forge first, then run.
- **Ignored in the mini bar:** close pane / close tab (Ctrl+W, Ctrl+Shift+W), split, focus-neighbour, font size. They act on panes Steve cannot see.

All keys come from Steve's own keymap (`keymap.json`), so a rebind in Settings > Shortcuts applies to the mini bar too.

**Summon key:** default Ctrl+Shift+G (the existing "Ask Forge (go to the bar)" binding). From any app while minimised, it brings the mini bar to the front and focuses its box. The hook only listens; it does not swallow the key, so Chrome's own Ctrl+Shift+G (find previous) also runs, which is harmless. If Windows refuses the focus change, the bar flashes its outline instead (UNVERIFIED; live test).

### 4.6 The close button: quit Forge completely

- **X** with the tooltip "Quit Forge - closes every agent".
- If `confirmOnQuit` is on and agents are running, the bar grows a confirm row in place: "3 agents still running. 2 will resume, 1 will be lost." with [Quit Forge] and [Cancel]; Cancel has the focus. A "Don't ask again" box mirrors quit-guard's. No native dialog: a dialog parented to a minimised window, or under an always-on-top window, can be hidden (the "hidden confirm" fault from the 2026-10-01 Brain review).
- Then main calls `allowClose()`, then `app.quit()`. The X never touches the watchdog (D2, decided): it quits exactly like the main window's own X does today. `before-quit` disposes the mini bar, the shot card and the key hook. The existing 2.5 s `app.exit(0)` backstop stays.
- Result: Forge is fully closed. On a PC with "Keep Forge running" on (Steve's), the watchdog starts Forge again, as it does today after any X. On a PC without that switch, Forge stays closed.

### 4.7 Screen captures on the desktop

- When a new shot lands while the main window is minimised and the setting is on, a card pops at the **top right of the work area of the display under the mouse pointer**, 14 px in from the edges, 288 px wide.
- Same look and timing as `ShotPop`: 10 s, hover pauses, X closes, a new shot replaces the picture and stacks ghost cards (up to 3). It ends with a fade (there is no cog to tuck into).
- It **never takes focus** (`focusable:false`; clicks and drags still work).
- **Click** the picture: copies the image and the quoted path (as today) and, when the mini bar shows, puts the path in its box (instead of pasting into a pane Steve cannot see).
- **Drag** the picture: a real file drag into any app (the existing `shots.startDrag`).
- After Forge is restored, the big window's `ShotPop` does not pop shots that already showed on the desktop.
- Phone images that reach the shelf (`electron/companion-host.ts:35`) pop too.

### 4.8 Settings

Settings > General > "When Forge is minimised":

- "Show the mini bar" (`miniBar`, default on)
- "Dictate and Listen keys work in any app" (`miniGlobalKeys`, default on)
- "Show screen captures on the desktop" (`shotsOnDesktop`, default on)

- "Speak updates when agents finish or ask" (`miniSpeakUpdates`, default on)
- "Chime when agents finish or ask" (`miniChime`, default on)

Internal: `miniBarBounds` (per display id: x, y, width), `miniBarTucked`.

### 4.9 Notifications: done, asking, stopped

- **Source:** the host's existing pane signals (`subscribeBusy` / `subscribeAttention`, `activityOf`). No new detection. Events: **Done** (quiet after at least 8 s of work), **Asking** (a question or permission prompt), **Stopped** (the process exited).
- **Toast:** a card slides up at the right of the stage:
  - line 1: brand logo, "Ruth is done", project, how long it worked ("2 min"), and the state shape (tick for Done, ? for Asking, square for Stopped);
  - line 2: the agent's last line, one sentence (Claude panes: the last reply; other panes: the last non-empty screen line);
  - buttons: Peek, Reply, Open, and X. Asking toasts also show the answer buttons (4.10).
- A toast stays 8 s; hover pauses it. Then it folds into the bell's count.
- A burst (3 or more within 5 s) shows one toast: "3 agents are done: Jonah, Ruth, Ivy".
- **Activity panel (bell):** the last 30 events, newest first, each with time, project, state word and shape, and the last line. Click a row = Peek that agent. Opening it marks all as seen.
- **Chime:** a short sound on Done, a different two-note sound on Asking (sound, plus the word on the card; never sound alone).
- **Chips update live:** Working (ring), Done (tick, for 6 s as today, then Idle), Asking (?), Waiting (dots), Stopped (square).
- No Windows (OS) notifications: the bar is on screen whenever Forge is minimised. Phone push is unchanged.

### 4.10 Peek: look at an agent without opening Forge

- Opens in the stage from a chip, a toast or an Activity row.
- **Header:** logo, name, project, state word and shape, time in that state; buttons Open (restores Forge on that pane) and Close.
- **Body:**
  - Claude panes: the last reply as formatted text (Markdown, rendered with `web/src/lib/markdown.tsx`), read from the session JSONL.
  - Other panes: the last 40 screen lines, monospace (`terminalHost.snapshotText`).
  - It refreshes when the pane goes quiet, and every 2 s while the pane works and the Peek is open.
- **Reply box** at the bottom: sends to that agent (same send path as the bar), with its own mic. Sending makes that agent the target.
- **Asking:** the question (`attentionPrompt`) shows at the top in a box with answer buttons. The buttons and what they send reuse the phone's "Claude Code is asking" answer card, so desktop and phone answer the same way. (Where the phone gets its options is UNVERIFIED; check before building.) "Open Forge" stays as the safe fallback.

### 4.11 Talk to Forge, and Forge tells you things

**Chat (typed or spoken):**
- With the target on Forge, what Steve types or dictates goes to the Forge Brain / voice agent, as in the big bar (`hubAsk`).
- The **Chat panel** opens in the stage and shows the last 10 turns ("You" / "Forge"). Unlike `CaptionRail`, lines do not fade after 9 s; the panel collapses 20 s after the last turn unless hovered, or it stays while Listen is on.
- Answers are spoken as today (`sayBrain`, `brainVoice`; `voiceReplyMode = 'text'` means text only).
- **Listen** (hands-free) works from the bar: Steve talks, Forge answers aloud. The Chat panel shows the words.
- Forge can already act on all projects (open agents, read panes, send to them), so "tell Jonah to run the tests" or "what is Ruth doing?" works from the bar with no new tools.

**Forge speaks up on its own** (new, "Speak updates", default on while minimised):
- **Done:** "Jonah is done." For Claude panes it adds the first one or two sentences of the last reply, trimmed the same way as `spokenBrainReply` (`src/state/VoiceAgent.tsx:268`): "Jonah is done. Jonah says: fixed the login redirect, and tests pass."
- **Asking:** "Ruth is asking: allow an edit to login.ts?" (the one-line `promptFor`).
- **Stopped:** "Ivy stopped."
- **Burst:** "Three agents are done: Jonah, Ruth and Ivy."
- Use the pane's name, never "he" or "she".
- Each line is built from a template plus the agent's own words. No model call, so it is instant and free.
- **Never talks over Steve:** it waits while he dictates, while Listen hears him, and while Forge is already speaking. It queues, merges, and drops anything older than 60 s.
- **Speaker button** on the bar turns it off and on. With `voiceReplyMode = 'text'` it shows the toast only.
- **Brain overlap:** the Brain already reports on panes it opened itself (after 20 s, in its own words). The announcer leaves those panes to the Brain while the Brain runs, so nothing is said twice.
- Audio while Forge is minimised is UNVERIFIED; live test.

### 4.12 Tuck, open, maximise

- **Tuck (`_`):** the bar shrinks to a pill at the same spot: `( :: forge - (tick)2 ?1 (ring)3 - (mic) )`, showing counts per state with shapes and the mic. Click the pill to unfold. Talk keys, toasts and spoken updates still work while tucked. The tucked state is remembered.
- **Open:** restores Forge as it was (normal or maximised). **Open maximised:** restores and maximises.
- **Keep minimised:** the default; the bar stays until Forge is opened or quit.
- Double-click the grip: Open.

## 5. Architecture

### 5.1 Files

Main process:

| File | New / changed | Job |
|---|---|---|
| `electron/minibar-window.ts` | new | Create on first minimise, then keep hidden for a fast re-show. Show, hide, dispose. Save and load bounds. Resize with the bottom edge fixed. Relay. Quit flow. Summon focus. Reuse the work-area clamp from `overlay-window.ts` (export it; do not change the overlay's behaviour). |
| `electron/shot-card-window.ts` | new | Create on demand, place at the top right, show, auto-hide, dispose. |
| `electron/global-keys.ts` | new | The native keyboard hook (5.5 b). On only while minimised and `miniGlobalKeys` is on. |
| `electron/main.ts` | changed | Wire minimize / restore / show / focus to the mini bar, the hook and host mode. Dispose in `before-quit`. Register IPC. Re-send mode on the main window's `did-finish-load`. |
| `electron/shots-watcher.ts` | changed | After a new shot: if the main window is minimised and `shotsOnDesktop` is on, show the card and mark the id `shownOnDesktop`. |
| `electron/quit-guard.ts` | changed | Export the running-sessions summary (count, resume, lost) for the inline confirm. Its dialog stays as is. |
| `electron/preload.ts` | changed | `window.forge.minibar` (view half and host half), `window.forge.shotCard`, `window.forge.panes.lastReply`. |
| `electron/pane-reply.ts` | new | The JSONL tail read and "last words" logic lifted out of `electron/brain/host.ts:1268-1282` and `electron/brain/home.ts:296`, made async (`fs.promises`, still capped at 512 KB). The Brain and the new `panes:lastReply` invoke both use it. |
| `electron/brain/host.ts` | changed | Uses `pane-reply.ts`. Exposes the set of panes the Brain opened (`brain:openedPanes` invoke) for the announcer's overlap rule. |
| `shared/ipc.ts`, `shared/types.ts` | changed | Channels, `MiniBarState`, `MiniBarCall`, `RemoteKey`, settings, `Shot.shownOnDesktop?`. |

Renderer:

| File | New / changed | Job |
|---|---|---|
| `src/main.tsx` | changed | Route `#minibar` to `MiniBarApp` and `#shotcard` to `ShotCardApp`, with no providers (like the overlay). |
| `src/minibar/MiniBarApp.tsx`, `MiniBarApp.css` | new | The bar view and the stage. |
| `src/minibar/Peek.tsx`, `Chat.tsx`, `Activity.tsx`, `Toasts.tsx`, `Pill.tsx` | new | The stage panels, the toast stack and the tucked pill. |
| `src/state/announcer.ts` | new | Runs in the host. Turns pane events into toasts, Activity rows and spoken lines (4.9, 4.11): templates, burst merge, the "never talk over Steve" queue, the Brain overlap rule. |
| `src/state/VoiceHubController.tsx` | changed | A `say(text, { kind: 'announce' })` method on the controller, wrapping `hearBrain` / `sayBrain`, so announcements use the same voice, queue and `voiceReplyMode` as Forge's answers. |
| `src/minibar/ShotCardApp.tsx` | new | The desktop variant of the `ShotPop` card. |
| `src/state/MiniBarHost.tsx` | new | Mounted in `App.tsx` in the main window only. Publishes state, runs calls, feeds remote keys. |
| `src/lib/barSend.ts` | new | `Composer`'s send / `sendToPane` lifted out so the big bar and the host share one path. |
| `src/lib/barDraft.ts` | new | `Composer`'s text lifted into a module store (the `barMode.ts` / `barDictation.ts` pattern) for the hand-off. |
| `src/components/hub/Composer.tsx` | changed | Uses `barSend` and `barDraft`. No visible change. |
| `src/hooks/useDictation.ts` | changed | A new "minibar" sink in phrase routing. Talk keys also attach to the host's remote key target. |
| `src/hooks/useShortcuts.ts` | changed | The dispatcher also accepts remote commands; a mini-mode filter (run, restore first, ignore). |
| `src/components/ShotPop.tsx` | changed | Skips `shownOnDesktop` ids; exposes the card for the desktop variant (fade, no tuck). |
| Settings UI | changed | The three toggles. |

### 5.2 Window options

**Mini bar:** `frame:false`, `transparent:true`, `backgroundColor:'#00000000'`, `hasShadow:false`, `resizable:false`, `skipTaskbar:true`, `alwaysOnTop:true` then `setAlwaysOnTop(true,'screen-saver')`, `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})`, `minimizable:false`, `maximizable:false`, `fullscreenable:false`, `acceptFirstMouse:true`, `focusable:true`, `backgroundThrottling:false`, `sandbox:true`, the same preload, `index.html#minibar`. No `parent` (a child would minimise with the main window). Show with `showInactive()`. Re-assert topmost on blur, as `overlay-window.ts:209` does.

**Shot card:** the same, except `focusable:false` and `#shotcard`. It never calls `focus()`.

`skipTaskbar` is fine: the taskbar still shows Forge's minimised main window, and clicking it restores Forge (and hides the bar).

### 5.3 Relay

Modelled on the overlay's `toHost` / `toOverlay` (`electron/overlay-window.ts:64-72`). Main caches the last state, so a freshly loaded view gets it at once.

| Channel | Direction | Kind | Payload |
|---|---|---|---|
| `minibar:mode` | main -> host | send | `{ on: boolean }` |
| `minibar:publish` | host -> main | send | `MiniBarState` |
| `minibar:state` | main -> view | send | `MiniBarState` |
| `minibar:call` | view -> main -> host | send | `MiniBarCall` |
| `minibar:resize` | view -> main | send | `{ height: number }` |
| `minibar:openMain` | view -> main | invoke | none |
| `minibar:quitInfo` | view -> main | invoke | -> `{ confirm: boolean, running: number, resume: number, lost: number }` |
| `minibar:quit` | view -> main | invoke | `{ dontAskAgain?: boolean }` |
| `minibar:pickFiles` | view -> main | invoke | -> `string[]` |
| `keys:remote` | main -> host | send | `RemoteKey` |
| `shotcard:show` | main -> card | send | `{ shot: Shot }` |
| `panes:lastReply` | host -> main | invoke | `{ paneId }` -> `{ text: string; at: number } \| null` (Claude panes; null otherwise) |
| `brain:openedPanes` | host -> main | invoke | -> `string[]` (pane ids) |

```ts
type AgentStatus = 'starting' | 'working' | 'waiting' | 'asking' | 'idle'

interface MiniBarState {
  rev: number
  at: number                                   // host clock, for the heartbeat
  project: { id: string; name: string } | null
  projects: { id: string; name: string; running: number }[]
  agents: {                                    // every project; the view filters
    projectId: string; tabId: string; paneId: string
    name: string; brand: string                // brand drives the logo
    status: AgentStatus
  }[]
  target: { kind: 'pane'; paneId: string } | { kind: 'forge' }
  draft: string                                // hand-off only; see 5.4
  dictation: { phase: 'off' | 'listening' | 'writing' | 'sending'; level?: number; sendInMs?: number }
  listen: { on: boolean; speaking: boolean; muted: boolean }
  keymap: { command: string; chord: string; scope: 'run' | 'restore' }[]
  talkKeys: { dictate: string; listen: string }  // KeyboardEvent.code values
  events: {                                    // newest first, last 30
    id: string; at: number; kind: 'done' | 'asking' | 'stopped'
    projectId: string; paneId: string; name: string; brand: string
    workedMs?: number; line?: string; prompt?: string
  }[]
  unseen: number
  toasts: string[]                             // event ids on screen now
  peek: {
    paneId: string; source: 'reply' | 'screen'
    text: string; at: number
    asking?: { prompt: string; choices: { label: string; id: string }[] }
  } | null
  thread: { who: 'you' | 'forge'; text: string; at: number }[]  // last 10
  speakUpdates: boolean
  tucked: boolean
}

type MiniBarCall =
  | { t: 'send'; text: string }
  | { t: 'setDraft'; text: string }
  | { t: 'target'; to: { kind: 'pane'; paneId: string } | { kind: 'forge' } }
  | { t: 'project'; id: string }
  | { t: 'reveal'; projectId: string; tabId: string; paneId: string }
  | { t: 'newAgent' }
  | { t: 'stop'; paneId: string }
  | { t: 'dictate' }                           // the mic button
  | { t: 'undoSend' }
  | { t: 'listen' }
  | { t: 'command'; id: string }               // a matched shortcut
  | { t: 'talkKey'; code: string; phase: 'down' | 'up' }
  | { t: 'otherKey' }                          // content-free: some other key went down
  | { t: 'paths'; paths: string[] }
  | { t: 'peek'; paneId: string } | { t: 'closePeek' }
  | { t: 'reply'; paneId: string; text: string }
  | { t: 'answer'; paneId: string; choiceId: string }
  | { t: 'seen' } | { t: 'dismissToast'; id: string }
  | { t: 'speakUpdates'; on: boolean }
  | { t: 'tuck'; on: boolean }
  | { t: 'open'; maximised: boolean }

type RemoteKey =
  | { t: 'talkKey'; code: string; phase: 'down' | 'up' }
  | { t: 'otherKey' }
  | { t: 'summon' }
```

Reuse what the phone already does rather than new code: Stop = an ESC (`'\x1b'`) written to the pane (`web/src/components/SessionComposer.tsx:862-864`); new agent = the same action as Ctrl+T (the phone's `create-tab` layout op, `electron/layout-engine.ts:180`); answer choices = the phone's parser `web/src/lib/answer-options.ts` (`parsePrompt` :65, `parseScreen` :149, `readAsk` :360) and its key sequence (`answerKeys` / `sendAnswerKeys`, `web/src/components/AnswerCard.tsx:112-122`), written raw to the pane.

### 5.4 State and hand-off rules

- **One writer:** the host. The view keeps only its text box while typing (pushed as `setDraft`, debounced 250 ms) and UI-only state such as an open popover.
- **On minimise:** the host publishes full state with `draft` = the big bar's text and `target` = the big bar's target.
- **On restore:** the host writes the last draft into `barDraft`, so `Composer` shows it. The project, tab and target Steve picked in the mini bar stay picked, so the big window opens where he was working.
- **Heartbeat:** the host publishes on every change (throttled to 10 per second) and at least every 2 s. With no publish for 6 s, the view shows "Forge is not answering" and an Open Forge button. This covers a renderer crash or reload while minimised (builders and `web:build` do reload the live renderer). The renderer watchdog skips minimised windows (`electron/renderer-watchdog.ts:257`), so this state is the only signal.
- **Host remount:** main re-sends `minibar:mode` on the main window's `did-finish-load`; the host publishes at once.
- **Phone:** unchanged. Phone commands still run in the host; the mini bar sees their results through state.

### 5.5 Keys

**(a) Mini bar focused.** `MiniBarApp` holds capture-phase keydown and keyup listeners.
- It matches chords against `state.keymap` itself, so it can `preventDefault` (for example Ctrl+T), then sends `{ t:'command', id }`. Commands with scope `restore` restore Forge first, then run.
- For the two talk keys it forwards raw `talkKey` down/up (no repeats). For any other key pressed while a talk key is down, it sends `otherKey`, with no key identity.
- The host dispatches synthetic `KeyboardEvent`s into a private `EventTarget`, and `attachTalkKey` gets a second attachment on that target. The tap / hold / lone-modifier logic stays in one place (`src/lib/stt-gesture.ts`).

**(b) Another app focused.** `electron/global-keys.ts`:
- On only while the main window is minimised and `miniGlobalKeys` is on. Off the moment Forge is restored. Zero global hooking while Forge is up.
- Main drops every hook event while any Forge window is focused (`BrowserWindow.getFocusedWindow()`), so (a) and (b) never double-fire.
- Forwards: talk-key down/up (tracks down state to drop the OS auto-repeat), content-free `otherKey` while a talk key is held, and `summon`.
- Filters the AltGr fake Left Ctrl the same way `stt-gesture.ts:242-248` and `KeyRecorder.tsx:71` / `:107` do.
- Privacy rule: never read characters, never log key events, never buffer, never swallow a key. The hook sees every keystroke on the machine, so this rule is part of the review.
- Library: `uiohook-napi` (N-API, prebuilt for win32-x64). Its fit for our Electron and packaging is UNVERIFIED, so Phase 0 spikes it.
- **Fallback if the spike fails:** no hook. The summon key moves to Electron `globalShortcut` (registered on minimise, unregistered on restore; it swallows Ctrl+Shift+G from other apps while minimised). The talk keys then work only when the mini bar has focus.

### 5.6 Quit and the watchdog

- Today `before-quit` deletes the heartbeat, and the watchdog restarts Forge at once unless `watchdog.pause` holds a future expiry.
- The watchdog is separate from Forge: `scripts/watchdog.mjs`, run by a per-user Windows scheduled task that the "Keep Forge running" switch registers (`electron/watchdog-host.ts`). Friends have it only if they turn that switch on.
- Decided (D2, Steve 2026-10-08): the mini bar's X does not write `watchdog.pause` and does not call `pauseWatchdog`. It behaves like the main window's X. Steve needs Forge running whenever his PC is on, so the watchdog keeps bringing it back. Tray Quit keeps its 30-minute pause, unchanged.

### 5.7 Edge cases

- Minimise during a quit: no bar.
- No projects: the bar shows "Add a project" and Open Forge.
- Renderer reload or crash while minimised: "Forge is not answering", then it recovers on the host's first publish.
- Display unplugged, taskbar moved, DPI change: re-clamp on `screen` `display-added`, `display-removed` and `display-metrics-changed`.
- Full-screen video or game: the bar stays on top. Steve can drag it away. Auto-hide over full screen is listed under Later.
- Win+D: live test.
- Forge and Forge Dev both running: each has its own bar. Fine.
- Second launch or a .md double-click: restores the main window, so the bar hides.
- Native dialogs started from the mini bar (the file picker) are parented to the mini bar window, never to the minimised main window.
- Stale preload: the host must guard `window.forge.minibar?.` so a renderer on an old preload does not crash (an unguarded new `window.forge.X` once unmounted the renderer and stranded the phone).
- `requestAnimationFrame` may stop in a minimised window. The host uses timers, not rAF, for publishing and the send countdown.
- `document.hidden` while minimised is UNVERIFIED. No host logic may depend on it.

## 6. Build plan

| Phase | Who | What | Depends on |
|---|---|---|---|
| 0 | builder (spike, throwaway) | `uiohook-napi` with our Electron version: installs without a rebuild; works packaged (`asarUnpack` like node-pty); the AltGr sequence; Right Shift held while typing capitals; Windows Defender does not flag it. Output: go / no-go. | none |
| 1 | builder | Mini bar window, relay, host, state hand-off, project pill, agent chips, target, send, new agent, Stop, Open, X with inline confirm (no watchdog change), drag, bounds, resize, heartbeat. Lift `barSend` and `barDraft` out of `Composer`. | none |
| 2 | builder | Dictation sink, mic, Listen, the level meter, and keys when the mini bar is focused (5.5 a). | 1 |
| 3 | builder | Global keys (5.5 b) or the fallback. | 0, 2 |
| 4 | builder | Desktop shot card. | 1 (it shares the `main.ts` wiring; never edit `main.ts` in parallel with another job) |
| 5 | designer + builder | The wide bar's stage: toasts, Activity, Peek (with Reply and answer buttons), Chat panel, tuck pill, Open maximised. `pane-reply.ts` and `panes:lastReply`. A researcher first confirms where the phone's answer card gets its choices. | 1 |
| 6 | builder | The announcer: spoken updates, chimes, burst merge, the quiet queue, the Brain overlap rule, `say()` on the hub. | 2, 5 |

Phase 5's look is a design job: the designer sends Steve a screenshot of the bar, a toast, Peek and the pill before the builder wires it up (Steve cannot picture new UI from words).

Rules for every job (from past incidents):

- Work in a git worktree, with a private Vite `cacheDir`. Never junction `node_modules` for a packaged build.
- Never run `web:build` in the live checkout.
- Main-process changes need a Forge restart. Steve decides when, because a restart strands the phone for about 10 minutes.

## 7. Checks (lean)

- `npm run typecheck` and `npm run build`.
- One script, `scripts/minibar-check.mjs`, on a throwaway Forge (`--data-dir`, playwright-core):
  1. Minimise: a second window at `#minibar` is visible and always on top.
  2. Send `echo minibar-ok` to a shell pane from the bar: the text appears in the pane.
  3. Ctrl+Shift+PageDown in the bar: the project changes.
  4. Restore: the bar hides and the draft is kept.
  5. Put an image on the clipboard while minimised: a `#shotcard` window shows at the top right and is gone after about 10.5 s.
  6. Run `sleep 9; echo done` in a shell pane while minimised: a Done toast shows and an Activity row is added; clicking Peek shows the pane's last lines.
  7. X with a running pane: the confirm row shows. Quit: the process exits and no `watchdog.pause` file is written.
- A unit check for `src/state/announcer.ts`: templates, burst merge, the quiet queue, the 60 s drop, the Brain overlap rule.
- Live, by Steve: the talk keys from Chrome, AltGr, Win+D, two monitors, a full-screen video, the summon key from Chrome, spoken updates while minimised, answering an "Asking" prompt from Peek.

## 8. Decisions (Steve, 2026-10-08)

- **D1, keys outside Forge: A.** Dictate, Listen and the summon key work in any app; all other keys work when the mini bar has focus. (Rejected B: every Forge key everywhere, which would also fire in the app in front.)
- **D2, after X: the watchdog stays exactly as it is.** The X never pauses it. On Steve's PC Forge comes back by itself; on a PC without the watchdog switch, X leaves Forge closed.

## 9. Later (not in this spec)

- Model, effort and permission pickers in the bar.
- Auto-hide over full-screen apps.
- Show the bar, the shot card and spoken updates when Forge is only behind other windows, not minimised.
- Brain-worded summaries ("Jonah fixed the login bug and wants you to check the redirect") for every pane, not just the Brain's own. Costs a model turn per finish.
