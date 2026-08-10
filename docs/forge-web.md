# Forge Web

Forge in a browser tab. One URL, a Firebase login, and the terminals already
running on Steve's PC appear — same projects, same tabs, same splits, same
look. When the PC is off, the same URL still opens the repo from GitHub so the
files and history are there; the terminals are simply asleep.

The desktop application's behaviour does not change. Nothing here is a
replacement for it — Forge Web is a second window onto the same machine.

---

## The shape of it

```
browser (Firebase Hosting, one stable URL)
   │
   │  1. sign in (Firebase email/password — the same accounts as Companion)
   │  2. read users/<uid>/host  ──────────────▶  Firebase RTDB
   │                                                  ▲
   │                                                  │ desktop publishes its
   │                                                  │ tunnel hostname + presence
   │  3. connect straight to the PC                   │
   ▼                                                  │
ngrok tunnel ──────────▶ forge-server (on Steve's PC) ┘
                              │
                              ├── PTY sessions  (the real terminals, mirrored)
                              ├── projects / workspace / store
                              ├── git + gh
                              └── skills, commands, agents

   … and when users/<uid>/host says nobody is home:

browser ──▶ GitHub REST API  (read the tree, edit, commit to a branch)
```

Terminal bytes never pass through Firebase. Firebase carries identity and one
hostname; the session itself is a direct connection from the browser to the PC.

---

## Decisions

These were settled with Steve before any code was written. They are recorded
here because most of them are the kind that look arbitrary in six months.

| # | Decision | Why |
| - | -------- | --- |
| 1 | Terminals run on Steve's PC. No cloud runner. | The point of Forge is real terminal powers on a real machine with real credentials. |
| 2 | Identity is the existing Firebase email/password auth. | `companion/web/js/auth.js` and `electron/companion/rest.ts` already implement it, per-uid isolation and all. |
| 3 | Firebase also does rendezvous: the desktop publishes its tunnel hostname under `users/<uid>/host`. | Solves "the tunnel address changed" without a relay that would see every keystroke. |
| 4 | The web client is its own app, but wears the desktop's face. | Steve wants it to *feel* like Forge desktop. It reuses the desktop's components and CSS through a transport shim rather than reimplementing them. |
| 5 | The browser **mirrors** the desktop's sessions. It does not spawn its own. | One workspace, one truth. Open a tab in the browser and it appears on the desk. Forge Mobile already works this way. |
| 6 | The terminal widget is xterm.js fed real PTY bytes. | Claude Code is a full-screen TUI. A prettier "blocks of output" view cannot render it. A structured layer can be added on top later; it cannot be the foundation. |
| 7 | Everything bound to physical hardware is out: voice/dictation, screenshot tray, desktop control/overlay, Forge Mobile, Forge TV. | A browser tab has no microphone worth the plumbing, and a public URL that moves the real mouse is a different risk class entirely. |
| 8 | Desktop online: edits land straight in the working tree on the PC. | The agent in the terminal sees them immediately, uncommitted — exactly like editing on the desktop. |
| 9 | Desktop offline: the browser reads and writes GitHub directly, committing to a `forge-web/*` branch. The desktop shows a banner and reconciles with an ordinary `git pull`. | GitHub is the durable place. A bespoke sync protocol would be a second source of truth. |
| 10 | Desktop offline: terminals show the last known transcript, frozen and badged. | Forge asleep should not look like Forge broken. `pty-host`'s replay buffer already holds it. |
| 11 | No always-on fallback host in v1. | The headless server means renting a £4 VPS later is a deploy, not a rewrite. Ship without it and see whether it is actually missed. |
| 12 | The web bundle is served by Firebase Hosting, not by the PC. | Forced by decision 9: if the PC served the page, "desktop off" mode could not load at all. |

### The honest limitation

With the PC powered off there is no terminal and no agent, because there is no
computer to run one. Offline mode is Forge's *shell* — projects, files, git —
not Forge's *powers*.

The mitigation is that closing the Forge **window** must not end the session.
`forge-server` runs as a background/tray process, so lids, shutdowns of the UI
and walking away all keep the terminals alive. Only a genuine power-off or
reboot drops the browser to GitHub-only mode.

---

## Security posture

Forge Web puts a shell on a home PC behind a public web address. That is the
whole risk in one sentence, and every decision below exists because of it.

- **Firebase ID token is the gate.** The server verifies it against Google's
  published keys on every connection, not just at pairing. An unverified socket
  never reaches a PTY.
- **The uid must match.** A valid token for a *different* account is refused;
  the desktop's configured uid is the only one admitted.
- **The account is the credential, by default.** A verified token for the
  configured uid is admitted with no prompt on the desktop. That default was
  chosen deliberately and it is the thing that makes the feature usable: the
  word-pair prompt can only be answered by somebody standing at this machine,
  so a door that always demanded one locked Steve out of his own desktop from
  anywhere he actually wanted to use a browser. The trade — a stolen Firebase
  password is a shell — is stated once beside the setting in shared/types.ts
  (`webRequireApproval`) and repeated nowhere.
- **Every browser is still recorded, listed and revocable.** Revoking one drops
  its live socket immediately, and a revoked browser stays refused in *both*
  modes. That is the one thing the permissive mode does not soften, and the
  device-list cap in `electron/store.ts` spends its budget on live rows so a
  tombstone can never be squeezed off the end of it.
- **Device approval is an optional hardening toggle**, off by default. Switched
  on, behaviour is exactly what it was: "Accept new browsers" must be armed and
  a human at the desk presses Allow on a prompt carrying the word pair.
- **A TOTP second factor**, also optional, RFC 6238 over `node:crypto` with no
  new dependency. Codes are single-use — the accepted counter is remembered, so
  the ±1 drift window is not three chances at the same six digits — recovery
  codes are hashed at rest exactly as `electron/mobile/auth.ts` hashes device
  tokens, and the secret is sealed with a key in a file of its own rather than
  written into settings.json. "Trust this browser for 30 days" lives on the
  device row, so revoking the browser revokes the trust in the same act.
- **Off by default.** Nothing binds a socket, publishes a hostname or reads a
  credential until `webEnabled` is switched on in the desktop's settings.
- **The source allowlist stays.** The tunnel dials the listener from loopback,
  so `isAllowedSource` still bites on anything that reaches the port directly.
- **Defence in depth, not the defence.** The allowlist and the device list are
  the second and third locks. The token is the first, and it is the one that
  matters.

---

## Work plan

### Phase 1 — `forge-server`: the headless core

Most of this is already done, and was done before anyone thought about a
browser. `electron/main.ts` is a *registration* file, not a logic file: the
capabilities live in modules, and the load-bearing ones already import no
Electron at all — `electron/pty/session-manager.ts`, `electron/pty/replay.ts`,
`electron/git/*`, `electron/mobile/*`, `electron/companion/*`,
`skills-store.ts`, `memory-store.ts`, `projectfolder.ts`, `git-remote.ts`.
That house style is why `scripts/mobile-smoke.mjs` can drive the real server
over a real socket with no Electron in the process, and it is the reason a
second host is cheap.

What is actually left:

- `electron/store.ts` reaches Electron in two places (`app.getPath('appData')`,
  `app.getVersion()`). Inject both; the file becomes Electron-free. **Done.**
- `electron/git-watcher.ts` keeps all of its logic *inside* its `ipcMain.handle`
  closures, so nothing but IPC can reach it. Lift each handler body into an
  exported function and leave the registration as thin wrappers. This is the
  only genuine extraction in Phase 1, and it is forced by the code rather than
  chosen: every other capability the browser needs is already callable.
  `commandsFeed()` and `probeTools()`/`latestFor()` are already plain exported
  functions; `electron/git/*`, `electron/pty/*`, `skills-store.ts` and
  `memory-store.ts` already import no Electron at all.
- Nothing moves out of `main.ts`. It stays the registration file it already is.

**There is no `electron/server/services.ts`, and there should not be.** An
earlier draft of this plan proposed one — a facade gathering every capability
behind a single injectable object. That is a layer this codebase does not want.
The established pattern, used by both `MobileServerHost` and `CompanionHost`,
is the opposite: *the server declares the narrow interface it needs, and the
Electron host file implements it by calling the existing modules.* The
interface lives next to the consumer that justifies it, which is why
`MobileServerHost` asks for `replay(id)` and `write(id, data)` and nothing
else. Forge Web follows that, with `WebServerHost` in `electron/web/server.ts`.

The practical consequence, and the reason this matters: only the files a smoke
test bundles have to be Electron-free. `mobile-smoke.mjs` bundles
`mobile/server.ts` and `mobile/auth.ts` and injects a real `PtySessionManager`
for everything else. `web-smoke.mjs` does the same. Modules like `commands.ts`
that import `ipcMain` at the top stay exactly as they are — the *host* calls
them, and the host is always inside Electron.

**Desktop behaviour must be byte-identical afterwards.** The existing smoke
scripts (`pty:smoke`, `git:check`, `session:check`, `mobile:smoke`,
`skills:smoke`, `commands:check`) are the proof and must all still pass.

### Phase 2 — the web host

- `shared/web.ts`: the wire protocol, versioned, in the style of
  `shared/mobile.ts`. Every frame, limit and record shape in one file.
- `electron/web/server.ts`: HTTP + WebSocket, Electron-free and injectable so
  a smoke script can drive it with no Electron at all — the standard this
  repo already holds `mobile/server.ts` to.
- `electron/web/auth.ts`: Firebase ID token verification (Google JWKS, cached),
  uid matching, device records, approval prompts, revocation.
- `electron/web-host.ts`: the Electron wiring — settings, lifecycle against
  `webEnabled`, PTY sink registration via `addPtySink`, renderer ops for
  tab/pane layout.
- Rendezvous: publish `users/<uid>/host` (hostname, version, presence) through
  the existing `electron/companion/rest.ts`; clear it on shutdown.
- Tunnel: reuse `electron/mobile-tunnel.ts`.
- `scripts/web-smoke.mjs`: end to end over a real socket against a real
  `PtySessionManager`, no Electron, no mocks.

### Phase 3 — the web client

- New Vite app in `web/`, deployed to Firebase Hosting.
- A `forgeClient` that presents the same surface the renderer expects from
  `window.forge`, backed by the WebSocket. The desktop's components are reused
  against it wherever they are Electron-free.
- xterm.js on relayed PTY bytes, reusing the approach in
  `mobile/src/lib/term.ts`.
- Project rail, tabs, splits/mosaic, git panel, skills and commands flyouts,
  agent chooser, approvals.
- Connection states are first-class UI: connecting, live, offline (GitHub),
  awaiting device approval.

### Phase 4 — GitHub mode

- GitHub auth in the browser: a **fine-grained personal access token**, pasted
  by the user, scoped to the chosen repositories with Contents read/write.

  Not OAuth, and not by preference. Every GitHub token endpoint — the web flow,
  the device flow and a GitHub App's user-to-server flow alike — terminates at
  `https://github.com/login/oauth/access_token`, which sends no
  `Access-Control-Allow-Origin`. A browser cannot complete the exchange, and
  Forge Web deliberately has no server to exchange through. Device flow was
  planned here until it was tried.

  The cost is a long-lived credential in browser storage, so the UI treats that
  as the fact it is: it names the exact permission to grant, shows what the
  token can actually reach by asking GitHub rather than assuming, and offers to
  forget it. If a small Cloud Function ever becomes acceptable — Firebase
  Hosting is already in play — a GitHub App user-to-server flow would replace
  this with a short-lived token and a refresh token. That is a deliberate
  trade, not an oversight.
- File tree, viewer and editor over the GitHub REST API.
- Commits land on a `forge-web/*` branch, never on `master` directly.
- Frozen terminal transcripts from the last cached replay, clearly badged.
- On the desktop: a banner when a `forge-web/*` branch has commits the local
  tree has not seen, offering the pull.

### Phase 5 — desktop settings and the background service

- Settings: `webEnabled`, Firebase sign-in, the public URL, the device list
  with revoke, the device-approval toggle and the TOTP enrolment.
- `forge-server` survives the window closing — tray process or equivalent — so
  that GitHub-only mode is rare rather than nightly.

---

## How this gets tested

A green typecheck proves nothing about a product. Every phase has a gate below,
and a phase is not finished until its gate passes on a real run — not until an
agent says it does.

The standard is already set by `scripts/mobile-smoke.mjs`: it esbuild-bundles
the *real* server and auth modules and drives them exactly as the Electron host
does — against a real `PtySessionManager`, over a real WebSocket, with a real
pwsh session on the other end. No mock server, no fake PTY, no stubbed auth.
Every test below is written to that bar.

| Phase | Gate | Command |
| ----- | ---- | ------- |
| 1 | Desktop behaviour unchanged after the extraction, and `store.ts` imports no Electron. | `npm run typecheck && npm run pty:smoke && npm run session:check && npm run git:check && npm run gitwatch:smoke && npm run skills:smoke && npm run commands:check && npm run mobile:smoke` |
| 2 | The web host serves a real PTY over a real socket with no Electron in the process, and every auth refusal path actually refuses. | `npm run web:auth && npm run web:rendezvous && npm run web:smoke` |
| 3 | The client renders the desktop's UI against a live host, and a typed command's output comes back. | `npm run web:e2e` |
| 4 | With the host down, the client reaches GitHub, lists a tree, and a commit lands on a `forge-web/*` branch. | `npm run web:offline` |
| 5 | The settings toggle starts and stops the host; closing the window does not kill the session. | `npm run web:check` |

### What each gate must actually assert

**Phase 2 — `scripts/web-smoke.mjs`.** Modelled directly on `mobile-smoke.mjs`,
including its three-server structure (the source-address lockout is per address
and every socket in a smoke run comes from 127.0.0.1, so the refusal phase must
be torn down before the success phase starts).

- A valid token for the configured uid attaches to a live session, receives the
  replay buffer, writes a command and reads its output back.
- Each refusal is asserted *separately*, because each is a different sentence on
  screen: malformed token, expired token, valid token for the wrong uid,
  unapproved device (with the hardening toggle on), revoked device, stale
  protocol version. `scripts/web-auth-check.mjs` carries the ones that are about
  the admission decision rather than the wire — the account-only path with no
  prompt raised, revocation and the uid match holding in *both* modes, and the
  second factor, including the assertion the feature stands on: a replayed TOTP
  code is refused.
- Rate limits and the max-write cap bite.
- Heartbeat loss closes the session inside the grace window.
- Token verification runs against injected JWKS, so the test needs no network
  and no real Firebase project.

**Phase 3 — `scripts/web-e2e.mjs`.** Playwright against a real browser and a
real Forge, using the throwaway-profile pattern (`--data-dir` pointed at a
seeded scratch directory, driven with `playwright-core`) so it never touches
Steve's own data root.

- Sign in, land on the project list, attach to a session.
- Reload the page, and then restart the browser context carrying its stored
  state over, and land back in the workspace **with no credential typed** —
  which is the whole promise of the account-only default and the only assertion
  that catches a session that survives a reload but not a restart.
- With a second factor enrolled: the browser is asked for a code, a wrong one is
  answered on the same screen, and the code the app is showing gets it in.
- Type `echo forge-web-<nonce>` and assert the nonce appears in the browser's
  terminal.
- Assert the same nonce appears in the desktop window's terminal — that is the
  actual claim of decision 5 (mirror, not a parallel world), and it is the one
  assertion that cannot be faked by a client-side echo.
- Tabs and splits created in the browser appear on the desktop.
- Screenshot at 1440px and 390px, and in both themes.

**Phase 4 — `scripts/web-offline.mjs`.** Host deliberately down.

- Client detects absence via the rendezvous record and enters GitHub mode
  rather than hanging or blanking.
- Terminals render the last cached transcript, frozen and badged.
- An edit commits to a `forge-web/*` branch against a scratch repo, and never
  to `master`.
- Bringing the host back returns the client to live mode without a reload.

**Phase 5 — `scripts/web-check.mjs`.** Lifecycle only.

- `webEnabled: false` binds no port, publishes no hostname, reads no
  credential. Asserted by inspecting the listener and the rendezvous record,
  not by trusting the setting.
- Toggling it on starts the host; toggling it off stops it and clears the
  published hostname.
- Closing the window leaves sessions alive; quitting the app takes them down.

### The security tests are not optional

The refusal assertions in Phase 2 are the most important tests in this
document. This feature puts a shell behind a public address, and every one of
those paths is the difference between a locked door and an open one. A refusal
path that is not tested is a refusal path that does not work.

## What only Steve can do

Everything else is code and can be built and proved without leaving the
repository. These cannot: they need credentials, a console, or a decision only
the account holder can make. Each is written so it can be done in one sitting,
and none of them blocks the others.

1. **A Firebase project with Hosting and Realtime Database enabled.** The
   Companion already needs one (`companion/GO-LIVE.md` has the exact commands).
   If Forge Web shares it, there is nothing to do beyond enabling Hosting.
   Note that `webProjectId` is a *new* settings field rather than a read of the
   Companion's: `companionUid` changes whenever the Companion is signed in or
   out, and letting that re-point who gets a shell is not acceptable for this
   door.

2. **Deploy the database rules.** `companion/database.rules.json` now carries
   the `host` block Forge Web needs, and it is proved against the emulator by
   `npm run web:rendezvous` — but the emulator is not the project. Until this
   runs, the live database refuses the rendezvous write and the browser can
   never find the desktop:

   ```
   cd companion && firebase deploy --only database
   ```

3. **An ngrok account with a second domain.** The decision this once left open
   has been taken: Forge Web supervises an **ngrok** agent of its own, through
   the same `electron/mobile-tunnel.ts` Forge Mobile already drives. That was
   the cheaper of the two honest options — the file already handles download,
   spawn, restart and permanent-refusal detection — and the alternative, a
   second `cloudflared` supervisor written from scratch, bought nothing that
   code did not already do. (The only `cloudflared` in the repository remains
   `scripts/mobile-tunnel.mjs` and `scripts/mobile-go.mjs`: standalone dev
   scripts that spawn a quick tunnel and exit. Neither is importable and neither
   is supervised.)

   What Steve has to do is one-time and on the ngrok dashboard: reserve a second
   domain — Forge Mobile's cannot be reused, because one domain forwards to one
   port — and paste it, with the authtoken, into Settings › Forge Web. A free
   plan allows three concurrent agent sessions, and two links running at once
   take two of them.

   `FORGE_WEB_HOSTNAME` still works and now means one thing only: a tunnel run
   by hand, outside Forge. On that path the status reads `configured` rather
   than `live`, because Forge never started that process and cannot report on
   it.

4. **A fine-grained GitHub personal access token** — offline mode only, and
   only when you want it. Create it under Settings → Developer settings →
   Fine-grained tokens: pick the specific repositories, grant **Contents:
   Read and write** and nothing else, and give it the shortest expiry you can
   live with. Paste it into the browser when it asks.

   No OAuth app, because a browser cannot complete GitHub's token exchange —
   see Phase 4 above for why. The token lives in that browser and nowhere else:
   it never reaches the desktop, never enters the offline cache, and "forget
   this token" genuinely removes it.

5. **Two Hosting sites, then deploy.** This one has a trap in it, which is why
   it is spelled out.

   `companion/firebase.json` used to declare a *single* hosting site pointing at
   `companion/web`. Deploying Forge Web through it would have replaced the
   Companion PWA with the Forge Web bundle — same project, same URL, one site.

   So it now declares two, and they are kept apart by target names. In the
   Firebase console, under Hosting, add a second site (the name is globally
   unique and becomes the URL). Then, once, from `companion/`:

   ```
   firebase target:apply hosting companion <your-companion-site>
   firebase target:apply hosting web       <your-forge-web-site>
   ```

   That writes the `targets` block shown in `.firebaserc.example`. After it,
   each site deploys on its own and neither can clobber the other:

   ```
   npm run web:deploy                 # Forge Web only — builds, then ships web/dist
   cd companion && firebase deploy --only hosting:companion
   ```

   Also copy `web/config.example.json` to `web/public/config.json` and fill in
   your project's `apiKey` and `databaseUrl` **before** building. Neither is
   secret — a Firebase web API key is a public identifier — which is why it is
   served beside the bundle rather than baked into it.

   The Forge Web site is served with a Content-Security-Policy that allows only
   `self` for scripts, the Firebase auth and database hosts, `api.github.com`
   for offline mode, and `wss:` for the tunnel. `wss:` is deliberately not
   pinned to one host: the tunnel hostname changes, which is the entire reason
   the rendezvous record exists.

## Two things that were wired but not right

Both were found by building the thing rather than by planning it, both are
fixed, and both are recorded because the shape they were corrected *into* is
the part worth keeping.

**Forge Web used to borrow the Companion's Firebase session.** The rendezvous
record is written under a signed-in uid, and the only session this desktop held
belonged to Forge Companion — so `web-host.ts` refused to publish unless
`companionUid` equalled `webUid`. Switching Forge Web on therefore depended on
a *different feature* being signed in as the same account, and signing the
Companion out stopped Forge Web publishing without saying so.

That contradicted the reason `webUid` is a separate field at all: the
Companion's uid changes whenever it is signed in or out, and letting that
re-point who gets a shell on this machine is not acceptable. Forge Web now
holds its own session — `webApiKey`, `webDatabaseURL`, `webEmail`,
`webRefreshToken`, and `webUid` written by its own sign-in — through the same
`electron/companion/rest.ts` client. The two features share an identity
*provider* and nothing else. `window.forge.web.signIn()` / `signOut()` drive it,
the stored credential is a refresh token and never a password or an ID token,
and a signed-out Forge Web publishes nothing while saying why in
`WebStatus.session.detail`. `npm run web:check` asserts that case with the
Companion signed in as a *different* account, which is exactly the arrangement
that used to fail in silence.

**No tunnel was supervised in-app.** Now one is: Forge Web runs its own ngrok
agent on its own port and domain (see item 3 above), so `tunnel.state` reports
`starting`, `live` and `error` as things Forge watched happen, and a tunnel that
dies retracts the published hostname instead of leaving browsers dialling a dead
address. `FORGE_WEB_HOSTNAME` survives as an explicitly-documented override for
a tunnel run by hand, and says `configured` rather than `live` because on that
path Forge cannot see the process.

## What is deliberately not here

- No cloud runner and no per-session containers.
- No agent execution when the PC is off.
- No voice, screenshots, desktop control, Mobile or TV in the browser.
- No second user. One account, one machine, one human.
