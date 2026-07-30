/**
 * The Electron half of the Forge Companion — everything companion-sync.ts is
 * deliberately not allowed to know about: settings, the shots shelf, the PTY
 * manager, BrowserWindows and IPC.
 *
 * Keeping the split means the service can be driven head-less against the
 * Firebase emulator (scripts/companion-smoke.mjs) with a temp FORGE_DATA_DIR
 * and no Electron at all, which is the only way to test a network service
 * honestly.
 *
 * ## How project status is derived
 *
 * Without touching the renderer. Forge already knows everything the phone list
 * needs, in two places main can read directly:
 *
 *   - `getProjects()`               — name, colour, folder
 *   - `getManager().list()`         — live PTY sessions, each with its `cwd`
 *   - `getWorkspace(projectId)`     — the saved tab layout, on disk
 *
 * A pane's cwd *is* its project's folder (see Project.path), so counting live
 * panes per project is a path comparison and nothing more. The alternative —
 * reaching into the renderer's AppState for its pane tree — would couple this
 * service to a component another milestone owns, for information main already
 * has. The renderer can still enrich the picture through `companion:publish`,
 * which just asks for a republish.
 */

import { BrowserWindow, ipcMain } from 'electron'
import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { IPC } from '@shared/ipc'
import type { CompanionSignInResult, CompanionStatus } from '@shared/types'
import { CompanionSync, type CompanionHost, type CompanionProjectInfo, type CompanionProjectStatus } from './companion-sync'
import type { CompanionConfig } from './companion/protocol'
import { adoptShotFiles } from './shots-watcher'
import { getDataDir, getProjects, getSettings, getWorkspace, setSettings } from './store'
import { getManager } from './pty-host'

let sync: CompanionSync | null = null

/* ------------------------------------------------------------------ host */

function configFromSettings(): CompanionConfig {
  const s = getSettings()
  return {
    enabled: s.companionEnabled,
    apiKey: s.companionApiKey,
    databaseURL: s.companionDatabaseURL,
    authBase: s.companionAuthBase,
    tokenBase: s.companionTokenBase,
    email: s.companionEmail,
    refreshToken: s.companionRefreshToken,
    uid: s.companionUid
  }
}

function saveConfig(patch: Partial<CompanionConfig>): void {
  const map: Record<keyof CompanionConfig, string> = {
    enabled: 'companionEnabled',
    apiKey: 'companionApiKey',
    databaseURL: 'companionDatabaseURL',
    authBase: 'companionAuthBase',
    tokenBase: 'companionTokenBase',
    email: 'companionEmail',
    refreshToken: 'companionRefreshToken',
    uid: 'companionUid'
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    const key = map[k as keyof CompanionConfig]
    if (key) out[key] = v
  }
  if (Object.keys(out).length > 0) setSettings(out)
}

/** Case-insensitive path identity — Windows, and a pane's cwd is user-typed. */
function samePath(a: string, b: string): boolean {
  if (!a || !b) return false
  try {
    return resolve(a).toLowerCase() === resolve(b).toLowerCase()
  } catch {
    return false
  }
}

function listProjects(): CompanionProjectInfo[] {
  return getProjects().map((p) => ({ id: p.id, name: p.name, color: p.color, path: p.path }))
}

function statusOf(projectId: string): CompanionProjectStatus {
  const project = getProjects().find((p) => p.id === projectId)
  if (!project) return { panes: 0, tabs: 0, lastActivity: 0 }

  let panes = 0
  let lastActivity = 0
  try {
    for (const s of getManager().list()) {
      if (!samePath(s.cwd, project.path)) continue
      panes += 1
      if (s.startedAt > lastActivity) lastActivity = s.startedAt
    }
  } catch {
    /* the PTY manager is lazy; no sessions yet is not an error */
  }

  const workspace = getWorkspace(projectId)
  const tabs = workspace?.tabs.length ?? 0
  if (lastActivity === 0) {
    // Nothing live — fall back to when the layout was last written, which is
    // the closest thing to "when did Steve last touch this project".
    try {
      lastActivity = statSync(join(getDataDir(), 'layouts', `${projectId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)).mtimeMs
    } catch {
      lastActivity = project.createdAt
    }
  }
  return { panes, tabs, lastActivity: Math.round(lastActivity) }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

const host: CompanionHost = {
  getConfig: configFromSettings,
  saveConfig,
  listProjects,
  statusOf,
  adoptShots: (files) => adoptShotFiles(files),
  emit: (event) => {
    if (event.type === 'status') {
      broadcast(IPC.companionStatusEvent, event.status)
      return
    }
    if (event.type === 'utterance') {
      const { projectId, projectName, itemId, text } = event
      // The voice pipeline is somebody else's milestone. All this service
      // promises is that the event fires with this payload — see
      // CompanionUtteranceEvent in shared/types.ts.
      broadcast(IPC.companionUtterance, { projectId, projectName, itemId, text })
      return
    }
    // Images already reached the tray through the shots shelf's own broadcast.
    console.log(`[companion] ${event.paths.length} image(s) from the phone -> ${event.projectId}`)
  },
  log: (line, ...rest) => console.log(`[companion] ${line}`, ...rest)
}

/* ------------------------------------------------------------------- api */

function service(): CompanionSync {
  if (!sync) sync = new CompanionSync(host)
  return sync
}

function offStatus(): CompanionStatus {
  return {
    enabled: false,
    configured: false,
    state: 'off',
    email: '',
    uid: '',
    detail: '',
    projects: 0,
    lastInboxAt: 0
  }
}

/**
 * Send text to Steve's phone.
 *
 * Exported so the voice pipeline — which lives in the renderer, and whose
 * milestone is not this one — can answer a companion message from the main
 * process side too. The renderer's route is `window.forge.companion.reply()`.
 */
export async function companionReply(itemId: string, text: string, projectId?: string): Promise<boolean> {
  if (!sync) return false
  return sync.reply(String(itemId ?? ''), String(text ?? ''), projectId)
}

export function registerCompanionHandlers(): void {
  ipcMain.handle(IPC.companionStatus, () => (sync ? sync.getStatus() : offStatus()))

  ipcMain.handle(IPC.companionSignIn, async (_e, email: string, password: string): Promise<CompanionSignInResult> => {
    return service().signIn(String(email ?? ''), String(password ?? ''))
  })

  ipcMain.handle(IPC.companionSignOut, (): CompanionStatus => {
    service().signOut()
    return service().getStatus()
  })

  ipcMain.handle(IPC.companionPublish, async (): Promise<number> => {
    if (!sync) return 0
    return sync.publishProjects()
  })

  ipcMain.handle(IPC.companionReply, async (_e, itemId: string, text: string, projectId?: string) =>
    companionReply(itemId, text, projectId)
  )

  // Start it — which, with the shipped defaults, means "notice it is off and
  // do nothing". No network call, no credential read.
  service().start()
}

/**
 * Re-read settings and bring the link up or down to match. Called from the
 * settings write handler, so flipping `companionEnabled` takes effect at once
 * rather than at the next launch.
 */
export function applyCompanionSettings(): void {
  if (!sync && !getSettings().companionEnabled) return
  service().start()
}

export function disposeCompanion(): void {
  sync?.dispose()
  sync = null
}
