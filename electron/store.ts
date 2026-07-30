import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { BUILTIN_AGENT_PROFILES, inferKind, isClaudeCommand, isPermissionMode } from '@shared/agents'
import { isValidSkillName } from '@shared/skills'
import type { AgentProfile, Project, Settings, StoreSnapshot, ThemeCore, Workspace } from '@shared/types'
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

/** The Windows account name, for the account chip's first run. */
function defaultAccountName(): string {
  try {
    const name = userInfo().username.trim()
    if (!name) return 'You'
    // "steve" reads better with a capital on a chip you look at all day.
    return name.charAt(0).toUpperCase() + name.slice(1)
  } catch {
    return 'You'
  }
}

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

/**
 * A fresh settings.json, computed rather than frozen: two of these values are
 * answers about *this* machine (is there a DictationMic to borrow from, what is
 * this Windows account called), and a constant evaluated at import time would
 * bake the authoring machine's answers into everybody else's install.
 */
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
    geminiModel: 'gemini-2.5-flash',
    accountName: defaultAccountName(),
    accountColor: '#C6FF4A',
    themeId: 'volt',
    customThemes: [],
    reducedMotion: false,
    themeBg: '#0b0c0e',
    themeInk: '#e8eaed',
    voiceAutoRelay: false,
    voiceRelayGraceMs: 2500,
    // Spoken replies on by default: an agent you have to read is not one you can
    // talk to while you work.
    voiceReplyMode: 'both',
    voiceReplyVoice: '',
    // Neural speech by default. With no Gemini key the renderer's engine chain
    // degrades to the local SAPI voice on its own, so this is safe to prefer.
    voiceEngine: 'gemini',
    // Empty = the built-ins in electron/gemini-tts.ts (Sulafat, 3.1 flash TTS).
    voiceTtsVoice: '',
    voiceTtsModel: '',
    // On: it is what replaced the spoken "listening again" announcement.
    voiceEarcons: true,
    projectsRoot: '',
    // Empty = use gemini-media.ts's built-in default, which the MCP bridge shares.
    geminiImageModel: '',
    openrouterKey: '',
    // Mirrors DEFAULT_OPENROUTER_MODEL in src/lib/voicebrain.ts, the same way
    // geminiModel above mirrors DEFAULT_GEMINI_MODEL — main cannot import a
    // renderer module, and voice-check asserts the two literals still agree.
    openrouterModel: 'google/gemini-2.5-flash-lite',
    // Heuristic memory is free and predictable; letting a model rewrite the
    // project summary is neither, so it is opt-in.
    memoryLlmSummarize: false,
    // The skills library. Computed rather than frozen for the same reason as
    // the dictation paths above: it is an answer about *this* machine's data
    // root, which FORGE_DATA_DIR is allowed to move.
    skillsLibraryDir: defaultSkillsDir(),
    skillsEnabled: [],
    // Steve wants his Claude panes reachable from his phone out of the box.
    remoteControlDefault: true,
    // The phone link (M9) is off, unconfigured and credential-less out of the
    // box. Nothing in electron/companion-sync.ts runs until all three change.
    companionEnabled: false,
    companionApiKey: '',
    companionDatabaseURL: '',
    companionAuthBase: '',
    companionTokenBase: '',
    companionEmail: '',
    companionRefreshToken: '',
    companionUid: ''
  }
}

/** %APPDATA%\Forge\skills — see electron/skills-store.ts. */
function defaultSkillsDir(): string {
  return join(resolveDataRoot(), 'skills')
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
  // --data-dir wins over the environment: it is the more specific request, and
  // it is what you reach for when launching a throwaway copy from a shell that
  // already exports FORGE_DATA_DIR for something else.
  const flag = dataDirFlag()
  if (flag) return resolve(flag)
  const override = process.env['FORGE_DATA_DIR']
  if (override && override.trim()) return resolve(override.trim())
  return join(app.getPath('appData'), 'Forge')
}

/** `--data-dir <path>` or `--data-dir=<path>`, whichever the caller used. */
function dataDirFlag(): string | null {
  const argv = process.argv
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--data-dir') {
      const next = argv[i + 1]
      if (next && next.trim() && !next.startsWith('--')) return next.trim()
    }
    if (arg.startsWith('--data-dir=')) {
      const value = arg.slice('--data-dir='.length).trim()
      if (value) return value
    }
  }
  return null
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

/** A hex colour, or the fallback. Nothing off disk gets to be a CSS injection. */
function hex(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value.trim())
    ? value.trim()
    : fallback
}

/**
 * A theme the user made. Every colour is re-validated: these end up as inline
 * custom properties on the document, so "it came out of our own settings file"
 * is not a good enough reason to trust the string.
 */
function normaliseTheme(raw: unknown): ThemeCore | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Partial<ThemeCore>
  if (typeof t.id !== 'string' || !t.id.trim()) return null
  const ansi = Array.isArray(t.ansi) ? t.ansi : []
  if (ansi.length !== 16) return null
  return {
    id: t.id.trim().slice(0, 64),
    name: (typeof t.name === 'string' && t.name.trim() ? t.name.trim() : t.id).slice(0, 48),
    appearance: t.appearance === 'light' ? 'light' : 'dark',
    bg: hex(t.bg, '#0b0c0e'),
    panel: hex(t.panel, '#121317'),
    text: hex(t.text, '#e8eaed'),
    accent: hex(t.accent, '#c6ff4a'),
    danger: hex(t.danger, '#ff5c48'),
    warn: hex(t.warn, '#ffb347'),
    info: hex(t.info, '#7fd1ff'),
    ok: hex(t.ok, '#5ee6a8'),
    termBg: hex(t.termBg, '#0e0f12'),
    termFg: hex(t.termFg, '#e8eaed'),
    ansi: ansi.map((c) => hex(c, '#e8eaed')),
    custom: true,
    ...(typeof t.basedOn === 'string' ? { basedOn: t.basedOn } : {})
  }
}

/** Keep unknown/extra keys out, fill missing keys in, never trust the file. */
function normaliseSettings(raw: Partial<Settings> | null): Settings {
  const s = raw ?? {}
  const DEFAULT_SETTINGS = defaultSettings()
  const profiles: AgentProfile[] = Array.isArray(s.agentProfiles)
    ? s.agentProfiles.filter((p) => p && p.id && p.name)
    : []
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
    if (p.remoteControl === undefined && builtin?.remoteControl !== undefined) p.remoteControl = builtin.remoteControl
    // Profiles written before the shell/agent split get a kind from their
    // command; a built-in's kind is not up for negotiation.
    p.kind = builtin?.kind ?? inferKind(p)
    // A permission mode on something that is not Claude is noise: drop it, so
    // renaming a profile's command cannot leave a stale flag behind.
    if (!isClaudeCommand(p.command) || !isPermissionMode(p.permissionMode)) delete p.permissionMode
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
    // "First run" means no settings.json, not "no `onboarded` key". A
    // settings.json written before onboarding existed belongs to somebody who
    // has been using Forge for months, and showing them the welcome card would
    // be the merge announcing itself rather than the feature working.
    onboarded: raw === null ? false : s.onboarded !== false,
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
      brain === 'claude' || brain === 'openai' || brain === 'stub' || brain === 'gemini' || brain === 'openrouter'
        ? brain
        : DEFAULT_SETTINGS.voiceBrain,
    anthropicKey: typeof s.anthropicKey === 'string' ? s.anthropicKey : '',
    geminiKey: typeof s.geminiKey === 'string' ? s.geminiKey.trim() : '',
    geminiModel:
      typeof s.geminiModel === 'string' && s.geminiModel.trim() ? s.geminiModel.trim() : DEFAULT_SETTINGS.geminiModel,
    accountName:
      typeof s.accountName === 'string' && s.accountName.trim()
        ? s.accountName.trim().slice(0, 40)
        : DEFAULT_SETTINGS.accountName,
    accountColor: hex(s.accountColor, DEFAULT_SETTINGS.accountColor),
    themeId:
      typeof s.themeId === 'string' && s.themeId.trim() ? s.themeId.trim().slice(0, 64) : DEFAULT_SETTINGS.themeId,
    customThemes: (Array.isArray(s.customThemes) ? s.customThemes : [])
      .map(normaliseTheme)
      .filter((t): t is ThemeCore => t !== null)
      .slice(0, 40),
    reducedMotion: Boolean(s.reducedMotion),
    themeBg: hex(s.themeBg, DEFAULT_SETTINGS.themeBg),
    themeInk: hex(s.themeInk, DEFAULT_SETTINGS.themeInk),
    voiceAutoRelay: Boolean(s.voiceAutoRelay),
    voiceReplyMode:
      s.voiceReplyMode === 'text' || s.voiceReplyMode === 'voice' || s.voiceReplyMode === 'both'
        ? s.voiceReplyMode
        : DEFAULT_SETTINGS.voiceReplyMode,
    voiceReplyVoice: typeof s.voiceReplyVoice === 'string' ? s.voiceReplyVoice.slice(0, 120) : '',
    voiceEngine: s.voiceEngine === 'local' || s.voiceEngine === 'gemini' ? s.voiceEngine : DEFAULT_SETTINGS.voiceEngine,
    // Blank is meaningful for both: "whatever gemini-tts.ts defaults to".
    voiceTtsVoice: typeof s.voiceTtsVoice === 'string' ? s.voiceTtsVoice.trim().slice(0, 40) : '',
    voiceTtsModel: typeof s.voiceTtsModel === 'string' ? s.voiceTtsModel.trim().slice(0, 80) : '',
    // Undefined means a settings.json written before earcons existed, and the
    // answer for that file is the default (on) rather than a silent off.
    voiceEarcons: s.voiceEarcons === undefined ? DEFAULT_SETTINGS.voiceEarcons : Boolean(s.voiceEarcons),
    projectsRoot: typeof s.projectsRoot === 'string' ? s.projectsRoot.slice(0, 400) : '',
    voiceRelayGraceMs: Number.isFinite(s.voiceRelayGraceMs)
      ? clamp(s.voiceRelayGraceMs as number, 0, 60_000)
      : DEFAULT_SETTINGS.voiceRelayGraceMs,
    // Blank is meaningful here — it means "whatever gemini-media.ts defaults to".
    geminiImageModel: typeof s.geminiImageModel === 'string' ? s.geminiImageModel.trim() : '',
    openrouterKey: typeof s.openrouterKey === 'string' ? s.openrouterKey.trim() : '',
    openrouterModel:
      typeof s.openrouterModel === 'string' && s.openrouterModel.trim()
        ? s.openrouterModel.trim()
        : DEFAULT_SETTINGS.openrouterModel,
    memoryLlmSummarize: Boolean(s.memoryLlmSummarize),
    skillsLibraryDir:
      typeof s.skillsLibraryDir === 'string' && s.skillsLibraryDir.trim()
        ? s.skillsLibraryDir.trim()
        : DEFAULT_SETTINGS.skillsLibraryDir,
    // Only names that could ever be folders survive the trip off disk — this
    // list is turned into paths under ~/.claude/skills.
    skillsEnabled: (Array.isArray(s.skillsEnabled) ? s.skillsEnabled : [])
      .map((n) => String(n ?? '').trim())
      .filter((n) => isValidSkillName(n))
      .filter((n, i, all) => all.indexOf(n) === i)
      .slice(0, 200),
    remoteControlDefault: s.remoteControlDefault ?? DEFAULT_SETTINGS.remoteControlDefault,
    // Companion (M9). Trimmed, because every one of these is pasted by hand out
    // of the Firebase console and a trailing space in a URL is a mystery bug.
    // `enabled` is coerced rather than defaulted: a settings.json written before
    // M9 has no key at all, and the answer for that file is "off".
    companionEnabled: Boolean(s.companionEnabled),
    companionApiKey: str(s.companionApiKey),
    companionDatabaseURL: str(s.companionDatabaseURL).replace(/\/+$/, ''),
    companionAuthBase: str(s.companionAuthBase).replace(/\/+$/, ''),
    companionTokenBase: str(s.companionTokenBase).replace(/\/+$/, ''),
    companionEmail: str(s.companionEmail),
    companionRefreshToken: str(s.companionRefreshToken),
    companionUid: str(s.companionUid)
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
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
