/**
 * Keeps checks off the real profile.
 *
 * A check that starts Electron, imports electron/store.ts, or runs a real agent
 * CLI can write wherever that code writes by default — %APPDATA%\Forge, the
 * home directory's CLI configs. One did: bridge-register-check's Electron probe
 * rewrote the everyday Forge's bridge\mcp.json with this checkout's paths and a
 * still-encrypted key, and every new Claude pane lost its Gemini tools. The
 * live sections of share-check started qwen and agy under the real home, and
 * both CLIs' config files changed during that run.
 *
 * So every such check takes a sandbox from here:
 *
 *   const box = makeSandbox('register')
 *   spawn(exe, args, { env: box.env() })      // temp HOME, APPDATA, data dir…
 *   const hits = realHits([somePath])          // [] or the real paths it names
 *   const before = snapshotReal(); …; changedSince(before)   // [] or the files touched
 *   box.cleanup()
 *
 * The real locations are captured once, when this module loads, from the
 * process's own environment — so a check that later rewrites process.env for a
 * child still measures against the real ones.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve } from 'node:path'

const REAL_HOME = homedir()
const REAL_APPDATA = process.env['APPDATA'] || join(REAL_HOME, 'AppData', 'Roaming')

/**
 * Nothing a check writes may land under any of these. The two Forge profiles,
 * then the configs Forge's bridge and share code write into for the other
 * agent CLIs (agy's lives in ~/.gemini/config).
 */
export const REAL_ROOTS = [
  join(REAL_APPDATA, 'Forge'),
  join(REAL_APPDATA, 'Forge Dev'),
  join(REAL_HOME, '.codex'),
  join(REAL_HOME, '.gemini'),
  join(REAL_HOME, '.qwen'),
  join(REAL_HOME, '.config', 'opencode'),
  join(REAL_HOME, '.claude.json')
]

/**
 * The files the watch compares, a narrower set than REAL_ROOTS: the ones Forge
 * code writes, and not the logs, caches and chat history the CLIs churn while
 * Steve is using them in another pane — a guard that fails because somebody
 * typed into qwen is a guard nobody trusts.
 */
const WATCHED = [
  { path: join(REAL_APPDATA, 'Forge', 'bridge'), deep: true },
  { path: join(REAL_APPDATA, 'Forge Dev', 'bridge'), deep: true },
  { path: join(REAL_HOME, '.codex', 'config.toml') },
  { path: join(REAL_HOME, '.codex', 'AGENTS.md') },
  { path: join(REAL_HOME, '.gemini', 'settings.json') },
  { path: join(REAL_HOME, '.gemini', 'GEMINI.md') },
  { path: join(REAL_HOME, '.gemini', 'config', 'mcp_config.json') },
  { path: join(REAL_HOME, '.qwen', 'settings.json') },
  { path: join(REAL_HOME, '.qwen', 'QWEN.md') },
  { path: join(REAL_HOME, '.config', 'opencode'), deep: false }
]

/**
 * The variables a Forge pane exports that point at live things — this pane's
 * share folder and pipe, its canvas board, its browser link. A check started
 * from inside Forge would otherwise hand them to every child.
 */
const PANE_VARS = [
  'FORGE_BRIDGE_OUT',
  'FORGE_CANVAS_DIR',
  'FORGE_BROWSER_LINK_FILE',
  'FORGE_SHARE_DIR',
  'FORGE_SHARE_LINK',
  'FORGE_SHARE_ROOT'
]

/** Is `p` at or under `root`? Case-blind, since both are Windows paths here. */
function isUnder(p, root) {
  const rel = relative(resolve(root).toLowerCase(), resolve(p).toLowerCase())
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The paths in `paths` that fall under a real root. Empty and null entries are ignored. */
export function realHits(paths) {
  return paths.filter((p) => typeof p === 'string' && p && REAL_ROOTS.some((root) => isUnder(p, root)))
}

/** mtime and size of every watched file, keyed by path. */
export function snapshotReal() {
  const out = {}
  const add = (p, deep) => {
    let st
    try {
      st = statSync(p)
    } catch {
      return
    }
    if (!st.isDirectory()) {
      out[p] = `${st.mtimeMs}:${st.size}`
      return
    }
    for (const name of readdirSync(p)) {
      const child = join(p, name)
      if (deep) add(child, true)
      else {
        try {
          if (!statSync(child).isDirectory()) add(child, false)
        } catch {
          /* gone between the listing and the stat */
        }
      }
    }
  }
  for (const w of WATCHED) add(w.path, w.deep ?? false)
  return out
}

/** Watched files that appeared, vanished or changed since `before`. */
export function changedSince(before) {
  const after = snapshotReal()
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]).sort()
}

/** Remove `key` from an env copy in every casing (Windows env is case-blind). */
function drop(env, key) {
  for (const k of Object.keys(env)) if (k.toUpperCase() === key.toUpperCase()) delete env[k]
}

/**
 * A throwaway root with a home, an app-data pair and a Forge data dir inside it.
 *
 * `env(extra)` is process.env with every home- and profile-shaped variable
 * pointed into the sandbox — HOME, USERPROFILE (what Node, Go and Rust's
 * `home` crate read on Windows), HOMEDRIVE/HOMEPATH, APPDATA, LOCALAPPDATA, the
 * XDG set (OpenCode), CODEX_HOME, FORGE_DATA_DIR — and the pane variables
 * dropped. PATH is kept, so every CLI still resolves from where it is installed.
 */
export function makeSandbox(label) {
  const root = mkdtempSync(join(tmpdir(), `forge-${label}-`))
  const home = join(root, 'home')
  const appData = join(home, 'AppData', 'Roaming')
  const localAppData = join(home, 'AppData', 'Local')
  const dataDir = join(root, 'data')
  // CODEX_HOME too: Codex refuses to start when the folder it names is missing.
  for (const d of [home, appData, localAppData, dataDir, join(home, '.codex')]) mkdirSync(d, { recursive: true })

  const env = (extra = {}) => {
    const out = { ...process.env }
    for (const k of PANE_VARS) drop(out, k)
    const drive = parse(home).root.replace(/[\\/]+$/, '')
    const vars = {
      HOME: home,
      USERPROFILE: home,
      HOMEDRIVE: drive,
      HOMEPATH: home.slice(drive.length),
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      CODEX_HOME: join(home, '.codex'),
      FORGE_DATA_DIR: dataDir,
      ...extra
    }
    for (const [k, v] of Object.entries(vars)) {
      drop(out, k)
      out[k] = v
    }
    return out
  }

  const cleanup = () => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  }

  return { root, home, appData, localAppData, dataDir, env, cleanup }
}
