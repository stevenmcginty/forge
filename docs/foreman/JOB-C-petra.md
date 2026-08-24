# Job C — Foreman on Forge Web and Forge Mobile

You are Petra, a GLM 5.3 pane in Forge. Omar (a Claude pane) is the gaffer on this job and will judge the result by re-running the Verify commands and reading the diff. Work in this checkout (C:\Users\steve\Desktop\forge). Other agents are editing `src/**` (desktop UI) and possibly `web/src/components/PaneView.tsx` (another session moved header buttons recently) — pull the latest state of a file before editing it, keep edits additive, and commit small.

## Job
Carry Foreman's state and controls to the browser (`web/`) and the phone (`mobile/`) so a person can switch Foreman on/off, seed it, read its status line and its decision log, exactly as on the desktop.

## Context
"Foreman" is a main-process agent that drives a Claude terminal pane end to end from a one-line seed. Core is committed: `shared/foreman.ts` (types — `ForemanState { paneId, status: 'off'|'starting'|'driving'|'waiting'|'done'|'error', line, seed, log: ForemanLogEntry[] }`, `ForemanStartRequest { paneId, seed }`, `FOREMAN_SEED_MAX`, `idleForemanState`), `electron/foreman/ipc.ts` (`ipcMain.handle` for `IPC.foremanStart/Stop/List`, pushes `IPC.foremanState` to the main window; exports `registerForemanHandlers`, `setForemanTarget`). The desktop renderer uses `window.forge.foreman.*`. The browser and phone talk to main over WebSockets, not IPC, so main must (a) broadcast every Foreman state change as a frame and (b) accept start/stop ops from those clients.

## Files
Read first:
- `shared/web.ts` — the browser wire protocol: find the `attention` frame (`type: 'attention'`, ~line 1333) and the layout/op request shapes (`op: 'close-pane'` etc., ~2225-2245 `wireString`), plus how frames are validated at the boundary.
- `electron/web/server.ts` — `this.broadcast({ type: 'attention', ... })` (~842) and `pushAttention`; how incoming ops are dispatched to pty-host/app; where per-client `hello`/snapshot is assembled (a reconnecting browser must receive current Foreman states in the snapshot, not only deltas).
- `electron/web-host.ts` — where main hands events to the server (`ipcMain.on(IPC.webAttention...)` ~1784) — model your Foreman fan-out on it.
- `electron/mobile-host.ts` and `electron/mobile/**`, `shared/` mobile protocol file(s) — the phone's equivalent of the above.
- `electron/foreman/ipc.ts` — you need a hook to *observe* state pushes from main without going through the renderer. Add a small additive export there: `onForemanState(cb: (s: ForemanState) => void): () => void` and `foremanStart(req)/foremanStop(paneId)/foremanList()` functions that call the same host the IPC handlers use (they exist as `ensureHost().start(...)`, `host.stop(...)`, `host.list()`). Keep the existing handlers untouched.
- `web/src/components/PaneView.tsx` — header (`pane__header` ~817), `WAITING` chip (~842) — house pattern for a status chip; `web/src/state/**` for how frames become state and how ops are sent.
- `mobile/src/components/PaneView.tsx` — header `bar` (~168) and its state/socket layer.

Build:
1. **Wire**: `foreman` frame `{ type: 'foreman', state: ForemanState }` broadcast on every state push; Foreman states included in the initial snapshot; ops `{ op: 'foreman-start', paneId, seed }` and `{ op: 'foreman-stop', paneId }` validated at the boundary (seed capped to `FOREMAN_SEED_MAX`, paneId must be a live pane the client is allowed to see, same authorisation as `close-pane`). Same for the mobile protocol.
2. **Web UI**: in the pane header, a "Foreman" switch on Claude panes only (see `shared/agents.ts` `isClaudeCommand`), lit with the accent when on; click-on opens a one-line seed strip ("What's the job? One line is enough." — blank allowed only if the pane already has a session, meaning take over); click-off sends `foreman-stop` at once. A one-line status footer while status ≠ off; tapping it opens a scrollable log panel (kind tag, HH:MM, text). Reuse the existing chip/footer styling; no hard-coded colours; must work at phone width in the browser too (Forge Web is used on a phone).
3. **Mobile UI**: same switch in the `bar`, same seed sheet, footer and log — use the phone's existing sheet/list components.
4. Reconnect: after a socket reconnect the switch shows the true state (from the snapshot).

## Don't
- Don't touch `src/**` (desktop renderer), `electron/foreman/host.ts`, `persona.ts`, `kit*.ts`, `shared/foreman.ts` (except purely additive exports if needed — say so).
- Don't change the existing attention frames or any other op.
- No new dependencies.

## Verify
- `npm run typecheck` → 0 errors (all four lanes).
- `npm run web:check` and any mobile check in package.json still pass; extend `scripts/web-check.mjs` (or the closest suite) with: a `foreman` frame reaches a connected client; the snapshot carries current states; `foreman-start` with an over-long seed is capped; `foreman-stop` for a pane the client cannot see is refused. Paste outputs.
- Open Forge Web in a browser against the dev app (`npm run dev`; if "Port 5173 is in use" kill the stale dev tree) and confirm by observation: switch visible on a Claude pane, absent on pwsh; seed strip; footer; log; survives a reload.
- Commit small, prefixed "Foreman Web:" / "Foreman Mobile:". Don't push.

## Report
Write your final report to `docs/foreman/JOB-C-petra-REPORT.md`: CHANGED (files, one line each), VERIFIED (commands + outcomes verbatim), DEVIATIONS, BLOCKED. Then commit it. If the brief is wrong or impossible as written, write BLOCKED with why — do not improvise outside it.
