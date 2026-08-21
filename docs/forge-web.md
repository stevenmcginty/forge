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
tunnel (cloudflared) ──▶ forge-server (on Steve's PC) ┘
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
| 7 | Voice/dictation, the screenshot tray, the overlay, Forge Mobile and Forge TV stay out. **The desktop's screen does not**: a browser may watch it, and behind a second lock drive it. | A browser tab has no microphone worth the plumbing. The screen is the one hardware-bound thing that earns its risk — seeing and fixing the machine you are away from is most of what "Forge from anywhere" means, and a terminal cannot answer a dialog that is not in one. It travels over the existing WebSocket rather than WebRTC, whose media is peer-to-peer over UDP and would need a paid TURN relay to cross this tunnel at all. |
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
`electron/tray.ts` is what makes that true rather than aspirational: with
Forge Web switched on, an icon appears in the notification area and closing
the window hides it there instead of closing the app — sessions stay alive,
the rendezvous record stays published, sockets stay open. The tray's menu
shows what the link is doing and offers "Quit Forge", which is the one visible
act that actually tears everything down. Nobody who has not switched Forge Web
on acquires an icon; for them closing the window quits exactly as it always
did. Only a genuine power-off, a reboot, or Quit from the tray drops the
browser to GitHub-only mode.

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
  chosen deliberately and it is the thing that makes the feature usable: a
  prompt at the desk can only be answered by somebody standing at this
  machine, so a door that always demanded one locked Steve out of his own
  desktop from anywhere he actually wanted to use a browser. The trade — a
  stolen Firebase password is a shell — is stated once beside the setting in
  shared/types.ts (`webPin`) and repeated nowhere.
- **No browser is recorded, and there is nothing to revoke.** Forge Web kept a
  list of admitted browsers with a Revoke button on every row, and it was
  removed rather than kept for tidiness: it was never a gate. A browser holding
  a verified token for the configured uid and the desktop's PIN was admitted
  whether or not it was on the list, so every row implied a lock that was not
  there, and a stale row implied it about a browser nobody had used for months.
  What ends access is the PIN and signing Forge Web out — both of which end it
  for *every* browser, which is the honest granularity for a door whose
  credential is one account. An upgrading desktop's `webDevices` list is
  dropped on load by `normaliseSettings` and gone from settings.json on the
  next write.
- **An unlock PIN is the one optional lock.** Four to twelve digits, set once
  in Settings › Forge Web, and asked of every browser on every connection —
  not just the first, with no trust window on the door and nothing on disk
  that excuses it (`electron/web/auth.ts`). The page may replay digits it
  already typed, from memory only, for ten minutes after the tab was last
  visible (`PIN_GRACE_MS` in shared/web.ts), so a phone that dropped its
  socket on an app switch does not re-prompt immediately. A reload forgets
  them. It is stored as a versioned scrypt hash
  (`scrypt$1$salt$hash` in `electron/web/pin.ts`); the digits themselves are
  never written to settings.json. A wrong PIN gets one sentence for every
  cause — `pin-invalid`, never a reason why — and counts against the same
  per-source lockout mobile pairing uses (`AUTH_MAX_FAILURES`/
  `AUTH_LOCKOUT_MS`), which is what makes a four-digit secret defensible at
  all. It replaces both locks this feature shipped with first — the word-pair
  prompt a human answered at the desk, and a TOTP enrolment with ten recovery
  codes to keep — because neither survives being away from the desk and this
  one thing does. With no PIN set the account alone gets in, which is the
  shipped default; what a PIN buys beyond the door is the mouse, see the
  escalation guard below.
- **Off by default.** Nothing binds a socket, publishes a hostname or reads a
  credential until `webEnabled` is switched on in the desktop's settings.
- **The source allowlist stays.** The tunnel dials the listener from loopback,
  so `isAllowedSource` still bites on anything that reaches the port directly.
- **The `Origin` check names a *site*, not a project.** It is the one control
  that stops any page on the internet opening a socket to a tunnel hostname it
  guessed, so it fails closed and an unconfigured desktop admits no browser at
  all. What that costs is a name somebody has to get right, and Forge Web
  shipped getting it wrong: `webAllowedOrigins` derived every origin from the
  Firebase *project* id, which is a site's name only until a project has two
  sites — and this project has two, the Companion's PWA and Forge Web's bundle.
  The real page was refused by the real desktop from the first minute. Hence
  `webSiteId`, and hence the rule this refusal now follows: **a refusal that
  cannot reach the browser must reach the desk.** It fires during the upgrade,
  where there is no socket to carry a `refused` frame, so the browser sees only
  a failed handshake and does what any page does with one — retries, forever,
  saying "Reconnecting to the desktop". `WebStatus.refusal` carries the origin
  to the Settings card and a notification instead.
- **Defence in depth, not the defence.** The source allowlist and the `Origin`
  check are the second and third locks. The token is the first, and it is the
  one that matters.
- **The screen is off, control is off, and control cannot be switched on
  alone.** Decision 7 used to say the desktop's screen was out of scope
  entirely, on the grounds that "a public URL that moves the real mouse is a
  different risk class". The sentence was right and the conclusion has been
  reversed deliberately: the screen is in, and what answers the risk is an
  escalation rule rather than an absence.

  The rule is that **a browser may only be given the mouse on a desktop that
  has an unlock PIN set** (`canControl` in `electron/web-host.ts`, which is
  nothing more than `Boolean(settings.webPin)`), and that is not
  belt-and-braces. It is the only thing standing between the account-only
  default and a stolen password rewriting every remaining lock: a browser
  that can move the real cursor can open Settings on this desk and clear the
  PIN itself, silently, in a couple of clicks, and dissolve the one lock that
  was standing in the way. Requiring a PIN before the mouse is offered at all
  means the cursor always arrives behind something a stolen password does not
  come with: a short secret set by somebody who was actually sitting at this
  desk.

  Three further things hold it in place. **Starting a mirror spends a fresh
  PIN** when one is set — not the one that opened the connection, because what
  is being asked is "is that person still there" rather than "is this a
  browser that once signed in" (`checkFreshPin` in `electron/web/auth.ts`; the
  first `mirror-start` carries no PIN, the desktop answers `needsPin`, and the
  second carries what was typed — the same round trip `hello` itself uses).
  **Both gates are read per event**, so switching control off at the desk, or
  clearing the PIN, stops the next click rather than the next session. And
  **the desk is told out loud**: a watch raises an OS notification whether or
  not anybody is looking at Forge, and the Settings card says it is happening
  and offers a Stop, because a capture in progress is otherwise
  indistinguishable from no capture at all.

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
  uid matching, device records, the unlock PIN, revocation.
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
  asking for the unlock PIN.

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

- Settings: `webEnabled`, Firebase sign-in, the public URL, how many browsers
  are connected right now, and the unlock PIN — set, change or clear.
- `forge-server` survives the window closing — a tray process, `electron/tray.ts`
  — so that GitHub-only mode is rare rather than nightly.

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
  screen: malformed token, expired token, valid token for the wrong uid, a
  blank device id, stale protocol version. `scripts/web-auth-check.mjs`
  carries the ones that are about the admission decision rather than the wire —
  the account-only path with no prompt raised, a browser this desktop has never
  seen being admitted from an address it has never seen, and the PIN itself:
  `pin-required` on the first hello of a sign-in, `pin-invalid` on a wrong one,
  the per-source lockout that is what makes four digits defensible at all, and
  the assertion the feature stands on — a set PIN never lands on disk as
  anything but a versioned `scrypt$1$…` string. It also asserts what the removal
  of the device list has to keep true: `WebAuth` has no `revoke` or `forget` to
  call, and a `webDevices` key cannot get back into settings.json from either
  direction.
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
- With an unlock PIN set: the browser is asked for it, a wrong one is refused
  on the same screen, and the right one gets it in.
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
   never find the desktop. Run this from the **repo root** — see item 5 below
   for why it is no longer `companion/`:

   ```
   firebase deploy --only database --project <your-project-id>
   ```

3. **Nothing at all, for the tunnel.** This item used to be "an ngrok account
   with a second domain", and it is recorded here rather than deleted because
   the reasoning that put it there was sound and its premise was wrong.

   Forge Web first supervised an **ngrok** agent of its own, through the same
   `electron/mobile-tunnel.ts` Forge Mobile already drives — the cheaper of the
   two honest options, since that file already handled download, spawn, restart
   and permanent-refusal detection. What it never checked is the limit that
   matters: **ngrok's free plan allows one online endpoint per account.**

   This was observed, not reasoned. With Forge Web's domain left blank and
   Forge Mobile's tunnel already up, ngrok refused:

   ```
   The endpoint 'https://cure-task-legroom.ngrok-free.dev' is already online.
   … ERR_NGROK_334
   ```

   The endpoint it names is Forge Mobile's own reserved domain. Leaving `--url`
   off does not mint a throwaway address, as was assumed when the requirement
   was relaxed — it uses the account's single default endpoint, which is the one
   already in use. So the two links collide, blank does not help, and the only
   way to read a browser link was to switch the phone link off. Two links that
   cannot both be up is one link.

   So `webTunnel` now defaults to **`cloudflared`**, a quick tunnel supervised by
   `electron/cloudflare-tunnel.ts`: no account, no domain, no authtoken, no
   per-account agent limit, and therefore nothing for Steve to do beyond
   switching Forge Web on. The price is a different `*.trycloudflare.com`
   hostname on every start, and that price was already paid — the rendezvous
   record exists precisely so the browser reads whatever address this desktop
   landed on before it dials. `scripts/cf-tunnel-check.mjs` proves the
   supervisor, and `npm run web:check` kills a live tunnel and asserts the
   *new* address reaches the record.

   **ngrok is still there**, as `webTunnel: 'ngrok'`, for anybody who wants one
   steady address and is content to stop the phone link to get it. That path is
   unchanged: paste the authtoken into Settings › Forge Web, and optionally a
   reserved domain (Forge Mobile's cannot be reused — one domain forwards to one
   port). Forge Mobile itself is untouched and stays on ngrok, because a phone
   that scanned a QR keeps the address it was given.

   `FORGE_WEB_HOSTNAME` still works and still means one thing only: a tunnel run
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

   The fix moved the deploy config, not just the site list. Firebase refuses a
   `public` path outside the directory holding `firebase.json`, and `web/dist`
   (Forge Web) and `companion/web` (the Companion PWA) are siblings — no
   `firebase.json` inside either one can see both. So the **deploy** config
   — the one with two hosting sites, kept apart by target names — now lives at
   the **repo root** (`firebase.json`, committed) and is the one every deploy
   command below runs against. `companion/firebase.json` stays where it is and
   keeps a narrower job: it is the **emulator** config `npm run web:rendezvous`
   passes with `--config`, and what `companion/GO-LIVE.md` documents.

   Every project already has one default hosting site, named after the project
   id — that one is Companion's. Add a second, for Forge Web:

   ```
   firebase hosting:sites:create <your-forge-web-site> --project <your-project-id>
   ```

   Site ids are globally unique and become the URL. Then, once, **from the repo
   root**:

   ```
   firebase target:apply hosting companion <your-companion-site> --project <your-project-id>
   firebase target:apply hosting web       <your-forge-web-site> --project <your-project-id>
   ```

   That writes a root `.firebaserc` (gitignored — see `.gitignore`'s note on
   it) in the shape `companion/.firebaserc.example` shows. After it, each site
   deploys on its own and neither can clobber the other:

   ```
   npm run web:deploy                                              # Forge Web only — builds, then ships web/dist
   firebase deploy --only hosting:companion --project <your-project-id>   # the phone PWA
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

## Three things that were wired but not right

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

**No tunnel was supervised in-app.** Now one is: Forge Web runs its own agent on
its own port — a cloudflared quick tunnel by default, or ngrok for a steady
address (see item 3 above) — so `tunnel.state` reports `starting`, `live` and
`error` as things Forge watched happen, a tunnel that dies retracts the published
hostname instead of leaving browsers dialling a dead address, and one that comes
back on a different hostname republishes rather than waiting for a heartbeat.
`FORGE_WEB_HOSTNAME` survives as an explicitly-documented override for a tunnel
run by hand, and says `configured` rather than `live` because on that path Forge
cannot see the process.

**Whose grid is it? Two answers were shipped before this one.** A PTY has one
grid and this link gives it another viewer, so something has to decide whose
size wins. The record matters, because both losing answers looked obviously
right on the day they were written:

1. **Last mover wins** (Forge Mobile's original arrangement). The browser said
   what size it was reading at, the desktop stood down, and the desk letterboxed
   its own pane to match. Symmetrical, simple, and wrong: the first time a tab
   connected, every pane on the desk re-flowed in front of the person using it.
2. **The desk owns it while it has a window.** A browser's `cols`/`rows` were
   dropped outright whenever a window existed here, and the browser drew the
   desk's grid at a shrunken font. That stopped the fighting and threw away the
   point of a big screen: a browser on a 32-inch monitor spent two thirds of it
   letterboxing a laptop's pane, and a phone on the same rule drew a 200-column
   grid at 7px. Rejected in its turn.

So the rule is now: **the width follows the typist.** The grid belongs to the
device somebody last *typed* into the pane on. That device's wishes are honoured
on the real PTY — native, at whatever its own screen holds — and every other
viewer, this desktop's own renderer included, draws that grid at a font shrunk to
fit its box (`follow` in `web/src/lib/term.ts` and `applyGrid` in
`src/lib/terminals.ts`, both floored at 7px, below which the pane overflows and
is clipped). Sit at the desk and type, and the desk is native; pick up the phone
and type, and the phone is; glance at any screen without touching it and nothing
moves anywhere.

Nothing on the wire changed for any of it — a browser still sends its
`cols`/`rows` on `attach` and on every `resize`, unconditionally, because those
frames are a *wish* and a client that tracked the policy would be a client that
could hold a stale copy of it. What changed on this side is that the server no
longer decides: it names the viewer (minted per socket, so two browsers are two
viewers) on `write`, `resize` and `attach`, and the registry in
`electron/pty/grid-owner.ts` is the single place the rule lives. A host that
ignores the name — `scripts/web-e2e.mjs`'s does — behaves as it always did, which
is also what an unowned pane does: yes.

Three edges are worth stating because they are what makes the rule liveable.
**A `write` is not always typing**: a browser watching a busy pane sends the
terminal's own replies (`CSI 6 n` above all) down the same frame, and counting
those would mean watching moved a grid after all — `shared/typing.ts` is the
line, and the desk's typed-draft tracker uses the very same predicate.
**Departure releases**: a browser that hangs up, or detaches from a pane, stops
holding anything it held, and so does this desktop's window when it is destroyed;
ownership goes back to unclaimed and the next wish — very often the desk's own
next fit — takes it. **The desk is a follower like any other**, told the real
geometry on `IPC.ptyGeometry` and font-scaling to it; it is still told *which*
panes a browser is reading separately, because "IN BROWSER" on a pane header is
worth knowing and because that message must stay a label. Forge Mobile is wired
through the same registry — see "One PTY, several viewers" in `docs/MOBILE.md`.

## What is deliberately not here

- No cloud runner and no per-session containers.
- No agent execution when the PC is off.
- No voice, screenshots, Mobile or TV in the browser. The desktop's screen *is*
  in the browser now, and so is its mouse — see decision 7 and the escalation
  paragraph in the security posture, which is what pays for it.
- No WebRTC anywhere in Forge Web: no ICE, no STUN, no TURN. The picture rides
  the WebSocket the terminals do, for the reason decision 7 gives.
- No second user. One account, one machine, one human.

## Notifications and Web Push

Two layers, and the bell in the title bar is the switch for both.

1. **Tab-local.** Once notification permission is granted, a pane that settles
   on a question while the tab is *hidden* raises a `new Notification` from the
   page itself (`web/src/state.tsx`). Instant, no third party.
2. **Web Push.** If the desktop sent a `pushKey` in `hello-ok`, the page also
   subscribes through `public/sw.js` and hands the subscription to the desktop
   (`push-subscribe`). The desktop (`electron/web/push.ts`) then posts an
   encrypted payload to the browser vendor's push service on `asking` and
   `done` transitions — but only when no connected browser has said it is
   visible (`visibility` request). This is what reaches a closed tab or a
   locked phone. Tapping the notification focuses the open tab and jumps to
   the pane, or opens one on `/?session=<id>`.

Requirements: a secure context (HTTPS, or `localhost`); on iPhone the page
must be added to the home screen (Safari only exposes `PushManager` to an
installed web app — hence the manifest and `apple-` tags in `index.html`).
The desktop keeps its VAPID keypair and the subscription list in
`web-push.json` in the data dir; dead subscriptions (404/410) are dropped on
the next send. The service worker caches nothing — `lib/update.ts` still owns
the update story.
