# Handoff

## Agent bar: model + effort + mode picker and usage strip (2026-09-29, NOT committed, NOT restarted)

- **Asked (Steve):** a small button in the desktop agent bar to pick the pane's model (Sonnet 5.5 came out today) and effort; then a wider bar whose picker shows the current model, usage, and progress to plan limits; then "copy the voice agent picker, pop up, no sideways scroll".
- **Built:** `src/components/hub/ModelPicker.tsx/.css` (picker on BrainPicker's `.bpick` shell, root class `apick`; `UsageStrip` under the input row), `Composer.css` (bar `clamp(600px, 72vw, 1240px)`), one import + mounts in `Composer.tsx` (the `sendToPane` hunk there is another session's). Claude roster in `shared/agents.ts` is now Fable 5.1 / Opus 5.5 `[1m]` / Sonnet 5.5 / Haiku 4.5 by full id; Codex roster matches `codex debug models`. Usage plumbing: `electron/usage-hub.ts` (one copy of the two watchers, feeds the desktop window and Forge Web), `shared/usage-windows.ts`, `usage:snapshot`/`usage:frame` IPC in `preload.ts`, `src/lib/paneUsage.ts` (`usePaneUsage`, guarded, null until restart). `~/.claude/statusline.js` forge-status copy gained `model_name`, `effort`, `cost_usd`.
- **Why the old picker broke:** the global `.modelpick` class in `src/components/VoiceSurface.css:445` (inline-flex, 18px, overflow hidden) squashed it.
- **Windows shown are the real ones:** Claude 5-hour + Weekly; Codex on Steve's plan = Monthly (43200 min); API-key panes none. No invented daily/monthly.
- **Checked:** typecheck 0, lint:hooks 0, agent-bar:check 43/0, web:usage passes; designer viewed 1600 dark and 900 light with injected frames. Not viewed: a real Mode send, a Codex frame, widths below 900.
- **Open:** (1) usage needs one Forge restart (new preload + main); (2) the open menu is ~920px tall with usage, scrolls, clips the Bypass row: tighten; (3) Mode hides when the footer shows no mode (Claude default), so J2a could return an explicit `'default'`; (4) `getPath('downloads')` in `electron/browser-panes/ipc.ts:37`, `chat-panes/views.ts:141`, `phone-mirror.ts:179` can abort IPC registration when USERPROFILE is odd; (5) at 900px the top bar overlaps "New" with the Agents/Browser tabs (parallel session's TitleBar/DeckBar edits).

## Dictation is obvious: the bar's edge is a live synthesizer (2026-09-29, pushed cf3550f)

- **Asked (Steve):** he could not see that he was dictating (only the mic button changed). Wanted the whole agent bar to change colour, a "Listening" word, and the outer edge to synthesize with his voice; then turned down, smoother (no "hair-like" bristles), and a lesser version for agent voice mode.
- **Built (designer agent, verified by typecheck 0, lint:hooks 0, headless screenshots; NOT seen with a real mic):** `src/components/DictationEdge.tsx` (canvas ribbon round the bar, levels smoothed at 120 Hz), `DictationCue.tsx` (decides where the one cue shows: bar first; pane frame/strip and top band only with no bar), `DictationCueView.tsx`, `DictationCue.css` (tokens), `Composer.tsx/.css` (`data-mic`, `data-edge`, chip, review store), `DictateButton.css`, `SynthesizerIndicator.tsx` (bar size props), `barDictation.ts` (cue stores). Dictation = indigo to violet (dark `#6d7bff`/`#a58bff`/`#d3c4ff`); agent voice = lime, half height, slower. Blue vs yellow is the axis Steve's colour vision keeps (checked under deuteranopia and protanopia).
- **Rules to keep:** one animated cue at a time; reach ~8 px and glow low so controls near the bar stay usable; every state has a word and a shape. The impeccable hook flags `var(--spring-glide)` as bounce: false positive (the curve never passes 1), left as is; Steve was asked whether to add the ignore and has not answered.
- **"Sent" flash (same day):** when Enter goes into a pane (`terminalHost.submit` calls `announcePaneSent`, `src/lib/paneSent.ts`), a comet spins once round that pane's edge (and its Wall tile) in ~0.76 s, lime if the agent sent it, else violet. Pure CSS on one pseudo-element via a `data-sent` attribute; nothing runs between sends (Steve asked for it cheap). Not measured for CPU/memory, not seen live.
- **Open:** the agent-mode stop button is still violet (offered "fix the button"); reduced-motion ring, frame rate and the no-bar pane fallback are unchecked.

## Dictate key now sends (2026-09-29, pushed 4929c41)

- **Asked (Steve):** dictating into a terminal did not press Enter; he pressed it by hand. Cause: a key dictation stopped by the key stayed raw by design (a002704); only the bar's mic button sent.
- **Fix:** `startDictation` (`src/hooks/useDictation.ts`) arms `keyWantsSend`; once the mic listens, `keyDictationSendsOnEnd` goes on; the phase-idle effect calls the bar's `sendKeyWords` (countdown "Sending… 1.5 s", Undo/Esc, then `terminalHost.submit`). Skipped when `dictateAutoSend` (Enter per phrase) is on. typecheck 0, lint:hooks 0. Not tried live.
- **Stale comments left:** `Composer.tsx:50`, `HubLayer.tsx:31`, `settings/VoiceKeys.tsx:12`, `useDictation.ts:68` still say the key is "raw".

## Share link: caller placed by pane id (2026-09-29, pushed b59842d, Forge NOT restarted)

- **Found while testing the chat tools:** five panes all launched as "Claude Code" in one folder made `caller()` (`electron/share-link.ts`) return null, so `pane_send`, `pane_read`, `chat_ask` and `chat_answer` all failed with `Forge does not know a pane called "Claude Code"`. `share_panes` hid it by falling back to `panes.json`. Renaming a tab does not help: `launchTitle` never changes.
- **Fix:** the bridge sends `paneId` (`FORGE_PANE_ID`); `caller()` matches it first. Field in `shared/share.ts`. Checks: share-link-check 93/0, share-check 307/0, chat-relay-check 85/0, typecheck 0. `bridge:build` run, `bridge:install` was a no-op (config points at `bridge/`).
- **To do:** restart Forge (main changed), start a fresh agent pane, then try `chat_ask` for real (banner, Copy and open, Send answer). Not committed.

## Top-left buttons redesigned; pane and project shortcuts; chat relay built (2026-09-29, pushed to master 0a8eb3b, Forge NOT restarted)

- **Asked (Steve):** (1) Forge talks to its three built-in chatbots (ChatGPT, Gemini, Claude tabs); (2) redesign Wall / New / Freeform / Full screen; (3) a shortcut that lists every pane in the project.
- **Shortcut:** already exists. `Ctrl+Shift+E` opens the "every pane" sheet (`toggle-panes-switcher`, `src/lib/uiCommands.ts:70`; 1-9 jump, Enter opens). Nothing built. Free combos if he wants another: Ctrl+Shift+A/L/P, Ctrl+P, Ctrl+Space.
- **Built:** the top-left group is one tray (`.deckbar__agents` in `src/components/shell/DeckBar.css`). The Wall switch (`WallSwitch`, `TitleBar.tsx`) shows both words, "Wall" and "Full screen", with a lit capsule on the current view; over the browser or board neither is lit. Grid | Free and Fit were then REMOVED from the bar at Steve's request (they stay in the … menu's Tools, `TerminalGrid.tsx:214`; `WallLayoutControls` and the `.deckbar__wallmode` / `.deckbar__fit` CSS are gone). Agents tooltip reads the live key from the keymap. Behaviour, `data-new-agent` and the New anchor are unchanged.
- **Checked:** typecheck 0, lint:hooks 0 warnings, a refuter re-ran both and read the diff (HOLDS). Only a headless mock render was seen; the real app was not driven. Steve has not looked at it yet.
- **Left alone:** the Forge Web copy in `web/src/deck/DeckTopBar.tsx` (`dk-wall`, `dk-new`) now looks different from the desktop.
- **Projects shortcut:** `Ctrl+Shift+P` (new) toggles the all-projects pop-up (`toggle-project-sheet`, `defaultKey` in `src/lib/uiCommands.ts`). `Ctrl+Shift+B` (`rail.toggle`) already did the same; it is now titled "All projects (pop-up, old rail key)" in `shortcutCommands.ts`. Neither works with focus inside a chat page (the page swallows keys). canvas:check 145/145.
- **Chat relay (Steve chose option 1, the clipboard relay, over automation):** agent calls MCP `chat_ask({bot,message})` then polls `chat_answer` (waits ~45 s per call; states waiting/answered/dismissed/expired/none). Steve sees a banner under the top bar (`src/components/shell/ChatRelayBar.tsx`): [Copy and open <bot>] then [Send answer to <agent>]; nothing is copied or switched before he presses. Main reads the clipboard only on that button. Answer comes back wrapped as untrusted text. Logic in `electron/chat-relay.ts` (Electron-free, injected deps), wired in `electron/pty-host.ts`, ops in `shared/share.ts`, tools in `bridge/share-bridge.mjs`. Nothing reads, types into or scripts a chat page (grep-checked). Checks: chat-relay-check 85/0, share-link-check 90/0, share-check 307/0, typecheck 0, lint:hooks 0; a refuter re-ran all (HOLDS).
- **Chat relay, to do:** (a) it is NOT live until Forge restarts (main + preload changed; restart strands the phone ~10 min, so pick a moment); (b) agents pick up the new tools only after `npm run bridge:build` and `npm run bridge:install` (not run) and a fresh agent session; (c) no shortcut for the banner buttons: chat views forward no keys (`before-input-event` not wired); (d) not on Forge Web / phone; (e) real end-to-end with ChatGPT/Gemini/Claude untested.
- **Tree:** other files in `git status` (usage hub, model picker, Composer) belong to a parallel session; do not commit them with this.

## Dictate key + mic button, and the bar aims at the pane by default (2026-09-28, pushed to master)

- **Asked (Steve):** start dictation with the Dictate key (now Right Shift; Right Alt is the Agent key, his swap), stop it with the bar's mic button, and it should send. Also: the bar's target chip should default to the terminal, with Forge one click away.
- **Built:** the press that stops decides. Key start + mic-button stop → "Sending… 1.5 s" with Undo/Esc, then Enter in the pane the words were typed into, or the bar's send if they landed in the bar (`src/lib/barDictation.ts` landing + send-on-end flag, `useDictation.ts` phase effect, `Composer.tsx` pane review). Key start + key stop stays raw. No second Enter when `dictateAutoSend` is on. `barMode.ts` target now defaults to `pane`; Esc in the bar on Forge comes back to the pane; placeholder and chip titles say so.
- **Checked:** typecheck 0, lint:hooks 0 warnings, agent-bar-check 43/0, dictation:check 31/0. Steve confirmed key start + button stop sends when the chip is on the pane.
- **Open:** the bar's own send into a Claude pane still sometimes leaves the words on the prompt without the Enter (whole message typed in one chunk; the echo-wait in `sendToPane`, d40f619, did not cure it). Being debugged against a real Claude CLI.

## Desktop bar mic works like the phone's mic (2026-09-28, pushed to master)

- **Asked (Steve):** the bar's dictation button did not put the words in the input or send them. Wanted it like the phone: dictate, press, it holds, then sends.
- **Built:** `src/lib/barDictation.ts` (new) marks a dictation the bar's mic started; `useDictation.ts` gives the button its own start (`dictateIntoBar`) and routes that session's phrases to the bar, ending it when the sidecar is back at idle. `Composer.tsx` puts the words in the bar, shows "Sending… 1.5 s" with Undo (Esc undoes, and never reaches the pane), then sends as Enter. Undo keeps the words to edit. Right Alt stays raw dictation into the focused pane. Listen unchanged. Same desktop speech engine.
- **Checked:** typecheck 0, lint:hooks 0 warnings, agent-bar-check 43/0, dictation:check 31/0. Steve tested live.
- **Left out:** the phone's spoken commands ("stop", "yes", "option two", "next tab").
- **Follow-up, Enter lost now and then:** the bar typed the words, waited a fixed 70 ms, then pressed Enter; Claude Code takes a long line as a paste and swallowed an Enter that came mid-paste, so the words sat on the prompt. `sendToPane` in `Composer.tsx` now waits for the pane's echo plus 150 ms of quiet (`terminalHost.readiness`), 1.5 s at most, then presses Enter. Typecheck and lint clean; pushed on Steve's say-so, not yet confirmed live.

## Phone Listen dead after a drop (2026-09-28)

- **Asked (Steve):** the agent (Listen) button on the phone works, then drops, then a tap does nothing. Dictation still works.
- **Cause:** `web/src/deck/voiceAgent.ts` `onState`: when a live session ended by itself (Claude's `fail()` on a lost `events` long-poll, e.g. the phone socket blinking), the phase went to `error` but `session` still held the dead session. `toggleWebVoice` → `startWebVoice` returns at once while `session` is set, so every later tap was a no-op until a reload or an agent switch.
- **Fix:** `closed` (not rolling) tears down and goes `off`; `error` goes through `fail()`, which tears down. The next tap opens a new session. Same module drives the laptop deck's voice bar, so it is fixed there too.
- **Checked:** webclient typecheck 0, voice-alerts:check 35/0. Not tried on the phone. No web:build here (it reloads the live renderer).

## Top bar: settings cog icon and theme background color (2026-09-28, pushed to master)

- **Asked (Steve):** Change the settings icon in the top right from three dots to a cog icon, and change the background color of the top panel to match the blue color of the Forge app.
- **Built:**
  1. `src/components/Icon.tsx`: Added `'cog'` as an alias to `gear` in `IconName` and `PATHS`.
  2. `src/components/TitleBar.tsx` & `web/src/deck/DeckTopBar.tsx`: Swapped `<Icon name="dots" size={16} />` for `<Icon name="cog" size={16} />` on the top-right settings/menu trigger button.
  3. `src/components/shell/DeckBar.css` & `web/src/deck/DeckTopBar.css`: Set `.deckbar` and `.dk-bar` background to `var(--bg-base)` with `border-bottom: 1px solid var(--line-hairline)`, matching the theme background color (`#080d14` in the active Ice theme) and seamlessly blending into the Windows native titlebar overlay controls.
  4. `electron/browser-panes/manager.ts` & `scripts/web-check.mjs`: Added trusted chatbot audio permission bypass (`isTrustedChatbotAudio`) for ChatGPT, Gemini, and Claude in browser/chat panes to allow in-page dictation without permission prompts, and mocked `WebContentsView` in web checks.
- **Checked:** `npm run typecheck` (0 errors), `node scripts/theme-check.mjs` (50/50 passed), `node scripts/layout-engine-check.mjs` (70/70 passed), `node scripts/web-check.mjs` (passed).

## Wall: Grid and Free layout switch uses smaller icons without text (2026-09-28, pushed to master)

- **Asked (Steve):** In wall view, grid and free need just to be smaller icons not text, simple change.
- **Built:**
  1. `src/components/MosaicView.tsx`: Removed text labels from `WallLayoutSwitch` buttons, retaining `aria-label` for screen reader accessibility; sized SVG glyphs to 11×11.
  2. `src/components/shell/DeckBar.css`: Styled `.deckbar__wallmode .wallmode__btn` as 26×26px squares with centered icons to fit seamlessly into the title bar pill without text styling.
  3. `src/components/MosaicView.css`: Centered button icons and removed text font rules.
- **Checked:** `npm run typecheck` (0 errors), `npm run lint:hooks` (0 warnings), `node scripts/mosaic-check.mjs` (113/0 passed).

## Voice picker short list (2026-09-28)

- **Asked (Steve):** the desktop voice picker shows every agent. Default to GPT Live, Gemini Live, and Claude. More in the popout shows the rest. Change who is on that list, and the order, in Settings.
- **Built:** `voiceMenu` on Settings. Default order is GPT Realtime (`gpt-realtime`, not the mini), Gemini Live, Claude, then the other six behind More. The brain in use stays on the short list. Settings → Voice & Agent → Voice menu: tick, Up, Down, Reset. Phone, web, and watch pickers unchanged.
- **Checked:** typecheck 0, lint:hooks 0, agent-bar:check 43/0. Not seen on screen.
- **Needs:** a Forge restart. The menu is saved in the main process. A window reload alone shows the three, but a custom order will not stick until restart.

## Top bar: branch/project picker next to settings; prominent image notifications (2026-09-28, pushed to master)

- **Asked (Steve):** Move the branch picker to the right hand side next to settings, agents wall new to the left, and when we put and paste an image make the notification a little more noticeable.
- **Built:**
  1. **Top bar layout (`src/components/TitleBar.tsx`, `src/components/shell/DeckBar.css`):** Moved `ProjectChip` (project folder, name, git branch, chevron) to `deckbar__right` immediately preceding `DeckMenu` ("..."), leaving `AgentControls` (Agents menu, Wall switch, New button, WallLayoutControls) on the left beside the Forge wordmark. Updated `deckbar__right` gap to 6px and zeroed project chip margin for clean spacing.
  2. **Image put & paste notifications (`src/components/ScreenshotTray.tsx`, `src/components/ScreenshotTray.css`, `src/components/shell/Shell.css`, `src/components/TitleBar.tsx`):**
     - Clicking a thumbnail in the shelf to put and paste its quoted path into the terminal now announces globally via `actions.setNotice()` in addition to the in-shelf toast, ensuring the notice is seen even if the menu closes or the terminal takes focus.
     - `ScreenshotTray.css`: Upgraded `.tray__toast` styling with semi-bold typography, glowing accent diamond mark (`.tray__toast-mark`), accent border, and `--accent-glow` box shadow. Increased toast display duration from 2.2s to 3.5s.
     - `Shell.css`: Enhanced `.dtoast` with an accent-tinted border, glowing box shadow, and larger glowing accent diamond.
     - `TitleBar.tsx`: Fresh screenshot capture from the OS now announces itself with a global notice via `actions.setNotice('Screenshot captured')`.
- **Checked:** `npm run typecheck` (0 errors across node, web, mobile, webclient). Fast test suite 49/50 passed (only `web:check` skipped due to electron export stub in node env).

## Chat tabs: ChatGPT, Gemini, Claude websites as tabs (2026-09-28, pushed to master)

- **Asked (Steve):** free web chatbots inside Forge so the data is in one place. Must look like a chatbot, not a CLI. Chats sit beside the CLI tabs and count toward the 9 tabs. Tab colour = brand: Claude orange, Gemini multicolour, ChatGPT white. Logins in Settings. Must work from the phone.
- **Built (foreman + 3 builders in worktrees `.claude/worktrees/chat-panes|chat-desktop|chat-phone`, merged at bb305ad on branch chat-panes, patch applied here):** new layout node `ChatLeaf {type:'chat', id, bot, title}` (a chat tab's root, never in a split) and `newChatTab` layout op; `shared/chatbots.ts` (URLs, colours, sign-in cookie names, composer selectors — best-known values, not verified live). Desktop: `electron/chat-panes/{views,signin,ipc}.ts` (WebContentsView per chat, partition `persist:forge-browser`, same as the browser), `src/components/ChatPane.tsx` (brand bar: logo, "Claude · Chat", sign-in word, Back/Reload/Home), Wall tiles, "Chatbots" group in New and Agents menus, Settings → Chatbots card (status, Sign in, Sign out). Phone: `electron/chat-panes/phone-mirror.ts` makes an offscreen, phone-sized copy per watching phone; JPEG frames over the Forge Web socket (`shared/chat-mirror.ts`), taps/scroll/text back via sendInputEvent; `web/src/components/ChatMirror.tsx` + brand tabs + web "Chatbots" menus. Gaffer added `prepareBrowserSession()` so chat views get the browser's no-permission-prompts policy.
- **Checked:** typecheck 0, lint:hooks 0, electron-vite build, scratch web build, layout-engine:check 70/0, mosaic:check 113/0, chat-mirror-check 42/0. Screenshots in the session scratchpad `chat-desktop/`.
- **Pushed (Steve picked it, 2026-09-28):** the desktop already ran this code, so it sent a chat tab to the live phone page, which crashed in `collectLeaves` (`Cannot read properties of undefined (reading 'type')`: a chat root read as a split). The push redeploys Forge Web with the chat-aware walkers; reload the phone. **Forge Mobile (native app) has the same crash** (`leavesOf` in `mobile/src/components/Browser.tsx`) until a manual `npm run apk:build -- --bump && npm run apk:release`.
- **Forge Mobile chat tabs (ed0f1ea, pushed):** the mobile socket (`electron/mobile/server.ts`) now serves the same chat mirror; one shared host (`sharedChatMirrorHost()` in `phone-mirror.ts`) for both sockets, mobile mirrors keyed `phone:<deviceId>`; `hello-ok.features` advertises `CHAT_MIRROR_FEATURE` and the app hides chat rows / the Chatbots group without it. App: `mobile/src/components/ChatMirror.tsx`, chat rows in Browser, Chatbots group in NewTab. `scripts/mobile-smoke.mjs` has chat checks. Needs a Forge restart (main) and an APK release to reach the phone. TV still hides chat tabs. Known: stopping Forge Web (`disposeChatMirrors`) also ends a Forge Mobile phone's chat mirrors.
- **Full screen arrows step into chat tabs (07a7677, pushed):** `src/lib/paneStops.ts` builds one stop list (a chat tab = one stop, a terminal tab = each pane); `pane.prev/next` (paddles and Ctrl+PageUp/PageDown) use it. `useChatPlacement` trims the chat page 8px clear of `.pcar__btn`. Not seen live. Ctrl+PageUp/PageDown do nothing while the keyboard is inside the chat page (chat views do not pass keys back like `browser-panes/manager.ts:422` does) — needs an electron/ change.
- **CLIs and chat tabs:** the bridge cannot see or type into a chat tab. A CLI can `browser_open` the same site in its own tab (same `persist:forge-browser` logins).
- **Not built / not seen live:** WallStrip skips chat tabs; phone Wall shows a still ChatTile; scroll direction, offscreen focus, and composer selectors untested on the real sites. A fresh session gets a Cloudflare "Verify you are human" on claude.ai (a click passes it).

## Project picker ordering reflects active/working projects on mobile and web (2026-09-28)

- **Asked (Steve):** In Forge mobile browser, the order of the projects needs to reflect projects that are active like desktop app. When projects are being worked on they need to appear at the top of the list.
- **Root Cause:**
  1. `web/src/components/ProjectSheet.tsx` rendered projects without sorting, leaving them in static array insertion order regardless of active or working state.
  2. The desktop previously only pushed attention frames (`state.asking`) to web clients, not active background execution (`busy`).
- **Built:**
  1. **IPC & Web Protocol (`shared/ipc.ts`, `shared/api.ts`, `electron/preload.ts`, `shared/web.ts`):** Added `webBusy: 'web:busy'` channel and `WebBusyFrame` (`{ type: 'busy', sessionId, busy }`).
  2. **Desktop PTY to Web (`src/lib/terminals.ts`, `electron/web-host.ts`, `electron/web/server.ts`):** Forwarded terminal `setBusy` state transitions to the web host, tracking `busyNow` set on the web server and broadcasting to connected web clients with replay on hello-ok.
  3. **Web Client & State (`web/src/lib/client.ts`, `web/src/state.tsx`):** Added `onBusy` handler and `busy: Set<string>` to `ForgeState`.
  4. **Project Sheet (`web/src/components/ProjectSheet.tsx`, `ProjectSheet.css`):** Wired `sortProjectsForPicker` using active (`project.id === state.projectId`), working (checks `asking`, `busy`, and Foreman), open, and pinned. Added row attributes `data-working`, `data-attention`, `data-pinned`, pulsating dot glow animation for working projects, and pin icon.
  5. **Web Rail & Mobile App (`web/src/components/Rail.tsx`, `web/src/styles.css`, `mobile/src/components/Browser.tsx`):** Updated `Rail.tsx` working fact to inspect `state.busy` and Foreman alongside `asking`; updated `Browser.tsx` to sort by active project and Foreman working state.
- **Checked:** `npm run typecheck` (0 errors across node, web, mobile, webclient), `npm run lint:hooks` (0 warnings), `npm run rail:check` (63/63 passed), `npm test` (50/50 checks passed).

## Remember this phone: 7-day unlock ticket (2026-09-27, 5f4373c, pushed, LIVE)

- **Asked (Steve):** picked option 1 below. 7 days is my default; Steve did not name a number.
- **Built (builder in a worktree, patch applied here, left unstaged):** every unlock with a PIN set (PIN, passkey or ticket) now earns a single-use ticket. A spent ticket always has passkey rights, so it can never enrol a passkey. The desktop keeps digests only, in `web-remembered.json` in the data dir. A ticket expires `RESUME_IDLE_MS` (7 d) after its socket closes. On load, open entries get closedAt = load time. A PIN change voids all. Eviction: 8 per phone, 256 in total, oldest first. `rememberedList/Forget/ForgetAll` on `WebAuth`, 3 IPC channels (optional in ForgeApi), and a "Remembered phones" block in the Settings "Getting in" card (`WebSection.tsx`, all calls use `?.`). Client: `localStorage['forge-web-remembered']` (fixed key; the client never sees the uid), read fresh at every hello, dropped on a refusal, cleared on sign-out; the 30 s drop is gone. `PASSKEY_RESUME_MS` renamed.
- **Checked:** typecheck (all configs) 0, lint:hooks, web:auth 100/0, web:passkey 81/0, scratch vite build. The foreman re-ran all of them.
- **Live:** Forge restarted 2026-09-27 22:25 at Steve's request. dev.log shows `"Chrome on Android" admitted ... with a remembered-phone ticket`. CI (Checks, Forge Web, Publish Forge) green. Settings list not yet looked at on screen.

## Phone keeps asking to unlock after sleep (2026-09-27 21:10, read-only)

- **Asked (Steve):** phone browser logs out too often after screen-off or leaving the app; find why and list fixes.
- **Found:** the Google (Firebase) session is NOT lost: `localStorage['forge-web-auth']`, no expiry (`web/src/lib/auth.ts:25`). What returns is the desktop PIN gate. The PIN is never stored: RAM only, 10 min grace (`PIN_GRACE_MS`, `shared/web.ts:605`; `web/src/lib/client.ts:757-913`), wiped on reload, tab kill or >10 min hidden. The passkey resume ticket lasts 30 s after the socket closes (`PASSKEY_RESUME_MS`, `shared/web.ts:625`), RAM-only on both sides (`electron/web/auth.ts:535`), lost on desktop restart. A PIN unlock gets no resume ticket at all (`auth.ts:683-685`). By design: "There is no 'remember this desktop.'" (`shared/web.ts:838-846`).
- **Log:** all 38 recent refusals are `pin-required`, each followed by `"Chrome on Android" admitted ... with a passkey`, so each return costs a fingerprint.
- **Options put to Steve:** (1) "Remember this phone": a signed device ticket issued after PIN/passkey, kept in localStorage and on the desktop disk, bound to uid + deviceId + page origin, rotated on use, idle expiry, voided on PIN change, revocable from the desktop. (2) Stretch the timers: resume 30 s -> ~15 min, PIN grace 10 min -> longer, give PIN unlocks a ticket, keep it in sessionStorage. Does not survive a desktop restart. Recommended (1). Waiting on his pick.

## Phone Listen capsule finished; phone tap targets ≥ 44px (2026-09-27 17:30, pushed)

- **Asked (Steve):** continue Tomas's paused work: phone tap targets ≥ 44px, fix SynthesizerIndicator and PhoneListen.css. Scope: web/src/components, web/src/deck.
- **Root cause of 121 web type errors:** `import type { HubLook } from hubView` pulled `VoiceHubController` and the whole desktop renderer into `tsconfig.webclient.json`. `HubLook` now lives in `src/components/hub/hubLook.ts` (no imports); hubView re-exports it.
- **Listen capsule (`web/src/components/PhoneListen.{tsx,css}`):** Tomas's direction kept (mic + synth left, agent chip + chevron right; the chevron replaces long-press). Both buttons 44 px tall (mic 60×44, agent 48×44). Blocked uses `aria-disabled`, so a tap still says why. ON = mic filled with ink (not hue only); error/blocked = dashed rim. Legacy `.plisten` block CSS, `ListenGlyph`, hold code removed. Picker subtitle now says "Tap the chevron by Listen".
- **SynthesizerIndicator:** canvas sized in first paint; static looks redraw on `transitionend` (was stuck in the old lime); one cached `getComputedStyle`; reduced motion shows dots when off (was same as on).
- **Tap targets:** audit at the session scratchpad `tap-targets-audit.md` (61 OK, 10 FIX). Fixes under `pointer: coarse` or `.app[data-mobile]` in AnswerCard, ChatView, LiveFiles, Sheets.phone, ProjectSheet, Mirror CSS. Desktop look unchanged.
- **Checked:** `npm run typecheck` 0 errors, webclient 0 (was 121), lint:hooks, scratch vite build. Harness at 390×844 measured the capsule. Not tried on a real phone.
- **Open:** (1) Deck on a finger tablet has ~20 targets under 44 (tile buttons 22×20) — Deck is never shown on a phone (`Workspace.tsx:70`); needs a decision. (2) `.mchip` can shrink under 44 wide at 360–390 px; terminal keys 39 px wide under 360 px. (3) 7 small targets in `web/src/styles.css`, listed in the audit, not changed. (4) Tomas's own edits in `web/src/lib/term.ts` and `web/src/styles.css` (sticky tab strip, blur composer on terminal touch) were pushed as he had them, at Steve's choice; nobody reviewed them.

## Wall tile scroll bar; paperclip on every pane bar (2026-09-27 14:30, pushed)

- **Scroll bar:** "can't scroll in the Wall" meant "there is no scroll bar". Steve is on a laptop touchpad, and two-finger scroll already worked. xterm's own bar is on the terminal's far right, which a life-size tile crops off. New `TileScrollbar` in `MosaicView.tsx` (+ `.mtile__scroll` CSS) draws a slim bar inside the right resize edge. It shows only while there is history. Drag the thumb, press the track to jump, or use the wheel over it. It never starts typing. `terminalHost.scrollInfo / watchScroll / scrollToLine` feed it. Checked: typecheck, throwaway test (drag to top → viewportY 0, track middle → 181/362, wheel on bar moves, tile stays not-typing).
- A page reload at 13:51 did NOT fix anything, so the stale-renderer idea was wrong.
- **Paperclip:** new `src/components/AttachButton.tsx`, a small (12/13 px) paperclip on every Wall tile bar (beside Expand, always shown) and in the Full screen pane actions. It opens the file box, and the picked paths go in as a quoted paste, exactly like a file drop (`filePaths` in `src/lib/paths.ts`; `onAttach` in MosaicView and TerminalPane). Checked: typecheck, throwaway test (path typed into the tile, tile switched to typing).

## Phone: Listen (voice agent) + spoken pane alerts (2026-09-27, a5659ff, pushed)

- **Asked (Steve):** voice agents on the phone, to relay what the agents are doing. Picked option 1 (web page, not a native app). This reverses the 23 Sep decision D (no spoken replies on the phone) for Listen only.
- **Built (web only, no desktop restart):** `web/src/components/PhoneListen.{tsx,css}`, a Listen control left of the phone text box, mounted from `SessionComposer.tsx` (phone face only; `Composer.tsx` got `listen`/`listenLine` props). While live, the text box shows the state word, the agent and a caption. The agent picker opens from the chevron. `web/src/deck/voice-alerts.ts` + `voiceAgent.ts`: alerts are read from `voice-context` text polls (5 s), every brain. DONE = working then ready/idle on 2 polls. ASKING is sent at once. Alerts coalesce and are spoken only while listening (realtime `sendContext(note, true)`, Claude `sendText`). Idle hold while any pane works (cap 20 min). Screen wake lock while live.
- **Checked:** typecheck, lint:hooks, voice-alerts:check 35/0 (fast lane), realtime:check 28, dictation:check 31, scratch vite build. Screenshots are in the session scratchpad `phone-listen/`.
- **Not tested:** anything live: alerts on each brain, the wake lock on the Pixel, and the navigator and mic hold against a real desktop.
- **Limits:** alerts cover the open project only, and only while Listen is on (Web Push covers the rest). The Listen UI hides on a project with no tabs (SessionComposer returns null). Glyph/AgentMark SVGs are copied from `web/src/deck/VoiceBar.tsx` and could be shared later.

## Panes and tiles stop re-rendering on unrelated changes (2026-09-27, pushed)

- **Asked (Steve):** plan B of the audit below ("the big fix"). Rule from Steve: terminals must still refit on every size change (small screens).
- **Found first:** PTY output never dispatches, and nothing dispatches per second. Re-renders came from user gestures times the number of tiles, so the targeted fix (panes/tiles only, 9 files) replaced the planned 80-file split. The other ~110 `useApp()` sites are unchanged and still re-render as before.
- **Built (builder, in worktree `.claude/worktrees/appstate-split`, patch applied to this checkout):** `AppState.tsx` has a subscribe/getSnapshot store plus `useActions()` (stable for the provider's lifetime; every action reads `liveStateRef`, which also fixes `openToolPane`'s stale `updatesAutoRun`), `useAppSelector(selector, isEqual)`, `shallowEqual`; the six helper hooks use selectors; `useApp()` unchanged. `MosaicTile`, `TerminalPane`, `SplitView`, `TerminalGrid`, `StripTile` memo'd with stable props (`src/hooks/useStableCallback.ts`). `useHandoffFlow` hands out a stable `handOff`.
- **Checked:** typecheck, lint:hooks, mosaic:check 113, electron-vite build. Throwaway Forge, Wall with 4 tiles: rail toggle 0 tiles re-render, unrelated setting 0, rename a tab 1 (only that tile). Cols follow width: 96 at 1500px, 55 at 900px, 91 in Full screen.
- **Known:** in `mosaicText:'scaled'` (not the default, not Steve's setting) the wall reference re-measures only when the set of panes changes, so a scale can go stale after a geometry change. Applying the patch hot-reloaded the live renderer; it threw once mid-HMR ("useApp must be used inside <AppStateProvider>", two module copies) and the watchdog reload fixed it.

## Performance audit (2026-09-27, read-only, nothing built)

- **Asked (Steve):** where can Forge be optimised. Four read-only agents (main, renderer, Forge Web, startup).
- **Quick wins (S effort):** `perMessageDeflate` is off on the Forge Web socket (`electron/web/server.ts:981`); every PTY chunk is its own JSON frame to the phone (`server.ts:1097`, `:3486`); pane create runs `execFileSync('git')` up to 1.5 s (`electron/pty-host.ts:872` -> `git-remote.ts:42`) and a sync PATH walk (`pty-host.ts:820`, `which.ts:44`) on the main thread; `syncAgyConfig` does `spawnSync('agy')` (10 s timeout) before `createWindow` (`electron/bridge/share-mcp.ts:463`, `main.ts:1427-1568`); `qrcode` and web `Mirror` are static imports.
- **Medium:** replay buffer rebuilds a 192 KB string per raw chunk (`pty-host.ts:263`, `:270` reduce); no code splitting (desktop 2.48 MB, web 1.49 MB single chunks).
- **Big:** one AppState context (`src/state/AppState.tsx:2531`) read at 121 sites; no `memo` on `TerminalPane`, so any dispatch re-renders every pane.
- **Not Forge:** the `playwright@claude-plugins-official` plugin in Steve's user Claude config starts ~200 MB of npx/node per Claude session; forge-bridge already has a browser. gemini-bridge + share-bridge are kept apart on purpose (key isolation, `bridge/share-bridge.mjs:20`).
- **Built (quick wins, not committed):** deflate on the web socket (level 1, threshold 1 KB); `gitRemoteOrigin` 30 s per-folder cache (still sync); `whichCommand` caches hits only; replay/deskLog trim amortized at 1.5x with a byte counter (`trimReplay`, readers trim first); `syncAgyConfig` async + serialized, not awaited at boot or on settings change (`agy mcp list` measured 1.5 s); `qrcode` and web `Mirror` lazy (Mirror chunk 38 kB). Web batching dropped: pty-host already batches every 12 ms.
- **Checked:** typecheck, lint:hooks, web:io, pty:smoke, share:check 307/0, agents:check, gh:check, replay-trim equivalence script (old vs new identical, 32 cases).
- **Needs:** a Forge restart for the main-process parts. Next big item: the AppState split.

## Gemini Live / GPT voice "can't reach it" (2026-09-27 08:09)

- Both failed at the token mint in main (`electron/realtime/tokens.ts`), `ws=none`. At the same minute dev.log shows cloudflared "no recent network activity" and web-push `ECONNRESET`: the PC's network dropped. At 08:12 both token endpoints answered in <700 ms x10 from Node. The hub shows only "can't reach it"; the raw error is not logged.
- **Cause: NordVPN (NordLynx) was connected.** The phone also showed "laptop asleep" at once. Steve turned the VPN off: the phone connected, and Gemini Live opened at 08:27 (setupComplete 714 ms, mic 16 kHz flowing). No code change.

## Project picker: in-use projects first (2026-09-26, not committed)

- **Asked (Steve):** projects you are working in, and any project in use, should come to the top of the picker.
- **Built:** `shared/project-order.ts`. Order is draw-only (saved order is not rewritten): pinned projects stay the top block, then the project you are in, then one that is working or waiting, then one with panes open, then the rest. Pinned rows use a stronger tint (`ProjectRail.css`). Web rail and the phone list use the same order. Web has no "still printing" signal, so there "working" means a pane is waiting on you.
- **Checked:** `npm run rail:check`. Not looked at on screen.

## Forge Watch UI rebuilt in Compose for Wear (2026-09-25, not committed)

- **Asked (Steve):** watch app "not up to scratch"; basic, small, voice. Problem picked: looks bad / too big. Chose Compose for Wear over tidying the Views.
- **Built (designer):** `watch/app/.../{WatchTheme,VoiceScreen,PickerScreen,SettingsScreen}.kt`; the three activities now `setContent`. Voice screen: curved status on the top rim, one round mic with state word on the bottom rim (LISTENING etc., shape differs per state), Send N only with a draft. XML layouts and old drawables deleted. Kotlin 1.9.25 -> 2.0.21 + compose plugin, wear compose-material3 1.5.6. Voice/link logic, manifest and `:watchface` untouched.
- **Checked:** `./gradlew assembleDebug`, `:app:testDebugUnitTest` (VoiceCommands 10/10). Screenshots: `./gradlew :app:testDebugUnitTest -Pforge.shots=<dir>` (Roborazzi, 12 shots, round 384px).
- **Needs:** install on the Pixel Watch 2 (`adb connect 192.168.4.46:<port>`, then `adb -s <ip:port> install -r watch/app/build/outputs/apk/debug/app-debug.apk`). Not seen on hardware.

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
