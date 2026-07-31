# Forge polish backlog

Steve fixes these from inside Forge — open this project, speak or paste an item into a Claude pane.
After each fix: `npm run build` must stay at zero TS errors, and run the relevant suite
(`voice:check`, `mosaic:check`, `theme:check`, `skills:smoke`, `pty:smoke`…). Renderer changes
hot-reload; main-process changes need an app restart (reopen panes with `claude --continue`).

## From the BridgeSpace comparison (2026-07-30)

1. **Readable wall mode.** The mosaic scales tiles into unreadable miniatures; BridgeSpace keeps
   every pane at native font in narrow columns. Add a wall-level toggle ("Readable") that refits
   EVERY tile to its box (the double-click-header refit, applied wall-wide, debounced), plus a
   one-click "columns" preset that lays tiles as N equal-width full-height columns like
   BridgeSpace's grid. Keep the scale-model mode as "Overview".
2. **Bolder workspace colours in the rail.** Project colour should tint the row chip and the
   selected state (BridgeMind-style coloured borders/badges), not just the small dot. Same tokens,
   more confidence.
3. **Richer pane-header controls.** Add one-click: maximise-in-tab (zoom), split-h/split-v (exist),
   copy-last-output, clear, and the profile badge as a menu (relaunch as…, permission mode for
   Claude). Keep the header slim — icons on hover.
4. **Per-pane footer status line** (BridgeSpace shows "bypass permissions · 1 MCP" per pane):
   a subtle one-line footer on Claude panes — permission mode + MCP count + model if detectable.

## Known small items

5. `getBitmap()` deprecation warning from shots-watcher (use `toBitmap()`).
6. `[DEP0190]` shell:true spawn warning in system.ts/tools.ts probing — switch to argv arrays.
7. Renderer bundle is 1.47 MB — split xterm + settings + voice into lazy chunks.
8. Tray: no enlarged hover preview; ~3.5 thumbnails visible at rail width; no multi-select drag.
9. Videos don't thumbnail in the tray (assets-only today) — add a video thumbnail path.
10. Mosaic: cascade drop near the far corner can push tiles off-view (wall scrolls); reset-to-grid
    button visible while zoomed; no keyboard move/resize of tiles.
11. Voice: no wake word / VAD gate — room noise gets transcribed and answered. (Bigger: ties into
    Gemini Live milestone.)
12. Voice settings "compare three" row is fixed at Sulafat/Achernar/Aoede — let favourites be pinned.
13. Skills flyout: machine skills can't be edited in place (by design) — consider "open in pane"
    action that cds a terminal to the skill folder.
14. First dictation of a session waits ~3–6s for the model with only the dim-dots hint — consider
    optional warm-start on app launch (setting).
15. Gemini launch-profile panes: inject GEMINI_API_KEY (from settings geminiKey) into the pane env
    for profiles whose command is `gemini`, so the interactive CLI works in API-key mode without the
    retired Google login. (Check session-manager buildEnv + profile flag; the CLI's API-key auth
    still works — only its Google-login/Code Assist mode was retired.)
16. Onboarding/GIVE-TO-A-FRIEND: code-signing decision pending — SAC blocks unsigned exes
    unpredictably; a cert fixes SmartScreen + auto-update trust in one purchase.
