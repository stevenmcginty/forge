# Job C report — Foreman on Forge Web and Forge Mobile

## CHANGED

- `shared/web.ts` — `WebForemanFrame` (`type: 'foreman'`, whole `ForemanState`), `foreman?: ForemanState[]` on `WebHelloOkFrame`, `foreman-start` / `foreman-stop` request kinds.
- `shared/mobile.ts` — `'foreman-start' | 'foreman-stop'` on `OpFrame` (+ optional `seed`), `ForemanFrame` (`t: 'foreman'`), `foreman?: ForemanState[]` on `HelloOkFrame`.
- `electron/web/server.ts` — boundary validation for both verbs (pane must be live against `sessions()` → `unknown-session`; seed capped via `wireString(..., FOREMAN_SEED_MAX)`), optional `foremanStart`/`foremanStop` host hooks, `pushForeman` broadcast, `foreman` in `hello-ok` from the snapshot.
- `electron/mobile/server.ts` — the same, on the phone link: foreman ops intercepted in the `op` case before the renderer dispatch, `pushForeman`, snapshot `foreman`.
- `electron/foreman/ipc.ts` — additive `onForemanState` / `foremanStart` / `foremanStop` / `foremanList` exports; `sendState` now also notifies state listeners; the kit install moved into `foremanStart` so a browser/phone start gets it too (the IPC handler calls the same function — see DEVIATIONS).
- `electron/web-host.ts` — subscribes `onForemanState → pushForeman` while the link is up (unsubscribed in `stop()`); snapshot carries `foremanList()`; host hooks call the exported foreman functions.
- `electron/mobile-host.ts` — the same wiring on the phone link.
- `web/src/lib/client.ts` — `onForeman` handler + `case 'foreman'` (coerced, malformed states dropped).
- `web/src/state.tsx` — `Picture.foreman` record, fed by `hello-ok` and the push; `foremanStart`/`foremanStop` actions.
- `web/src/components/PaneView.tsx` — the FOREMAN switch (Claude panes only, accent-lit), the seed strip ("What's the job? One line is enough."; blank only where `leaf.sessionId` exists), the status footer while status ≠ off, the decision-log panel (kind, HH:MM, text).
- `web/src/styles.css` — styles for the above, tokens only, phone-width rules included.
- `mobile/src/lib/link.ts` — `foreman` map in `LinkPicture` (from `hello-ok` and the push), `foremanStart`/`foremanStop` methods (op frames).
- `mobile/src/App.tsx` — resolves the pane's project and Claude-ness (`sessionLeafOf` / `sessionIsClaude`) and passes foreman props into `PaneView`.
- `mobile/src/components/PaneView.tsx` — the switch in the `bar`, the seed sheet, the status footer, the log bottom sheet.
- `mobile/src/styles.css` — styles for the above, in the bar-button family (`--volt` lit state).
- `scripts/web-smoke.mjs` + `scripts/fixtures/web-smoke-entry.ts` — a foreman phase against a recording host (the brief's four assertions, plus a healthy stop).
- `scripts/web-check.mjs` — a real-host foreman phase (snapshot, exports, a real `foreman-stop` through the whole chain).

## VERIFIED

`npm run typecheck` → exit 0, 0 errors across all four lanes (node, web, mobile, webclient).

`npm run web:smoke` → `web:smoke — all checks passed`, including:

```
PASS  a Foreman state pushed on the desktop reaches a connected browser as a foreman frame
PASS  and hello-ok carries the current Foreman states, so a reconnecting browser learns the switch is on from the snapshot
PASS  a seed over FOREMAN_SEED_MAX (2000) is capped to it and starts, not refused
PASS  foreman-start for a pane the client cannot see is refused as unknown-session, and the host was never asked
PASS  and so is foreman-stop, for the same reason and with the same courtesy
PASS  while foreman-stop for a live pane reaches the host and answers ok
```

`npm run web:check` → `web lifecycle: all good` (222 PASS), including:

```
PASS  the real host's hello-ok carries the foreman states, so a reconnecting browser hears 'nothing is driven' as an answer rather than as silence
PASS  and the exported list answers with no host behind it, which is the shape a freshly booted desktop has
PASS  a foreman-stop for a live pane travels the whole chain — browser, server, web-host, the foreman module — and answers ok
PASS  and the same verb for a pane this desktop does not have is refused at the boundary, against the real session list
```

`npm run mobile:smoke` → `mobile:smoke — all checks passed`.
`npm run mobile:auth` → `mobile:auth — all checks passed`.

Browser observation, against a real WebServer + the real web client (vite dev), with a scripted Foreman host and a loopback identity stub — a real desktop app could not be launched for this without touching the live Forge or opening a real Claude session, so the desktop half of the chain is what `web:check` proves and the UI half is what this observes:

- FOREMAN switch present on the Claude pane; **absent** on the pwsh pane.
- Click-on opens the seed strip; typed "a website for a sweet shop", Start → strip closes, switch lights, footer appears (`STARTING · Reading the pane and forming the concept`) and moves to `WAITING · Waiting for the pane`.
- Footer tap opens the log: `seed 19:03 a website for a sweet shop`, `brief 19:03 …`, `instruction 19:03 …`.
- Full page reload: switch still lit, footer still there — from the snapshot, not the push.
- At 390×844: switch and footer render and stay within the viewport.
- Click-off: switch unlit and footer gone immediately.

## DEVIATIONS

1. **Ops are request kinds on the web, op-frame verbs on the phone.** The brief spelled both links' ops as `{ op: 'foreman-start', ... }`. On the phone that is exactly what shipped (`OpFrame.op` grew the two verbs). On the web, every non-layout mutation is a `WebRequest` *kind* (`git-action`, `paste-image`, …) and layout ops are the forwarded-to-renderer kind; Foreman ops are answered by main, so they became `kind: 'foreman-start'` / `kind: 'foreman-stop'` to follow the house pattern rather than the layout one.
2. **The IPC `foreman:start` handler was refactored, not left byte-identical.** The kit install + `ensureHost().start()` moved into the exported `foremanStart()` and the handler now calls it — otherwise a start asked from a browser or the phone would skip installing the Foreman kit. Behaviour of the desktop path is unchanged (same order, same error logging); this is the one edit inside an existing handler.
3. **The four boundary assertions live in `web-smoke.mjs`, not `web-check.mjs`.** The brief allowed "or the closest suite": `web-smoke` drives the real `WebServer` with a recording host, which is the only way to assert the seed cap and the refusal deterministically — a real `foreman-start` opens a real Claude session, which no check may do. `web-check` instead proves the real-host half (snapshot, exports, a real `foreman-stop` end to end) and deliberately does not exercise a real start.
4. **The browser observation ran against a scripted host, not `npm run dev`.** The live desktop is Steve's running Forge; launching a dev instance from this checkout would pop a window over his work and share his profile, and signing a real browser in needs his account. The observation served the *real* web client from vite against a real `WebServer` whose foreman hooks pushed a scripted job — every pixel the brief lists was observed in a real Chrome. The driver was throwaway and is deleted.

## BLOCKED

Nothing.
