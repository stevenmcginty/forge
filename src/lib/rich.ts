/**
 * The data contract between the terminal (xterm, fed real PTY bytes) and the
 * conversation display Forge Web draws over it.
 *
 * Decision 6 in docs/forge-web.md stands: xterm is the emulator and the PTY is
 * the truth. What this file adds is the *shape* of what the display reads off
 * that emulator — styled text, cut into turns, plus the agent's own status line
 * lifted out of its TUI footer — so that lib/term.ts (which produces it),
 * lib/feed.ts (which structures it) and components/Feed.tsx (which paints it)
 * agree on one vocabulary without importing each other's internals.
 */

/** One run of cells that share a style. Colours are CSS strings, already resolved. */
export interface Run {
  text: string
  /** Resolved foreground, or undefined for the terminal's default. */
  fg?: string
  /** Resolved background, or undefined for the terminal's default. */
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
}

/** One logical line of the screen (wrapped rows already joined). */
export interface RichLine {
  runs: Run[]
  /** The same line as plain text — what the parser classifies on. */
  text: string
}

/**
 * `thinking` is the agent's shown reasoning — Grok folds it under a
 * `Thinking…` header — and is drawn folded on both faces, never as the answer.
 */
export type FeedRole = 'user' | 'agent' | 'system' | 'tool' | 'thinking'

export interface FeedBlock {
  /** Role and position in the capture — stable across re-parses, not a uuid. */
  id: string
  role: FeedRole
  lines: RichLine[]
  /** Plain text of the block, for copy and for tests. */
  text: string
  /**
   * The clock the TUI printed beside a user turn (`12:40 PM`), lifted off the
   * end of the line so the words and the time can be set apart. Only Grok
   * prints one so far; absent means the screen did not say.
   */
  clock?: string
}

/** The permission / approval mode an agent TUI reports in its footer. */
export type PermissionMode = 'bypass' | 'accept-edits' | 'plan' | 'default' | 'auto' | 'unknown'

/**
 * What an agent's own footer says about itself, lifted out of the screen so the
 * page can show it in one consistent strip instead of the TUI's own chrome.
 * Every field is optional because every CLI draws a different footer; a field
 * the parser is not sure about is left undefined rather than guessed.
 */
export interface PaneStatus {
  /** Model name as the TUI prints it — "Opus 4.1", "gpt-5-codex", "grok-4". */
  model?: string
  mode: PermissionMode
  /** The mode as the TUI printed it, for a tooltip. */
  modeLabel?: string
  /** Working directory / branch, when shown. */
  cwd?: string
  branch?: string
  /** Context usage as the TUI prints it — "42%", "128k left". */
  context?: string
  /** The TUI is mid-turn (spinner, "Thinking…", "Working…", elapsed timer). */
  busy: boolean
  /** A short phrase for the busy state — "Thinking", "Running tool", "Baking…". */
  activity?: string
  /**
   * What is left of the plan's quota, as the TUI printed it — Grok's
   * `Weekly limit left: 3%`. Nothing else prints one, so it is absent for the rest.
   */
  quota?: string
  /** The raw footer lines that were stripped, for a "show footer" affordance. */
  footer: string[]
}

export interface Transcript {
  blocks: FeedBlock[]
  status: PaneStatus
}
