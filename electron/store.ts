import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUILTIN_AGENT_PROFILES } from '@shared/agents'
import type { Project, Settings, StoreSnapshot, Workspace } from '@shared/types'
import { clampKeep, DEFAULT_KEEP } from './shots/shelf'

/**
 * Dead-simple JSON persistence in %APPDATA%\Forge.
 *
 *   settings.json          app settings + agent profiles + window bounds
 *   projects.json          the project list (ordered)
 *   layouts/<id>.json      one terminal workspace per project
 *   shots/                 the screenshot shelf (real PNGs)
 *
 * Writes are atomic (tmp file + rename) and debounced by the caller where it
 * matters. Reads are tolerant: a corrupt file falls back to defaults rather
 * than crashing the app, and the bad file is kept as `<name>.corrupt`.
 */

/**
 * Dictation's two paths default to *nothing found*, and are filled in only when
 * this particular machine happens to have something usable.
 *
 * A packaged Forge carries its own frozen sidecar and downloads its own model,
 * so the normal answer on a fresh install is the empty string — which the
 * dictation host reports as a clean setup state rather than pointing at a folder
 * that only exists on the machine Forge was written on.
 *
 * The fast path is for that machine: an install of DictationMic already has an
 * interpreter with onnx-asr in it and has already paid for the 660 MB model, so
 * if it is there, use it. Both are editable in settings.json and from Settings.
 */
const PARAKEET_NAME = 'parakeet-tdt-0.6b-v2'

function dictationMicHome(): string {
  return join(homedir(), 'Desktop', 'DictationMic')
}

/** An interpreter that can import onnx-asr, if one is sitting on this disk. */
function detectSttPython(): string {
  const candidate = join(dictationMicHome(), 'venv', 'Scripts', 'python.exe')
  return existsSync(candidate) ? candidate : ''
}

/**
 * A Parakeet model already on this disk: Forge's own download first, then
 * DictationMic's copy. Empty when neither is there.
 *
 * Deliberately not shared with electron/stt-model.ts's defaultModelDir(): that
 * one is evaluated live on every spawn, this one only seeds a fresh
 * settings.json. Keeping them apart means downloading the model does not have to
 * rewrite a setting the user may have pointed somewhere else on purpose.
 */
function detectSttModelDir(): string {
  for (const candidate of [
    join(resolveDataRoot(), 'models', PARAKEET_NAME),
    join(dictationMicHome(), 'models', PARAKEET_NAME)
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

function defaultSettings(): Settings {
  return {
    agentProfiles: BUILTIN_AGENT_PROFILES,
    lastProjectId: null,
    railCollapsed: false,
    terminalFontSize: 13,
    terminalFontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
    shell: 'pwsh.exe',
    catchShots: true,
    shotsKeep: DEFAULT_KEEP,
    window: { width: 1440, height: 900, maximized: false },
    onboarded: false,
    sttPython: detectSttPython(),
    sttModelDir: detectSttModelDir(),
    sttAutoStopSeconds: 10,
    sttHotkey: 'ControlRight',
    voicePanelOpen: false,
    voicePanelWidth: 380,
    // Gemini is the live brain; with no key set it degrades to the stub.
    voiceBrain: 'gemini',
    anthropicKey: '',
    geminiKey: '',
    geminiModel: 'gemini-2.5-flash'
  }
}

let dataDir = ''
let layoutDir = ''

/**
 * Everything Forge owns lives under one root. FORGE_DATA_DIR moves it, which
 * is how a second copy of Forge can be run side by side (its own settings, its
 * own shots, its own single-instance lock) without disturbing the one you are
 * using — see scripts/ and the M2 notes.
 */
export function resolveDataRoot(): string {
  const override = process.env['FORGE_DATA_DIR']
  if (override && override.trim()) return resolve(override.trim())
  return join(app.getPath('appData'), 'Forge')
}

function ensureDirs(): void {
  if (!dataDir) {
    dataDir = resolveDataRoot()
    layoutDir = join(dataDir, 'layouts')
  }
  mkdirSync(layoutDir, { recursive: true })
}

function filePath(name: string): string {
  ensureDirs()
  return join(dataDir, name)
}

function readJson<T>(name: string, fallback: T): T {
  const p = filePath(name)
  if (!existsSync(p)) return fallback
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch (err) {
    console.error(`[store] ${name} is unreadable, falling back to defaults:`, err)
    try {
      renameSync(p, `${p}.corrupt`)
    } catch {
      /* best effort */
    }
    return fallback
  }
}

function writeJson(name: string, value: unknown): void {
  const p = filePath(name)
  const tmp = `${p}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, p)
  } catch (err) {
    console.error(`[store] failed to write ${name}:`, err)
  }
}

/* ------------------------------------------------------------------ merging */

/** Keep unknown/extra keys out, fill missing keys in, never trust the file. */
function normaliseSettings(raw: Partial<Settings> | null): Settings {
  const s = raw ?? {}
  const DEFAULT_SETTINGS = defaultSettings()
  const profiles = Array.isArray(s.agentProfiles) ? s.agentProfiles.filter((p) => p && p.id && p.name) : []
  // Re-seed any built-in the user deleted by hand, preserving their edits.
  for (const builtin of BUILTIN_AGENT_PROFILES) {
    if (!profiles.some((p) => p.id === builtin.id)) profiles.push({ ...builtin })
  }
  for (const p of profiles) {
    if (typeof p.command !== 'string') p.command = ''
    if (!p.accent) p.accent = '#C6FF4A'
    if (!p.badge) p.badge = p.name.slice(0, 2).toUpperCase()
    const builtin = BUILTIN_AGENT_PROFILES.find((b) => b.id === p.id)
    p.builtin = Boolean(builtin)
    // Adopt a new built-in default (e.g. the Gemini bridge) into a settings.json
    // written before the flag existed, without overriding a deliberate opt-out.
    if (p.mcpBridge === undefined && builtin?.mcpBridge !== undefined) p.mcpBridge = builtin.mcpBridge
  }

  const win = s.window ?? DEFAULT_SETTINGS.window
  const brain = s.voiceBrain
  return {
    agentProfiles: profiles,
    lastProjectId: s.lastProjectId ?? null,
    railCollapsed: s.railCollapsed ?? false,
    terminalFontSize: clamp(s.terminalFontSize ?? DEFAULT_SETTINGS.terminalFontSize, 9, 28),
    terminalFontFamily: s.terminalFontFamily || DEFAULT_SETTINGS.terminalFontFamily,
    shell: s.shell || DEFAULT_SETTINGS.shell,
    catchShots: s.catchShots ?? true,
    shotsKeep: clampKeep(s.shotsKeep),
    onboarded: s.onboarded === true,
    sttPython: typeof s.sttPython === 'string' ? s.sttPython : DEFAULT_SETTINGS.sttPython,
    sttModelDir: typeof s.sttModelDir === 'string' ? s.sttModelDir : DEFAULT_SETTINGS.sttModelDir,
    // 0 legitimately means "never auto-stop", so a junk value has to fall back
    // to the default rather than to clamp()'s floor.
    sttAutoStopSeconds: Number.isFinite(s.sttAutoStopSeconds)
      ? clamp(s.sttAutoStopSeconds as number, 0, 600)
      : DEFAULT_SETTINGS.sttAutoStopSeconds,
    sttHotkey: s.sttHotkey || DEFAULT_SETTINGS.sttHotkey,
    window: {
      x: typeof win.x === 'number' ? win.x : undefined,
      y: typeof win.y === 'number' ? win.y : undefined,
      width: clamp(win.width ?? 1440, 720, 10000),
      height: clamp(win.height ?? 900, 480, 10000),
      maximized: Boolean(win.maximized)
    },
    voicePanelOpen: Boolean(s.voicePanelOpen),
    voicePanelWidth: clamp(s.voicePanelWidth ?? DEFAULT_SETTINGS.voicePanelWidth, 300, 640),
    voiceBrain:
      brain === 'claude' || brain === 'openai' || brain === 'stub' || brain === 'gemini'
        ? brain
        : DEFAULT_SETTINGS.voiceBrain,
    anthropicKey: typeof s.anthropicKey === 'string' ? s.anthropicKey : '',
    geminiKey: typeof s.geminiKey === 'string' ? s.geminiKey.trim() : '',
    geminiModel:
      typeof s.geminiModel === 'string' && s.geminiModel.trim() ? s.geminiModel.trim() : DEFAULT_SETTINGS.geminiModel
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo
}

/* ------------------------------------------------------------------- public */

let settingsCache: Settings | null = null
let projectsCache: Project[] | null = null

export function getSettings(): Settings {
  if (!settingsCache) settingsCache = normaliseSettings(readJson<Partial<Settings> | null>('settings.json', null))
  return settingsCache
}

export function setSettings(patch: Partial<Settings>): Settings {
  settingsCache = normaliseSettings({ ...getSettings(), ...patch })
  writeJson('settings.json', settingsCache)
  return settingsCache
}

export function getProjects(): Project[] {
  if (!projectsCache) {
    const raw = readJson<Project[]>('projects.json', [])
    projectsCache = Array.isArray(raw) ? raw.filter((p) => p && p.id && p.path) : []
  }
  return projectsCache
}

export function setProjects(projects: Project[]): Project[] {
  projectsCache = projects
  writeJson('projects.json', projects)
  // Drop layout files for projects that no longer exist.
  try {
    const ids = new Set(projects.map((p) => p.id))
    for (const f of readdirSync(layoutDir)) {
      if (f.endsWith('.json') && !ids.has(f.replace(/\.json$/, ''))) {
        unlinkSync(join(layoutDir, f))
      }
    }
  } catch {
    /* best effort */
  }
  return projects
}

function layoutFile(projectId: string): string {
  ensureDirs()
  return join(layoutDir, `${sanitiseId(projectId)}.json`)
}

function sanitiseId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function getWorkspace(projectId: string): Workspace | null {
  const p = layoutFile(projectId)
  if (!existsSync(p)) return null
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Workspace
    if (!parsed || !Array.isArray(parsed.tabs)) return null
    return parsed
  } catch (err) {
    console.error(`[store] layout for ${projectId} unreadable:`, err)
    return null
  }
}

export function setWorkspace(projectId: string, workspace: Workspace): void {
  const p = layoutFile(projectId)
  const tmp = `${p}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(workspace, null, 2), 'utf8')
    renameSync(tmp, p)
  } catch (err) {
    console.error(`[store] failed to write layout for ${projectId}:`, err)
  }
}

export function deleteWorkspace(projectId: string): void {
  try {
    unlinkSync(layoutFile(projectId))
  } catch {
    /* not there — fine */
  }
}

export function snapshot(): StoreSnapshot {
  return { settings: getSettings(), projects: getProjects() }
}

export function getDataDir(): string {
  ensureDirs()
  return dataDir
}

/** %APPDATA%\Forge\shots — created on demand, owned by the shots shelf. */
export function getShotsDir(): string {
  const dir = join(getDataDir(), 'shots')
  mkdirSync(dir, { recursive: true })
  return dir
}
