import { compareVersions } from './tools'

/**
 * The slash commands a Claude pane understands, and what has changed in the CLI
 * lately — as pure functions over two strings.
 *
 * Nothing here fetches, reads a file or touches Electron, for the same reason
 * shared/tools.ts does not: the two documents Forge reads are *published
 * markdown owned by somebody else*, so the only thing that can realistically
 * break is the parsing, and parsing that lives in a pure function is parsing
 * that `npm run commands:check` can hold to a real captured sample without a
 * network.
 *
 * Both sources were verified by hand on 2026-07-30:
 *
 *   COMMANDS_DOC_URL   raw markdown, one `| `/name args` | description |` row
 *                      per built-in command. ~60 rows.
 *   CHANGELOG_URL      `## <version>` headings, `- ` bullets underneath.
 *
 * Neither is an API and neither promises to stay this shape, which is exactly
 * why BUNDLED_COMMANDS exists below: a parse that comes back empty is treated
 * as a failed fetch, and the flyout falls back rather than showing nothing.
 */

/* ------------------------------------------------------------------ types */

/** One built-in slash command, as the docs describe it. */
export interface SlashCommand {
  /** `context` — no leading slash; the slash is punctuation, not the name. */
  name: string
  /** The argument form the docs print, e.g. `[level|auto]`. Empty when none. */
  args: string
  /** First sentence of the description — what a row shows. */
  summary: string
  /** The whole description — what the expanded row and the tooltip show. */
  detail: string
  /** Other names for the same command, e.g. `quit` for `/exit`. */
  aliases: string[]
  /**
   * The version this command first worked in, when the docs declare one.
   *
   * The page carries these as `{/* min-version: 2.1.169 *​/}` markers, and they
   * are the single most useful thing in it for somebody running a CLI that
   * ships several times a week: `/cd` reading "Unknown command" is not a broken
   * install, it is a version. Keeping the marker turns that from a puzzle into
   * a chip on the row.
   */
  minVersion?: string
}

/** One version's worth of changelog. */
export interface ReleaseNote {
  version: string
  bullets: string[]
}

/**
 * Where an answer came from, so the UI can say so.
 *
 * This is not decoration. "No network, showing what shipped in the app" and
 * "fetched a minute ago" are the difference between trusting a command list and
 * being misled by one, and a feed that cannot tell you which it is has to be
 * assumed to be the worse of the two.
 */
export type FeedOrigin = 'live' | 'cached' | 'bundled'

export interface CommandsFeed {
  commands: SlashCommand[]
  releases: ReleaseNote[]
  commandsFrom: FeedOrigin
  releasesFrom: FeedOrigin
  /** `claude --version` on this machine, when it could be read. */
  installed: string | null
  /** What the npm registry says the latest is. */
  latest: string | null
  /** When the live documents were last successfully read. */
  fetchedAt: number | null
  /** Why the last attempt did not get through, when it did not. */
  error?: string
}

/* ---------------------------------------------------------------- sources */

/** Mintlify serves every docs page as raw markdown at `.md`. This is that. */
export const COMMANDS_DOC_URL = 'https://code.claude.com/docs/en/commands.md'

/** The changelog in the repo, not the releases API — no rate limit, no auth. */
export const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md'

/* --------------------------------------------------------- the docs table */

/**
 * Split one markdown table row into cells.
 *
 * Written by hand rather than `line.split('|')` because of `/advisor
 * [model\|off]` and `/mcp [reconnect <server>\|enable\|disable]`: a pipe inside
 * a cell is escaped, and splitting naïvely turns one command into three cells
 * of nonsense. The escape is also *removed* here — `\|` in the source is a
 * literal `|` in the argument form, and printing the backslash would be quoting
 * the markdown at somebody instead of the command.
 */
function splitRow(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '\\' && line[i + 1] === '|') {
      cell += '|'
      i++
      continue
    }
    if (ch === '|') {
      cells.push(cell)
      cell = ''
      continue
    }
    cell += ch
  }
  cells.push(cell)
  const trimmed = cells.map((c) => c.trim())
  // A leading and trailing pipe are conventional, and each mints an empty cell.
  while (trimmed.length > 0 && trimmed[0] === '') trimmed.shift()
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop()
  return trimmed
}

/**
 * MDX, made readable.
 *
 * The table cells are not prose — they are source. Left alone, a row reads
 * `{/* min-version: 2.1.198 *​/}As of v2.1.198, running \`/agents\` prints a
 * reminder to ask Claude to create or manage [subagents](/docs/en/sub-agents)`,
 * which is worse than no description at all.
 *
 * Links keep their text and lose their target, because the target is a path on
 * a docs site this app has no browser for. HTML tags are deliberately *not*
 * stripped: `<path>` and `<server>` appear in these descriptions as argument
 * placeholders, and a tag-stripping pass eats exactly the words that say what
 * to type.
 */
function cleanProse(text: string): string {
  return String(text ?? '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `{/* min-version: 2.1.169 *​/}` → `2.1.169`. */
function parseMinVersion(text: string): string | null {
  const m = /\{\/\*\s*min-version:\s*v?(\d+(?:\.\d+)+)\s*\*\/\}/i.exec(String(text ?? ''))
  return m?.[1] ?? null
}

/**
 * The first sentence, for the one line a row has room for.
 *
 * Splitting on ". " is safe here in a way it usually is not, because the thing
 * being split is a table cell: version numbers like `v2.1.205` have no space
 * after their dots, so the only dot-then-space in one of these cells is a real
 * full stop.
 */
function firstSentence(text: string): string {
  const t = text.trim()
  const stop = t.search(/[.!?](\s|$)/)
  const s = (stop === -1 ? t : t.slice(0, stop + 1)).trim()
  return s.length > 240 ? `${s.slice(0, 239)}…` : s
}

/**
 * `Alias: /quit` and `Aliases: /reset, /new`, as names.
 *
 * Worth pulling out rather than leaving in the prose because an alias is a
 * thing you *search for*: typing "new" and being told there is no such command
 * when `/new` works perfectly well is the search being wrong, not you.
 */
function parseAliases(text: string): string[] {
  const found: string[] = []
  // `Alias(es)?`, not `Aliases?` — the latter reads as "Aliase" plus an optional
  // "s" and silently misses every singular "Alias:", which is most of them.
  for (const m of text.matchAll(/Alias(?:es)?:\s*([^.]*)/gi)) {
    for (const hit of (m[1] ?? '').matchAll(/`\/([a-z0-9][a-z0-9-]*)`/gi)) {
      found.push(hit[1]!.toLowerCase())
    }
  }
  return [...new Set(found)]
}

/**
 * Every command in the docs page.
 *
 * Deliberately forgiving: anything that is not a two-cell row whose first cell
 * is a backticked `/name` is skipped in silence — the page has headings, notes
 * and prose around the table, and one day it may have a second table. A row it
 * cannot read is a row it does not show, never a throw.
 *
 * The first spelling of a name wins. The page lists `/cost` as an alias row of
 * its own ("Alias for `/usage`"), and both should appear, but neither should
 * appear twice if the page ever repeats itself.
 */
export function parseCommandsDoc(markdown: string): SlashCommand[] {
  const out: SlashCommand[] = []
  const seen = new Set<string>()

  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    // `|---|:--|` and friends: the row that draws the line under the header.
    if (/^\|[\s:|-]+$/.test(line)) continue

    const cells = splitRow(line)
    if (cells.length < 2) continue

    const head = /^`\/([a-z0-9][a-z0-9-]*)([^`]*)`$/i.exec(cells[0]!)
    if (!head) continue

    const name = head[1]!.toLowerCase()
    const source = cells[1]!.trim()
    if (!source || seen.has(name)) continue
    seen.add(name)

    // Aliases and the version marker are read from the *source*, before the
    // backticks and the MDX comment they live inside are cleaned away.
    const aliases = parseAliases(source)
    const minVersion = parseMinVersion(source)
    const detail = cleanProse(source)

    out.push({
      name,
      args: (head[2] ?? '').trim(),
      summary: firstSentence(detail),
      detail,
      aliases,
      ...(minVersion ? { minVersion } : {})
    })
  }

  return out
}

/* ----------------------------------------------------------- the changelog */

/**
 * `## 2.1.220` and the bullets under it, newest first.
 *
 * `limit` is a guard rather than a preference: the file is every version ever
 * shipped and grows forever, and nothing in the UI is going to show version
 * 1.0.4. Stopping at the cap keeps a 400 KB document from becoming 400 KB of
 * parsed objects held in memory for the life of the app.
 */
export function parseChangelog(markdown: string, limit = 40): ReleaseNote[] {
  const out: ReleaseNote[] = []
  let current: ReleaseNote | null = null

  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    const head = /^##\s+v?(\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)\s*$/.exec(line)
    if (head) {
      if (out.length >= limit) break
      current = { version: head[1]!, bullets: [] }
      out.push(current)
      continue
    }
    if (!current) continue
    const bullet = /^[-*]\s+(.+)$/.exec(line)
    if (bullet) current.bullets.push(bullet[1]!.trim())
  }

  return out
}

/**
 * The versions that landed after the one you are running.
 *
 * Empty means up to date, and the UI says so rather than pretending the last
 * eight entries are news — which is the whole point of asking. When the
 * installed version cannot be read at all, nothing can be claimed to be new, so
 * this answers empty and the caller shows recent history instead.
 */
export function releasesAhead(
  releases: ReleaseNote[],
  installed: string | null | undefined
): ReleaseNote[] {
  if (!installed) return []
  return releases.filter((r) => compareVersions(r.version, installed) > 0)
}

/**
 * Does this command need a newer CLI than the one installed?
 *
 * Answers false whenever it cannot be sure — no marker, or no readable
 * installed version. A reference that greys out a command you actually have is
 * worse than one that stays quiet, because the first makes you stop trying.
 */
export function needsNewerCli(
  command: SlashCommand,
  installed: string | null | undefined
): boolean {
  if (!command.minVersion || !installed) return false
  return compareVersions(command.minVersion, installed) > 0
}

/* -------------------------------------------------------------- searching */

/**
 * Does this command match what has been typed?
 *
 * Name first, then aliases, then the prose. A leading slash is ignored because
 * typing `/co` into a box full of slash commands is the natural thing to do and
 * matching it literally would find nothing.
 */
export function matchesQuery(command: SlashCommand, query: string): boolean {
  const q = String(query ?? '').trim().toLowerCase().replace(/^\//, '')
  if (!q) return true
  if (command.name.includes(q)) return true
  if (command.aliases.some((a) => a.includes(q))) return true
  return command.detail.toLowerCase().includes(q)
}

/**
 * Commands whose name starts with the query, before ones that merely contain
 * it, before ones that only match in their description — so `/co` puts `/color`
 * and `/compact` above the dozen commands whose prose says "context".
 */
export function rankCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = String(query ?? '').trim().toLowerCase().replace(/^\//, '')
  const matched = commands.filter((c) => matchesQuery(c, q))
  if (!q) return matched
  const rank = (c: SlashCommand): number => {
    if (c.name.startsWith(q)) return 0
    if (c.aliases.some((a) => a.startsWith(q))) return 1
    if (c.name.includes(q)) return 2
    return 3
  }
  return matched
    .map((c, i) => ({ c, i, r: rank(c) }))
    // Index as the tiebreak keeps the docs' own order — which is alphabetical —
    // inside each rank, rather than whatever the sort happens to do.
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c)
}

/** `/effort [level|auto]` — the whole thing, for a heading. */
export function commandSignature(command: SlashCommand): string {
  return command.args ? `/${command.name} ${command.args}` : `/${command.name}`
}

/**
 * What actually gets typed into a pane.
 *
 * The argument form is *not* included. `/add-dir <path>` is documentation;
 * typing it into Claude Code submits a literal `<path>`, and a helper that puts
 * a placeholder where a real value goes is a helper that has to be corrected
 * every single time. The trailing space is deliberate — the cursor lands where
 * the argument goes.
 */
export function commandToType(command: SlashCommand): string {
  return command.args ? `/${command.name} ` : `/${command.name}`
}

/* ---------------------------------------------------------------- bundled */

/**
 * When the snapshot below was taken from the live page.
 *
 * Shown in the UI whenever the bundled list is what is on screen. A cheat sheet
 * that cannot say how old it is invites you to trust a command that was renamed
 * six months ago.
 */
export const BUNDLED_SNAPSHOT_DATE = '2026-07-30'

/**
 * Enough of the list to be useful with no network, on first run, forever.
 *
 * Not the whole page — that would be a second copy of somebody else's document
 * to keep in step, and the point of fetching is that we do not have to. These
 * are the commands that are worth having when the fetch has failed: the ones
 * that manage context and cost, the ones that get you out of trouble, and the
 * ones whose names are not guessable. Summaries are shortened from the source.
 */
const BUNDLED_ROWS: Array<[name: string, args: string, summary: string, aliases: string[]]> = [
  ['add-dir', '<path>', 'Add a working directory for file access during the current session.', []],
  ['agents', '', 'Create and manage subagent configurations.', []],
  ['background', '[prompt]', 'Detach this session to run as a background agent and free the terminal.', ['bg']],
  ['branch', '[name]', 'Branch the conversation here, so you can try a different direction without losing this one.', []],
  ['bug', '[report]', 'Report a bug or share the conversation, after a consent screen.', ['share']],
  ['clear', '[name]', 'Start a new conversation with empty context.', ['reset', 'new']],
  ['compact', '[instructions]', 'Free up context by summarising the conversation so far.', []],
  ['config', '[key=value]', 'Open settings, or set one directly with key=value.', ['settings']],
  ['context', '[all]', 'Show what is using the context window, as a grid.', []],
  ['copy', '[N]', 'Copy the last assistant response — or the Nth latest — to the clipboard.', []],
  ['cost', '', 'What this session has cost. Alias for /usage.', []],
  ['diff', '', 'An interactive diff viewer for uncommitted changes and per-turn diffs.', []],
  ['doctor', '', 'Check the health of the installation and its dependencies.', []],
  ['effort', '[level|auto]', 'Set the model effort level: low, medium, high, xhigh, max.', []],
  ['exit', '', 'Exit the CLI.', ['quit']],
  ['export', '[filename]', 'Export the conversation as plain text.', []],
  ['fork', '[prompt]', 'Copy this conversation into a background session and keep working here.', []],
  ['help', '', 'Show help and available commands.', []],
  ['hooks', '', 'View hook configurations for tool events.', []],
  ['init', '', 'Initialise the project with a CLAUDE.md guide.', []],
  ['keybindings', '', 'Open your keyboard shortcuts file.', []],
  ['login', '', 'Sign in to your Anthropic account.', []],
  ['logout', '', 'Sign out.', []],
  ['mcp', '', 'Manage MCP server connections and OAuth authentication.', []],
  ['memory', '', 'Edit CLAUDE.md memory files and view auto-memory entries.', []],
  ['model', '[model]', 'Switch model, and save it as the default for new sessions.', []],
  ['permissions', '', 'Review and edit what Claude is allowed to do without asking.', []],
  ['resume', '', 'Reopen an earlier conversation from a picker.', []],
  ['review', '', 'Review a pull request.', []],
  ['rewind', '', 'Rewind the conversation, the code, or both, to an earlier point.', []],
  ['status', '', 'Account, model, connection and version, in one screen.', []],
  ['statusline', '', 'Set up the status line at the foot of the CLI.', []],
  ['terminal-setup', '', 'Install the key binding that makes Shift+Enter a newline.', []],
  ['todos', '', 'Show the current to-do list.', []],
  ['usage', '', 'Token usage and cost for this session, and your plan limits.', ['cost']],
  ['vim', '', 'Toggle vim-style editing in the prompt.', []]
]

export const BUNDLED_COMMANDS: SlashCommand[] = BUNDLED_ROWS.map(([name, args, summary, aliases]) => ({
  name,
  args,
  summary,
  // The snapshot has no long form. Repeating the summary keeps every consumer
  // free of "which of these two fields is populated this time".
  detail: summary,
  aliases
}))
