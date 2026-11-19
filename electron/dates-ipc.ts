import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { DEFAULT_PROFILE_ID } from '@shared/agents'
import { agentPrompt, DATES_IPC, todayOf, type DateAlert, type DateInput, type DatePatch } from '@shared/dates'
import { paneOpenReply } from './foreman/pane-caller'
import { getMainWindow } from './main-window'
import { getDates } from './dates-store'
import { getProjects, getSettings } from './store'
import { askRendererTool } from './voice-agent/ipc'

/**
 * Main-process wiring for Dates: IPC for the desktop renderer, every change
 * sent to every window, the alert scheduler and its desktop notifications.
 * The list itself lives in dates-store.ts, the rules in shared/dates.ts.
 */

/** The first alert pass, a minute after start; then one every 15 minutes. */
const FIRST_PASS_MS = 60_000
const PASS_EVERY_MS = 15 * 60_000
/** Pane names stay short enough for a tab. */
const PANE_NAME_MAX = 40

let started = false
let firstPass: ReturnType<typeof setTimeout> | null = null
let passTimer: ReturnType<typeof setInterval> | null = null
/**
 * Notifications still on screen. Held so they are not garbage collected before
 * Steve clicks them — a collected Notification loses its click handler.
 */
const shown = new Set<Notification>()

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

/** Bring Forge's window to the front and ask its renderer to open Dates. */
function revealDates(): void {
  const win = getMainWindow()
  if (!win) {
    app.focus({ steal: true })
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send(DATES_IPC.open)
}

function notify(alert: DateAlert): void {
  if (!Notification.isSupported()) return
  const note = new Notification({ title: alert.title, body: alert.body })
  shown.add(note)
  note.on('click', () => {
    shown.delete(note)
    revealDates()
  })
  note.on('close', () => {
    shown.delete(note)
  })
  note.show()
}

function runPass(): void {
  try {
    getDates().checkNow()
  } catch (err) {
    console.error('[dates] alert pass failed:', err)
  }
}

/** Register the IPC handlers, fan changes out to the windows, start the scheduler. Call once. */
export function initDates(): void {
  if (started) return
  started = true
  const dates = getDates()

  ipcMain.handle(DATES_IPC.list, () => dates.list())
  ipcMain.handle(DATES_IPC.add, (_e, input: DateInput) => dates.add(input, 'steve'))
  ipcMain.handle(DATES_IPC.update, (_e, id: string, patch: DatePatch) => dates.update(String(id), patch ?? {}))
  ipcMain.handle(DATES_IPC.complete, (_e, id: string) => dates.complete(String(id)))
  ipcMain.handle(DATES_IPC.snooze, (_e, id: string, until: string) => dates.snooze(String(id), String(until)))
  ipcMain.handle(DATES_IPC.remove, (_e, id: string) => dates.remove(String(id)))

  dates.onChange((items) => broadcast(DATES_IPC.changed, items))
  dates.onAlert(notify)

  // Neither timer may hold the app open on quit; disposeDates clears both too.
  firstPass = setTimeout(() => {
    firstPass = null
    runPass()
  }, FIRST_PASS_MS)
  firstPass.unref?.()
  passTimer = setInterval(runPass, PASS_EVERY_MS)
  passTimer.unref?.()
}

/** Stop the scheduler. For before-quit. */
export function disposeDates(): void {
  if (firstPass) clearTimeout(firstPass)
  firstPass = null
  if (passTimer) clearInterval(passTimer)
  passTimer = null
  shown.clear()
}

/**
 * The agent a hand-off would get: the default agent of the project Steve last
 * had on screen, else Forge's default. Same answer as the renderer's
 * openAgentPane with no profile named (src/state/AppState.tsx).
 */
function handOffAgent(): string {
  try {
    const last = getSettings().lastProjectId
    const project = last ? getProjects().find((p) => p.id === last) : undefined
    return project?.defaultProfileId || DEFAULT_PROFILE_ID
  } catch {
    return DEFAULT_PROFILE_ID
  }
}

/**
 * Open an agent pane on the desktop with the line's prompt as its first
 * message, submitted. Same route as the open_agent_pane tool takes for a
 * caller that is not a pane (electron/browser-panes/ipc.ts): the renderer runs
 * it in the project on screen.
 */
export async function openDateAgent(id: string): Promise<{ ok: boolean; error?: string }> {
  const item = getDates()
    .list()
    .find((i) => i.id === String(id))
  if (!item) return { ok: false, error: 'There is no date with that id.' }
  const win = getMainWindow()
  if (!win || win.webContents.isLoading()) return { ok: false, error: 'The Forge window on the desktop is not ready.' }
  const name = item.title.length > PANE_NAME_MAX ? `${item.title.slice(0, PANE_NAME_MAX - 1).trimEnd()}…` : item.title
  const reply = paneOpenReply(
    await askRendererTool('open_agent_pane', {
      agent: handOffAgent(),
      prompt: agentPrompt(item, todayOf(new Date())),
      name,
      submit: true
    })
  )
  return reply.ok ? { ok: true } : { ok: false, error: reply.text }
}
