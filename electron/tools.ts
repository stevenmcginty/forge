import { execFile } from 'node:child_process'
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import {
  allToolSpecs,
  isPlainCommand,
  npmLatestUrl,
  parseNpmLatest,
  parseVersion,
  parseWingetList
} from '@shared/tools'
import type { ToolId, ToolLatest, ToolProbe, ToolSpec } from '@shared/types'
import { whichCommand } from './agent-probe'
import { getSettings } from './store'

/**
 * What is installed on this machine, and what is available.
 *
 * Two questions with two very different costs, kept apart on purpose:
 *
 *   probeTools()   spawns `<tool> --version` — local, fast, no network
 *   latestFor()    asks winget or registry.npmjs.org — slow, and offline half
 *                  the time on a laptop
 *
 * so the Updates & Tools section can render the installed column immediately
 * and fill the "latest" column in behind it. Both are cached for the session,
 * because neither answer changes while you are looking at the page, and a
 * settings tab that re-runs five subprocesses and three HTTPS requests every
 * time you click on to it is a settings tab that makes the app feel broken.
 *
 * Nothing here installs, downloads or writes anything. The Update *button* does
 * not live in this file at all: it types a command into a terminal pane in the
 * renderer, which is the only place in Forge where "run an installer" is a
 * thing a person does rather than a thing that happens.
 *
 * The catalogue is no longer fixed. `specs()` is the built-ins plus whatever
 * has been added in Settings, which means every function below already works
 * for a tool nobody had heard of when this file was written — and why the one
 * command that gets *spawned* is checked against `isPlainCommand` at the point
 * of use rather than trusted because a form validated it earlier.
 */

/** A hung shim must not hold the settings page open. */
const VERSION_TIMEOUT_MS = 6000
/** winget goes to the network for the `Available` column. */
const WINGET_TIMEOUT_MS = 25_000
const REGISTRY_TIMEOUT_MS = 8000

/**
 * How long a "latest" answer stays good. Long enough that clicking around the
 * settings page is free; short enough that "Check all" after `npm i -g` is not
 * the only way to see a new number. A forced refresh ignores it entirely.
 */
const LATEST_TTL_MS = 30 * 60 * 1000

const probeCache = new Map<ToolId, ToolProbe>()
const latestCache = new Map<ToolId, ToolLatest>()

/**
 * The catalogue *right now*: what Forge ships with, plus whatever is in
 * settings.json.
 *
 * Read on every call rather than captured at startup, because a tool added in
 * the settings page has to appear in the list the same second it is added, and
 * the alternative — an IPC that pushes the catalogue into this module whenever
 * settings change — is a second copy of the truth for no benefit.
 */
function specs(): ToolSpec[] {
  return allToolSpecs(getSettings().customTools)
}

/**
 * What a cached answer was an answer *to*.
 *
 * Editing a row's npm package and pressing Check must not hand back the reply
 * for the old one. The id alone cannot see that change, so the cache key carries
 * the part of the spec the answer depends on.
 */
function fingerprint(spec: ToolSpec): string {
  return `${spec.id}|${spec.latest.source}|${spec.latest.npmPackage ?? ''}|${(spec.latest.wingetIds ?? []).join(',')}`
}

function probeFingerprint(spec: ToolSpec): string {
  return `${spec.id}|${spec.command}|${(spec.versionArgs ?? ['~none']).join(' ')}`
}

/* ------------------------------------------------------------ installed */

/**
 * Run `<command> <args>` and hand back its first line.
 *
 * `shell: true` on Windows for the same reason system.ts needs it: the CLIs
 * here are npm shims, i.e. `.cmd` batch files, which CreateProcess refuses to
 * execute directly. The argument list is fixed and comes from TOOL_SPECS —
 * nothing user-supplied is ever interpolated into it.
 */
function runVersion(command: string, args: string[]): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: VERSION_TIMEOUT_MS, windowsHide: true, shell: process.platform === 'win32' },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'ENOENT') return resolve({ ok: false, error: 'not found on PATH' })
          // Some CLIs print their version and exit non-zero; if there is usable
          // output, prefer it over the failure.
          const text = `${stdout}`.trim()
          if (text) return resolve({ ok: true, text })
          const detail = (`${stderr}` || (err as Error).message || '').trim().split('\n')[0] ?? 'could not run'
          return resolve({ ok: false, error: detail.slice(0, 140) })
        }
        resolve({ ok: true, text: `${stdout}`.trim() })
      }
    )
  })
}

async function probeOne(spec: ToolSpec): Promise<ToolProbe> {
  const id = spec.id
  // A custom row's command is a string from a config file, and this is the one
  // place Forge would *execute* it. `sanitiseCustomTool` already refused
  // anything shell-shaped on the way in; this is the same rule enforced at the
  // point of use, so a settings.json edited by hand cannot smuggle a pipeline
  // past a validator it never went through.
  if (!isPlainCommand(spec.command)) {
    return { id, found: false, error: 'not a plain command — name the program, nothing more' }
  }

  const resolved = whichCommand(spec.command)
  if (!resolved) return { id, found: false, error: 'not found on PATH' }

  // A tool with no version arguments is found and nothing more — see the note
  // on Kimi in shared/tools.ts.
  if (!spec.versionArgs) return { id, found: true, path: resolved }

  const result = await runVersion(spec.command, spec.versionArgs)
  if (!result.ok) return { id, found: true, path: resolved, error: result.error }
  const version = parseVersion(result.text.split('\n')[0] ?? '')
  return version
    ? { id, found: true, path: resolved, version }
    : { id, found: true, path: resolved, error: 'no version reported' }
}

/**
 * Every tool at once. Each probe is an independent subprocess with its own
 * six-second ceiling, so run in series the worst case is half a minute of a
 * settings page saying "…" because one shim on the machine is wedged. In
 * parallel the worst case is six seconds.
 *
 * `only` narrows it to the ids the caller actually reads, and it is not a
 * micro-optimisation. A tool that is *absent* costs a full PATH × PATHEXT walk
 * — on Steve's machine 39 directories × 15 extensions = 585 synchronous
 * `statSync`/`accessSync` calls each, and ten of the eighteen specs are absent.
 * `whichCommand` runs before the first await inside `probeOne`, so the whole
 * sweep is one uninterrupted block on the main process's event loop: 322ms
 * measured, during which no `pty:create` and no keystroke is serviced.
 *
 * The settings page genuinely wants all of them. The commands flyout wants
 * exactly one, and asking it for eighteen is what made the first terminal of
 * every session slow to appear.
 */
export async function probeTools(refresh = false, only?: readonly string[]): Promise<ToolProbe[]> {
  if (refresh) probeCache.clear()
  const wanted = only && only.length ? specs().filter((s) => only.includes(s.id)) : specs()
  return Promise.all(
    wanted.map(async (spec) => {
      const key = probeFingerprint(spec)
      const cached = probeCache.get(key)
      if (cached) return cached
      const probe = await probeOne(spec)
      probeCache.set(key, probe)
      return probe
    })
  )
}

/* -------------------------------------------------------------- available */

function runWinget(args: string[]): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(
      'winget',
      args,
      { timeout: WINGET_TIMEOUT_MS, windowsHide: true, shell: false, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'ENOENT') return resolve({ ok: false, error: 'winget is not on this machine' })
          // winget exits non-zero for "no applicable upgrade", which is not a
          // failure — the stdout is still the answer.
          const text = `${stdout}`.trim()
          if (text) return resolve({ ok: true, text })
          const detail = (`${stderr}` || (err as Error).message || '').trim().split('\n')[0] ?? 'winget failed'
          return resolve({ ok: false, error: detail.slice(0, 140) })
        }
        resolve({ ok: true, text: `${stdout}` })
      }
    )
  })
}

/**
 * Ask winget what it has for a package.
 *
 * `winget list` rather than `winget show`: list reports the *installed* version
 * and, only when there is one, an `Available` column with the upgrade. show
 * reports the newest version in the source whether or not you have it, which
 * reads identically when you are up to date and is therefore a worse answer to
 * the question "do I need to do anything".
 *
 * `--disable-interactivity` keeps it from ever waiting for a keypress in a
 * process with no console attached, and the agreement flags stop a first run on
 * a fresh machine from blocking on a prompt nobody can see.
 */
async function wingetLatest(id: ToolId, wingetIds: string[]): Promise<ToolLatest> {
  const checkedAt = Date.now()
  let lastError = 'not managed by winget'
  for (const pkg of wingetIds) {
    const result = await runWinget([
      'list',
      '--id',
      pkg,
      '--exact',
      '--disable-interactivity',
      '--accept-source-agreements'
    ])
    if (!result.ok) {
      lastError = result.error
      // No winget at all is fatal for every id; a per-package failure is not.
      if (/not on this machine/.test(result.error)) break
      continue
    }
    const row = parseWingetList(result.text, pkg)
    if (!row.present) continue
    // No `Available` column means winget knows of nothing newer, so the latest
    // version *is* the installed one.
    const latest = row.available ?? row.installed
    if (latest) return { id, source: 'winget', latest, via: pkg, checkedAt }
  }
  return { id, source: 'winget', error: lastError, checkedAt }
}

/**
 * The npm dist-tag endpoint. A plain GET of ~4 KB of JSON — no `npm` process,
 * no lockfile, no cache directory, and no way for it to modify anything.
 */
async function npmLatest(id: ToolId, pkg: string): Promise<ToolLatest> {
  const checkedAt = Date.now()
  try {
    const res = await fetch(npmLatestUrl(pkg), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS)
    })
    if (!res.ok) {
      return { id, source: 'npm', error: `registry said ${res.status}`, checkedAt }
    }
    const version = parseNpmLatest(await res.text())
    return version
      ? { id, source: 'npm', latest: version, via: pkg, checkedAt }
      : { id, source: 'npm', error: 'no version in the registry reply', checkedAt }
  } catch (err) {
    // Offline is the common case and is not worth a scary message.
    const message = (err as Error).name === 'TimeoutError' ? 'timed out' : 'offline or unreachable'
    return { id, source: 'npm', error: message, checkedAt }
  }
}

async function latestOne(spec: ToolSpec): Promise<ToolLatest> {
  const id = spec.id
  switch (spec.latest.source) {
    case 'npm':
      return npmLatest(id, spec.latest.npmPackage ?? '')
    case 'winget':
      return wingetLatest(id, spec.latest.wingetIds ?? [])
    default:
      // `local` and `none` have nothing to ask. Answering with a timestamp and
      // no version is what makes the UI say "managed locally" rather than
      // spinning forever on a check that was never going to happen.
      return { id, source: spec.latest.source, checkedAt: Date.now() }
  }
}

/**
 * Latest-available for the given tools, or all of them.
 *
 * The requests run together: three of them are network round trips and doing
 * them one after another is the difference between "Check all" taking a second
 * and taking most of a minute.
 */
export async function latestFor(ids?: ToolId[] | null, refresh = false): Promise<ToolLatest[]> {
  const all = specs()
  const wanted = ids?.length ? all.filter((t) => ids.includes(t.id)) : all
  const now = Date.now()
  return Promise.all(
    wanted.map(async (spec) => {
      const key = fingerprint(spec)
      const cached = latestCache.get(key)
      if (!refresh && cached && now - cached.checkedAt < LATEST_TTL_MS) return cached
      const fresh = await latestOne(spec)
      latestCache.set(key, fresh)
      return fresh
    })
  )
}

export function registerToolsHandlers(): void {
  ipcMain.handle(IPC.toolsProbe, (_e, refresh: boolean) => probeTools(refresh === true))
  ipcMain.handle(IPC.toolsLatest, (_e, ids: ToolId[] | null, refresh: boolean) =>
    latestFor(Array.isArray(ids) ? ids : null, refresh === true)
  )
}
