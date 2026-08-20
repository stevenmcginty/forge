import { commandExe } from './agents'
import type { ToolId, ToolLatest, ToolLatestSource, ToolSpec } from './types'

/**
 * The tools Forge knows how to *report on*, and the pure logic for reading
 * versions out of what they print.
 *
 * Everything here is deliberately free of Electron, `node:child_process` and
 * `fetch`: the main process supplies the strings (a stdout, a registry JSON
 * body) and this file turns them into answers. That is what lets
 * `npm run updates:check` test the parsing without a machine that happens to
 * have winget on it, and what keeps "is 7.6.4 older than 7.6.10?" one function
 * with one test rather than an inline comparison at four call sites.
 *
 * The catalogue below is the whole contract for the Updates & Tools section.
 * Adding a row is adding an entry here.
 */

/* ----------------------------------------------------------------- catalogue */

/**
 * Update commands are typed into a real pane rather than run for you — see
 * `openToolPane` in src/state/AppState.tsx. So they are written the way you
 * would write them yourself, not the way a script would: no `--silent`, no
 * `--accept-package-agreements`, nothing that suppresses a prompt you should
 * be reading.
 *
 * Most rows below no longer spell their update command out at all: `npm i -g
 * <the package we already ask the registry about>` and `winget upgrade <the id
 * that just answered>` are derivable from the `latest` block, so
 * `updateCommandFor()` derives them. A literal `updateCommand` here means the
 * derived one would be *wrong*, and the comment says why. That is what lets a
 * tool added in Settings get a working Update button without anyone writing
 * code for it.
 */
export const TOOL_SPECS: ToolSpec[] = [
  {
    id: 'pwsh',
    name: 'PowerShell',
    blurb: 'the shell every pane starts in',
    command: 'pwsh',
    versionArgs: ['--version'],
    latest: { source: 'winget', wingetIds: ['Microsoft.PowerShell'] },
    // Derived: one winget id, so there is nothing to disambiguate.
    updateCommand: null
  },
  {
    id: 'claude',
    name: 'Claude Code',
    blurb: 'the `claude` CLI — also what the GLM 5.3 pane runs',
    command: 'claude',
    versionArgs: ['--version'],
    latest: { source: 'npm', npmPackage: '@anthropic-ai/claude-code' },
    // `claude update` is a real subcommand (aliased `upgrade`) — verified
    // against `claude --help` on 2026-07-30. It knows whether this install came
    // from npm or from the native build, which `npm i -g` does not, so it is
    // the better command even though the npm one would usually work.
    updateCommand: 'claude update'
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    blurb: 'OpenAI’s `codex` CLI',
    command: 'codex',
    versionArgs: ['--version'],
    latest: { source: 'npm', npmPackage: '@openai/codex' },
    // Derived both ways: `npm i -g @openai/codex` updates it and installs it,
    // which is why this row works at all on a machine that has never had it.
    updateCommand: null
  },
  {
    id: 'grok',
    name: 'Grok Build',
    blurb: 'xAI’s `grok` CLI — what the Grok pane runs',
    command: 'grok',
    versionArgs: ['--version'],
    // A closed binary from xAI's own installer: not on npm, not on winget, so
    // there is no registry to ask about a newer version and the row reads
    // "managed locally". The install command is the Windows spelling of xAI's
    // official installer (everywhere else it is install.sh piped to bash) —
    // PowerShell only, not CMD — and `grok` signs in with a grok.com account
    // on first run. `grok update` is a real subcommand — verified against
    // `grok --help` (1.0.3, 2026-08-13) — and the only updater there is for a
    // binary no registry serves.
    latest: { source: 'local' },
    updateCommand: 'grok update',
    installCommand: 'irm https://x.ai/cli/install.ps1 | iex'
  },
  {
    id: 'kimi',
    name: 'Kimi',
    blurb: 'a local shim — it launches Claude Code against Kimi via OpenRouter',
    command: 'kimi',
    // Deliberately not probed for a version: `kimi --version` would start
    // Claude Code with a Kimi model configured and report *Claude's* version,
    // which is a wrong answer dressed as a right one.
    versionArgs: null,
    latest: { source: 'local' },
    updateCommand: null
  },
  {
    id: 'antigravity',
    name: 'Antigravity CLI',
    blurb: 'Google’s `agy` CLI — what the Antigravity pane runs',
    command: 'agy',
    versionArgs: ['--version'],
    // A closed-source Go binary from Google's own installer: not on npm, not
    // on winget, so there is no registry to ask about a newer version and the
    // row reads "managed locally". The install command is Google's official
    // PowerShell one-liner — it drops the binary under %LOCALAPPDATA%, no
    // admin rights needed, and `agy` signs in with a Google account on first
    // run.
    //
    // `agy update` is a real subcommand — verified against `agy --help`
    // (1.1.16, 2026-08-20) — and, like grok's, the only updater there is for a
    // binary no registry serves. Without it this row was the one harness in the
    // list with no way to move it forward from inside Forge.
    latest: { source: 'local' },
    updateCommand: 'agy update',
    installCommand: 'irm https://antigravity.google/cli/install.ps1 | iex'
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    blurb: 'the legacy `gemini` CLI — personal accounts moved to Antigravity',
    command: 'gemini',
    versionArgs: ['--version'],
    latest: { source: 'npm', npmPackage: '@google/gemini-cli' },
    updateCommand: null
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    blurb: 'the `opencode` CLI — also what the DeepSeek V4 pane runs',
    command: 'opencode',
    versionArgs: ['--version'],
    latest: { source: 'npm', npmPackage: 'opencode-ai' },
    // Derived (`npm i -g opencode-ai`), which both installs and updates it.
    // Worth knowing when this row disagrees with reality: OpenCode self-updates
    // by default, so it can move underneath you between two glances at this
    // panel. `"autoupdate": false` in ~/.config/opencode/opencode.json stops it.
    updateCommand: null
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    blurb: 'Alibaba’s `qwen` CLI — what the Qwen pane runs',
    command: 'qwen',
    versionArgs: ['--version'],
    latest: { source: 'npm', npmPackage: '@qwen-code/qwen-code' },
    // Derived (`npm i -g @qwen-code/qwen-code`), which both installs and
    // updates it. `qwen update` is a real subcommand — but it updates the
    // standalone build from Alibaba's own bucket, not an npm global, so the
    // button would be right for one install method and quietly wrong for the
    // other. npm is what the Install button here types, so npm is what the
    // Update button has to keep working on.
    updateCommand: null
  },
  {
    id: 'node',
    name: 'Node',
    blurb: 'runs the MCP bridge — update it however you installed it',
    command: 'node',
    versionArgs: ['--version'],
    // Two ids because winget splits Node into current and LTS, and which one
    // you have is not something Forge gets to assume. Whichever is *installed*
    // answers; if neither is, Node came from the .msi or from nvm and winget
    // has nothing to say about it — which the UI reports rather than guessing.
    latest: { source: 'winget', wingetIds: ['OpenJS.NodeJS.LTS', 'OpenJS.NodeJS'] },
    // Still null, and still for the original reason: nvm's Node is not winget's
    // Node, and `winget upgrade` aimed at the wrong one either does nothing or
    // installs a second copy. What has changed is that the button is no longer
    // permanently absent — `updateCommandFor` derives one *once a check has come
    // back naming the id winget actually has*. No answer, no button.
    updateCommand: null
  }
]

/**
 * Tools Forge does not run itself, offered as one-click additions in Settings.
 *
 * The catalogue above is "what Forge needs to work". This is "what Steve is
 * likely to want a row for anyway" — and the only thing separating the two is
 * that adding one of these writes a custom tool into settings.json rather than
 * shipping in the binary. Each is exactly the same shape, so an entry here is a
 * suggestion, never a special case: pick it and it becomes an ordinary custom
 * row that can then be edited or deleted like any other.
 *
 * Version arguments and package ids are the ones these tools actually use —
 * `git version 2.43.0` and `ffmpeg version 7.1` both parse, which is the only
 * thing that has to be right for a row to work.
 */
export const KNOWN_TOOLS: ToolSpec[] = [
  {
    id: 'git',
    name: 'Git',
    blurb: 'version control — every agent in every pane uses it',
    command: 'git',
    versionArgs: ['--version'],
    latest: { source: 'winget', wingetIds: ['Git.Git'] },
    updateCommand: null
  },
  {
    id: 'gh',
    name: 'GitHub CLI',
    blurb: 'the `gh` CLI — PRs, issues, releases',
    command: 'gh',
    versionArgs: ['--version'],
    latest: { source: 'winget', wingetIds: ['GitHub.cli'] },
    updateCommand: null
  },
  {
    id: 'firebase',
    name: 'Firebase CLI',
    blurb: 'deploys the phone companion’s database rules',
    command: 'firebase',
    versionArgs: ['--version'],
    latest: { source: 'npm', npmPackage: 'firebase-tools' },
    updateCommand: null
  },
  // opencode was here as a suggestion, described as "a candidate for an agent
  // profile". It is now a built-in profile and a built-in TOOL_SPEC, so leaving
  // the suggestion would offer a row that allToolSpecs drops as a duplicate.
  // qwen was here as a suggestion too, and left for the same reason opencode
  // did: it is now a built-in profile and a built-in TOOL_SPEC, so a suggestion
  // row would only offer something allToolSpecs drops as a duplicate.
  {
    id: 'uv',
    name: 'uv',
    blurb: 'the Python installer the dictation sidecar is built with',
    command: 'uv',
    versionArgs: ['--version'],
    latest: { source: 'winget', wingetIds: ['astral-sh.uv'] },
    updateCommand: null
  },
  {
    id: 'rg',
    name: 'ripgrep',
    blurb: 'the search every coding agent reaches for first',
    command: 'rg',
    versionArgs: ['--version'],
    latest: { source: 'winget', wingetIds: ['BurntSushi.ripgrep.MSVC'] },
    updateCommand: null
  },
  {
    id: 'ffmpeg',
    name: 'FFmpeg',
    blurb: 'video and audio, behind the media tools',
    command: 'ffmpeg',
    versionArgs: ['-version'],
    latest: { source: 'winget', wingetIds: ['Gyan.FFmpeg'] },
    updateCommand: null
  },
  {
    id: 'ollama',
    name: 'Ollama',
    blurb: 'local models',
    command: 'ollama',
    versionArgs: ['--version'],
    latest: { source: 'winget', wingetIds: ['Ollama.Ollama'] },
    updateCommand: null
  },
  {
    id: 'bun',
    name: 'Bun',
    blurb: 'a faster npm, when a project wants one',
    command: 'bun',
    versionArgs: ['--version'],
    latest: { source: 'winget', wingetIds: ['Oven-sh.Bun'] },
    updateCommand: null
  },
  {
    id: 'deno',
    name: 'Deno',
    blurb: 'the other JavaScript runtime',
    command: 'deno',
    versionArgs: ['--version'],
    latest: { source: 'winget', wingetIds: ['DenoLand.Deno'] },
    updateCommand: null
  },
  {
    id: 'code',
    name: 'VS Code',
    blurb: 'the editor, for when a pane is not the right shape',
    command: 'code',
    versionArgs: ['--version'],
    latest: { source: 'winget', wingetIds: ['Microsoft.VisualStudioCode'] },
    updateCommand: null
  }
]

export function toolSpec(id: ToolId): ToolSpec | undefined {
  return TOOL_SPECS.find((t) => t.id === id)
}

/**
 * The catalogue row for whatever a *launch command* runs — `codex` for
 * `codex --full-auto`, `opencode` for the DeepSeek profile's long line.
 *
 * This is the join between two lists that were written for different reasons:
 * agent profiles (what a pane launches) and tool specs (what Forge can check
 * and install). Without it, "Codex is not installed" and "here is the command
 * that installs it" would be two facts Forge holds and cannot put together.
 */
export function toolSpecForCommand(command: string, custom?: readonly ToolSpec[] | null): ToolSpec | null {
  const exe = commandExe(command)
  if (!exe) return null
  return allToolSpecs(custom).find((t) => commandExe(t.command) === exe) ?? null
}

/**
 * The whole catalogue: what Forge ships with, then whatever was added by hand.
 *
 * One function so main and renderer can never disagree about what the rows are.
 * A custom tool whose id collides with a built-in is dropped rather than
 * shadowing it — `sanitiseCustomTool` prefixes every custom id with `x:` so this
 * can only happen to a settings.json edited by hand, and quietly replacing
 * PowerShell's update command from a config file is not a thing this should
 * allow.
 */
export function allToolSpecs(custom?: readonly ToolSpec[] | null): ToolSpec[] {
  const seen = new Set(TOOL_SPECS.map((t) => t.id))
  const extra: ToolSpec[] = []
  for (const tool of custom ?? []) {
    if (!tool || seen.has(tool.id)) continue
    seen.add(tool.id)
    extra.push({ ...tool, custom: true })
  }
  return [...TOOL_SPECS, ...extra]
}

/* ------------------------------------------------------- what to type */

/**
 * The command the Update button puts in a pane, or null when there honestly
 * isn't one.
 *
 * Derived from the same `latest` block that the check uses, so the two can
 * never drift: if Forge knows enough to tell you a newer version exists, it
 * knows enough to tell you how to get it. A spec's own `updateCommand` wins,
 * for the cases where the obvious command is the wrong one — `claude update`
 * knows whether that install came from npm or the native build, and `npm i -g`
 * does not.
 *
 * `latest` is passed in for the winget case with more than one candidate id
 * (Node: current or LTS). The id that *answered* a check is the installed one;
 * with no check yet and no way to choose, this returns null and the row shows a
 * Check button instead of guessing which Node to upgrade.
 */
export function updateCommandFor(spec: ToolSpec, latest?: ToolLatest | null): string | null {
  const explicit = (spec.updateCommand ?? '').trim()
  if (explicit) return explicit
  switch (spec.latest.source) {
    case 'npm': {
      const pkg = (spec.latest.npmPackage ?? '').trim()
      return pkg ? `npm i -g ${pkg}` : null
    }
    case 'winget': {
      const id = wingetIdFor(spec, latest)
      return id ? `winget upgrade --id ${id} --exact` : null
    }
    default:
      return null
  }
}

/**
 * What to type when the tool is not on the machine at all.
 *
 * Rows for things you have not installed are the point rather than an oversight:
 * "Codex CLI — not installed — [Install]" is how a tool Forge has never seen
 * becomes a tool Forge keeps up to date, without a trip to a browser to find out
 * what the incantation is this month.
 *
 * Unlike the update case, an ambiguous winget id resolves to the first one —
 * there is nothing installed to be wrong about, and for Node the first id is the
 * LTS, which is the right default for somebody who has not chosen.
 */
export function installCommandFor(spec: ToolSpec): string | null {
  const explicit = (spec.installCommand ?? '').trim()
  if (explicit) return explicit
  switch (spec.latest.source) {
    case 'npm': {
      const pkg = (spec.latest.npmPackage ?? '').trim()
      return pkg ? `npm i -g ${pkg}` : null
    }
    case 'winget': {
      const id = (spec.latest.wingetIds ?? []).find((w) => w.trim())
      return id ? `winget install --id ${id.trim()} --exact` : null
    }
    default:
      return null
  }
}

/** The winget id to act on: the one that answered, or the only candidate. */
function wingetIdFor(spec: ToolSpec, latest?: ToolLatest | null): string | null {
  const ids = (spec.latest.wingetIds ?? []).map((w) => w.trim()).filter(Boolean)
  const via = (latest?.via ?? '').trim()
  if (via && ids.includes(via)) return via
  return ids.length === 1 ? ids[0]! : null
}

/* ------------------------------------------------------------ custom tools */

/** Every id written from Settings carries this, so it cannot shadow a built-in. */
export const CUSTOM_TOOL_PREFIX = 'x:'

/** Nothing bigger than this is a tools list; it is a corrupted file. */
export const MAX_CUSTOM_TOOLS = 40

/**
 * Is this a command Forge is willing to *spawn* to read a version?
 *
 * Probing runs `execFile(command, versionArgs, { shell: true })` — shell:true
 * because npm's shims are .cmd files that CreateProcess refuses to run directly.
 * That makes the command string shell syntax, so anything that could end one
 * statement and begin another is refused here: a tools list is a place to name a
 * program, not a place to write a pipeline.
 *
 * Update commands are deliberately *not* held to this. They are typed into a
 * terminal for a person to read and press Enter on, which is the correct place
 * for `winget upgrade X; npm i -g Y` — and no more privileged than the same
 * person typing it themselves.
 */
export function isPlainCommand(command: string): boolean {
  const c = String(command ?? '').trim()
  if (!c || c.length > 200) return false
  return !/[|&;<>^"'`$(){}\[\]*?!\n\r\t%]/.test(c)
}

/** A version argument: a flag or a word, never a fragment of shell. */
export function isPlainArg(arg: string): boolean {
  const a = String(arg ?? '').trim()
  return a.length > 0 && a.length <= 40 && /^[A-Za-z0-9._=\-\/]+$/.test(a)
}

/**
 * One line, no control characters — it is going into a terminal verbatim.
 *
 * The newline strip is the load-bearing part of this. With "press Enter for
 * me" turned on, a stored command containing a line break would submit its
 * first line and then run whatever followed — a two-line command wearing the
 * costume of one. Every string that can reach a pane goes through here.
 */
function oneLine(value: unknown, max: number): string {
  // Written as a loop rather than a regex because the character class it would
  // need is the one thing a source file cannot hold literally.
  let out = ''
  for (const ch of String(value ?? '')) {
    const code = ch.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f ? ' ' : ch
  }
  return out.trim().slice(0, max)
}

/** `Windows Terminal` → `x:windows-terminal`. Stable, so editing keeps the row. */
export function customToolId(seed: string): string {
  const slug = String(seed ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${CUSTOM_TOOL_PREFIX}${slug || 'tool'}`
}

/**
 * A tool row out of whatever a form or a hand-edited settings.json offered.
 *
 * Returns null rather than a half-built row: a tool with no name or no command
 * is not a tool, and a settings file that has one should lose that entry, not
 * put a blank line in the settings page. Everything else is clamped rather than
 * rejected, because a 300-character blurb is a mistake worth surviving.
 */
export function sanitiseCustomTool(raw: unknown): ToolSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const name = oneLine(r['name'], 40)
  const command = oneLine(r['command'], 200)
  if (!name || !isPlainCommand(command)) return null

  const rawId = oneLine(r['id'], 60)
  const id = rawId.startsWith(CUSTOM_TOOL_PREFIX) ? rawId : customToolId(rawId || name || command)

  const source = r['latest'] as Record<string, unknown> | undefined
  const declared = oneLine(source?.['source'], 12)
  const kind: ToolLatestSource =
    declared === 'npm' || declared === 'winget' || declared === 'local' ? (declared as ToolLatestSource) : 'none'

  const latest: ToolSpec['latest'] = { source: kind }
  if (kind === 'npm') {
    const pkg = oneLine(source?.['npmPackage'], 120)
    // The registry's own rules, near enough: a name that cannot be a package is
    // a check that will 404 forever, so it becomes "not checked" instead.
    if (/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(pkg)) latest.npmPackage = pkg
    else latest.source = 'none'
  }
  if (kind === 'winget') {
    const ids = (Array.isArray(source?.['wingetIds']) ? (source!['wingetIds'] as unknown[]) : [])
      .map((w) => oneLine(w, 120))
      .filter((w) => /^[A-Za-z0-9._+-]+$/.test(w))
      .slice(0, 3)
    if (ids.length) latest.wingetIds = ids
    else latest.source = 'none'
  }

  // `null` is meaningful — "never spawn this one" — and is not the same as the
  // key being absent, which means "the usual --version".
  const rawArgs = r['versionArgs']
  const versionArgs: string[] | null =
    rawArgs === null
      ? null
      : Array.isArray(rawArgs)
        ? (rawArgs.map((a) => oneLine(a, 40)).filter(isPlainArg).slice(0, 4) as string[])
        : ['--version']

  const tool: ToolSpec = {
    id,
    name,
    blurb: oneLine(r['blurb'], 120),
    command,
    versionArgs: versionArgs === null ? null : versionArgs.length ? versionArgs : ['--version'],
    latest,
    updateCommand: oneLine(r['updateCommand'], 300) || null,
    custom: true
  }
  const install = oneLine(r['installCommand'], 300)
  if (install) tool.installCommand = install
  return tool
}

/** A settings.json's worth of them: valid, unique, and not a thousand of them. */
export function sanitiseCustomTools(raw: unknown): ToolSpec[] {
  const list = Array.isArray(raw) ? raw : []
  const out: ToolSpec[] = []
  const seen = new Set<string>(TOOL_SPECS.map((t) => t.id))
  for (const entry of list) {
    const tool = sanitiseCustomTool(entry)
    if (!tool || seen.has(tool.id)) continue
    seen.add(tool.id)
    out.push(tool)
    if (out.length >= MAX_CUSTOM_TOOLS) break
  }
  return out
}

/** What `latest` means for this tool, in one word, for the UI to caption with. */
export function latestSourceLabel(source: ToolLatestSource): string {
  switch (source) {
    case 'npm':
      return 'npm registry'
    case 'winget':
      return 'winget'
    case 'local':
      return 'managed locally'
    default:
      return 'not checked'
  }
}

/* ------------------------------------------------------------- version maths */

/**
 * The version out of a `--version` line.
 *
 *   "PowerShell 7.6.4"          → 7.6.4
 *   "2.1.220 (Claude Code)"     → 2.1.220
 *   "v24.13.0"                  → 24.13.0
 *   "0.53.0"                    → 0.53.0
 *
 * Leading `v` is dropped because `node --version` is the only one that prints
 * it and comparing "v24.13.0" against winget's "24.18.0" as strings is exactly
 * the bug this function exists to prevent.
 */
export function parseVersion(text: string): string | null {
  const match = /\bv?(\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(text ?? ''))
  return match?.[1] ?? null
}

/**
 * Compare two dotted versions. -1 / 0 / 1, with the shorter one padded rather
 * than treated as smaller, so 7.6 and 7.6.0 are the same version.
 *
 * A prerelease suffix (`-rc.1`) sorts *before* the release it belongs to, per
 * semver, which matters the one time it matters: an installed 8.0.0-preview.2
 * must not read as newer than a released 8.0.0.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string } => {
    const clean = String(v ?? '')
      .trim()
      .replace(/^v/i, '')
    const [core = '', ...rest] = clean.split('-')
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: rest.join('-') }
  }
  const x = split(a)
  const y = split(b)
  const len = Math.max(x.nums.length, y.nums.length)
  for (let i = 0; i < len; i++) {
    const dx = x.nums[i] ?? 0
    const dy = y.nums[i] ?? 0
    if (dx !== dy) return dx < dy ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  // No suffix beats a suffix; otherwise fall back to a plain string order,
  // which is right for the rc.1 / rc.2 case and harmless for anything else.
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

/** Is `latest` a version worth telling somebody about, given what they have? */
export function isNewer(latest: string | null | undefined, installed: string | null | undefined): boolean {
  if (!latest || !installed) return false
  return compareVersions(latest, installed) > 0
}

/**
 * How to spell the latest version *next to* the installed one.
 *
 * winget reports PowerShell as `7.6.4.0` — the MSIX package version, four
 * fields — while `pwsh --version` says `7.6.4`. They are the same release, and
 * compareVersions knows it, but a row reading "7.6.4 → 7.6.4.0" is a person
 * squinting at two numbers trying to spot the difference. So when the two are
 * the same version, the latest column borrows the installed version's spelling
 * and the row reads "7.6.4 → 7.6.4": nothing to do, and obviously nothing to do.
 *
 * Only ever equal versions are rewritten. A real difference is always shown
 * exactly as its source reported it.
 */
export function displayLatest(latest: string, installed: string | null | undefined): string {
  if (!installed) return latest
  return compareVersions(latest, installed) === 0 ? installed : latest
}

/* ------------------------------------------------------------ winget parsing */

export interface WingetRow {
  /** Version winget believes is installed. */
  installed: string | null
  /** The `Available` column — present only when there is an upgrade. */
  available: string | null
  /** False when winget says the package is not installed at all. */
  present: boolean
}

/**
 * Read one row out of `winget list --id <ID> --exact`.
 *
 * winget prints a fixed-width table whose columns are positioned by the header,
 * and — when its stdout is a pipe rather than a console — nothing else: no
 * spinner, no carriage-return redraws. Verified against the real thing:
 *
 *   Name    Id                Version Available Source
 *   --------------------------------------------------
 *   Node.js OpenJS.NodeJS.LTS 24.13.0 24.18.0   winget
 *
 * The `Available` column simply does not exist when everything is up to date,
 * which is why "up to date" is `available: null` rather than a comparison.
 *
 * Column offsets are taken from the header rather than splitting on whitespace,
 * because a package called "Windows Terminal" has a space in it and would
 * otherwise shift every column right by one. When the header cannot be found —
 * a localised winget, a future format — it falls back to picking version-shaped
 * tokens out of the row, which is worse but never wrong about *whether* an
 * upgrade exists.
 */
export function parseWingetList(stdout: string, id: string): WingetRow {
  const absent: WingetRow = { installed: null, available: null, present: false }
  const text = String(stdout ?? '')
  if (!text.trim()) return absent
  // winget's own words for "you do not have this".
  if (/no installed package found/i.test(text)) return absent

  const lines = text.split(/\r?\n/)
  const needle = id.toLowerCase()
  const rowIndex = lines.findIndex((l) => l.toLowerCase().includes(needle) && !/^\s*-+\s*$/.test(l))
  if (rowIndex < 0) return absent
  const row = lines[rowIndex]!

  // The header is the last line above the row that names both columns we need.
  let header: string | null = null
  for (let i = rowIndex - 1; i >= 0; i--) {
    const line = lines[i]!
    if (/\bId\b/.test(line) && /\bVersion\b/.test(line)) {
      header = line
      break
    }
  }

  if (header) {
    const at = (label: string): number => {
      const re = new RegExp(`\\b${label}\\b`)
      return re.exec(header!)?.index ?? -1
    }
    const cols = [
      { key: 'version', start: at('Version') },
      { key: 'available', start: at('Available') },
      { key: 'source', start: at('Source') }
    ]
      .filter((c) => c.start >= 0)
      .sort((a, b) => a.start - b.start)

    const cell = (key: string): string => {
      const i = cols.findIndex((c) => c.key === key)
      if (i < 0) return ''
      const start = cols[i]!.start
      const end = cols[i + 1]?.start ?? row.length
      return row.slice(start, end).trim()
    }

    const installed = parseVersion(cell('version'))
    const available = parseVersion(cell('available'))
    if (installed || available) return { installed, available, present: true }
  }

  // Fallback: every version-shaped token on the row, in order. winget prints
  // installed first and available second, and never more than those two.
  const tokens = row.split(/\s{1,}/).filter(Boolean)
  const versions = tokens.map(parseVersion).filter((v): v is string => v !== null)
  return {
    installed: versions[0] ?? null,
    available: versions[1] ?? null,
    present: versions.length > 0
  }
}

/* -------------------------------------------------------------- npm registry */

/**
 * The version out of `https://registry.npmjs.org/<pkg>/latest`.
 *
 * That endpoint returns the full packument for the `latest` dist-tag, of which
 * we want exactly one field. It is asked for rather than the package root
 * because the root document for a package like @anthropic-ai/claude-code is
 * several megabytes of every version ever published, and this one is under 5 KB.
 */
export function parseNpmLatest(body: string): string | null {
  try {
    const json = JSON.parse(String(body ?? '')) as { version?: unknown }
    return typeof json.version === 'string' && json.version.trim() ? json.version.trim() : null
  } catch {
    return null
  }
}

export function npmLatestUrl(pkg: string): string {
  // Encoded per path segment, so a scoped name keeps the `/` that separates its
  // scope from its name — encodeURIComponent over the whole string would give
  // `%40anthropic-ai%2Fclaude-code`, which is a different (nonexistent) package.
  // The `@` is then put back: the registry accepts either form, and the one
  // that matches what you would type is the one worth logging.
  const path = pkg
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/%40/g, '@'))
    .join('/')
  return `https://registry.npmjs.org/${path}/latest`
}

/* ------------------------------------------------------------ self-update */

/**
 * What the self-updater is allowed to do in this process.
 *
 *   'real'       a packaged build: talk to the release feed
 *   'simulated'  FORGE_FAKE_UPDATE is set: render the whole banner flow against
 *                a version that does not exist, so the UI can be walked through
 *                end to end without publishing a release
 *   'off'        everything else — a dev run downloads nothing and shows nothing
 *
 * Split out as a pure function of (env, isPackaged) precisely so the guard can
 * be unit-tested. "Only when packaged" is the single most important line in the
 * whole feature — a bug there is `npm run dev` quietly replacing itself — and
 * asserting it needs to not require packaging the app.
 *
 * The simulated mode deliberately does NOT require `isPackaged`: its entire
 * purpose is a dev run. It never touches electron-updater and can never install
 * anything; see electron/updater.ts.
 */
export function updaterMode(
  env: Record<string, string | undefined>,
  isPackaged: boolean
): 'real' | 'simulated' | 'off' {
  const fake = (env['FORGE_FAKE_UPDATE'] ?? '').trim()
  // A junk value is ignored rather than obeyed: the banner has a version number
  // in it, and "FORGE_FAKE_UPDATE=yes" would put the word "yes" on screen.
  if (fake && parseVersion(fake)) return 'simulated'
  return isPackaged ? 'real' : 'off'
}

/**
 * electron-updater's way of saying "there is no feed here yet".
 *
 * Steve has not created the GitHub repo at the time this was written, so the
 * *normal* state of a packaged build is a 404 from the releases API. That is
 * not an error worth putting on screen — it is "no updates", and treating it as
 * a failure would mean every early build shipped with a red banner.
 */
export function isNoFeedError(message: string): boolean {
  const m = String(message ?? '').toLowerCase()
  return (
    m.includes('404') ||
    m.includes('no published versions') ||
    m.includes('cannot find channel') ||
    m.includes('unable to find latest version') ||
    m.includes('enotfound') ||
    m.includes('getaddrinfo') ||
    m.includes('net::err_internet_disconnected')
  )
}

/* -------------------------------------------------------- source updater */

/**
 * Lines of git output that are progress, not diagnosis.
 *
 * `git pull` narrates the fetch on *stderr* before it says anything about what
 * went wrong, so the first line of stderr is almost always the transport
 * header — "From https://github.com/stevenmcginty/forge". Reading a failure
 * off line one therefore reports the URL it succeeded in contacting, which is
 * the one part of the operation that worked. Every pull failure looked
 * identical on the banner until this existed.
 */
const GIT_NOISE = [
  /^from\s+https?:/i,
  /^from\s+\S+:/i,
  /^\s*[*=+!-]\s/, // " * branch master -> FETCH_HEAD", " * [new tag] …"
  /^remote:/i,
  /^receiving objects/i,
  /^resolving deltas/i,
  /^counting objects/i,
  /^compressing objects/i,
  /^unpacking objects/i,
  /^fetching/i,
  /^updating\s+[0-9a-f]{7,}\.\.[0-9a-f]{7,}/i,
  /^hint:/i,
  /^warning:/i,
  /^please commit your changes/i,
  /^aborting\.?$/i
]

/**
 * Turn raw git output into one sentence a person can act on.
 *
 * Two jobs, in order. First, skip the narration above and find the line that
 * actually says what failed. Second, translate the handful of failures a
 * stable checkout genuinely hits into plain English, because "Not possible to
 * fast-forward, aborting" tells you nothing about what to do next and
 * "uncommitted changes — commit or stash them" tells you everything.
 *
 * Anything unrecognised is passed through rather than swallowed: an updater
 * that only reports the failures it anticipated is an updater that goes quiet
 * exactly when something new is wrong.
 */
export function gitFailureReason(stderr: string, stdout = ''): string {
  const lines = `${stderr ?? ''}\n${stdout ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !GIT_NOISE.some((rx) => rx.test(line)))

  const all = lines.join(' ').toLowerCase()

  // The everyday one, and the reason this function exists: Steve edits the
  // stable checkout, or a parallel session does, and a fast-forward cannot run
  // over modified files. It is not a breakage — it is a sentence.
  if (all.includes('local changes') && all.includes('would be overwritten')) {
    return 'You have uncommitted changes in the Forge folder — commit or stash them, then update'
  }
  if (all.includes('untracked working tree files would be overwritten')) {
    return 'New files in the Forge folder clash with the update — move or delete them, then update'
  }
  // A stable checkout with its own commits is not a thing an updater should
  // rescue on a timer; say so and leave it to a human.
  if (all.includes('not possible to fast-forward') || all.includes('divergent branches')) {
    return 'This checkout has local commits that are not on GitHub — sort them out, then update'
  }
  if (all.includes('index.lock') || all.includes('could not lock')) {
    return 'Another git command is running in the Forge folder — wait for it to finish, then update'
  }
  if (all.includes('terminal prompts disabled') || all.includes('could not read username')) {
    return 'GitHub asked for a sign-in — run `git pull` in the Forge folder once, then update'
  }
  if (all.includes('authentication failed') || all.includes('permission denied')) {
    return 'GitHub refused the connection — check your git credentials, then update'
  }

  // Nothing recognised. Return the most diagnostic line there is: git puts the
  // real cause behind `error:` or `fatal:`, so prefer those over the first
  // surviving line, and drop the prefix — the banner already says "failed".
  const flagged = lines.find((line) => /^(error|fatal):/i.test(line))
  const chosen = (flagged ?? lines[0] ?? 'git pull failed').replace(/^(error|fatal):\s*/i, '')
  return chosen.replace(/:$/, '').slice(0, 200)
}

/* ------------------------------------------------------- self-update banner */

/**
 * Should the update banner be on screen?
 *
 * Dismissal is per *version*, not a global "do not show me updates": saying no
 * to 0.2.0 is not saying no to 0.3.0, and a switch that silently swallowed
 * every future release would be the last update anyone ever installed.
 */
export function shouldShowBanner(available: string | null | undefined, dismissed: string | null | undefined): boolean {
  const version = (available ?? '').trim()
  if (!version) return false
  return version !== (dismissed ?? '').trim()
}

/** Bytes-per-second into something a banner can say without being a spreadsheet. */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  const mb = bytesPerSecond / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`
  return `${Math.round(bytesPerSecond / 1024)} KB/s`
}

/** "2 minutes ago" for the last-checked line. Nothing more precise is useful. */
export function relativeTime(at: number, now = Date.now()): string {
  if (!at) return 'never'
  const secs = Math.max(0, Math.round((now - at) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
