import type { ToolId, ToolLatestSource, ToolSpec } from './types'

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
 */
export const TOOL_SPECS: ToolSpec[] = [
  {
    id: 'pwsh',
    name: 'PowerShell',
    blurb: 'the shell every pane starts in',
    command: 'pwsh',
    versionArgs: ['--version'],
    latest: { source: 'winget', wingetIds: ['Microsoft.PowerShell'] },
    updateCommand: 'winget upgrade Microsoft.PowerShell'
  },
  {
    id: 'claude',
    name: 'Claude Code',
    blurb: 'the `claude` CLI',
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
    id: 'gemini',
    name: 'Gemini CLI',
    blurb: 'the `gemini` CLI',
    command: 'gemini',
    versionArgs: ['--version'],
    latest: { source: 'npm', npmPackage: '@google/gemini-cli' },
    updateCommand: 'npm i -g @google/gemini-cli'
  },
  {
    id: 'node',
    name: 'Node',
    blurb: 'runs the MCP bridge, and npm installs the CLIs above',
    command: 'node',
    versionArgs: ['--version'],
    // Two ids because winget splits Node into current and LTS, and which one
    // you have is not something Forge gets to assume. Whichever is *installed*
    // answers; if neither is, Node came from the .msi or from nvm and winget
    // has nothing to say about it — which the UI reports rather than guessing.
    latest: { source: 'winget', wingetIds: ['OpenJS.NodeJS.LTS', 'OpenJS.NodeJS'] },
    updateCommand: null
  }
]

export function toolSpec(id: ToolId): ToolSpec | undefined {
  return TOOL_SPECS.find((t) => t.id === id)
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
