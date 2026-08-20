# Working from GitHub when the host is unreachable — plan

Status: proposal, 2026-08-20. Nothing here is built yet except where marked *shipped*.

## What exists today (*shipped*)

- **GitHub mode in Forge Web** (`web/src/components/GitHubMode.tsx`, `web/src/lib/repo.tsx`,
  `web/src/lib/github.ts`). When the rendezvous record says the desktop is asleep, the browser
  offers the repository over the GitHub REST API: file tree, viewer, editor, and a commit that
  lands on a `forge-web/YYYY-MM-DD` branch — never on the default branch. Auth is a fine-grained
  PAT pasted once and kept in that browser. Gate: `npm run web:offline`.
- **Which repo a project maps to** reaches the browser in the git snapshot the desktop pushes
  (`remoteUrl`, stripped of credentials by `electron/git-remote.ts`). A project that was never
  opened while the desktop was awake shows the `unknown-remote` empty state.
- **Desktop git actions** (`electron/git/git-actions.ts`): fetch, `pull --ff-only`, push, switch,
  commit. Fetch only on project activation (10-minute staleness) — never on a timer.

Two things that look related but are not:

- **Claude Code Remote Control** (`shared/remote.ts`, `--remote-control`) is a second window
  onto a session still running on the PC. It dies with the PC. It is not a cloud runner.
- The rendezvous record has no `onDisconnect`, so after a power cut the browser can believe
  the host is alive for up to ~3 minutes (`electron/web/rendezvous.ts:38-62`). Phase B's banner
  inherits that delay; worth an `onDisconnect` write while in there.

GitHub mode only appears when the desktop is *down*. A browser connected to a live host never
shows it, which is why it is invisible in normal use.

## What is missing — the three gaps

### Gap 1 — GitHub is stale, so the fallback shows old code

Nothing on the desktop pushes automatically. Whatever an agent did this afternoon exists only in
the working tree on Steve's PC. When the host drops, the browser reads `master` on GitHub, which
may be days behind. This is the "GitHub doesn't get updated in Forge" complaint.

### Gap 2 — No agent in the browser

GitHub mode is an editor, by design ("the honest limitation" — no computer, no terminal). Editing
files by hand in a browser is not the Forge experience. The fallback needs a place to *run* an
agent that is not Steve's PC.

### Gap 3 — Nothing brings the work back

Decision 9 in `docs/forge-web.md` promised a desktop banner for `forge-web/*` branches with a
one-click pull. It was never built: `grep forge-web electron/ src/` finds only settings copy.
Commits made while away sit on a branch until someone remembers.

## Plan

### Phase A — Keep GitHub current (closes gap 1)

*Shipped 2026-08-20.* `electron/git/git-shelf.ts` (desktop), `web/src/lib/github.ts` +
`repo.tsx` (browser reads the newest `forge-wip/*/<default>` shelf when it is younger than the
default branch, badges it `SHELF · <MACHINE>`, and starts the `forge-web/*` branch from it).
Setting: `gitShelfEnabled`, app-wide rather than per-project for v1, on by default, toggle under
Settings → Advanced → "GitHub while away". Gates: `npm run shelf:smoke` (real git, scratch repo
and bare origin) and the extended `npm run web:offline`. One deviation from the sketch below: the
temporary index is seeded from HEAD, not the real index, so a half-staged `git add -p` does not
leak into the shelf.

Two mechanisms, both on the desktop, both reusing the git-watcher's existing "pane went idle"
trigger so nothing polls.

1. **Auto-push committed work.** When the watched project's branch is ahead of its upstream and
   the working tree is clean, push. Opt-in per project (`autoPush` on the project record),
   default on for projects that already have an origin. Uses the existing `push` action, so the
   set-upstream case is already handled.

2. **Shelf uncommitted work without touching the branch.** After each pane goes idle (debounced,
   ~30 s) and on app quit, snapshot index + working tree into a commit that is *not* on any local
   branch and push it to `refs/heads/forge-wip/<machine>/<branch>`:

   ```sh
   GIT_INDEX_FILE=.git/forge-wip.index git add -A
   tree=$(GIT_INDEX_FILE=.git/forge-wip.index git write-tree)
   commit=$(git commit-tree $tree -p HEAD -m "forge wip: <branch> @ <time>")
   git push --force origin $commit:refs/heads/forge-wip/<machine>/<branch>
   ```

   Force-push is correct here: the shelf is a mirror of one machine's tree, not history. Skip
   when the tree hash is unchanged since the last shelf. Respect `.gitignore` (`git add -A`
   does). Never run when a merge/rebase is in progress.

3. **Browser reads the freshest ref.** In `repo.tsx`, when entering GitHub mode, look for
   `forge-wip/*/<default>` and prefer it over the default branch when its commit is newer,
   with a badge: "Reading the shelf from STEVE-PC, 14 minutes before it went quiet."

Gate: extend `scripts/web-offline.mjs` — stub repo has a `forge-wip/` ref newer than `master`;
assert the tree on screen is the shelf.

### Phase B — A harness that runs in the browser (closes gap 2)

Options, ranked. None of them run on Steve's PC; all of them end with a branch on GitHub, which
is exactly what Phase C knows how to bring home.

| Option | What it is | Subscription-auth? | Verdict |
|---|---|---|---|
| **Claude Code on the web** (claude.ai/code) | Anthropic's cloud sandbox clones the GitHub repo, runs Claude Code, pushes a branch / opens a PR. Works in any browser. | Yes — same Claude subscription Forge already uses. | **Primary.** Zero infrastructure. |
| GitHub Codespaces | Full VM in the browser with a terminal; run `claude` in it. | Needs `claude login` inside the codespace (works, browser device flow). | Secondary — heavier, 60 free core-hours/month, but it is a real shell. |
| GitHub Actions + `anthropics/claude-code-action` | `@claude` on an issue/PR comment spins a runner. | No — needs an API key as a repo secret. | Optional later; nice for "fix this issue" from a phone. |
| Agent inside Forge Web (Claude API from the browser + GitHub REST edits) | No shell, no tests, no tools beyond read/write files. | No — API key in the browser. | Rejected. Implies a capability it doesn't have. |

**Which harness for which agent.** A browser tab has no shell, no Node, no git and no filesystem,
so nothing inside Forge Web can *be* the harness; it can only open the door to one.

| Agent in Forge | Harness when the host is down | Why |
|---|---|---|
| Claude (`claude`) | Claude Code on the web — cloud session | Anthropic's sandbox clones the repo and runs the full CLI; chat UI works on a phone. |
| Gemini (`gemini`) | Jules (jules.google) | Google's equivalent: GitHub-connected VM, pushes a branch. |
| GLM 5.3 (`claude --model 'glm-5.3[1m]'` + Z.ai base URL) | **GitHub Codespaces** | Cloud sessions run Anthropic models only — no `ANTHROPIC_BASE_URL` override, so GLM cannot ride them. A codespace is a Linux VM with the same CLI and the same env, so the pane is identical, just a terminal in a browser tab. |
| Grok, Codex, Kimi, Qwen, opencode, anything else | GitHub Codespaces | No vendor cloud runner worth linking; the codespace runs whatever CLI the devcontainer installs. |

Codespaces setup, once, in the repo: `.devcontainer/devcontainer.json` installing Node plus
`@anthropic-ai/claude-code`, `@google/gemini-cli` and the rest of the roster. Per-agent
credentials go in **Codespaces secrets** (Settings → Codespaces → Secrets, repo-scoped) so they
arrive as env without being in the repo: for GLM that is `ANTHROPIC_AUTH_TOKEN` and
`ANTHROPIC_BASE_URL`, exactly the pair `shared/agents.ts` rewrites for the `glm` profile. Each
CLI's own login persists inside the codespace. Free tier is 60 core-hours a month.

Honest limit: only Claude and Gemini get a phone-native chat. Everything else gets a terminal
in a browser tab. There is no way round that short of someone running a VM — which is what
Codespaces is.

Work for the primary option, all in `web/`:

1. **"Work in the cloud" on the offline banner.** When the desktop is asleep, `OfflineBanner`
   gains a third choice beside *Frozen* and *GitHub*: opens claude.ai/code with the repo
   preselected and a starting branch of the freshest ref from Phase A. Deep-link parameters
   should be verified against the live product before shipping; if the URL only accepts a repo,
   the starting branch is named in the prompt text instead.
2. **Prompt handoff.** The prompt box on the GitHub-mode screen can send its text to that link,
   so the gesture is: type what you want, one tap, cloud session opens with the repo and the ask.
3. **Branch awareness.** The GitHub-mode tree picker lists `claude/*` and `forge-web/*` branches
   (GitHub REST `GET /repos/{o}/{r}/branches`) so a finished cloud session's work is readable
   in Forge Web without leaving it. Pull requests via `GET /repos/{o}/{r}/pulls` — the desktop's
   `gh` module already knows the shape.
4. **Codespaces** is one more link on the same banner — `https://github.com/codespaces/new?repo=…&ref=…`.
   No further work; the dev-container file in the repo (add `.devcontainer/devcontainer.json`
   with Node + `@anthropic-ai/claude-code` preinstalled) makes it useful.

Gate: `web-offline.mjs` asserts the banner offers the cloud link with the right repo and ref.
The live claude.ai/code round trip is a manual check, once.

### Phase C — Bring it home when the host is back (closes gap 3)

On the desktop, in `electron/git-watcher.ts` and `src/components/git/`:

1. **Scan on fetch.** The existing fetch-on-activation already pulls `refs/remotes/origin/*`.
   After it, list `origin/forge-web/*`, `origin/forge-wip/*`, `origin/claude/*` whose tip is
   not an ancestor of the current branch. Add them to the snapshot as `inbound: GitBranch[]`.
2. **Banner in the GIT section, plus an OS notification.** "3 branches have work from while
   you were away" with, per branch: commits, files, age, source (browser edit / cloud session /
   shelf). The first time a new inbound branch is seen after Forge starts or the host comes back,
   a desktop toast (Electron `Notification`) says so — the same gesture as GitHub's own "this
   branch had recent pushes" bar — and clicking it opens the GIT section. The choice offered is
   exactly two buttons: **Update local files** (merge into the current branch) or **Keep the
   branch** (leave it on GitHub, stop nagging about this tip until it moves again). A dismissed
   branch is remembered by tip sha, so it returns only when there is something new.
3. **Actions**, reusing `runGitAction`:
   - *Merge* — `git merge --ff-only`, falling back to `git merge --no-edit`; conflicts open a
     pane with the conflict list pre-typed as a prompt (the repo already has the
     `resolving-merge-conflicts` skill pattern).
   - *Restore shelf* — for `forge-wip/<this-machine>/<branch>` only, and only when the local
     tree is clean: `git checkout <shelf-sha> -- .` then delete the remote ref. Never offered
     for another machine's shelf.
   - *Delete* — after merge, prune the remote branch so the list stays honest.
4. **Tray + web mirror.** The same `inbound` count shows on the tray tooltip and in Forge Web's
   GitPanel when live, so it is seen from either side.

Gate: extend `scripts/git-check.mjs` with a scratch repo + bare remote: create `forge-web/x` on
the remote, assert `inbound` reports it, merge it, assert it is gone.

### Phase D — Make offline rarer (already promised)

`forge-server` in the tray after window close is *shipped* (`electron/tray.ts`). Remaining: a
settings hint when the machine's power plan will sleep, and a "wake on LAN" note. Low priority;
Phases A–C make being offline cheap instead of trying to prevent it.

## Order and size

1. **A** first — without it the fallback reads stale code and nothing else matters. ~1 day.
2. **C** second — the shelf is only safe if the restore path exists. ~1 day.
3. **B** third — mostly links and a branch list once A and C exist. ~half a day, plus the manual
   claude.ai/code verification.

## Decisions to confirm

- Shelf push defaults on for every project with an origin, or opt-in? Proposal: on, with a
  per-project switch, because the whole point is that it is there when you did not plan to need it.
- Branch prefix for cloud sessions: Claude Code on the web names its own (`claude/…`); we match
  on that prefix rather than renaming.
- The PAT stays browser-side. A Cloud Function for a GitHub App flow is still deliberately out
  (`docs/forge-web.md`, Phase 4).
