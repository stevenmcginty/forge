/**
 * Types shared between the Electron main process, the preload bridge and the
 * renderer. Keep this file dependency-free — it is imported from all three
 * contexts.
 */

/* ------------------------------------------------------------------ agents */

/**
 * What a profile *is*, which is not the same question as what it runs.
 *
 * `shell` a bare prompt. Neutral chrome: it is a tool, not a collaborator.
 * `agent` something that takes instructions — Claude, Kimi, Gemini, your own.
 *
 * The chooser and the profile editor group by this, so "give me a shell" is
 * never buried three rows down a list of agents.
 */
export type ProfileKind = 'shell' | 'agent'

/**
 * How much an agent is allowed to do without asking, chosen per profile and
 * overridable per pane.
 *
 * The four names are Claude Code's, because it got here first — but they are
 * rungs on a ladder, not Claude's flags, and every agent that has a comparable
 * ladder is mapped onto them. `shared/agents.ts` owns that mapping (see
 * PERMISSION_FAMILIES); today Claude Code, Codex, Antigravity and Grok each
 * have one:
 *
 *                Claude Code                        Codex
 *   default      (no flag)                          (no flag)
 *   acceptEdits  --permission-mode acceptEdits      --full-auto
 *   plan         --permission-mode plan             --sandbox read-only
 *   bypass       --dangerously-skip-permissions     --dangerously-bypass-…
 *
 * Antigravity spells the same rungs with `--mode`; Grok reuses Claude's own
 * `--permission-mode` values verbatim — see their rows in PERMISSION_FAMILIES.
 *
 * `bypass` is exactly as advertised: the agent stops asking. Panes launched
 * with it are badged BYPASS in the header, because the one thing worse than a
 * dangerous mode is a dangerous mode you forgot you turned on.
 */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass'

/**
 * An agent profile describes *what gets typed into a fresh shell*. Every pane
 * is a real pwsh session; a profile just decides whether we bootstrap it with
 * a command (`claude`, `kimi`, …) so that when the agent exits the prompt is
 * still there.
 */
export interface AgentProfile {
  id: string
  name: string
  /** Command written into the fresh shell. Empty string = plain shell. */
  command: string
  /** Accent colour used for the badge + pane focus ring. */
  accent: string
  /** Two-letter badge, e.g. "CC". */
  badge: string
  /** Built-ins ship with the app and cannot be deleted (only edited). */
  builtin?: boolean
  /**
   * Register Forge's cross-agent bridge (the Gemini MCP server) with this
   * agent at launch. Only meaningful for agents that accept Claude Code's
   * `--mcp-config` flag. Set `false` explicitly to opt a built-in out.
   */
  mcpBridge?: boolean
  /**
   * Optional so profiles written before the split still load; the store fills
   * it in from the command (empty command = shell).
   */
  kind?: ProfileKind
  /** Default permission mode, for commands that have one (see permissionFamily). */
  permissionMode?: ClaudePermissionMode
  /**
   * Launch this agent with Claude Code's Remote Control, so the session can be
   * watched and driven from Steve's phone (see docs/REMOTE.md). Only meaningful
   * for agents that accept `--remote-control`; set `false` to opt a built-in
   * out. Undefined means off, so a custom profile never gets a flag its tool
   * has never heard of.
   */
  remoteControl?: boolean
}

/* ---------------------------------------------------------------- projects */

export interface Project {
  id: string
  name: string
  /** Absolute folder path — the cwd for every session in this workspace. */
  path: string
  /** Colour dot in the rail. */
  color: string
  /** Profile used when a pane is opened without an explicit choice. */
  defaultProfileId: string
  createdAt: number
  /**
   * Where this project pushes — its GitHub remote, shown in the project menu
   * and handed to every pane in the workspace as `FORGE_REPO_URL`.
   *
   * The point is agents talking to each other without Steve in the middle:
   * Claude sets the repo up in one tab, and the Antigravity opened in the next
   * one already knows the URL rather than being told it. Filled in by hand, or
   * detected from `git remote get-url origin` the first time the menu is opened
   * on a folder that has grown an origin.
   *
   * Optional because projects saved before it existed have no field at all, and
   * because a folder with no remote yet is a perfectly normal project.
   */
  repoUrl?: string
  /**
   * Held at the top of the rail, above the scroller, however far the list below
   * is scrolled.
   *
   * The project list is the one rail section with no height of its own — it
   * takes the stack's slack — so a long list is a scrolling list, and the two or
   * three folders that are open every day are exactly the ones that scroll away.
   * Pinning is what fixes them.
   *
   * It changes where a project is *drawn*, never the order of this array:
   * `moveProject` still works in canonical indices, and the pinned block simply
   * renders the pinned entries in the order they already sit in. Which is what
   * lets dragging a row across the seam mean "pin it" — the drop sets this flag
   * and performs the ordinary move, rather than needing a second notion of order
   * that could disagree with the first.
   *
   * Optional, and absent on every project saved before it existed.
   */
  pinned?: boolean
}

/* ------------------------------------------------------------ pane layouts */

export type SplitDirection = 'row' | 'column'

/** A terminal pane. `id` doubles as the PTY session id. */
export interface PaneLeaf {
  type: 'leaf'
  id: string
  profileId: string
  /** User-editable title. Empty = derive from the profile name. */
  title: string
  /**
   * Per-open override of the profile's permission mode, chosen in the chooser.
   * Absent = whatever the profile says.
   */
  permissionMode?: ClaudePermissionMode
  /**
   * The Claude Code session this pane owns, as a uuid Forge minted when the
   * pane was created.
   *
   * This is the whole of resume-on-restore: because it is saved with the
   * layout, reopening Forge can hand the same id back to Claude and get the
   * same conversation, rather than the same empty box. Optional so panes
   * written before it existed still load — they are given one on load, and
   * simply start fresh that once. See shared/session.ts.
   */
  sessionId?: string
}

export interface PaneSplit {
  type: 'split'
  id: string
  /** `row` = side by side, `column` = stacked. */
  direction: SplitDirection
  /** Fraction of the axis taken by `a` (0.1 – 0.9). */
  ratio: number
  a: LayoutNode
  b: LayoutNode
}

export type LayoutNode = PaneLeaf | PaneSplit

export interface TerminalTab {
  id: string
  title: string
  root: LayoutNode
  activePaneId: string
  /**
   * The tab's own colour in the strip. Optional so tabs written before colours
   * existed still load, and absent — not empty — when the tab is untinted.
   */
  color?: string
  /**
   * Terminal text colour for every pane in this tab: the default foreground
   * xterm paints uncoloured output in, which is most of what an agent prints.
   * Output that names its own ANSI colour keeps it — that is the point of it.
   */
  textColor?: string
}

/**
 * How a project's terminal workspace is presented.
 *
 * `tabs`   one tab at a time, its pane tree at full size — the working view.
 * `mosaic` every live pane in the project as a small live tile — the peek view.
 */
export type WorkspaceViewMode = 'tabs' | 'mosaic'

/* ------------------------------------------------------------ mosaic wall */

/** A tile's box on the freeform mosaic wall, in wall pixels from its top-left. */
export interface MosaicRect {
  x: number
  y: number
  w: number
  h: number
}

/** A tile's placement, plus how its terminal is shown inside it. */
export interface MosaicTile extends MosaicRect {
  /**
   * True once the user double-clicked the header: the PTY is refitted to the
   * box (real cols/rows, life-size type) instead of being scaled into it, and
   * follows the box from then on. Opt-in per tile — see MosaicView.
   */
  fit?: boolean
}

/**
 * How the wall arranges itself.
 *
 * `auto`   the uniform grid: Forge places every tile, nobody drags anything.
 * `custom` freeform: every tile has a box the user put it in.
 */
export type MosaicLayoutMode = 'auto' | 'custom'

/**
 * How the mosaic draws terminal text — the wall's one legibility decision.
 *
 * `lifesize` every tile refits its PTY to its own box, so the type is exactly
 *            the size it is in tab view no matter how many tiles are up. You
 *            trade columns for letters: eight tiles means eight narrow
 *            terminals, not eight unreadable ones.
 * `scaled`   every tile is a scale model — the PTY keeps the cols and rows it
 *            had in tab view and the whole picture is shrunk to fit, so a
 *            full-screen TUI never reflows. Truthful, and past four or five
 *            tiles, tiny.
 *
 * A tile the user double-clicked overrides this either way — see MosaicTile.
 */
export type MosaicTextMode = 'lifesize' | 'scaled'

/** A project's freeform wall. Absent until the user first moves a tile. */
export interface MosaicState {
  mode: MosaicLayoutMode
  /** paneId → box. Only read in `custom` mode. */
  tiles: Record<string, MosaicTile>
  /**
   * Tabs the user dragged out of the strip and onto the wall. Purely a marker:
   * the tab itself is untouched, and its panes were already on the wall — the
   * strip just says which ones you placed by hand.
   */
  wallTabs: string[]
}

/** One project's terminal workspace. */
/**
 * One task on the delegation tray: a prompt written once, waiting to be
 * dragged onto whichever agent should do it. The card *is* the delegation
 * mechanism — there is no queue engine behind it, deliberately.
 */
export interface TaskCard {
  id: string
  text: string
  createdAt: number
}

/** A plan the tasks-panel planner session emitted in a ```tasks fence. */
export type PlannerUpdate = {
  projectId: string
  /** Prose plan, when the model sent one. */
  plan: string | null
  /** Self-contained task briefs, ready to become cards. */
  tasks: string[]
  /** Monotonic per-watch sequence so the renderer can ignore stale pushes. */
  seq: number
}

/* ---------------------------------------------------------------- the rail */

/**
 * The left rail's five sections.
 *
 * `projects` and `tasks` are the rail as it has always been, rehoused; `git`,
 * `activity` and `share` came later and are off until asked for. The order is
 * fixed and lives in shared/rail.ts, not here — this type is only the
 * vocabulary.
 */
export type RailSectionId = 'projects' | 'tasks' | 'git' | 'activity' | 'share'

/* ----------------------------------------------------------------- git (M12) */

/**
 * Where a branch stands against its upstream.
 *
 * The vocabulary is GitLens', deliberately: ahead / behind / diverged / gone is
 * already in the head of anyone who has used a git UI in the last decade, and
 * inventing a fifth spelling of it would buy nothing.
 *
 * `unknown` is not a failure — it is what a detached HEAD or a repository with
 * no commits honestly is. There is nothing to be ahead or behind of yet.
 */
export type GitUpstreamState =
  | 'unpublished'
  | 'synced'
  | 'ahead'
  | 'behind'
  | 'diverged'
  | 'gone'
  | 'unknown'

/** One record of `git status --porcelain=v2`, already interpreted. */
export interface GitFileChange {
  /**
   * Repo-relative with forward slashes — exactly as git prints it, and the form
   * the change tree is built from. Never compared against an absolute path
   * without lowercasing both: NTFS is case-insensitive and git is not.
   */
  path: string
  /** Absolute, with backslashes. What a drag onto a pane needs. */
  absPath: string
  /** The two porcelain columns verbatim: 'M.', '.M', 'A.', '??', 'UU'… */
  xy: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
  /** A submodule entry. One row, never recursed into. */
  submodule: boolean
  /** The previous path, for a rename record. */
  from?: string
}

export interface GitPullRequest {
  number: number
  title: string
  url: string
  isDraft: boolean
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  headRefName: string
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
}

export interface GitBranch {
  name: string
  current: boolean
  /** A refs/remotes/* entry. Only present after the Remote group is expanded. */
  remote: boolean
  upstream: string | null
  ahead: number
  behind: number
  state: GitUpstreamState
  /** Committer date in ms. The list is sorted by this, newest first. */
  lastCommitAt: number
  lastSubject: string
  /**
   * Only ever set when `gh` answered. Absent means "unknown", never "no pull
   * request" — the difference matters, because gh being absent or logged out is
   * the common case and must not be rendered as "this branch has no PR".
   */
  pr?: GitPullRequest
}

/**
 * What switching to a branch would actually do, measured from where you stand.
 *
 * The marks on a branch row answer "how does this branch compare to *origin*",
 * which is a genuinely different question to the one being asked at the moment
 * a finger is over the row — that one is "how does it compare to *here*". A
 * branch forty commits behind master and never pushed carries `▲+`, the mark
 * for unpublished, and nothing at all about the forty commits. Switching to it
 * empties them out of the working tree, which is how a click on an ordinary
 * looking row turns into "the app reverted itself".
 *
 * So this is the number the confirmation is built on, and it is read on demand
 * — one `rev-list` when a row is armed — rather than for every branch on every
 * poll, which would be twenty processes a second for a number nobody is
 * looking at yet.
 */
export interface GitBranchCompare {
  branch: string
  /** Commits HEAD has that the target does not. The rewind, stated as a count. */
  leaving: number
  /** Commits the target has that HEAD does not. */
  gaining: number
  /** Set when the two could not be compared — an unborn HEAD, a vanished ref. */
  error?: string
}

/**
 * Why there is no git answer for a project.
 *
 * Every one of these is a perfectly ordinary state for a folder to be in, not a
 * fault, and the UI says so in each case. A folder with no repository is the
 * state Forge was built for first; git is the addition.
 */
export type GitPresence = 'ok' | 'no-git' | 'no-repo' | 'no-folder' | 'error'

export interface GhState {
  status: 'absent' | 'unauthenticated' | 'ready' | 'error'
  login: string | null
  /** The open pull request whose head is the current branch. */
  currentPr: GitPullRequest | null
  checkedAt: number | null
}

export interface GitSnapshot {
  projectId: string
  /** Monotonic per project. The renderer discards anything older than it holds. */
  seq: number
  at: number
  presence: GitPresence
  /** One sentence from gitFailureReason(). Only when presence is 'error'. */
  error?: string
  repoRoot: string | null
  /** Null when detached or unborn. */
  branch: string | null
  detached: boolean
  /** True before the very first commit — porcelain v2's `# branch.oid (initial)`. */
  unborn: boolean
  /** Short sha, or null when unborn. */
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  state: GitUpstreamState
  remoteUrl: string | null
  /** `owner/repo`, only when remoteUrl is a github.com URL. Gates every gh call. */
  slug: string | null
  files: GitFileChange[]
  /** True when `files` was cut at GIT_MAX_FILES. The counts below are still true. */
  filesTruncated: boolean
  changed: number
  staged: number
  conflicted: number
  /** Local branches, newest commit first. Remote branches only after gitRemoteBranches. */
  branches: GitBranch[]
  /**
   * The mtime of FETCH_HEAD, so "fetched 6m ago" is honest.
   *
   * Read off the filesystem rather than tracked in memory on purpose: a fetch an
   * agent ran in a pane counts, and the answer survives a restart.
   */
  fetchedAt: number | null
  /** Set once a status read has taken longer than GIT_SLOW_MS. Slows the poller. */
  slow: boolean
  gh: GhState
}

export type GitActionKind = 'fetch' | 'pull' | 'push' | 'switch' | 'commit'

export type GitInboundKind = 'web' | 'cloud' | 'shelf'

export interface GitInbound {
  name: string
  kind: GitInboundKind
  sha: string
  commits: number
  lastCommitAt?: number
  lastSubject?: string
  dismissed: boolean
  machine?: string
  of?: string
}

export interface GitActionRequest {
  /**
   * A project id, never a path. Main resolves it against its own project list,
   * so the renderer cannot ask Forge to run git in an arbitrary folder.
   */
  projectId: string
  action: GitActionKind
  /** switch only. Must match a branch in the live snapshot. */
  branch?: string
  /** commit only. */
  message?: string
}

export interface GitActionResult {
  ok: boolean
  /** From gitFailureReason() — never raw git stderr. */
  error?: string
  /** The freshly re-read state, so the UI can never show a pre-action answer. */
  snapshot?: GitSnapshot
}

/* ------------------------------------------------------------ activity (M12) */

export type ActivityKind = 'read' | 'edit' | 'write'

/**
 * How much we actually know about who touched a file.
 *
 * 'exact'    read out of a Claude Code transcript's tool_use block — the pane
 *            and the path came from the same record, so there is no matching to
 *            get wrong.
 * 'inferred' seen on disk while exactly one pane happened to be working. True
 *            often enough to be useful, and marked so it is never mistaken for
 *            the first kind.
 */
export type ActivityExactness = 'exact' | 'inferred'

export interface ActivityEntry {
  /** Project-relative, forward slashes. The tree is built from this. */
  path: string
  absPath: string
  /** '' when nothing could be credited — rendered under "Unattributed". */
  paneId: string
  profileId: string
  exactness: ActivityExactness
  kind: ActivityKind
  at: number
  hits: number
}

export interface ActivitySnapshot {
  projectId: string
  seq: number
  entries: ActivityEntry[]
  /** At least one entry is a guess — drives the footer note. */
  hasInferred: boolean
  /** Entries were dropped at ACTIVITY_MAX_ENTRIES. */
  truncated: boolean
  /** The folder watcher hit its burst brake. Say so rather than lie by omission. */
  stormy: boolean
}

/**
 * What the renderer tells main about a pane, because only the renderer knows
 * which profile a pane is running and which Claude session it owns.
 */
export interface ActivityPane {
  paneId: string
  profileId: string
  /** Set only for Claude panes with a session — the key to the exact half. */
  sessionId?: string
}

/* --------------------------------------------------------------- share (M13) */

/**
 * How a slot came to be written. Cosmetic, and one value is load-bearing:
 * `agent` is what a slot with no Forge front matter reads back as, i.e. a file
 * an agent wrote with its own tools rather than through Forge. That is a
 * supported way to fill a slot, not a corruption to be repaired.
 */
export type ShareVia = 'rail' | 'mcp' | 'capture' | 'agent'

/**
 * One of the five pigeonholes, as the rail sees it.
 *
 * `preview` rather than the body, deliberately: five 64 KiB bodies is 320 KiB
 * structured-cloned across the preload boundary on every write, to draw five
 * one-line rows. The body is fetched by `share.read()` when a row is opened.
 */
export interface ShareSlot {
  /** 1..SHARE_SLOTS. The slot's identity — no caller ever passes a path. */
  index: number
  filled: boolean
  title: string
  /** First SHARE_PREVIEW_CHARS characters, newlines collapsed. Never the body. */
  preview: string
  bytes: number
  lines: number
  /** Epoch ms. The file's mtime when the front matter does not say. */
  updatedAt: number
  /** '' when nobody claimed it. */
  author: string
  via: ShareVia
  /** The body hit SHARE_MAX_BYTES and lost its tail. */
  truncated: boolean
  /** Set when the file could not be read. The row goes dim; nothing throws. */
  problem?: string
}

/**
 * A pane in this project, as written to `.forge/share/panes.json`.
 *
 * Composed in the renderer, because it is the only side that knows which
 * profile a pane runs and what `paneDisplayTitle` makes of its nickname.
 * Deliberately carries no busy flag: busy changes every few seconds, and a file
 * that churns wakes every watcher anyone has pointed at their repo.
 */
export interface SharePane {
  paneId: string
  /** paneDisplayTitle(profile, leaf.title) — the name a person would say. */
  title: string
  /** The profile's name: 'Claude Code', 'Codex', … */
  agent: string
  profileId: string
  openedAt: number
}

export interface ShareSnapshot {
  projectId: string
  /** Monotonic per-watch, so the renderer can ignore a stale push. */
  seq: number
  at: number
  presence: 'ok' | 'no-folder' | 'error'
  error?: string
  /** Absolute path to `<project>/.forge/share`. */
  root: string
  /**
   * Is `.forge/` in `.git/info/exclude`? False also means "not a plain repo" —
   * a worktree or submodule is skipped rather than guessed at.
   */
  excluded: boolean
  filled: number
  /** Always SHARE_SLOTS long, in index order, filled or not. */
  slots: ShareSlot[]
  panes: SharePane[]
}

/** One slot's full text, fetched only when a row is opened for reading. */
export interface ShareSlotBody {
  index: number
  title: string
  body: string
  bytes: number
  updatedAt: number
  author: string
  via: ShareVia
  truncated: boolean
}

export interface ShareWriteRequest {
  index: number
  title: string
  body: string
  author: string
  via: ShareVia
  /** Add to what is there rather than replace it. */
  append?: boolean
  /**
   * The `updatedAt` the caller last read.
   *
   * Three agents can hold the same slot open, so a write that does not say what
   * it was editing is a write that can silently lose somebody's work. A mismatch
   * is refused with a sentence naming who got there first; the caller decides
   * whether to reload or overwrite. Omitted means "I know I am clobbering".
   */
  expectUpdatedAt?: number
}

export interface ShareWriteResult {
  ok: boolean
  error?: string
  /** The slot moved under the caller. `error` says who moved it. */
  conflict?: boolean
  truncated?: boolean
  /** Bytes lost to truncation, so the caller can say so out loud. */
  dropped?: number
  slot?: ShareSlot
  /** Freshly re-read, like GitActionResult — no UI ever shows a pre-write answer. */
  snapshot?: ShareSnapshot
}

export interface Workspace {
  tabs: TerminalTab[]
  activeTabId: string | null
  /** The delegation tray. Optional so workspaces written before it existed still load. */
  tasks?: TaskCard[]
  /** Optional so workspaces written before the mosaic existed still load. */
  viewMode?: WorkspaceViewMode
  /** Optional so workspaces written before the freeform wall existed still load. */
  mosaic?: MosaicState
  /**
   * How far through TAB_NAME_POOL this project has got. Kept on the workspace
   * rather than recomputed from the open tabs so that closing a tab does not
   * hand its name straight back to the next one — the name you just killed
   * should not reappear on something else a second later.
   *
   * Optional so workspaces written before tabs had names still load.
   */
  nameCursor?: number
  /**
   * The Claude session id of the tasks panel's planner terminal, so the panel
   * resumes the same conversation across restarts rather than starting a new
   * one — and so the watcher knows which transcript on disk to tail.
   *
   * Optional so workspaces written before the panel existed still load.
   */
  plannerSessionId?: string
  /**
   * The URL the Devices preview points this project's phone frames at, typed by
   * hand. It wins over `detectedUrl` whenever it is set: a URL somebody chose is
   * never overruled by one Forge merely noticed, and an empty field is how you
   * hand the decision back to the detector.
   *
   * Optional so workspaces written before the project preview existed still load.
   */
  previewUrl?: string
  /**
   * The last local dev-server URL seen in this project's own terminal output —
   * `findDevServerUrl` in shared/devserver.ts, tapped by TerminalHost. What the
   * preview falls back to when nothing was typed, and what the "detected"
   * affordance offers when something was.
   */
  detectedUrl?: string
  /** When that URL was seen, so a stale one can say how old it is. */
  detectedUrlAt?: number
  /**
   * The command the Devices preview's Start button runs for this project, typed
   * by hand. It wins over the sniff (`PreviewDevCommand`) whenever it is set,
   * under the same rule as `previewUrl` over `detectedUrl`: a line somebody
   * chose is never overruled by one Forge guessed, and an empty field hands the
   * decision back to the guess.
   *
   * It is also the only way a folder with no package.json — a static site, a
   * python app — gets a Start button at all, and the one thing that outranks
   * the self-preview latch on Forge's own checkout.
   *
   * Optional so workspaces written before the Start button existed still load.
   */
  devCommand?: string
}

/**
 * A workspace the main process has just changed, on its way down to the
 * renderer. See `IPC.workspaceReplaced`.
 *
 * The renderer *follows* this rather than reconciling with it: a phone's
 * close-pane was performed in main against the authoritative layout
 * (electron/layout-engine.ts), so what arrives here is not a suggestion. Where
 * the desk had an unpersisted change of its own in the same quarter-second, the
 * replacement still wins — remote ops are rare and a lost 250ms of divider drag
 * is a cheaper failure than a phone whose taps do nothing.
 *
 * `reason` exists so a follower can tell a remote op from anything else that
 * might one day push a layout down. Today there is only one.
 */
export interface WorkspaceReplacedEvent {
  projectId: string
  workspace: Workspace
  reason: 'remote-op'
}

/* ------------------------------------------------------------------- shots */

/**
 * One screenshot on the shelf, as the renderer sees it. The main process owns
 * the files (see electron/shots/shelf.ts) and hands over a thumbnail data URL
 * rather than a path, because a renderer cannot read `file://` under our CSP —
 * and because 12 full-size 4K PNGs decoded in the DOM is not a tray, it is a
 * memory leak with rounded corners.
 */
export interface Shot {
  /** The file name — stable identity for keys and delete calls. */
  id: string
  name: string
  path: string
  createdAt: number
  bytes: number
  /** Pixel size of the original image. */
  width: number
  height: number
  /** PNG data URL, scaled to fit the tray (and a hover preview). */
  thumb: string
}

/* ---------------------------------------------------------------- settings */

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

/**
 * Which interpreter the voice agent talks to. `gemini` and `openrouter` are the
 * live ones; `stub` is the offline fallback used whenever no key is set.
 */
export type VoiceBrainId = 'stub' | 'gemini' | 'openrouter' | 'groq' | 'claude' | 'openai'

/**
 * How the voice agent answers.
 *
 *   text   written only — the panel as it has always been
 *   both   written and spoken (the default)
 *   voice  spoken only, and the panel collapses to the round button
 */
export type VoiceReplyMode = 'text' | 'both' | 'voice'

/**
 * Where the voice hub is, and how big.
 *
 *   docked    the pill lives in the status bar, as it always has
 *   floating  a bigger pill floating over the app, dragged anywhere
 *   expanded  the Voice Hub card — dial, conversation, composer
 *
 * These three are the *whole* of the voice agent's chrome now: the right-hand
 * panel it used to live in is gone, along with its `voicePanelOpen` and
 * `voicePanelWidth`. Steve's reason was the plain one — it was taking up all
 * that space to show what the hub already shows.
 *
 * `x`/`y` are the top-left of the floating thing in viewport pixels. They are
 * remembered while docked too, so dragging it out a second time puts it back
 * where he last had it rather than in the middle of his terminals. `w`/`h` are
 * the card's size after a corner-drag; 0 means "the default card", which is
 * what every install starts with.
 */
export type VoiceHubMode = 'docked' | 'floating' | 'expanded'

export interface VoiceHubPlacement {
  mode: VoiceHubMode
  x: number
  y: number
  w: number
  h: number
}

/** `create_project`, as it crosses to the main process. */
export interface MakeProjectFolderRequest {
  name: string
  /** 'desktop' | 'documents' | 'projectsroot', or an absolute allowed root. */
  parentDir?: string
}

export type MakeProjectFolderResult =
  | { ok: true; path: string; name: string }
  | { ok: false; error: string; path?: string }

/* ------------------------------------------------------- voice-agent ipc */

export interface GeminiCallRequest {
  key: string
  model: string
  system: string
  /** Oldest first. `model` is Gemini's own past replies. */
  turns: Array<{ role: 'user' | 'model'; text: string }>
  /** JSON schema handed to responseSchema, when the caller wants strict JSON. */
  schema?: unknown
  timeoutMs?: number
}

export type GeminiCallResult =
  | { ok: true; text: string; finishReason?: string; model?: string }
  | { ok: false; error: string; status?: number }

/**
 * OpenRouter's chat-completions call. Deliberately OpenAI-shaped, because that
 * is the API OpenRouter speaks — `system` is folded into the first message by
 * the main process rather than here.
 */
export interface OpenRouterCallRequest {
  key: string
  model: string
  system: string
  /** Oldest first. `assistant` is the model's own past replies. */
  turns: Array<{ role: 'user' | 'assistant'; text: string }>
  /** Ask for `response_format: { type: 'json_object' }`. */
  json?: boolean
  maxTokens?: number
  timeoutMs?: number
}

export type OpenRouterCallResult =
  | { ok: true; text: string; finishReason?: string; model?: string }
  | { ok: false; error: string; status?: number }

/**
 * Groq's call, which is the same call.
 *
 * Groq serves the OpenAI chat-completions API verbatim, so the wire shape is
 * byte-for-byte what OpenRouter takes — and these are aliases rather than a
 * second interface on purpose. One shape means one implementation in
 * electron/voice-bridge.ts (`callChat`), and a field added for one provider
 * cannot go missing for the other.
 */
export type GroqCallRequest = OpenRouterCallRequest
export type GroqCallResult = OpenRouterCallResult

/** Which on-disk key a `voice:import-key` call is after. */
export type KeySource = 'gemini' | 'openrouter' | 'groq'

export type ImportedKeyResult =
  | { ok: true; key: string; last4: string; source: string }
  | { ok: false; error: string }

/* ------------------------------------------------------------------ themes */

/**
 * A theme is a *core* of eight-odd colours plus the sixteen terminal slots.
 * Everything else in tokens.css (sunken wells, hovers, hairlines, the accent
 * washes, muted ink) is derived from those by mixing — see src/theme/themes.ts.
 *
 * That is what makes the theme editor tractable: you pick a background, a panel,
 * an ink and an accent, and the other forty tokens follow without you having to
 * keep them in step by hand.
 */
export interface ThemeCore {
  id: string
  name: string
  /** Drives the derivation direction and any light-only CSS. */
  appearance: 'dark' | 'light'
  /** App background. */
  bg: string
  /** Rail, trays, status bar — the raised furniture. */
  panel: string
  /** Primary ink. */
  text: string
  /** The one loud colour: live / focused / go. */
  accent: string
  danger: string
  warn: string
  info: string
  ok: string
  /** xterm canvas — usually a shade off `bg`. */
  termBg: string
  termFg: string
  /**
   * The sixteen ANSI slots in the canonical order:
   * black red green yellow blue magenta cyan white, then the eight brights.
   */
  ansi: string[]
  /** Set on themes the user made, so they can be deleted. */
  custom?: boolean
  /** Which built-in this one started life as. */
  basedOn?: string
}

/* -------------------------------------------------------- system probes */

export type ClaudeCliState =
  | { ok: true; version: string }
  | { ok: false; error: string }

/* ------------------------------------------------------ updates & tools */

/** The tools the Updates & Tools section reports on. See shared/tools.ts. */
/**
 * A tool's id.
 *
 * A plain string rather than a union of the five Forge shipped with, because the
 * catalogue is no longer fixed: a row can be one of ours or one that was added
 * in Settings, and a union would have made "the thing I use is not on this list"
 * a code change. Ids added by hand are prefixed `x:` by `sanitiseCustomTool`, so
 * a custom row can never collide with or shadow a built-in one.
 */
export type ToolId = string

/** Where "the latest version" comes from for a given tool. */
export type ToolLatestSource = 'npm' | 'winget' | 'local' | 'none'

export interface ToolSpec {
  id: ToolId
  name: string
  /** One line under the name, explaining what this thing is to Forge. */
  blurb: string
  /** The executable to look for on PATH. */
  command: string
  /** Arguments that make it print its version, or null to never spawn it. */
  versionArgs: string[] | null
  latest: {
    source: ToolLatestSource
    /** For `npm`. */
    npmPackage?: string
    /** For `winget`, tried in order until one is installed. */
    wingetIds?: string[]
  }
  /**
   * The command the Update button types into a pane, when the obvious one from
   * `latest.source` is wrong. Null is not "no update button": for an npm or
   * winget tool `updateCommandFor()` derives one. It means "nothing better than
   * the derived command" — and, when there is no source to derive from either,
   * that this is a local shim Forge has no business updating.
   */
  updateCommand: string | null
  /**
   * What to type when the tool is *not* installed. Same rule: usually derived
   * from the source, set here only when the obvious command is wrong.
   */
  installCommand?: string | null
  /** Added in Settings rather than shipped. Only these can be edited or removed. */
  custom?: boolean
}

/** What is on this machine right now. */
export interface ToolProbe {
  id: ToolId
  /** Resolved on PATH? */
  found: boolean
  /** Absolute path, when found. */
  path?: string
  /** Parsed installed version, when one could be read. */
  version?: string
  /** Why there is no version, when there is not. */
  error?: string
}

/** What the outside world says the latest version is. */
export interface ToolLatest {
  id: ToolId
  source: ToolLatestSource
  latest?: string
  /** winget only: the package id that actually answered. */
  via?: string
  /** Set when the check could not be made — offline, 404, no winget. */
  error?: string
  /** Epoch ms of the answer, so the UI can say how stale it is. */
  checkedAt: number
}

/* ------------------------------------------------------ forge self-update */

/**
 * The self-updater's whole visible state. `unsupported` is the honest answer in
 * a dev run and in any build with no publish feed behind it — it is not an
 * error, and the banner must never appear for it.
 */
export type UpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  /** The version being offered, when there is one. */
  version?: string
  /** 0–100 while downloading. */
  percent?: number
  bytesPerSecond?: number
  error?: string
  /** True when this status came from FORGE_FAKE_UPDATE rather than a real feed. */
  simulated?: boolean
}

/** The two bundles a dev run rebuilds but cannot hot-reload into itself. */
export type StaleBundle = 'main' | 'preload'

/**
 * "The bundle on disk is newer than the one this process is running."
 *
 * The dev-run counterpart to UpdateStatus, and mutually exclusive with it: a
 * packaged build is always `{ stale: false }` because its bundles cannot change
 * underneath it, and a checkout is always `unsupported` for updates. See
 * electron/stale-watcher.ts.
 */
export interface StaleStatus {
  stale: boolean
  /** Which bundles changed since boot. Empty when the app is current. */
  changed: StaleBundle[]
  /** mtime of the newest rebuild, or null when nothing has changed. */
  at: number | null
  /**
   * The version a restart would boot into — package.json as it is on disk *now*,
   * not as it was when this process started. On the stable checkout the strip
   * leads with this ("Forge v0.2.2 is ready"), because there "the code changed
   * on disk" almost always means "an update was pulled in".
   */
  version?: string
  /** Which checkout this is, from FORGE_CHANNEL. Stable wording differs from dev. */
  channel?: 'dev' | 'stable'
}

/**
 * The stable checkout keeping itself level with origin — the "Update available"
 * button for an app that is also a git repo. `available` is origin ahead of
 * HEAD; `updating` is the click being honoured (pull, then install only when
 * the dependency files moved); `error` is a pull or install that needs a
 * human. See electron/source-updater.ts.
 */
export type SourceUpdateStatus =
  | { phase: 'unsupported' }
  | { phase: 'idle' }
  | { phase: 'available'; behind: number; version?: string }
  | { phase: 'updating'; step: 'pull' | 'install'; version?: string }
  | { phase: 'error'; error: string }

/* --------------------------------------------------------- media generation */

/**
 * Generate an image. `projectPath` decides where it lands: the current project's
 * `assets/generated/`, falling back to %APPDATA%\Forge\bridge-out when no
 * project is open. The key is read from settings in the main process — it never
 * travels from the renderer.
 */
export interface MakeImageRequest {
  description: string
  count?: number
  aspect?: string
  projectPath?: string
}

export interface EditImageRequest {
  path: string
  instruction: string
  projectPath?: string
}

export interface MakeVideoRequest {
  description: string
  /** `16:9` or `9:16` — Veo takes no other shape. */
  aspect?: string
  /** Seconds, 4–8. */
  duration?: number
  projectPath?: string
}

export type MediaCallResult =
  | {
      ok: true
      /** Absolute paths of files actually written. Never empty. */
      paths: string[]
      model: string
      ms: number
      /** How many landed on the screenshot shelf. */
      adopted: number
      note?: string
    }
  | { ok: false; error: string; kind: string }

/* ------------------------------------------------------------ neural speech */

/**
 * Which engine says the agent's replies out loud.
 *
 *   edge    Microsoft's neural voices, over the same endpoint Edge's own Read
 *           Aloud uses — a real voice, no key, and no meaningful quota. The
 *           default, because it is the only neural engine that cannot run out
 *           mid-conversation.
 *   gemini  Google's TTS models — a real voice, needs a key and the network,
 *           and a free key runs out after ~6 sentences a minute. Kept for the
 *           thirty prebuilt voices.
 *   local   Chromium's `speechSynthesis`, i.e. Windows SAPI — no key, no
 *           network, and the thing Steve called robotic
 *
 * `local` is not merely a choice: it is what speaks when every neural engine is
 * missing, refused or unreachable. Falling back is automatic and announced
 * once — dead air would be worse than a robot. What the fallback chain must
 * never do is swap voices casually: the quota-driven Gemini→SAPI swap mid-reply
 * is the exact bug that made the edge engine the default.
 */
export type VoiceEngine = 'edge' | 'gemini' | 'local'

export interface VoiceSpeakRequest {
  text: string
  /**
   * Which neural engine to ask. Empty means Gemini, because every caller
   * predates the edge engine and that is what they meant.
   */
  engine?: 'edge' | 'gemini'
  /**
   * A voice name the chosen engine knows — `Sulafat` for Gemini,
   * `en-GB-SoniaNeural` for edge. Empty means that engine's default.
   */
  voice?: string
  /** Gemini only. Empty means the model in settings, which defaults to 3.1 flash. */
  model?: string
  /**
   * Barge-in handle. Pass the same id to `voice:speak-cancel` to abort this
   * request mid-flight. Anything falsy simply cannot be cancelled.
   */
  requestId?: string
}

export type VoiceSpeakResult =
  | {
      ok: true
      /**
       * Base64 audio. For `format: 'pcm16'` it is raw PCM — signed 16-bit
       * little-endian, `channels` interleaved, no WAV header. For
       * `format: 'mp3'` it is an MP3 file the renderer decodes with
       * `decodeAudioData`. Base64 rather than a typed array because it is what
       * the API already returned and what survives contextBridge unambiguously.
       */
      audio: string
      /**
       * How `audio` is encoded. Absent means `pcm16` — the only format that
       * existed before the edge engine.
       */
      format?: 'pcm16' | 'mp3'
      /** The mime the provider sent, verbatim. Spellings differ between models. */
      mime: string
      /** For pcm16. An mp3 carries its own rate; the decoder finds it. */
      sampleRate: number
      channels: number
      /** The model that actually spoke, which is not always the one asked for. */
      model: string
      voice: string
      ms: number
      /** Said when a fallback model answered instead of the requested one. */
      note?: string
    }
  | { ok: false; error: string; kind: string }

/* ------------------------------------------------- the Claude voice brain */

/**
 * The persistent Claude Agent SDK session that lives in the main process.
 *
 * Everything below is the wire between it and the renderer. Two things about
 * the shape are deliberate:
 *
 *  - **Events go one way, tools go the other.** The brain streams its reply out
 *    on `voice-agent:event`; when it wants to *know* something about Forge it
 *    asks, on `voice-agent:tool-request`, and the renderer answers. Only the
 *    renderer knows what is on screen, so the main process never guesses.
 *
 *  - **No manifest.** The old brains posted ~3,000 tokens of app state as the
 *    system prompt on every turn. This one has a static persona and a
 *    `get_app_state` tool, which is why the prompt caches and why the session
 *    can stay open across turns for free.
 */

/**
 * One thing the brain has to say, in the order it happened.
 *
 * `delta` arrives many times a second while the model writes; the renderer
 * chunks it into sentences for speech. Everything else is once-per-event.
 */
export type VoiceAgentEvent =
  /** A fragment of the reply as it is generated. Order is guaranteed. */
  | { type: 'delta'; text: string }
  /** A whole assistant turn has landed. The authoritative text. */
  | { type: 'assistant'; text: string }
  /**
   * A tool call started or finished — the "thinking" affordance and the hub's
   * activity strip. `end` carries the name back (matched by tool_use id in the
   * host) and whether the call succeeded; `ok` is meaningless on `start`.
   */
  | { type: 'tool'; name: string; phase: 'start' | 'end'; ok?: boolean }
  /** The turn is over. `text` is the SDK's own summary of the result. */
  | {
      type: 'result'
      ok: boolean
      text: string
      turns: number
      costUsd: number
      durationMs: number
    }
  /** Something went wrong. The session survives; the turn did not. */
  | { type: 'error'; message: string }

/** Starting the session. Everything here is optional. */
export interface VoiceAgentStartRequest {
  /**
   * The active project's folder, so `Read` and the bridge's tools resolve
   * relative paths where Steve is actually working. Falls back to home.
   */
  cwd?: string
}

/** What `voice-agent:start` / `stop` answer with. */
export interface VoiceAgentStatus {
  running: boolean
  /** The model the live session was started with — not the current setting. */
  model: string
  /** Set when the session gave up (crash loop, spawn failure, no login). */
  error: string | null
}

/**
 * The brain asking the renderer a question, on `voice-agent:tool-request`.
 * `id` is answered exactly once, with a `VoiceAgentToolResult`.
 */
export interface VoiceAgentToolRequest {
  id: string
  /** Bare tool name — `get_app_state`, not `mcp__forge__get_app_state`. */
  name: string
  args: unknown
}

/** The renderer's answer. An error is a *result*, never a rejection. */
export interface VoiceAgentToolResult {
  id: string
  ok: boolean
  /** Text the model sees. Stringified by the host if it is not already text. */
  result?: unknown
  error?: string
}

/* --------------------------------------------------------- agent memory */

/**
 * Which part of a project's memory an entry belongs to.
 *
 * These map one-for-one onto the `##` headings in
 * `%APPDATA%\Forge\memory\<projectId>.md`, which is a plain markdown file on
 * purpose: it is folded straight into the brain's system text, and Steve can
 * open it in Notepad and see exactly what Forge thinks it knows about him.
 *
 *   about        one rolling paragraph — what this project *is*
 *   decisions    choices that were made and should not be re-litigated
 *   preferences  standing instructions ("always use TypeScript strict mode")
 *   activity     a capped, timestamped list of what actually happened
 */
export type MemorySection = 'about' | 'decisions' | 'preferences' | 'activity'

export interface Settings {
  /** Editable in %APPDATA%\Forge\settings.json — built-ins are seeded here. */
  agentProfiles: AgentProfile[]
  lastProjectId: string | null
  railCollapsed: boolean
  terminalFontSize: number
  terminalFontFamily: string
  /** Life-size type on the mosaic wall, or scale models. See MosaicTextMode. */
  mosaicText: MosaicTextMode
  /**
   * Master switch for per-tab terminal text colours. Off prints every terminal
   * in the theme's default foreground; each tab keeps the colour it was given,
   * and gets it back the moment this goes on again.
   */
  tabTextColours: boolean
  /**
   * Ring the project's dot in the rail while any of its panes is working, so
   * "is the agent still going?" is answerable from a project you are not
   * looking at. Off leaves the rail perfectly still.
   */
  railBusyRing: boolean
  /**
   * Show the Tasks section in the rail at all.
   *
   * On, because the delegation dock is how work gets handed out. But it is a
   * section like any other now rather than a fixture, and a project Steve only
   * ever types in himself does not need it charging rail height for a composer
   * he is not using.
   *
   * Turning it off hides the panel. It does not touch the planner session: that
   * belongs to the workspace, not to the panel that happens to show it.
   */
  railTasks: boolean
  /**
   * Show the Git section — branch, what has changed, whether it is pushed.
   *
   * Off out of the box, and deliberately: a rail that grows a new panel on a
   * version bump has changed without being asked to. The rail's foot carries a
   * one-line link to Appearance while this and railActivity are both off, so
   * "off by default" does not mean "impossible to find".
   */
  railGit: boolean
  /**
   * Show the Activity section — which agent is touching which file.
   *
   * Off, and the one here that most deserves to be: it is the only part of
   * Forge that watches the project folder itself, and something that recursively
   * watches a directory you did not ask it to watch should be a choice.
   */
  railActivity: boolean
  /**
   * Show the Share section — five markdown slots every agent in the project can
   * read and write.
   *
   * Off, and the one with the most to say for itself being off: it is the only
   * part of Forge that writes *into* the project folder rather than into
   * %APPDATA%\Forge. It puts `.forge/share` there and adds `.forge/` to this
   * clone's `.git/info/exclude` so nothing is committed, but a feature that
   * creates a directory in somebody's repository has to be asked for.
   *
   * Independent of `shareTools`: the rail without the MCP tools is a perfectly
   * good manual scratchpad, and the tools without the rail is a perfectly good
   * agent-only one.
   */
  railShare: boolean
  /**
   * Give agents MCP tools for the shared scratchpad, as well as the files.
   *
   * Off out of the box, and independent of `railShare` — the rail without the
   * tools is a perfectly good manual scratchpad, and the tools without the rail is
   * a perfectly good agent-only one.
   *
   * On, four CLIs get a `forge_share` server: Claude Code through the mcp.json
   * Forge already writes, Codex through a `-c` flag on its launch, OpenCode
   * through an environment variable, and Qwen through a line added to
   * `~/.qwen/settings.json` — the one config file Forge owns for this, because
   * Qwen is the one vendor with no launch flag. Turning it off removes that line
   * again. Every other agent reads and writes the same five files with the tools
   * it already has, which is the mechanism; this is the convenience.
   *
   * See electron/bridge/share-mcp.ts, where every one of those strings was
   * checked against the installed CLI rather than inferred.
   */
  shareTools: boolean
  /**
   * Which sections are open. A set, not an order — the order is fixed in
   * shared/rail.ts, and an id in here that is not in RAIL_SECTION_ORDER is
   * dropped by the normaliser rather than trusted.
   */
  railOpen: RailSectionId[]
  /**
   * Per-section body height in px, dragged by each section's top edge.
   *
   * Partial because a section that has never been dragged has no opinion and
   * should get the default rather than a number written down at first render.
   * Projects is absent from this by design: it is the section that takes the
   * slack, so it has no height of its own to remember.
   */
  railHeights: Partial<Record<RailSectionId, number>>
  /** Shell executable. Defaults to pwsh.exe (PowerShell 7). */
  shell: string
  /** Watch the clipboard for screenshots and copied images. */
  catchShots: boolean
  /** How many shots the shelf keeps before pruning the oldest. */
  shotsKeep: number
  window: WindowBounds
  /**
   * Set once the first-run welcome has been dismissed. Absent (or false) in a
   * fresh data directory is exactly what "first run" means — see
   * src/components/Onboarding.tsx.
   */
  onboarded: boolean
  /**
   * The one-shot "set your Forge account" card for an install that already
   * dismissed the welcome but never signed Forge Web in. David and Adam's
   * machines: onboarded is true, webUid is blank, and without this they would
   * never be asked. Signing in, or pressing Later, sets it. A fresh first-run
   * never needs it — the welcome's own account row is the ask.
   */
  webAccountPromptDismissed: boolean

  /* ------------------------------------------------------ dictation (M3) */
  /** Python interpreter that can import onnx-asr + sounddevice. */
  sttPython: string
  /** Folder holding the Parakeet ONNX model files. */
  sttModelDir: string
  /** Stop listening after this many seconds of silence (0 = never). */
  sttAutoStopSeconds: number
  /** KeyboardEvent.code that toggles dictation while Forge is focused. */
  sttHotkey: string

  /* --------------------------------------------------- voice agent (M4) */
  /** Voice-agent panel: open state and width in px. */
  /**
   * The voice hub: docked in the status bar, floating as a pill, or expanded
   * into the hub card — and where it was left, and how big he made it.
   * Persisted, because a hub you have parked over the second monitor's terminal
   * is furniture, not a transient mode. See src/lib/voicehub.ts.
   *
   * This replaced `voicePanelOpen` / `voicePanelWidth` outright when the
   * right-hand panel was deleted. Both are dropped by the store's normaliser,
   * so an existing settings.json simply loses them on its next write.
   */
  voiceHub: VoiceHubPlacement
  /**
   * Does undocking the hub open a real Windows window, or a div inside Forge?
   *
   * On by default, because it is what was actually asked for: an undocked hub
   * that floats above Chrome and stays on screen while Forge is minimised. A
   * `<div>` cannot do either — it is inside the window Chrome is covering.
   * See electron/overlay-window.ts.
   *
   * The switch exists because a transparent always-on-top window depends on the
   * compositor behaving, and on a machine where it does not, the fix should be
   * a toggle rather than a downgrade. Off falls back to the in-window hub,
   * which is kept working for exactly that reason.
   */
  voiceOverlayWindow: boolean
  /**
   * Listen while speaking, so you can cut in mid-sentence.
   *
   * On by default. With it off the agent is half duplex — the microphone is
   * shut for the whole reply and the only way to interrupt is to click the
   * button, which is how Forge worked before and is still the right answer on a
   * machine with no working echo cancellation (a cheap USB speakerphone, an
   * HDMI monitor's speakers with the mic across the desk from them).
   *
   * When it is on, the reply ducks the instant it hears you and cancels once it
   * is sure. See src/lib/bargein.ts for why an open microphone here cannot
   * bring back the feedback loop the old rule existed to prevent.
   */
  voiceBargeIn: boolean
  voiceBrain: VoiceBrainId
  /**
   * Anthropic key for the (unbuilt) ClaudeBrain. Stored here and used nowhere:
   * no code in Forge sends it anywhere.
   */
  anthropicKey: string
  /**
   * Which model the Claude voice brain runs.
   *
   * Note what this is *not*: an API-key setting. The brain is a Claude Agent
   * SDK session, and it authenticates with the `claude` login already on this
   * machine — the same subscription every Forge pane uses. `anthropicKey`
   * above is untouched by it.
   *
   * An alias (`sonnet`, `opus`, `haiku`) rather than a pinned id, because the
   * CLI resolves aliases to whatever is current and a pinned id here would
   * quietly go stale. Changing it restarts the session on the next turn.
   */
  voiceClaudeModel: string
  /**
   * Keep the mic open at ~1% CPU and wake the agent on "hey Jarvis", instead of
   * only ever starting from the dictation hotkey.
   *
   * Off by default — opt-in until the wake-word model has proven itself the
   * way barge-in and earcons already have. Dictation and its hotkey are
   * unaffected either way; this only adds a second way in. See the STT
   * sidecar's openwakeword integration for the listener itself.
   */
  voiceWakeWord: boolean
  /**
   * Which model Foreman runs — the agent that drives a whole coding job in a
   * pane from one line of intent. See shared/foreman.ts and electron/foreman/.
   *
   * The same shape as `voiceClaudeModel` above and for the same reasons: an
   * alias rather than a pinned id, and no API key anywhere near it — the Agent
   * SDK session signs in with the machine's own `claude` login.
   */
  foremanModel: string
  /**
   * Which model Foreman's *driving* sessions run. A long job hands its session
   * over at every plan-step boundary to keep context lean (see `recycle` in
   * electron/foreman/host.ts); the seed session and Steve's mid-job messages
   * use `foremanModel`, and the sessions that carry the job between steps use
   * this. Same rules: an alias, no key, the machine's `claude` login.
   */
  foremanDriveModel: string
  /**
   * Foreman's standing brief: the house rules that are true of every job,
   * whatever the seed says. Which backend, how work is planned, what has to be
   * green before anything is finished, where keys live.
   *
   * Read by Foreman through a tool rather than pasted into its prompt, so
   * editing it takes effect on the next turn of a running job instead of the
   * next restart. Empty is a valid answer meaning "use your judgement"; the
   * default is DEFAULT_FOREMAN_BRIEF, capped at FOREMAN_BRIEF_MAX.
   */
  foremanBrief: string
  /**
   * Google AI Studio key for GeminiBrain — the one brain that really talks to a
   * model. Sent only to generativelanguage.googleapis.com, only when Gemini is
   * the selected brain.
   */
  geminiKey: string
  geminiModel: string
  /**
   * Z.AI Coding Plan key for the GLM 5.3 pane. Injected only into that
   * selector as ANTHROPIC_AUTH_TOKEN (plus the Z.ai gateway URL). Never sent
   * to a regular Claude pane, and never written into ~/.claude/settings.json.
   * Plain, local, same as geminiKey.
   */
  zaiKey: string

  /* --------------------------------------------------- account + themes (M6) */
  /** Display name on the account chip. Seeded from the Windows username. */
  accountName: string
  /** Avatar colour. */
  accountColor: string
  /** Built-in or custom theme id. Falls back to `volt` if it has gone missing. */
  themeId: string
  /** Themes the user built in the theme editor. */
  customThemes: ThemeCore[]
  /** Force the reduced-motion behaviour on, regardless of the OS setting. */
  reducedMotion: boolean
  /**
   * A cache of the current theme's background and ink, written by the renderer
   * whenever the theme changes.
   *
   * It exists because two things are painted before any renderer code runs: the
   * window's own background colour, and the native window controls Windows draws
   * into our titlebar. Without this, launching in Paper means a near-black
   * window flashing white — so main needs to know the answer at construction
   * time, and the only place the answer exists is the renderer's theme table.
   */
  themeBg: string
  themeInk: string


  /* -------------------------------------------------- voice relay (M6) */
  /**
   * Hand a finished agent turn straight back to the voice agent instead of
   * waiting to be asked. Stored here; the behaviour itself lives elsewhere.
   */
  voiceAutoRelay: boolean
  /** How long a pane must be quiet before a relay counts as "finished". */
  voiceRelayGraceMs: number
  /**
   * Whether the agent answers in writing, out loud, or both.
   *
   * `voice` is not merely "also speak": it is a different panel. The log and
   * the text box are hidden, leaving the round button and one line of status,
   * because if you are talking to it you are not reading it — and Steve wants
   * that space back for terminals.
   */
  voiceReplyMode: VoiceReplyMode
  /**
   * `SpeechSynthesisVoice.name` for the LOCAL engine. Empty means "pick the
   * best installed voice", which is what `chooseVoice` in src/lib/speech.ts
   * does. Irrelevant while the Gemini engine is speaking.
   */
  voiceReplyVoice: string
  /**
   * Which engine says it. `edge` out of the box: it needs no key, and it is the
   * only neural engine with no per-minute quota — which is what stops the voice
   * swapping to SAPI mid-reply. If the network is down it degrades to `local`
   * by itself, so this can safely default to the good one.
   */
  voiceEngine: VoiceEngine
  /**
   * An Edge neural voice name. Empty means `DEFAULT_EDGE_VOICE` in
   * shared/tts.ts — en-GB-SoniaNeural, a warm British female voice.
   */
  voiceEdgeVoice: string
  /**
   * A prebuilt Gemini voice name. Empty means `DEFAULT_TTS_VOICE` in
   * electron/gemini-tts.ts — Sulafat, the one Google documents as "Warm".
   */
  voiceTtsVoice: string
  /**
   * Gemini TTS model id. Empty means the built-in default
   * (`gemini-3.1-flash-tts-preview`); the module falls across to the 2.5 flash
   * model by itself when that one is out of quota.
   */
  voiceTtsModel: string
  /**
   * A soft two-note blip when the agent goes back to listening.
   *
   * It replaces something worse. The agent used to *announce* that it was
   * listening again — a spoken sentence, identical every time, which is exactly
   * the "robotic" Steve complained about. 120 ms of quiet sine says the same
   * thing and never says it twice the same way you can get sick of.
   */
  voiceEarcons: boolean
  /**
   * A two-note blip when a terminal's process finishes — the same pair rising
   * for a clean exit (code 0), falling for anything else. Played only while
   * Forge is not the focused window, because a chime is only useful when you
   * were not going to see it anyway.
   */
  terminalExitChime: boolean
  /**
   * Where `create_project` puts a new folder when he does not say. Empty means
   * the Desktop. Only this, the Desktop and Documents are ever writable from a
   * spoken command — see the handler in electron/main.ts.
   */
  projectsRoot: string
  /**
   * Image-generation model for `make_image` / `edit_image`. Empty means "use the
   * built-in default" (gemini-2.5-flash-image), which is also what the MCP
   * bridge falls back to, so the two cannot disagree by accident.
   */
  geminiImageModel: string
  /**
   * OpenRouter key for OpenRouterBrain. Sent only to openrouter.ai, only when
   * OpenRouter is the selected brain.
   */
  openrouterKey: string
  openrouterModel: string
  /**
   * Groq key for GroqBrain. Sent only to api.groq.com, only when Groq is the
   * selected brain.
   *
   * Groq is here for one reason: it is the cheapest way to keep the voice agent
   * talking. Its free tier costs nothing and needs no card, and its paid tier is
   * pennies a month at Forge's volume — against Gemini's free tier, which caps
   * at twenty requests a minute and takes the whole turn down with it when it
   * runs out. It is also the fastest thing available, which for a voice agent is
   * not a luxury: latency here is a pause in a conversation.
   */
  groqKey: string
  groqModel: string

  /* -------------------------------------------------------- agent memory */
  /**
   * Let the active brain rewrite the "About this project" summary every tenth
   * exchange. Off by default: the heuristic memory below costs nothing and is
   * predictable, whereas this is a real (if small) API call you did not ask for.
   */
  memoryLlmSummarize: boolean

  /* --------------------------------------------------- skills library (M8) */
  /**
   * Where the skills library lives. Defaults to %APPDATA%\Forge\skills; movable
   * by hand for anyone who would rather keep their skills in a repo.
   */
  skillsLibraryDir: string
  /**
   * Folder names of the skills currently synced into ~/.claude/skills, and so
   * visible to every claude and kimi session on this machine. The list is the
   * intent; electron/skills-store.ts reconciles the filesystem with it at
   * startup and after every toggle.
   */
  skillsEnabled: string[]

  /* ------------------------------------------------ remote control (M7) */
  /**
   * Master switch for Claude Code's Remote Control. On by default: Steve wants
   * to be able to pick a pane up on his phone. Turning it off suppresses the
   * flag for every pane regardless of the per-profile setting, which is the
   * switch you want when you are on a plan or a network where it cannot work.
   */
  remoteControlDefault: boolean

  /* ------------------------------------------------ github while away */
  /**
   * Keep GitHub current so Forge Web has something real to read when this
   * machine is unreachable. After a pane goes idle: push the branch when it is
   * ahead of its upstream, and shelve the uncommitted working tree to
   * `forge-wip/<machine>/<branch>` on origin. The real branch, index and
   * working tree are never touched. See electron/git/git-shelf.ts and
   * docs/GITHUB-FALLBACK-PLAN.md.
   */
  gitShelfEnabled: boolean

  /* ------------------------------------------------ closing and resuming */
  /**
   * Give every Claude pane a session id of Forge's own, so reopening a saved
   * layout resumes each conversation instead of starting a new one. On by
   * default — it is the difference between a restored workspace and a restored
   * *session*. See shared/session.ts.
   *
   * Turning it off is the escape hatch: panes launch exactly as they used to,
   * with no `--session-id` and no `--resume`.
   */
  resumeSessions: boolean
  /**
   * Ask before closing Forge while panes are still running. On by default, and
   * the backstop for everything `resumeSessions` cannot bring back — a build
   * halfway through, a shell with unsaved work, an agent that is not Claude.
   */
  confirmOnQuit: boolean

  /* ------------------------------------------------- forge companion (M9)
   *
   * The phone link. Every field is inert until `companionEnabled` is true AND
   * a session has been signed in — nothing here causes a single network call
   * on its own. See companion/README.md and companion/GO-LIVE.md.
   */

  /** Master switch. False = the service never starts, never reads a token. */
  companionEnabled: boolean
  /**
   * Firebase Web API key of the companion project (`forge-sync`). Public by
   * design: it identifies the project, it does not authorise anything —
   * database.rules.json is what authorises.
   */
  companionApiKey: string
  /**
   * RTDB root, e.g. `https://forge-sync-default-rtdb.europe-west1.firebasedatabase.app`.
   * Against the emulator suite: `http://127.0.0.1:9000?ns=forge-sync-default-rtdb`
   * — any query string here is carried onto every request.
   */
  companionDatabaseURL: string
  /**
   * Identity Toolkit base. Blank = Google's real one. Set only to point the
   * whole link at the emulator, which serves the same REST API under a path
   * prefix: `http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1`.
   */
  companionAuthBase: string
  /** Secure Token base. Blank = Google's. Emulator: same host, `/securetoken.googleapis.com/v1`. */
  companionTokenBase: string
  /** The signed-in account. Kept after sign-out so the form pre-fills. */
  companionEmail: string
  /**
   * The only credential stored on disk, and never the password: a Firebase
   * refresh token, revocable from the Firebase console without touching any
   * password Steve uses elsewhere.
   */
  companionRefreshToken: string
  companionUid: string

  /* --------------------------------------------------- forge mobile (M11)
   *
   * The phone's *terminal* link — a real socket carrying real PTY bytes, as
   * opposed to the Companion above, which carries discrete messages and images
   * over Firebase. The two are complements, not rivals: the Companion channel
   * is what tells the phone where to find this socket. See docs/MOBILE.md.
   *
   * Same posture as the Companion: inert until `mobileEnabled` is true. Nothing
   * here binds a port, mints a token or accepts a connection on its own.
   */

  /** Master switch. False = the server never listens and no token is minted. */
  mobileEnabled: boolean
  /** Listen port. */
  mobilePort: number
  /**
   * Interface to bind. `0.0.0.0` — the default — means "every interface", which
   * sounds alarming and is not: `isAllowedSource` in electron/mobile/server.ts
   * refuses every connection that is not loopback, LAN or tailnet, so binding
   * broadly is what makes the phone work on home wifi without also making a
   * forwarded router port into a public shell. Set to `127.0.0.1` to accept
   * only a local tunnel (cloudflared) and nothing else.
   */
  mobileBindHost: string
  /**
   * Paired phones. Each entry holds a SHA-256 of the device's token and never
   * the token itself — see electron/mobile/auth.ts, and the check in
   * scripts/mobile-auth-check.mjs that reads this file back to prove it.
   */
  mobileDevices: MobileDeviceRecord[]
  /**
   * When "Accept new phones" disarms itself — a ms-epoch timestamp, 0 when it
   * is not armed. A timestamp rather than a boolean on purpose: a boolean that
   * someone forgot to switch off would leave the desktop raising pairing
   * prompts for anyone on the internet who found the tunnel, forever. Written
   * as now + ACCEPT_WINDOW_MS when Steve arms it, zeroed when the window
   * lapses, and clamped by the store so a hand-edited file cannot arm it for a
   * week. See electron/mobile-host.ts.
   */
  mobileAcceptUntil: number
  /**
   * The permanent way in from outside the house. `'ngrok'` runs a supervised
   * ngrok agent against the account's permanent dev domain whenever the link
   * is up, so the phone keeps one address forever — see
   * electron/mobile-tunnel.ts. Off by default, like everything else here.
   */
  mobileTunnel: MobileTunnelMode
  /**
   * The ngrok authtoken, from the dashboard. Stored like the other keys in
   * this file (geminiKey, companionRefreshToken): plain, local, and revocable
   * at the far end. It is handed to ngrok as an argument — never written into
   * an ngrok config file — and redacted from every log line and status detail
   * this app emits.
   */
  mobileNgrokAuthtoken: string
  /**
   * The account's auto-assigned permanent domain (`<name>.ngrok-free.app`,
   * some accounts see `.ngrok-free.dev`), copied off the ngrok dashboard —
   * not invented. Normalised and shape-checked by the store, because it ends
   * up on a command line.
   */
  mobileNgrokDomain: string
  /**
   * May a paired television drive this desktop's mouse and keyboard?
   *
   * Off by default, and the default is the important part. Everything else on
   * the mobile link ends inside Forge — a pane, a tab, a project, a video — and
   * is bounded by what Forge itself can do. This one ends at the operating
   * system: a real cursor, real clicks, on whatever window happens to be under
   * them. Switched on, anything holding a paired device token on this network
   * can operate the machine.
   *
   * So it is a deliberate act with a narrow purpose — the Fire TV remote's
   * D-pad as a pointer on the screen it is already mirroring — and it is read
   * on every single input frame rather than captured when a mirror starts.
   * Turning it off while somebody is watching stops the next event, not the
   * next session. See the input block in shared/mobile.ts for what can be
   * expressed at all, and electron/mobile/input.ts for what performs it.
   */
  mobileControlEnabled: boolean
  /**
   * May the mirror carry this desktop's sound as well as its picture?
   *
   * Off by default, and for the reason the capture used to give for refusing
   * outright (see `captureScreen` in src/lib/mirror.ts): what Windows hands
   * over is the *system* mix, so switching this on sends every notification
   * chime, every call and every video playing on this machine to a television
   * that may be in a room with other people in it. That is a surprise nobody
   * should get by default, and the reason this is a switch rather than a
   * silent improvement to the mirror.
   *
   * It exists because the mirror's most useful passenger is Forge's own voice
   * agent, which speaks out of the desk's speakers and therefore cannot be
   * heard from the sofa the mirror is watched from. There is no way to send
   * that one voice and nothing else — Windows offers the mix or nothing — so
   * the honest shape is the mix, opt-in, clearly labelled.
   *
   * Read in main when a television asks to watch, and sent to the renderer on
   * the `start` event rather than looked up there: the desk's own copy of the
   * settings is a cache, and this decides what leaves the machine. Unlike
   * `mobileControlEnabled` it cannot be read per event, because a capture is
   * negotiated once — turning it off stops the *next* watch, not this one.
   */
  mobileMirrorAudio: boolean

  /* -------------------------------------------------------------- forge web
   *
   * Forge in a browser tab: the same terminals, mirrored, behind a public
   * address. See docs/forge-web.md, whose security posture these fields
   * implement between them.
   *
   * The same posture as the Companion and Forge Mobile above, and here it is
   * load-bearing rather than tidy: this feature puts a shell on a home PC
   * behind a URL anybody can reach, so nothing here binds a socket, publishes
   * a hostname or reads a credential until `webEnabled` is true *and* the
   * project and uid below are both filled in.
   *
   * Note the shape of the block: the door (`webEnabled`, `webProjectId`,
   * `webUid`, `webPin`), then Forge Web's *own* Firebase
   * session, then its *own* tunnel. The session fields are a deliberate mirror
   * of the `companion*` ones rather than a read of them — the two features
   * share an identity provider and nothing else, for the reason spelled out on
   * `webUid` below.
   */

  /** Master switch. False = nothing listens, nothing publishes, nothing verifies. */
  webEnabled: boolean
  /**
   * Keep Forge running: a scheduled task on this PC (per user, per profile)
   * runs scripts/watchdog.mjs for the whole logon session and relaunches Forge
   * when it closes, crashes or hangs. Local only — nothing leaves the machine.
   * Written by main (`watchdog:enable` / `watchdog:disable`), which registers
   * or removes the task in the same act; see electron/watchdog-host.ts.
   */
  keepRunning: boolean
  /**
   * The Firebase project whose ID tokens this desktop will accept, e.g.
   * `forge-sync` — the same project the Companion signs into (docs/forge-web.md,
   * decision 2), but a separate field because `CompanionConfig` has never held a
   * project id: it holds an API key, a database URL and a refresh token, and the
   * project id cannot be derived from any of them without string-scraping a
   * hostname.
   *
   * This is not a secret. It is half of what makes a token *ours*: every token
   * is checked for `aud === webProjectId` and
   * `iss === https://securetoken.google.com/<webProjectId>`, so a perfectly
   * valid, perfectly signed token minted by somebody else's Firebase project is
   * refused. Blank means unconfigured, and unconfigured admits nobody.
   */
  webProjectId: string
  /**
   * The Firebase **Hosting site** the browser bundle is served from, e.g.
   * `forge-web` in `https://forge-web.web.app` — and blank means "the same name
   * as the project", which is Firebase's own default site.
   *
   * A separate field from `webProjectId` because the two are separate names and
   * only one of them is the page's address. A project may host any number of
   * sites, each with a name of its own: this repo's `.firebaserc` puts Forge
   * Web on the `forge-web-aadafc` site inside the `forge-sync-aadafc` project,
   * so the page's origin shares no substring with the project at all.
   *
   * Only `webAllowedOrigins` reads it, and getting it wrong has exactly one
   * symptom, which is the one it was written for: every browser is refused at
   * the WebSocket upgrade with `Origin not allowed`, the page cannot tell a
   * refusal from a network fault, and it reconnects forever saying
   * "Reconnecting to the desktop". The token check is not involved and never
   * was — that is `webProjectId`'s job, and it kept doing it perfectly while
   * nothing could connect.
   */
  webSiteId: string
  /**
   * The one Firebase uid this desktop admits. Blank admits nobody.
   *
   * Deliberately its own field rather than a read of `companionUid`, even
   * though in practice they hold the same account. `companionUid` moves
   * whenever somebody signs the Companion in or out; if the web door read it,
   * signing the Companion in as a different account would silently re-point
   * who gets a shell on this machine. Which account may reach the terminals is
   * a decision somebody makes once, on purpose, here.
   *
   * Written by Forge Web's own sign-in and by nothing else — see
   * `webRefreshToken`. That *is* the deliberate decision: a human typed this
   * account's password into the Forge Web card. Signing Forge Web out clears
   * it, which is what makes a signed-out desktop admit nobody rather than
   * quietly keep admitting the last account it saw.
   */
  webUid: string
  /**
   * The unlock PIN, **hashed**, or '' when none is set.
   *
   * Never the digits somebody typed. What is written here is
   * `scrypt$1$<salt>$<hash>` — see electron/web/pin.ts, whose header is honest
   * about what that does and does not buy: it stops settings.json *being* the
   * PIN, and it is not, and cannot be, protection against somebody who has the
   * file and time to grind four digits. The defence against guessing is the
   * per-source lockout in electron/web/auth.ts.
   *
   * With one set, every browser answers it on every connection, whether or not
   * this desktop has seen that browser before. There is no trust window, no
   * list of browsers to be on, and no way to be excused it.
   *
   * With it blank the account is the credential: a Firebase ID token that
   * verifies against Google's keys, for `webUid`, admits the browser it came
   * from. That is deliberate rather than an oversight — it is the only shape
   * that works from a hotel a hundred miles away — and the price, stated once
   * and not repeated anywhere else in the codebase, is that a stolen Firebase
   * password is then a shell on this machine. This PIN is the mitigation that
   * survives being away from the desk; signing Forge Web out or clearing
   * `webUid` is the one that ends every browser's access at once.
   *
   * Written only by `web:pin-set` and `web:pin-clear`, in the main process.
   */
  webPin: string

  /* ----------------------------------------------- forge web's screen mirror
   *
   * Three switches, all off, that between them decide whether a browser can see
   * this desk, touch it, and hear it. They are the only settings in this file
   * that reach past Forge and out to the display and the operating system, and
   * every one of them is read at the moment it matters rather than cached — see
   * electron/web-host.ts, where the reading is done.
   */

  /**
   * May a browser see this screen at all?
   *
   * Off by default, and separate from `webEnabled` on purpose: switching Forge
   * Web on says "my terminals may be reached from a browser", which is a
   * sentence about Forge. This one says "and so may everything else on this
   * display" — the other windows, the messages, whatever is open behind Forge —
   * which is a different sentence about a different thing, and nobody should
   * arrive at it by having agreed to the first.
   *
   * Forge Mobile has no equivalent because a television on the sofa asks and
   * the desk is in the room; a browser three hundred miles away is asking about
   * a room nobody is in.
   */
  webMirrorEnabled: boolean
  /**
   * May the browser watching this screen also drive it — real mouse, real keys,
   * on whatever window is under the pointer?
   *
   * Off by default, and the default is the important part. It is the same
   * decision `mobileControlEnabled` is, one risk class further out: that one
   * hands a cursor to a paired device on the LAN, this one hands it to whatever
   * holds a Firebase password.
   *
   * **This toggle is not sufficient on its own.** Control is refused outright
   * unless `webPin` is also set, because a browser that can move the mouse can
   * open Settings on this desk and switch every remaining lock off itself — on
   * an account-only desktop a stolen Firebase password would then not merely be
   * a shell but a shell that can quietly re-key the door. A PIN is the one
   * thing a stolen password does not come with, and requiring it means the
   * mouse always arrives after something typed by somebody who set it up. The
   * guard is `canControl` in electron/web-host.ts and it is read per event, so
   * turning either off stops the next click rather than the next session.
   */
  webControlEnabled: boolean
  /**
   * May the mirror carry this desktop's sound as well as its picture?
   *
   * Off by default, for the reason `mobileMirrorAudio` gives at length: what
   * Windows hands over is the *system* mix, so switching this on sends every
   * notification chime, every call and every video playing on this machine
   * wherever the browser is. There is no way to send one application's audio
   * and nothing else, so the honest shape is the mix, opt-in, clearly labelled.
   *
   * Read in main when a browser asks to watch and sent to the renderer with the
   * request rather than looked up there: the desk's copy of the settings is a
   * cache, and this decides what leaves the machine. Unlike the control gate it
   * cannot be read per event, because a capture is negotiated once — turning it
   * off silences the *next* watch, not this one.
   */
  webMirrorAudio: boolean

  /* --------------------------------------------- forge web's own session
   *
   * The Firebase session Forge Web publishes its rendezvous record with. Its
   * own — not the Companion's.
   *
   * This block exists because the first cut of the feature did read the
   * Companion's: `web-host.ts` would only publish while `companionUid` equalled
   * `webUid`, which made switching Forge Web on depend on a *different feature*
   * being signed in as the same account, and made signing the Companion out
   * stop Forge Web publishing without saying so. That is precisely what the
   * note on `webUid` above says must never happen, arrived at from the other
   * direction.
   *
   * So the two features share an identity *provider* — the same Firebase
   * project, the same accounts, the same `electron/companion/rest.ts` client —
   * and nothing else. Same field names, same rules, same storage decision as
   * the `companion*` block: the credential that reaches disk is a refresh
   * token, never a password and never an ID token.
   */

  /**
   * Firebase Web API key of the project Forge Web signs into. Public by
   * design, exactly as `companionApiKey` is: it names the project, it
   * authorises nothing — database.rules.json is what authorises.
   */
  webApiKey: string
  /**
   * RTDB root, e.g. `https://forge-sync-default-rtdb.europe-west1.firebasedatabase.app`.
   * Against the emulator suite: `http://127.0.0.1:9000?ns=forge-sync-default-rtdb`
   * — any query string here is carried onto every request.
   */
  webDatabaseURL: string
  /**
   * Identity Toolkit base. Blank = Google's real one. Set only to point Forge
   * Web's sign-in at the emulator, which serves the same REST API under a path
   * prefix: `http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1`.
   */
  webAuthBase: string
  /** Secure Token base. Blank = Google's. Emulator: same host, `/securetoken.googleapis.com/v1`. */
  webTokenBase: string
  /** The account Forge Web is signed in as. Kept after sign-out so the form pre-fills. */
  webEmail: string
  /**
   * The only credential Forge Web stores, and never the password: a Firebase
   * refresh token, revocable from the Firebase console without touching any
   * password Steve uses elsewhere.
   *
   * Blank means signed out, and a signed-out Forge Web publishes no rendezvous
   * record at all — it says so in `WebStatus.session.detail` rather than
   * quietly doing nothing, because "quietly doing nothing" is the failure this
   * whole block was written to end.
   */
  webRefreshToken: string

  /* ------------------------------------------------ forge web's own tunnel
   *
   * How the outside world reaches this desktop's web listener, and the one
   * setting here that is *not* off by default — because the transport it
   * defaults to needs no account, no domain and nothing pasted. It is still
   * inert until `webEnabled`: the supervisor is only started once the server is
   * actually listening, so a Forge Web that is switched off spawns nothing.
   *
   * Two supervisors, chosen by `webTunnel`: `electron/cloudflare-tunnel.ts` and
   * the ngrok one Forge Mobile drives (`electron/mobile-tunnel.ts`). See
   * `WebTunnelMode` for what each one costs.
   */

  /**
   * The loopback port the web listener binds, and the port the tunnel forwards
   * to. Next door to Forge Mobile's 8420, so a machine can run both.
   *
   * `FORGE_WEB_PORT` still overrides it — that seam predates this field and is
   * how a second Forge on one box gets out of the first one's way.
   */
  webPort: number
  /** Which supervisor, if any, puts this desktop on the internet. */
  webTunnel: WebTunnelMode
  /**
   * The ngrok authtoken for Forge Web's agent, from the dashboard. Read only on
   * the `'ngrok'` path — the default transport has no credential at all. Stored like
   * every other key in this file: plain, local, and revocable at the far end.
   * Handed to ngrok as an argument — never written into an ngrok config file —
   * and redacted from every log line and status detail this app emits.
   *
   * Its own field rather than a read of `mobileNgrokAuthtoken` for the reason
   * the whole session block above exists: one feature's credentials must not
   * decide whether another feature works.
   */
  webNgrokAuthtoken: string
  /**
   * The domain Forge Web's tunnel binds, copied off the ngrok dashboard.
   * Normalised and shape-checked by the store, because it ends up on a command
   * line. Must not be the same domain as `mobileNgrokDomain`: one domain
   * forwards to one port, and both links want their own.
   */
  webNgrokDomain: string

  /* ------------------------------------------------ updates & tools (M10) */
  /**
   * What the Update button does with the command it puts in a pane.
   *
   * False — the default — types it and stops, leaving the cursor at the end of
   * an unsubmitted line. You read `winget upgrade Microsoft.PowerShell`, you
   * press Enter. True presses Enter for you.
   *
   * The default is the safe one because the alternative is a settings page
   * that can start installing software with one click on a button whose label
   * does not say "and run it now".
   */
  updatesAutoRun: boolean
  /**
   * The Forge version whose update banner has been dismissed. Per-version on
   * purpose: saying "not now" to 0.2.0 must not silence 0.3.0 as well.
   */
  updateDismissedVersion: string
  /**
   * The version whose "what's new" card has been seen.
   *
   * The card opens by itself exactly when this does not match the running
   * version, which is what makes it a one-time thing per release rather than a
   * banner. It is seeded to the current version on the update that introduces it,
   * for the `onboarded` reason: a card describing a release somebody did not
   * choose to read about is the feature announcing itself rather than working.
   * From the next update onward it fires properly.
   */
  lastNotesVersion: string
  /**
   * Tools added by hand, alongside the built-in catalogue.
   *
   * The whole point: the list of things worth keeping up to date is not one
   * Forge gets to close. A CLI released next month, a shim of Steve's own, the
   * thing he installed yesterday — each is a row here, checked and updated by
   * exactly the same code path as PowerShell. Validated by `sanitiseCustomTool`
   * on the way in, because this is a file a person edits.
   */
  customTools: ToolSpec[]
}

/* ------------------------------------------------------ forge mobile (M11) */

/**
 * A paired phone, as persisted in settings.json.
 *
 * `tokenHash` is a SHA-256 hex digest. The raw token exists in exactly two
 * places: the phone's Keystore-backed storage, and the single `hello-ok` frame
 * that delivered it. Never here, and never in a log line.
 */
export interface MobileDeviceRecord {
  id: string
  name: string
  tokenHash: string
  createdAt: number
  lastSeenAt: number
}

/**
 * A pairing offer, on its way to the QR in Settings.
 *
 * `token` is the only time a raw credential crosses an IPC boundary. It is
 * never persisted: what reaches settings.json is a SHA-256 of the *device*
 * token this one is exchanged for, and only once a phone has actually used it.
 */
export type MobilePairOffer =
  | {
      ok: true
      token: string
      expiresAt: number
      ttlMs: number
      host: string
      /**
       * 0 when `url` is a tunnel — meaning "the scheme's default port", never
       * "append 8420". See pairEndpoint in electron/mobile-tunnel.ts and
       * toOrigin in mobile/src/lib/secure.ts, which treat a port-less secure
       * URL as exactly that.
       */
      port: number
      /**
       * `wss://<domain>` when the tunnel is live, '' otherwise. When present it
       * is THE address to pair against — it works from anywhere, forever,
       * which is what makes pairing one-and-done.
       */
      url: string
      /**
       * The whole handshake as one `forge://pair?…` string — what the QR in
       * Settings encodes. Built by `pairLink` in shared/mobile.ts, parsed by
       * `toOrigin`/`pairTokenOf` on the phone; carrying it pre-built means the
       * renderer never assembles a link the phone might read differently.
       * Note it embeds `token`, so it is as much a credential as the token is.
       */
      link: string
    }
  | { ok: false; error: string }

/**
 * A pairing code minted for the Devices preview frames, on its way to the
 * `?pair=` link an iframe loads with.
 *
 * Thinner than `MobilePairOffer` on purpose: the preview frames dial loopback,
 * so there is no address half to choose — `port` is the one the server actually
 * bound, and the frame's own host (localhost or 127.0.0.1) is what names the
 * desktop. `code` is as much a credential as the QR token is, and is spent the
 * same way: once, by the frame that loads it, within the TTL.
 */
export type MobilePreviewOffer =
  | { ok: true; code: string; port: number; expiresAt: number }
  | { ok: false; error: string }

/** A layout operation from a phone, on its way to the renderer that owns tabs. */
export interface MobileCommandEvent {
  requestId: string
  deviceName: string
  op: {
    op: 'create-tab' | 'create-pane' | 'close-pane' | 'select-tab'
    projectId: string
    profileId?: string
    /** Still a wire value at this point: the renderer checks it, never casts it. */
    permissionMode?: string
    tabId?: string
    paneId?: string
  }
}

/**
 * The panes a phone is reading right now — a label for those pane headers, and
 * nothing more.
 *
 * It used to carry a geometry, because reading a pane used to move it. It must
 * not carry one again: only *typing* moves a grid now (see the "one PTY, several
 * viewers" block in electron/mobile-host.ts), and a size on this channel would
 * be a size somebody eventually followed — which would make glancing at a pane
 * reshape it after all. The real geometry has its own channel, `IPC.ptyGeometry`.
 * `WebWatchEvent` is its twin in shape as well as in purpose, and both are kept
 * as their own type on their own channel because a shared message would have to
 * be read twice as carefully at both ends.
 *
 * An empty list is the normal, and the message that says nobody is reading.
 */
export interface MobileWatchEvent {
  ids: string[]
}

export type MobileState = 'off' | 'starting' | 'listening' | 'error'

/* ------------------------------------------------------- the ngrok tunnel
 *
 * Written for Forge Mobile and now shared with Forge Web, which supervises its
 * own agent on its own port through the same class. The names below are
 * therefore feature-neutral, with the original `Mobile*` spellings kept as
 * aliases: they appear in `MobileStatus`, in electron/mobile-host.ts and in
 * scripts/tunnel-check.mjs, and renaming a type across three files to say the
 * same thing is churn rather than clarity.
 */

/** Which transport carries a link past the front door. See mobile-tunnel.ts. */
export type TunnelMode = 'off' | 'ngrok'

/**
 * Forge Web's, which has one more answer than the phone link's — and
 * deliberately is not the same type, because two of the three are wrong for a
 * phone and a shared union would let one be set there by mistake.
 *
 *  - **`'cloudflared'`** — the default, and the only one that needs nothing
 *    pasted. A quick tunnel (`electron/cloudflare-tunnel.ts`) with no account,
 *    no domain and no per-account limit, so it runs happily beside Forge
 *    Mobile's. The address is new on every start, which costs nothing here: the
 *    browser reads this desktop's current address out of the rendezvous record
 *    before it dials. See `WebHostRecord` in shared/web.ts.
 *  - **`'ngrok'`** — a supervised ngrok agent (`electron/mobile-tunnel.ts`,
 *    a second instance) against `webNgrokAuthtoken` and, optionally,
 *    `webNgrokDomain`. One steady address forever, at the price of the free
 *    plan's one-online-endpoint-per-account rule: with this chosen, the phone
 *    link and the browser link cannot both be up.
 *  - **`'off'`** — Forge runs no tunnel. Either there is no way in from
 *    outside, or one is run by hand and named with `FORGE_WEB_HOSTNAME`.
 */
export type WebTunnelMode = 'off' | 'cloudflared' | 'ngrok'

export type TunnelState = 'off' | 'starting' | 'live' | 'retrying' | 'error'

/**
 * What a supervised tunnel is doing. `error` is terminal on purpose: it means
 * a door that will not open (bad authtoken, someone else's domain, no session
 * allowance left), where retrying buys nothing — `detail` says which key to go
 * and fix. Transient trouble shows as `retrying` and never needs Steve.
 */
export interface TunnelStatus {
  state: TunnelState
  /** The public https URL the agent reported, while live. */
  url: string
  /** A human sentence, or empty when there is nothing to say. Never a token. */
  detail: string
}

/** Forge Mobile's spellings. Identical types — see the block comment above. */
export type MobileTunnelMode = TunnelMode
export type MobileTunnelState = TunnelState
export type MobileTunnelStatus = TunnelStatus

/** What the Settings panel shows about the link. */
export interface MobileStatus {
  enabled: boolean
  state: MobileState
  /** Where it is actually listening, once it is. */
  host: string
  port: number
  /**
   * The addresses a phone can reach this machine on right now — LAN and
   * tailnet, worked out from the live interface list. The Settings panel shows
   * these because "it's listening" is not an answer to "what do I type".
   */
  addresses: string[]
  devices: MobileDeviceRecord[]
  /**
   * Whether the server has a phone bundle to serve at all — `mobile/dist` in a
   * checkout, `resources/mobile-web` in a packaged build, '' when neither
   * exists. The Devices preview frames point at this server, so this is the
   * difference between "the preview works" and "run `npm run mobile:build`".
   */
  web: boolean
  /** Phones with a socket open this second. */
  connected: number
  /**
   * When "Accept new phones" disarms itself (ms epoch), or 0 while it is not
   * armed. Rides this status rather than a stream of its own, so the Settings
   * toggle and its countdown stay honest through the one broadcast the panel
   * already watches.
   */
  acceptUntil: number
  /** A human sentence, or empty when there is nothing to say. */
  detail: string
  /** The ngrok tunnel, when one is configured. `state: 'off'` otherwise. */
  tunnel: MobileTunnelStatus
}

/* --------------------------------------------------------------- forge web */

/**
 * Where the link stands, as one word the Settings panel switches on. The same
 * four values as `MobileState`, and deliberately so: it is the same question
 * about the same kind of thing, and two vocabularies for one idea is how two
 * panels end up disagreeing about what "starting" looks like.
 */
export type WebState = 'off' | 'starting' | 'listening' | 'error'

/**
 * How the outside world reaches this desktop, as far as Forge can tell.
 *
 * Four of these five words mean the same as they do on `TunnelStatus`, because
 * they describe the same supervised ngrok agent: Forge Web now runs one of its
 * own (electron/mobile-tunnel.ts, a second instance on its own port), so
 * `starting`, `live` and `error` are observations rather than guesses. The
 * supervisor's `retrying` is folded into `starting` — from the settings panel's
 * point of view a tunnel that is coming back up is a tunnel that is coming up,
 * and the reason it is having to is already in `detail`.
 *
 * `configured` is the odd one out and is kept deliberately: it means "somebody
 * gave us a hostname we do not supervise", which is what `FORGE_WEB_HOSTNAME`
 * does. It is not a claim that anything is listening at the far end, because on
 * that path Forge did not start the tunnel and cannot see it — and a panel that
 * said `live` about a process it has never met would be lying.
 */
export type WebTunnelState = 'off' | 'starting' | 'live' | 'configured' | 'error'

export interface WebTunnelStatus {
  state: WebTunnelState
  /** The bare hostname the browser is told to dial, or '' when there is none. */
  host: string
  /** A human sentence, or empty when there is nothing to say. Never a token. */
  detail: string
}

/**
 * Forge Web's own Firebase session, as the settings panel should show it.
 *
 * Its own — the Companion's sign-in is a different feature and cannot stand in
 * for it (see the `webApiKey` block in `Settings`). This rides `WebStatus`
 * rather than a stream of its own for the reason everything else here does: a
 * panel that has to subscribe to two things is a panel that forgets one.
 *
 * `detail` is the load-bearing field. A signed-out Forge Web is not an error
 * and not a silence; it is a sentence saying which door to go and open, and the
 * whole point of this status is that the panel can show it.
 */
export interface WebSessionStatus {
  /** True when there is a refresh token and a uid to publish under. */
  signedIn: boolean
  /** The account, kept after sign-out so the form pre-fills. */
  email: string
  /** The uid the rendezvous record is published under. '' when signed out. */
  uid: string
  /** Why publishing cannot happen yet, or '' when nothing is in the way. */
  detail: string
}

/** What the desktop last managed to publish at `users/<uid>/host`. */
export interface WebRendezvousStatus {
  /** The hostname currently believed to be published, or '' when none is. */
  published: string
  /** ms epoch of the last successful write, publish or heartbeat. */
  at: number
  /** The last failure as a sentence, or '' while things are working. */
  detail: string
}

/** What the Settings panel shows about Forge Web. */
/** What the "Keep Forge running" panel shows — see electron/watchdog-host.ts. */
export interface WatchdogStatus {
  /** The scheduled task exists on this PC. */
  installed: boolean
  /** A watchdog process for this profile is alive right now. */
  running: boolean
  paused: boolean
  /** Age of the heartbeat the watchdog reads, or null with no file. */
  heartbeatAgeMs: number | null
  /** ISO timestamp of the last relaunch the watchdog log records, or ''. */
  lastRestart: string
  taskName: string
}

export interface WebStatus {
  enabled: boolean
  state: WebState
  /**
   * True when this desktop knows whose tokens to accept *and* holds the session
   * it would publish its address with: a project id, a uid, and Forge Web's own
   * Firebase credentials. Separate from `enabled` because they are two
   * different things to tell somebody: the switch is off, versus the switch is
   * on and nothing can come of it yet. `session.detail` says which.
   */
  configured: boolean
  /** Where it is actually listening, once it is. Loopback — see web-host.ts. */
  host: string
  port: number
  /**
   * The address a browser would dial — `wss://<hostname>/web` — or '' when
   * there is no tunnel hostname to build one from. Built by `webSocketUrl` in
   * shared/web.ts rather than assembled here, so both ends agree on it.
   */
  url: string
  /** Browsers with an authenticated socket open this second. */
  connected: number
  /**
   * True while a browser is watching this screen.
   *
   * The one fact on this status that a person cannot get any other way. A tab
   * opening announces itself by opening a tab; a capture in progress looks
   * exactly like no capture at all, so if the card does not say it, nothing
   * does. It is also what the Stop button is enabled by — see
   * `IPC.webMirrorEnd`.
   */
  mirroring: boolean
  /**
   * True when an unlock PIN is set. Never the PIN, and never its hash: the
   * panel needs the fact, and the fact is all it gets. See `webPin` in
   * `Settings`; the panel mirrors this rather than reading the setting so the
   * card and the door cannot disagree.
   */
  pinSet: boolean
  /** A human sentence, or empty when there is nothing to say. */
  detail: string
  /** Forge Web's own Firebase session — see `WebSessionStatus`. */
  session: WebSessionStatus
  tunnel: WebTunnelStatus
  rendezvous: WebRendezvousStatus
  /**
   * The last browser this desktop turned away at the door, or null.
   *
   * Every other refusal in Forge Web reaches the person it concerns: a bad
   * token, a token for the wrong account and a wrong PIN all travel back down
   * the socket as a `refused` frame the page renders. The origin check cannot —
   * it fires *during* the upgrade, so there is no WebSocket to say it on, and
   * the browser is handed a bare failed handshake that is indistinguishable
   * from an unreachable machine. The page therefore does the only sensible
   * thing with a network fault, which is retry, and a misconfiguration looks
   * exactly like a tunnel that is down.
   *
   * So the sentence surfaces here instead, on the desktop, where somebody can
   * act on it. It carries the origin verbatim because the fix is to compare it
   * with the Hosting site in Settings — see `webSiteId`.
   */
  refusal: WebRefusal | null
}

/**
 * A browser refused before it had a socket to be told on. See
 * `WebStatus.refusal`, which is the only thing that carries it.
 */
export interface WebRefusal {
  /** The `Origin` header as the browser sent it, e.g. `https://forge-web.web.app`. */
  origin: string
  /** What this desktop would have accepted instead, for the panel to show beside it. */
  allowed: string[]
  /** ms epoch. */
  at: number
}

/**
 * The answer to `window.forge.web.signIn()`. The same shape as
 * `CompanionSignInResult` and for the same reason: the two failures a person
 * can act on (wrong password, unconfigured project) are sentences, not codes.
 *
 * `created` is true when the account did not exist and this call made it, which
 * the panel says out loud — signing in to a *new* account on the machine that
 * is about to serve a shell is worth a second look.
 */
export type WebSignInResult = { ok: true; uid: string; created: boolean } | { ok: false; error: string }

/**
 * A layout operation from a browser, on its way to the renderer. See
 * `WebLayoutOp` in shared/web.ts — this carries it verbatim.
 *
 * Only `select-project` still travels this way: the rest are performed in main
 * against the authoritative layout (electron/layout-engine.ts), and the window
 * hears about them as a `WorkspaceReplacedEvent` instead.
 */
/**
 * A browser asking for a folder to be added to the project rail.
 *
 * `WebCommandEvent`'s sibling rather than another member of it — see
 * `IPC.webProjectAdd` for why — and answered on the same `webCommandResult`
 * channel with the same `requestId`.
 *
 * The path has already been checked on the main side: it is absolute, it
 * exists, and it is a directory. The renderer is still the one that decides
 * what adding it *means*, because it owns the rail.
 */
export interface WebProjectAddEvent {
  requestId: string
  /** The browser's own name, for a "added from Chrome on Windows" toast. */
  deviceName: string
  /** An absolute path to a folder that was there a moment ago. */
  path: string
}

export interface WebCommandEvent {
  requestId: string
  /** The browser's own name, for a "opened from Chrome on Windows" toast. */
  deviceName: string
  op: {
    op: string
    projectId: string
    profileId?: string
    /** Still a wire value at this point: the renderer checks it, never casts it. */
    permissionMode?: string
    tabId?: string
    paneId?: string
    direction?: SplitDirection
  }
}

/**
 * The panes a browser is reading right now — a label for those pane headers,
 * and nothing more.
 *
 * `MobileWatchEvent`'s twin. Both carry ids and no geometry, because reading a
 * pane must never move it — only typing does (see the "one PTY, several viewers"
 * block in electron/web-host.ts), and the real geometry travels on
 * `IPC.ptyGeometry` instead. Still its own type on its own channel, because the
 * two viewers arrive on different links with different lifecycles and a shared
 * message would have to be read twice as carefully at both ends.
 *
 * An empty list is the normal, and the message that says nobody is reading.
 */
export interface WebWatchEvent {
  ids: string[]
}

/**
 * "A browser wants to watch this screen." Main → renderer.
 *
 * Two messages rather than `MobileMirrorEvent`'s three, and the missing one is
 * the difference between the two features: there is no `signal`, because there
 * is no peer connection to negotiate. The picture leaves the renderer as
 * encoded chunks on `IPC.webMirrorChunk` and travels down the same WebSocket
 * everything else on this link does — see the screen-mirror block in
 * shared/web.ts for why WebRTC cannot be used through a tunnel.
 *
 * The renderer answers `start` by capturing, encoding, and pushing a config
 * followed by chunks; it answers `stop` by tearing all of that down. Nothing
 * else is expected of it, and nothing it sends back is interpreted here.
 */
export type WebMirrorEvent =
  /**
   * `audio` is main's answer to "may this one carry sound?", read off
   * `webMirrorAudio` at the moment the browser asks. It travels with the
   * request rather than being looked up in the renderer, because main holds the
   * settings that decide what may leave this machine and because a capture is
   * negotiated once: the answer has to be fixed before the stream is opened,
   * not sampled from a copy that may be a debounced save behind.
   */
  | { kind: 'start'; audio: boolean }
  | { kind: 'stop' }

/**
 * Forge TV — the mobile app as a Fire TV APK, built on demand or downloaded.
 *
 * `idle` and `done` are both resting states; they differ only in whether the
 * last build in this session was ours. Whether an APK exists at all is
 * `sizeBytes > 0`, which survives a restart, because the file does.
 */
export type ForgeTvPhase = 'idle' | 'building' | 'fetching' | 'done' | 'error'

/**
 * Where the APK this Forge is serving came from.
 *
 * The difference matters to the person reading the panel, because the two are
 * not the same app. A *built* one has this desktop's LAN address baked into it
 * and stops working when the router hands out a new lease. A *downloaded* one
 * is the shared release: no address inside it at all, so it finds whichever
 * Forge answers on the network it is switched on in (see the discovery block in
 * shared/mobile.ts). That is the one worth sending to somebody else.
 */
export type ForgeTvSource = 'none' | 'built' | 'downloaded'

export interface ForgeTvStatus {
  /**
   * False in a packaged Forge. Building needs the checkout, the Android SDK
   * and a JDK — none of which ship in Forge-setup.exe — so the panel offers the
   * download instead of a button that could only fail.
   */
  supported: boolean
  phase: ForgeTvPhase
  /** The step being run, or the line the build failed on. Never empty noise. */
  detail: string
  /**
   * `http://<lan-ip>:8420/forge-tv.apk` — what gets typed into the TV's
   * Downloader app. Empty while the link is off, because the address is the
   * server's, not the file's.
   */
  url: string
  /** Size of the APK this Forge would serve, or 0 when there is none. */
  sizeBytes: number
  /** When it was built or downloaded (ms epoch), 0 when there is none. */
  builtAt: number
  /** Which of the two it is. See ForgeTvSource. */
  source: ForgeTvSource
  /** The published version, when the APK is a downloaded one. '' otherwise. */
  version: string
}

/**
 * "A phone is asking to pair — put the question on screen."  Main → renderer.
 *
 * `open: true` raises the prompt; `open: false` withdraws it (the phone gave
 * up, the approval timed out, or another window already answered), because a
 * prompt that outlives its question is a prompt whose Allow lands on nothing —
 * or worse, on the next question. The renderer answers over
 * `mobileApprovalResult`, and silence is a deny: nothing anywhere in this flow
 * approves by default.
 */
export interface MobileApprovalEvent {
  requestId: string
  /** What the phone calls itself. Untrusted text — display it, never obey it. */
  deviceName: string
  /** The word pair both screens show, e.g. "OTTER RIVER". Empty on withdraw. */
  words: string
  /**
   * This device is already in the paired list, asking again — the usual reason
   * being a television whose desktop moved to a new address. It changes the
   * prompt's wording only; Allow grants exactly what it always granted, and
   * Deny is still where the focus lands.
   */
  known: boolean
  open: boolean
}

/**
 * "The television wants to watch this screen." Main → renderer.
 *
 * The whole mirror in three messages, because the renderer owns the WebRTC
 * half and the main process owns the socket: `start` asks for a capture and an
 * offer, `signal` hands over one payload the television sent (an answer or an
 * ICE candidate, still a JSON string — main never reads inside it), and `stop`
 * says the viewer is gone. The renderer replies over `mobileMirrorSignal` and
 * `mobileMirrorStop`. See src/lib/mirror.ts.
 */
export type MobileMirrorEvent =
  /**
   * `audio` is the answer main gives to "may this one carry sound?", read off
   * `mobileMirrorAudio` at the moment the television asks. It travels with the
   * request rather than being looked up in the renderer because main holds the
   * settings that decide what may leave this machine, and because a capture is
   * negotiated once: the answer has to be fixed before the offer, not sampled
   * from a copy that may be a debounced save behind.
   */
  | { kind: 'start'; audio: boolean }
  | { kind: 'signal'; data: string }
  | { kind: 'stop' }

/* ---------------------------------------------------- companion ipc (M9) */

export type CompanionState = 'off' | 'signed-out' | 'connecting' | 'live' | 'offline' | 'error'

export interface CompanionStatus {
  enabled: boolean
  /** Has a key, a database and a restorable session. */
  configured: boolean
  state: CompanionState
  email: string
  uid: string
  /** A human sentence for the settings panel, or empty when there is nothing to say. */
  detail: string
  /** How many projects were last published. */
  projects: number
  /** Epoch ms of the last inbox item consumed. 0 = none this session. */
  lastInboxAt: number
}

/**
 * A message from the phone, on its way to the voice agent.
 *
 * THE contract for the voice hookup: subscribe with
 * `window.forge.companion.onUtterance(...)`, do whatever the voice pipeline
 * does with a transcript, then call `window.forge.companion.reply(itemId, text)`
 * to put the answer back on Steve's phone. `itemId` is opaque — pass back
 * exactly what you were given and the reply threads under the message.
 */
export interface CompanionUtteranceEvent {
  /** Forge's own project id, as in `Project.id`. */
  projectId: string
  projectName: string
  /** Opaque id of the inbox item. Hand it to `reply()` to thread the answer. */
  itemId: string
  text: string
}

export type CompanionSignInResult = { ok: true; uid: string; created: boolean } | { ok: false; error: string }

/* -------------------------------------------------------------------- ipc */

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  dataDir: string
  maxSessions: number
  shell: string
  /**
   * Which checkout this window is — the same FORGE_CHANNEL discriminator
   * StaleStatus.channel carries. Required, and always sent: the title bar wears
   * its dev marks off this, and a renderer that has not hydrated yet has no
   * AppInfo at all, so absence already means "assume stable, show nothing".
   */
  channel: 'dev' | 'stable'
}

export interface CreateSessionRequest {
  id: string
  cwd: string
  cols: number
  rows: number
  /** Command written into the shell once it is ready. Empty = nothing. */
  bootstrapCommand?: string
  /**
   * Naming context for the bootstrap transforms. Only Remote Control uses it
   * today, to label the session Steve's phone will show — see
   * `remoteControlName` in shared/remote.ts.
   */
  projectName?: string
  paneTitle?: string
  /**
   * The pane's saved Claude session id. The main process decides what to do
   * with it — claim it on a first launch, resume it on every one after — in
   * electron/bridge/claude-session.ts.
   */
  sessionId?: string
  /**
   * `false` keeps this pane out of Remote Control regardless of profile and
   * settings. A bridged session routes its conversation through claude.ai and
   * writes no messages to the local transcript — fatal for any pane whose
   * transcript is read by Forge itself (the planner). Absent means the
   * profile/settings decide, as ever.
   */
  remoteControl?: false
  /**
   * The project's repo URL, if the renderer knows one (see `Project.repoUrl`).
   * Absent means "ask git yourself": the PTY host falls back to
   * `git remote get-url origin` in the pane's cwd, so a pane opened in a folder
   * whose remote was set up five minutes ago still gets it.
   */
  repoUrl?: string
}

export type CreateSessionResult =
  | {
      ok: true
      id: string
      pid: number
      /** True when an existing shell was re-adopted (renderer reload/crash). */
      restored?: boolean
    }
  | { ok: false; id: string; error: string }

export interface PtyDataEvent {
  id: string
  data: string
}

export interface PtyExitEvent {
  id: string
  exitCode: number
  signal?: number
}

/**
 * A pane's real grid, and whether this desk is the one choosing it.
 *
 * `deskOwns` false means a phone or a browser typed into this pane last and
 * therefore holds its geometry: the desk draws `cols`×`rows` shrunk to fit,
 * rather than refitting the PTY out from under whoever is working on it. True
 * covers both "the desk owns it" and "nobody does", because a pane no remote
 * has claimed is one the desk may size freely. See `IPC.ptyGeometry`.
 */
export interface PtyGeometryEvent {
  id: string
  cols: number
  rows: number
  deskOwns: boolean
}

export interface WindowStateEvent {
  maximized: boolean
  focused: boolean
}

export interface StoreSnapshot {
  settings: Settings
  projects: Project[]
}

/* -------------------------------------------------------------- dictation */

/**
 * The dictation sidecar's life in one word.
 *
 *   off        never started (it is spawned lazily, on first use)
 *   starting   process up, model loading — a few seconds
 *   idle       ready and waiting for the hotkey
 *   listening  mic open, `level` is live
 *   finishing  mic closed, the last phrase is still being transcribed
 *   error      see `error`; setup-shaped kinds need the user to fix a path
 */
export type SttPhase = 'off' | 'starting' | 'idle' | 'listening' | 'finishing' | 'error'

export type SttErrorKind =
  /** The configured interpreter is not there, or refused to launch. */
  | 'python-missing'
  /** stt_service.py could not be found next to the app. */
  | 'sidecar-missing'
  /** The model folder is absent, or its files are missing/truncated. */
  | 'model-missing'
  /** onnx-asr found the files but would not load them. */
  | 'model-load'
  /** The microphone could not be opened (in use, or no permission). */
  | 'audio'
  /** Asked to listen while the model was still loading. */
  | 'not-ready'
  /**
   * The wake word cannot be heard — openWakeWord is not installed, or its
   * models could not be fetched. Dictation itself is unaffected: the sidecar
   * downgrades the session to ordinary phrase capture and carries on.
   */
  | 'wake-unavailable'
  /** Restarted too many times too quickly — we stopped trying. */
  | 'crash-loop'
  | 'internal'

export interface SttError {
  kind: SttErrorKind
  msg: string
}

/**
 * What kind of listening session the sidecar is in.
 *
 *   phrase   push-to-talk: the mic opens, phrases come back, silence ends it
 *   wake     always-listening: the mic stays open and only what follows
 *            "hey Jarvis" (or an explicit capture) is transcribed
 */
export type SttMode = 'phrase' | 'wake'

/**
 * How to open the microphone. Everything here is optional, and an absent (or
 * empty) request is exactly the push-to-talk start dictation has always made —
 * that is what keeps the hotkey's behaviour bit-for-bit unchanged.
 */
export interface SttStartOptions {
  /** Defaults to `phrase`. `wake` is the always-listening session. */
  mode?: SttMode
  /**
   * A conversation, not dictation: the sidecar waits out thinking pauses (a
   * few seconds of silence) before deciding a phrase is over, instead of
   * cutting at the ~1 s dictation gap that splits a long sentence into
   * fragments. The agent sets it; the dictation hotkey leaves it absent.
   */
  conversation?: boolean
}

export interface SttStatus {
  phase: SttPhase
  /** Smoothed 0..1 mic level. Only meaningful while listening. */
  level: number
  error: SttError | null
  /** True once the model has reported ready in the current sidecar process. */
  ready: boolean
  /**
   * The current session's mode. Absent from statuses built before wake mode
   * existed, where it always meant `phrase`.
   */
  mode?: SttMode
  /**
   * How many times the wake word has fired in this sidecar process. It only
   * ever goes up: a wake is detected by noticing that this number *changed*,
   * never by its value, because the event itself is instantaneous and there is
   * nothing else to latch onto.
   */
  wakeCount?: number
  /**
   * True while audio is actually on its way to the speech engine. Always true
   * in `phrase` mode while listening; in `wake` mode it is the difference
   * between idle monitoring and taking down what was just said.
   */
  capturing?: boolean
}

export interface SttPhraseEvent {
  text: string
}

/* --------------------------------------------------- speech model (M8) */

/**
 * Forge ships the dictation engine but not the 660 MB Parakeet model, which is
 * fetched on demand into %APPDATA%\Forge\models. This is that fetch, as the UI
 * sees it — one object covering both "what is on disk" and "how far along".
 *
 *   unknown      nobody has looked yet
 *   missing      not downloaded
 *   partial      a previous attempt left bytes behind; it will resume
 *   downloading  in flight, `fraction` is live
 *   ready        installed and big enough to be real
 */
export type SttModelStatus = 'unknown' | 'missing' | 'partial' | 'downloading' | 'ready'

/**
 * *Whose* model this is, which is a different question from whether it works.
 *
 *   forge         downloaded into %APPDATA%\Forge\models — ours to manage
 *   dictationmic  DictationMic already paid the 660 MB and we borrow it
 *   external      a folder the user typed in themselves
 *   none          nothing configured and nothing found
 *
 * It exists because the advice differs: only `none`/`external`-with-nothing-in-it
 * should ever be offered a download, and borrowing DictationMic's copy is a
 * *good* outcome that deserves saying out loud rather than an install prompt.
 */
export type SttModelSource = 'forge' | 'dictationmic' | 'external' | 'none'

/** One model file as found on disk. `ok` means "big enough to be real". */
export interface SttModelFile {
  name: string
  bytes: number
  ok: boolean
}

export interface SttModelState {
  status: SttModelStatus
  /** Where the bytes are coming from. */
  source: SttModelSource
  /** Folder the model is (or will be) in. Empty when nothing is configured. */
  dir: string
  /** Forge's own model folder, populated or not — where a download lands. */
  forgeDir: string
  /**
   * Per-file presence from the last look at the disk, so the settings card can
   * say *which* file is missing instead of just "not installed". Empty while a
   * download is in flight, when the interesting number is the progress bar.
   */
  files: SttModelFile[]
  bytes: number
  totalBytes: number
  /** 0..1 across the whole model. */
  fraction: number
  /** File currently being fetched, while downloading. */
  file: string
  /** One sentence fit to show the user, including the failure reason. */
  message: string
  /** e.g. "~660 MB" — what to warn about before they commit. */
  sizeHint: string
  /** Set when a download ended badly, so the card can show it in red. */
  error?: string
}

/* ------------------------------------------------------- agent detection */

/** One of the CLI agents Forge can launch, as found (or not) on PATH. */
export interface AgentPresence {
  /** Matches the built-in profile id: `claude`, `kimi`, `gemini`. */
  id: string
  name: string
  /** The command Forge would type into a shell. */
  command: string
  found: boolean
  /** Absolute path of the resolved executable, when we found one. */
  path?: string
  /** Where to go and get it. */
  installUrl: string
}

/**
 * What Forge can say about *any* command line without becoming a shell.
 *
 * `AgentPresence` answers for the built-ins the welcome card lists. This answers
 * for whatever a profile actually launches, including one typed in by hand, and
 * is what lets the chooser and the Agents settings say "not installed" on the
 * row you are about to click rather than in a pane three seconds later.
 *
 * `unknown` is the honest third state and matters more than it looks. A command
 * like `conda activate x; claude` or `& "C:\tools\my agent.exe"` cannot be
 * resolved by looking at PATH — answering "not installed" for it would be a
 * confident lie about a profile that works perfectly.
 */
export interface CommandPresence {
  /** The command line exactly as it was asked about. */
  command: string
  /** The program it launches — empty when the line is not a plain command. */
  exe: string
  /** True only when we looked and found it. */
  found: boolean
  /** True when nothing was looked up, because the line is not resolvable. */
  unknown: boolean
  /** Absolute path of what we found. */
  path?: string
}

/* ------------------------------------------------------- the dev server */

/**
 * How a project starts its own dev server, read off its package.json.
 *
 * The Devices preview's answer to "nothing is answering at that URL". Forge is
 * already the terminal every dev server prints its banner into, so the honest
 * next step when the banner's server has died is to offer to run the script
 * again rather than to explain that it is gone.
 *
 * Null rather than a guess when the folder has no package.json, no scripts, or
 * none of the four names Forge recognises — a guessed command is worse than no
 * command. The empty state still offers a box to type one into, and what is
 * typed there is remembered on the workspace (`Workspace.devCommand`), so a
 * static site or a python app reaches the same Start button by another door.
 *
 * `self` is the one answer that is neither a command nor an absence: the folder
 * *is* this checkout, and the sniff refuses to guess there for a reason the
 * renderer has to know about rather than merely obey — see the latch in
 * electron/main.ts. The view swaps the Start button for the Forge Mobile
 * preview, which is how Forge looks at itself.
 */
export type PreviewDevCommand =
  | {
      kind: 'command'
      /** The whole line to put in a pane, package manager included: `npm run dev`. */
      command: string
      /** Which script it runs — `dev`, `start`, `serve` or `preview`. */
      script: string
    }
  | { kind: 'self' }

/**
 * "Is the thing listening on this port *this project's*?"
 *
 * The question the Devices preview has to ask before it frames a loopback URL.
 * A port is machine-wide and first-come-first-served, so a URL noticed in a
 * project's terminal is only ever a claim about an address — never proof that
 * the server answering there has anything to do with the project. Two projects
 * that both like port 3000 is not an edge case, it is a Tuesday.
 *
 * Answered in electron/preview/port-owner.ts, which is where the two tests that
 * settle it are written down.
 */
export interface PortOwnerQuery {
  /** The port the preview wants to frame. */
  port: number
  /**
   * The PTY pids of the asking project's live panes, so a server started by one
   * of them is recognised however deep the spawn chain goes.
   */
  pids: number[]
  /** The project's folder, for the command-line test. */
  path: string
}

export interface PortOwnerResult {
  /** The listening process, or null when nothing holds the port. */
  pid: number | null
  /** Its command line, for the message the view shows. Null when unknown. */
  command: string | null
  /**
   * Is this the asking project's server?
   *
   * Uncertainty answers `true`: a probe that could not run is not evidence of a
   * stranger, and refusing to show a project its own site because `netstat` was
   * missing would be worse than the bug this exists to prevent. Only a listener
   * positively traced to somebody else answers `false`.
   */
  owned: boolean
  /** Which test settled it — see the module for what each one means. */
  reason: 'descent' | 'address' | 'unowned' | 'closed' | 'unknown'
}

/**
 * Errors the user has to *fix something* about, rather than retry. These put
 * the pill in its amber state and open the setup card.
 */
export function isSttSetupError(kind: SttErrorKind): boolean {
  return (
    kind === 'python-missing' ||
    kind === 'sidecar-missing' ||
    kind === 'model-missing' ||
    kind === 'model-load' ||
    kind === 'crash-loop'
  )
}
