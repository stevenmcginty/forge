# Forge — what's next

State as of 2026-07-30 night: **everything built today is merged and running.** Terminals, projects,
mosaic + freeform wall, screenshot tray, dictation (Parakeet), the voice agent (round button, Gemini
brain on your free key, neural Sulafat voice, free-flow dispatch, per-project memory), the floating
Voice Hub (right panel deleted), skills (compact button + your 10 machine skills), image/video
generation, video/file understanding, phone Remote Control on Claude panes, Companion scaffold,
Settings (8 sections, 5 themes + editor), permission modes incl. BYPASS, packaging (Forge.exe +
secrets gate), updates system. All suites green (~1000 checks). Start the app with the **Forge**
desktop shortcut.

## Immediate loose ends

1. **The mystery stash.** ~860 uncommitted lines were found in this repo before the Hub merge and
   are preserved in `git stash list` ("unknown local edits found pre-hub-merge"). If they were your
   in-app pane's work: `git stash show -p` to review, replay what's wanted on top of the Hub
   (expect conflicts in SkillsRail/AppState), drop the rest. If they weren't yours — investigate
   before anything else.
2. **Regenerate your NEW Gemini key sometime** (it was pasted into the Claude session transcript).
   aistudio.google.com/apikey → delete + recreate → paste into Settings → Models & APIs. 2 minutes.
3. **Billing check on the OLD key** (still used by DictationMic): aistudio.google.com/apikey plan
   column; if Paid, Billing → Reports shows what today's Veo tests cost (likely small). Forge no
   longer uses that key.
4. **Switch the brain to `gemini-3.6-flash`** in Settings → Models & APIs if not done — best free
   upgrade in the app.

## Working from inside Forge (the M6 plan)

- Open the **forge** project, open Claude panes (bypass mode if you like), talk or type.
- **POLISH.md** is the hit list — BridgeSpace-inspired items (readable wall mode, bolder workspace
  colours, richer pane headers, per-pane status footer) + all known warts. Point a pane at an item.
- Renderer changes hot-reload live. Main-process changes need an app restart — panes die, but
  `claude --continue` in a reopened pane resumes the session.
- After fixes, have the pane run the suites: `npm run build` (must stay 0 TS errors) plus the
  relevant `*:check`/`*:smoke` (voice, mosaic, theme, skills, hub, pty, shots, memory, updates,
  bridge, stt). They are the regression net — keep them green, extend them with new fixes.
- Commit small and often. `git log` tells the story so far.

## Next feature milestones (specs in the task list / earlier design)

1. **Desktop pill** — the pill as an OS-level always-on-top window: talk to your agent while
   Chrome (or anything) is focused; actions run in Forge in the background. Builds on the
   VoiceAgent provider (already headless). Phase 2: global dictation typing into ANY app —
   supersedes DictationMic.
2. **forge:// action links + QR codes** — protocol handler → AppAction executor;
   Settings-generated QR codes route commands from your phone via the Companion channel
   (the ChatGPT voice-agent-powers-the-app pattern).
3. **Companion go-live** — YOUR commands, ~10 min: follow `companion/GO-LIVE.md`
   (firebase projects:create forge-sync → rules deploy → hosting deploy → fill settings → sign in
   phone-first). Then phone → images into projects, messages to the agent, replies back.
4. **Gemini Live conversation mode** — realtime speech-to-speech with tool calling (the full
   talking-agent). Model ladder A/B first: try `gemini-3.1-pro-preview` as the brain for a day.
5. **Wake word / VAD gate** — stop room noise being transcribed; pairs with Live mode.
6. **Code-signing decision** — one cert purchase fixes SmartScreen warnings, Smart App Control
   blocks, and makes auto-update trustworthy for distribution/selling.
7. **Forge releases** — when ready to ship: create GitHub repo `stevenmcginty/forge`, upload
   `Forge-<ver>-setup.exe` + `latest.yml` from `npm run dist`; the in-app update banner does the rest.

## Where things live

- Your data/settings: `%APPDATA%\Forge` (settings.json, shots, skills library, memory/, bridge/)
- Speech model: DictationMic's (borrowed, read-only) or download your own in Settings → Voice
- The plan/history of today: `~\.claude\plans\currently-i-have-two-functional-babbage.md` +
  this repo's git log. Claude's project memory also carries the state.
- Suites: `package.json` scripts, all `*:check` / `*:smoke`.
