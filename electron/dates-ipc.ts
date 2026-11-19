import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { DEFAULT_PROFILE_ID } from '@shared/agents'
import { isDatesTool, runDatesTool } from '@shared/dates-tools'
import {
  agentPrompt,
  DATES_IPC,
  dateNoticeOf,
  statusOf,
  todayOf,
  weeklyDue,
  weeklyPrompt,
  type DateAlert,
  type DateInput,
  type DatePatch,
  type DatesWeeklyPatch
} from '@shared/dates'
import { paneOpenReply } from './foreman/pane-caller'
import { getMainWindow } from './main-window'
import { getDates, type DatesService } from './dates-store'
import { getProjects, getSettings } from './store'
import { askRendererTool } from './voice-agent/ipc'

/**
 * Main-process wiring for Dates: IPC for the desktop renderer, every change
 * sent to every window, the alert scheduler and its desktop notifications,
 * and the weekly check. The list itself lives in dates-store.ts, the rules in
 * shared/dates.ts.
 */

/** The first alert pass, a minute after start; then one every 15 minutes. */
const FIRST_PASS_MS = 60_000
const PASS_EVERY_MS = 15 * 60_000
/** Pane names stay short enough for a tab. */
const PANE_NAME_MAX = 40
/** The weekly check's pane, and the file in the data dir that can replace its prompt. */
const WEEKLY_PANE_NAME = 'Weekly dates check'
const WEEKLY_PROMPT_FILE = 'dates-weekly-prompt.md'
const NOT_READY = 'The Forge window on the desktop is not ready.'

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

/**
 * One tick: the alert pass (08:00 to 21:00 only, inside `checkNow`), then the
 * weekly check when its slot has come (at any hour).
 */
function runPass(): void {
  const dates = getDates()
  try {
    dates.checkNow()
  } catch (err) {
    console.error('[dates] alert pass failed:', err)
  }
  try {
    if (weeklyDue(dates.getWeekly(), new Date())) {
      void runWeeklyCheck().then((r) => {
        if (!r.ok) console.warn(`[dates] the weekly check did not start: ${r.error ?? 'no reason given'}`)
      })
    }
  } catch (err) {
    console.error('[dates] weekly check failed:', err)
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

  ipcMain.handle(DATES_IPC.weeklyGet, () => dates.getWeekly())
  ipcMain.handle(DATES_IPC.weeklySet, (_e, patch: DatesWeeklyPatch) => dates.setWeekly(patch ?? {}))
  ipcMain.handle(DATES_IPC.weeklyRun, () => runWeeklyCheck())
  // The realtime voice agent's Dates tools: the same runDatesTool as every other agent.
  ipcMain.handle(DATES_IPC.tool, (_e, name: string, args: unknown) =>
    isDatesTool(String(name)) ? runDatesTool(dates, String(name), args) : { ok: false, text: 'There is no Dates tool by that name.' }
  )

  dates.onChange((items) => broadcast(DATES_IPC.changed, items))
  dates.onWeekly((weekly) => broadcast(DATES_IPC.weeklyChanged, weekly))
  dates.onAlert((alert) => {
    notify(alert)
    // The in-app notice, on every window (docs/DATES.md, "In-app notices").
    broadcast(DATES_IPC.alert, dateNoticeOf(alert))
  })

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
  if (!windowReady()) return { ok: false, error: NOT_READY }
  const name = item.title.length > PANE_NAME_MAX ? `${item.title.slice(0, PANE_NAME_MAX - 1).trimEnd()}…` : item.title
  return openPane(agentPrompt(item, todayOf(new Date())), name)
}

/** Whether the desktop window can take a pane now. */
function windowReady(): boolean {
  const win = getMainWindow()
  return !!win && !win.webContents.isLoading()
}

/** An agent pane with `prompt` as its first message, submitted, by the open_agent_pane route. */
async function openPane(prompt: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const reply = paneOpenReply(await askRendererTool('open_agent_pane', { agent: handOffAgent(), prompt, name, submit: true }))
  return reply.ok ? { ok: true } : { ok: false, error: reply.text }
}

/** The text of `<dir>/dates-weekly-prompt.md`, or null when there is none. */
function customWeeklyPrompt(dir: string): string | null {
  try {
    return readFileSync(join(dir, WEEKLY_PROMPT_FILE), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[dates] could not read ${WEEKLY_PROMPT_FILE}; the default prompt is used:`, err)
    }
    return null
  }
}

/** One weekly check at a time: a slow renderer must not get two panes. */
let weeklyStarting = false

/**
 * The weekly check (docs/DATES.md, "Weekly check"): open an agent pane named
 * "Weekly dates check" whose prompt is `dates-weekly-prompt.md` (when it is
 * not empty) or `DEFAULT_WEEKLY_PROMPT`, then today's date and the number of
 * open lines, then `WEEKLY_HARD_RULES`. Started: recorded as `started`. No
 * window ready: nothing is recorded, so the next tick tries again. Any other
 * failure: recorded as `failed`, and the next try is next week.
 *
 * `opts.dates` is for scripts/dates-check.mjs; the app uses the live list.
 */
export async function runWeeklyCheck(opts: { dates?: DatesService } = {}): Promise<{ ok: boolean; error?: string }> {
  if (weeklyStarting) return { ok: false, error: 'The weekly check is already starting.' }
  if (!windowReady()) return { ok: false, error: NOT_READY }
  weeklyStarting = true
  const dates = opts.dates ?? getDates()
  try {
    const today = todayOf(new Date())
    const open = dates.list().filter((i) => statusOf(i, today) !== 'done').length
    const started = await openPane(weeklyPrompt(customWeeklyPrompt(dates.dir), today, open), WEEKLY_PANE_NAME)
    dates.markWeeklyRun(started.ok ? 'started' : 'failed', started.error)
    return started
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err)
    dates.markWeeklyRun('failed', message)
    return { ok: false, error: message }
  } finally {
    weeklyStarting = false
  }
}
