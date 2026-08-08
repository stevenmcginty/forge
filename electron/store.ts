import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import {
  BUILTIN_AGENT_PROFILES,
  inferKind,
  isPermissionMode,
  migrateBuiltinCommand,
  permissionFamily
} from '@shared/agents'
import { isValidSkillName } from '@shared/skills'
import { sanitiseCustomTools } from '@shared/tools'
import { ACCEPT_WINDOW_MS, MOBILE_PORT, normaliseNgrokDomain } from '@shared/mobile'
import {
  DEFAULT_RAIL_OPEN,
  isRailSectionId,
  RAIL_SECTION_MAX_H,
  RAIL_SECTION_MIN_H
} from '@shared/rail'
import type {
  AgentProfile,
  MobileDeviceRecord,
  Project,
  RailSectionId,
  Settings,
  StoreSnapshot,
  ThemeCore,
  VoiceHubMode,
  VoiceHubPlacement,
  Workspace
} from '@shared/types'
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
    // Life-size out of the box: a wall you cannot read is a wall you will not
    // use, and that is the whole point of the mosaic.
    mosaicText: 'lifesize',
    // Colours on out of the box: telling two Claudes apart by the colour they
    // print in is the reason the tints exist.
    tabTextColours: true,
    // On out of the box: the rail already tells you how many shells a project
    // has, and "are any of them still thinking" is the other half of that.
    railBusyRing: true,
    // The dock is how work gets handed out, so it stays on. Git, activity and
    // share are additions the user turns on rather than panels that arrive
    // uninvited — see the comments on those fields in shared/types.ts.
    railTasks: true,
    railGit: false,
    railActivity: false,
    railShare: false,
    // Off, like the section it belongs to — and separately, because it is the
    // half that touches other vendors' config files.
    shareTools: false,
    railOpen: [...DEFAULT_RAIL_OPEN],
    railHeights: {},
    shell: 'pwsh.exe',
    catchShots: true,
    shotsKeep: DEFAULT_KEEP,
    window: { width: 1440, height: 900, maximized: false },
    onboarded: false,
    sttPython: detectSttPython(),
    sttModelDir: detectSttModelDir(),
    sttAutoStopSeconds: 10,
    sttHotkey: 'ControlRight',
    // The voice hub starts where it always was — in the status bar. Dragging it
    // out (or Ctrl+Shift+G) is the opt-in; see src/lib/voicehub.ts. There is no
    // voicePanelOpen/Width any more: the right-hand panel is gone.
    voiceHub: { mode: 'docked', x: 0, y: 0, w: 0, h: 0 },
    // On: undocking is meant to put the hub over Chrome and keep it there when
    // Forge is minimised, and only a real window can. See overlay-window.ts.
    voiceOverlayWindow: true,
    // On: "always listening and ready to interrupt" is the ask, and half duplex
    // cannot do the second half. See src/lib/bargein.ts.
    voiceBargeIn: true,
    // Gemini is the live brain; with no key set it degrades to the stub.
    voiceBrain: 'gemini',
    anthropicKey: '',
    // The Claude voice brain's model. An alias, not a pinned id — the CLI
    // resolves it to whatever is current, and it costs no key: the Agent SDK
    // session signs in with the machine's own `claude` login. Sonnet because
    // this is a conversation, and latency is the thing you notice.
    voiceClaudeModel: 'opus',
    // Off: the wake-word listener is new and unproven, so it stays an opt-in
    // rather than something that starts eavesdropping on everyone's upgrade.
    voiceWakeWord: false,
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
    // Neural speech by default — the Edge engine, because it needs no key and
    // has no per-minute quota, so the voice cannot swap to SAPI mid-reply the
    // way the quota-capped Gemini default used to. If the network is down the
    // renderer's engine chain degrades to the local voice on its own.
    voiceEngine: 'edge',
    // Empty = DEFAULT_EDGE_VOICE in shared/tts.ts (en-GB-SoniaNeural).
    voiceEdgeVoice: '',
    // Empty = the built-ins in electron/gemini-tts.ts (Sulafat, 3.1 flash TTS).
    voiceTtsVoice: '',
    voiceTtsModel: '',
    // On: it is what replaced the spoken "listening again" announcement.
    voiceEarcons: true,
    // A finished terminal should say so — but only when nobody is looking.
    terminalExitChime: true,
    projectsRoot: '',
    // Empty = use gemini-media.ts's built-in default, which the MCP bridge shares.
    geminiImageModel: '',
    openrouterKey: '',
    // Mirrors DEFAULT_OPENROUTER_MODEL in src/lib/voicebrain.ts, the same way
    // geminiModel above mirrors DEFAULT_GEMINI_MODEL — main cannot import a
    // renderer module, and voice-check asserts the two literals still agree.
    openrouterModel: 'google/gemini-2.5-flash-lite',
    groqKey: '',
    // Mirrors DEFAULT_GROQ_MODEL in src/lib/voicebrain.ts, for the same reason
    // as the two model literals above. 70b rather than the quicker 8b because
    // Forge's free-tier ceiling is tokens-per-minute, not requests: the manifest
    // alone is ~3k tokens a turn, and 8b-instant's 6k TPM leaves room for barely
    // one exchange a minute. 70b-versatile gets 12k.
    groqModel: 'llama-3.3-70b-versatile',
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
    // Closing Forge should not be the end of the conversation. On by default:
    // a restored layout that starts four empty Claudes is a restored *shape*,
    // not restored work. See shared/session.ts.
    resumeSessions: true,
    // …and the backstop for everything resuming cannot bring back.
    confirmOnQuit: true,
    // The phone link (M9) is off, unconfigured and credential-less out of the
    // box. Nothing in electron/companion-sync.ts runs until all three change.
    companionEnabled: false,
    companionApiKey: '',
    companionDatabaseURL: '',
    companionAuthBase: '',
    companionTokenBase: '',
    companionEmail: '',
    companionRefreshToken: '',
    companionUid: '',
    // Forge Mobile (M11) — the phone's terminal link. Off, unpaired, and not
    // listening out of the box; nothing in electron/mobile/ binds a port until
    // this is switched on. The bind host is broad on purpose — see the note on
    // `mobileBindHost` in shared/types.ts, and isAllowedSource in
    // electron/mobile/server.ts, which is what actually decides who gets in.
    mobileEnabled: false,
    mobilePort: MOBILE_PORT,
    mobileBindHost: '0.0.0.0',
    mobileDevices: [],
    // "Accept new phones" is disarmed. 0 rather than false because the armed
    // state is a deadline, not a switch — see the note in shared/types.ts.
    mobileAcceptUntil: 0,
    // The ngrok tunnel: off, and holding no account material, until Steve does
    // the one-time setup in Settings › Forge Mobile. See mobile-tunnel.ts.
    mobileTunnel: 'off',
    mobileNgrokAuthtoken: '',
    mobileNgrokDomain: '',
    // The Update button types the command and stops. Turning this on is opting
    // in to a settings page that can start an installer with one click.
    updatesAutoRun: false,
    updateDismissedVersion: '',
    // Empty is "never seen one", which is right for a fresh install: the
    // normaliser seeds it to the running version, so a first launch is not
    // followed by a changelog for a release the user did not upgrade to.
    lastNotesVersion: '',
    // Empty on purpose: the built-in catalogue covers what Forge itself runs,
    // and everything else is Steve's to add.
    customTools: []
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
  // The default is always the real profile. A development checkout gets its own
  // by naming one in an untracked .forge-profile file, which scripts/dev.mjs
  // reads and passes down as FORGE_DATA_DIR.
  //
  // Deciding it here on app.isPackaged instead would be wrong: the everyday
  // Forge is launched from source too, so an unpackaged run is not the same
  // thing as a development run, and keying on it sent the real app to an empty
  // profile the moment this file was pulled into the stable checkout.
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
  // The chooser shows profiles in this order and nothing lets a user reorder
  // them, so a stored order is only an accident of when each row was written —
  // a built-in added later (Antigravity) would otherwise sit below every custom
  // profile forever, and a built-in demoted in the roster (Gemini, now
  // API-key-only) would keep its old shelf position. Built-ins follow the
  // roster; customs keep their creation order after them.
  const rosterOrder = new Map(BUILTIN_AGENT_PROFILES.map((b, i) => [b.id, i]))
  profiles.sort((a, b) => (rosterOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rosterOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  for (const p of profiles) {
    if (typeof p.command !== 'string') p.command = ''
    if (!p.accent) p.accent = '#C6FF4A'
    if (!p.badge) p.badge = p.name.slice(0, 2).toUpperCase()
    const builtin = BUILTIN_AGENT_PROFILES.find((b) => b.id === p.id)
    p.builtin = Boolean(builtin)
    // A built-in still carrying a command Forge itself shipped and then fixed
    // gets the fix. Without this the correction only ever reaches machines that
    // had never run the broken version — i.e. not the ones that hit the bug.
    if (builtin) p.command = migrateBuiltinCommand(p.id, p.command, builtin.command)
    // Adopt a new built-in default (e.g. the Gemini bridge) into a settings.json
    // written before the flag existed, without overriding a deliberate opt-out.
    if (p.mcpBridge === undefined && builtin?.mcpBridge !== undefined) p.mcpBridge = builtin.mcpBridge
    if (p.remoteControl === undefined && builtin?.remoteControl !== undefined) p.remoteControl = builtin.remoteControl
    // Profiles written before the shell/agent split get a kind from their
    // command; a built-in's kind is not up for negotiation.
    p.kind = builtin?.kind ?? inferKind(p)
    // A permission mode on something with no ladder to climb is noise: drop it,
    // so renaming a profile's command cannot leave a stale flag behind. Note
    // this is the *family* test, not the Claude one — Codex has modes of its
    // own, and stripping them on load would silently reset the profile every
    // time Forge started.
    if (permissionFamily(p.command) === null || !isPermissionMode(p.permissionMode)) delete p.permissionMode
  }

  const win = s.window ?? DEFAULT_SETTINGS.window
  const brain = s.voiceBrain
  return {
    agentProfiles: profiles,
    lastProjectId: s.lastProjectId ?? null,
    railCollapsed: s.railCollapsed ?? false,
    terminalFontSize: clamp(s.terminalFontSize ?? DEFAULT_SETTINGS.terminalFontSize, 9, 28),
    terminalFontFamily: s.terminalFontFamily || DEFAULT_SETTINGS.terminalFontFamily,
    mosaicText: s.mosaicText === 'scaled' ? 'scaled' : DEFAULT_SETTINGS.mosaicText,
    tabTextColours: s.tabTextColours ?? DEFAULT_SETTINGS.tabTextColours,
    railBusyRing: s.railBusyRing ?? DEFAULT_SETTINGS.railBusyRing,
    // Undefined means a settings.json written before the rail had sections. The
    // dock was always there, so its absence means "on"; git, activity and share
    // were never there, so theirs means "off". Hence the two different spellings.
    railTasks: s.railTasks ?? DEFAULT_SETTINGS.railTasks,
    railGit: Boolean(s.railGit),
    railActivity: Boolean(s.railActivity),
    railShare: Boolean(s.railShare),
    shareTools: Boolean(s.shareTools),
    railOpen: Array.isArray(s.railOpen) ? s.railOpen.filter(isRailSectionId) : [...DEFAULT_RAIL_OPEN],
    railHeights: normaliseRailHeights(s.railHeights),
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
    // Mirrors sanitiseHubPlacement in src/lib/voicehub.ts — main cannot import a
    // renderer module, and hub:check asserts the two still agree. The position
    // is deliberately *not* clamped here: the window that saved it may have
    // been a different size, so the renderer clamps against the live viewport.
    //
    // `voicePanelOpen` and `voicePanelWidth` used to sit here. They are not
    // read and not written: normalising builds this object from scratch, so the
    // first save after the update quietly drops them from an existing file.
    voiceHub: hubPlacement(s.voiceHub),
    // Undefined means a settings.json written before the overlay window
    // existed; that file gets the default (on), not a silent off — same
    // reasoning as voiceEarcons below.
    voiceOverlayWindow:
      s.voiceOverlayWindow === undefined
        ? DEFAULT_SETTINGS.voiceOverlayWindow
        : Boolean(s.voiceOverlayWindow),
    voiceBargeIn:
      s.voiceBargeIn === undefined ? DEFAULT_SETTINGS.voiceBargeIn : Boolean(s.voiceBargeIn),
    // Every member of VoiceBrainId, and it has to stay that way: `groq` was
    // missing from this list, so choosing Groq in Settings was written to disk
    // and then silently normalised back to Gemini on the next read — the brain
    // you picked was never the brain you got.
    voiceBrain:
      brain === 'claude' ||
      brain === 'openai' ||
      brain === 'stub' ||
      brain === 'gemini' ||
      brain === 'openrouter' ||
      brain === 'groq'
        ? brain
        : DEFAULT_SETTINGS.voiceBrain,
    anthropicKey: typeof s.anthropicKey === 'string' ? s.anthropicKey : '',
    voiceClaudeModel:
      typeof s.voiceClaudeModel === 'string' && s.voiceClaudeModel.trim()
        ? s.voiceClaudeModel.trim().slice(0, 80)
        : DEFAULT_SETTINGS.voiceClaudeModel,
    voiceWakeWord: Boolean(s.voiceWakeWord),
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
    // A stored 'gemini' with no voice ever picked is the OLD default, not a
    // choice — every settings.json written before the Edge engine existed says
    // exactly that, and those users were the ones hearing the quota swap the
    // voice to SAPI mid-reply. They get the new default. A 'gemini' WITH a
    // picked voice is somebody's deliberate selection and is kept — and the
    // Settings page pins voiceTtsVoice the moment anyone picks the Gemini
    // engine, so a deliberate choice made after this shipped sticks too.
    voiceEngine:
      s.voiceEngine === 'local' || s.voiceEngine === 'edge'
        ? s.voiceEngine
        : s.voiceEngine === 'gemini' && typeof s.voiceTtsVoice === 'string' && s.voiceTtsVoice.trim()
          ? 'gemini'
          : DEFAULT_SETTINGS.voiceEngine,
    voiceEdgeVoice: typeof s.voiceEdgeVoice === 'string' ? s.voiceEdgeVoice.trim().slice(0, 60) : '',
    // Blank is meaningful for both: "whatever gemini-tts.ts defaults to".
    voiceTtsVoice: typeof s.voiceTtsVoice === 'string' ? s.voiceTtsVoice.trim().slice(0, 40) : '',
    voiceTtsModel: typeof s.voiceTtsModel === 'string' ? s.voiceTtsModel.trim().slice(0, 80) : '',
    // Undefined means a settings.json written before earcons existed, and the
    // answer for that file is the default (on) rather than a silent off.
    voiceEarcons: s.voiceEarcons === undefined ? DEFAULT_SETTINGS.voiceEarcons : Boolean(s.voiceEarcons),
    terminalExitChime:
      s.terminalExitChime === undefined ? DEFAULT_SETTINGS.terminalExitChime : Boolean(s.terminalExitChime),
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
    groqKey: typeof s.groqKey === 'string' ? s.groqKey.trim() : '',
    groqModel:
      typeof s.groqModel === 'string' && s.groqModel.trim() ? s.groqModel.trim() : DEFAULT_SETTINGS.groqModel,
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
    // Both undefined in any settings.json written before resume existed, and
    // the answer for that file is the default (on) rather than a silent off —
    // same reasoning as voiceEarcons above.
    resumeSessions: s.resumeSessions === undefined ? DEFAULT_SETTINGS.resumeSessions : Boolean(s.resumeSessions),
    confirmOnQuit: s.confirmOnQuit === undefined ? DEFAULT_SETTINGS.confirmOnQuit : Boolean(s.confirmOnQuit),
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
    companionUid: str(s.companionUid),
    // Forge Mobile (M11). Coerced rather than defaulted, like companionEnabled:
    // a settings.json written before M11 has no key, and the answer is "off".
    mobileEnabled: Boolean(s.mobileEnabled),
    mobilePort: clamp(Number(s.mobilePort ?? MOBILE_PORT), 1024, 65535),
    mobileBindHost: str(s.mobileBindHost) || DEFAULT_SETTINGS.mobileBindHost,
    mobileDevices: mobileDevices(s.mobileDevices),
    mobileAcceptUntil: acceptUntil(s.mobileAcceptUntil),
    // The domain is shape-checked, not just trimmed: it ends up on ngrok's
    // command line, and a junk value degrading to '' (tunnel refuses to start
    // with a sentence) beats a junk value degrading to an argument.
    mobileTunnel: s.mobileTunnel === 'ngrok' ? 'ngrok' : 'off',
    mobileNgrokAuthtoken: str(s.mobileNgrokAuthtoken),
    mobileNgrokDomain: normaliseNgrokDomain(s.mobileNgrokDomain),
    // Coerced rather than defaulted, like companionEnabled above: a settings.json
    // written before M10 has no key, and the answer for that file is "no".
    updatesAutoRun: Boolean(s.updatesAutoRun),
    // A version string goes into a comparison, never into markup — but it also
    // never needs to be longer than "10.20.30-rc.1", so it is capped.
    updateDismissedVersion: str(s.updateDismissedVersion).slice(0, 40),
    /*
     * A genuinely fresh install gets the running version so its own bundled
     * notes do not announce themselves as an update. An existing settings file
     * without this key is an upgrade from before the card existed, though: leave
     * it empty so the first launch after that upgrade actually opens the card.
     */
    lastNotesVersion: raw === null ? appVersion() : s.lastNotesVersion === undefined ? '' : str(s.lastNotesVersion).slice(0, 40),
    // Validated in shared/tools.ts rather than here, because the settings page
    // has to apply exactly the same rules to what it is about to save as this
    // does to what it just loaded — a form that accepts a row the store then
    // silently drops is worse than one that refuses it.
    customTools: sanitiseCustomTools(s.customTools)
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * The running version, for seeding `lastNotesVersion` on a fresh install.
 *
 * Wrapped because the settings normaliser is exercised head-less by check
 * scripts with `app` stubbed, and `app.getVersion` is not part of the shape they
 * stub. An empty string there is harmless: it means the card opens once in a test
 * process that has no window to open it in.
 */
function appVersion(): string {
  try {
    return typeof app?.getVersion === 'function' ? app.getVersion() : ''
  } catch {
    return ''
  }
}

/**
 * Paired phones, made safe off disk.
 *
 * The one field worth being strict about is `tokenHash`: it is compared with
 * `timingSafeEqual` over a hex buffer in electron/mobile/auth.ts, so anything
 * that is not exactly 64 hex characters is dropped rather than carried into a
 * comparison it would make throw. A malformed entry is a device that can no
 * longer connect, which is the correct failure — it is not a device that gets
 * in by being malformed.
 */
function mobileDevices(raw: unknown): MobileDeviceRecord[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((d) => (d && typeof d === 'object' ? (d as Record<string, unknown>) : {}))
    .map((d) => ({
      id: str(d.id).slice(0, 128),
      name: str(d.name).slice(0, 64) || 'Phone',
      tokenHash: str(d.tokenHash).toLowerCase(),
      createdAt: Number(d.createdAt) || 0,
      lastSeenAt: Number(d.lastSeenAt) || 0
    }))
    .filter((d) => d.id && /^[0-9a-f]{64}$/.test(d.tokenHash))
    .slice(0, 20)
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo
}

/**
 * Dragged rail-section heights, made safe off disk.
 *
 * Unknown ids are dropped rather than carried, so a section renamed in a later
 * version does not leave a dead key sitting in settings.json forever. Values are
 * clamped to the same bounds the drag handle enforces, and anything non-finite
 * is dropped entirely — a `NaN` reaching CSS as a custom property fails
 * silently, and the symptom is a drag handle that looks broken for no reason.
 *
 * The viewport fraction that clampSectionHeight also applies is deliberately not
 * enforced here: main has no window height to speak for, and a height saved on a
 * big monitor should not be permanently truncated by having once been loaded on
 * a laptop. The renderer clamps again at render time, which is where the
 * viewport is actually known.
 */
function normaliseRailHeights(raw: unknown): Partial<Record<RailSectionId, number>> {
  const out: Partial<Record<RailSectionId, number>> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isRailSectionId(key)) continue
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) continue
    out[key] = Math.round(clamp(n, RAIL_SECTION_MIN_H, RAIL_SECTION_MAX_H))
  }
  return out
}

/**
 * The "Accept new phones" deadline, made safe off disk.
 *
 * Two rules, both about the same failure: this timestamp is the only thing
 * standing between "nobody can summon a pairing prompt" and "anyone who finds
 * the tunnel can". A deadline in the past is dead and reads back as 0 — so a
 * window armed before a crash does not quietly reopen days later. And a
 * deadline further out than one window from *now* is clamped, so a hand-edited
 * (or corrupted) file cannot arm the desktop for a week.
 */
function acceptUntil(raw: unknown): number {
  const until = Number(raw ?? 0)
  if (!Number.isFinite(until) || until <= Date.now()) return 0
  return Math.min(until, Date.now() + ACCEPT_WINDOW_MS)
}

/** The voice hub's saved placement, made safe. See src/lib/voicehub.ts. */
function hubPlacement(raw: unknown): VoiceHubPlacement {
  const v = (raw ?? {}) as Partial<VoiceHubPlacement>
  const mode: VoiceHubMode = v.mode === 'floating' || v.mode === 'expanded' || v.mode === 'docked' ? v.mode : 'docked'
  const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0)
  // 0 means "the default card"; anything else is clamped to what a corner-drag
  // is allowed to produce. The bounds are duplicated from HUB_CARD_MIN/MAX for
  // the usual reason — main cannot import a renderer module — and hub:check
  // asserts the four numbers still match.
  const dim = (n: unknown, lo: number, hi: number): number => {
    const px = num(n)
    return px === 0 ? 0 : clamp(px, lo, hi)
  }
  return { mode, x: num(v.x), y: num(v.y), w: dim(v.w, 340, 760), h: dim(v.h, 400, 1000) }
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
