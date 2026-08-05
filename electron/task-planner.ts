import { execFile } from 'node:child_process'
import { ipcMain } from 'electron'
import { IPC, MAX_TASK_CARDS, MAX_TASK_TEXT } from '@shared/ipc'
import type { TaskPlanBrainRequest, TaskPlanResult } from '@shared/types'
import { whichCommand } from './agent-probe'
import { callGemini } from './voice-bridge'

/**
 * The brain behind the delegation tray's Plan button.
 *
 * A goal typed into the tray is handed to `claude -p` — one headless turn of
 * the same CLI every pane runs, so it uses the login Steve already has and
 * costs no second credential — which breaks it into self-contained task
 * briefs. The renderer turns those into cards; dealing them onto agents stays
 * a human act, by drag, like everything else on the wall.
 *
 * Same spawn discipline as claudeVersion in system.ts: run the exact file the
 * PATH probe found, via cmd.exe only when it is a .cmd shim, never through a
 * shell string.
 */

/** Planning is one model turn, but a cold CLI plus a real think takes time. */
const PLAN_TIMEOUT_MS = 120_000

/** More briefs than a hand can hold stops being a plan and starts being noise. */
const PLAN_MAX_TASKS = 8

/** The rules both brains plan by — Claude gets them inline, Gemini as system text. */
function planRules(projectName: string): string {
  return [
    `You are the planning step of a delegation tray in a terminal app. The user states a goal for the project "${projectName}"; you split it into tasks that will each be handed to a separate coding agent working in this same repository.`,
    '',
    'Rules:',
    `- 2 to ${PLAN_MAX_TASKS} tasks. Fewer, bigger tasks beat many slivers; one task is fine if the goal does not divide.`,
    '- Each task must be a self-contained brief: the agent receiving it sees ONLY that text, so restate whatever context it needs from the goal.',
    '- Tasks run in parallel by different agents, so make them as independent as you can; where order matters, say so inside the brief itself.',
    '- Write each brief as a direct instruction to the agent, in plain prose on a single line.',
    '',
    'Reply with ONLY a JSON array of strings — no markdown fences, no commentary, no object wrapper.'
  ].join('\n')
}

function planPrompt(goal: string, projectName: string): string {
  return `${planRules(projectName)}\n\nGoal: ${goal}`
}

/**
 * Pull a JSON array of strings out of a model reply that was told to send
 * exactly that — and that will, some days, wrap it in fences anyway.
 */
function parseTasks(stdout: string): string[] | null {
  const text = stdout.trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(parsed)) return null
    const tasks = parsed
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim().slice(0, MAX_TASK_TEXT))
      .filter((t) => t.length > 0)
      .slice(0, Math.min(PLAN_MAX_TASKS, MAX_TASK_CARDS))
    return tasks.length > 0 ? tasks : null
  } catch {
    return null
  }
}

/** The Gemini arm: same rules, same JSON contract, over the voice brain's call. */
async function planWithGemini(goal: string, projectName: string, brain: { key: string; model: string }): Promise<TaskPlanResult> {
  const result = await callGemini({
    key: brain.key,
    model: brain.model,
    system: planRules(projectName),
    turns: [{ role: 'user', text: `Goal: ${goal}` }],
    schema: { type: 'ARRAY', items: { type: 'STRING' } },
    timeoutMs: 60_000
  })
  if (!result.ok) return { ok: false, error: result.error }
  const tasks = parseTasks(result.text)
  if (!tasks) return { ok: false, error: 'Gemini answered, but not with a task list — try again' }
  return { ok: true, tasks }
}

export function planTasks(goal: string, projectName: string, cwd: string): Promise<TaskPlanResult> {
  const exe = whichCommand('claude')
  if (!exe) return Promise.resolve({ ok: false, error: 'Claude Code is not on PATH — the planner runs on it' })

  const prompt = planPrompt(goal, projectName)
  const viaCmd = /\.(cmd|bat)$/i.test(exe)
  const file = viaCmd ? (process.env['ComSpec'] ?? 'cmd.exe') : exe
  // The prompt goes down stdin, never onto the command line: it is multi-line,
  // and a newline inside an argument relayed through cmd.exe ends the command
  // at the newline. Headless claude reads a piped prompt by design.
  const args = viaCmd ? ['/d', '/s', '/c', exe, '-p'] : ['-p']

  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      // The project folder as cwd, so the model may lean on CLAUDE.md et al if
      // the CLI chooses to load them — context for free, never required.
      { timeout: PLAN_TIMEOUT_MS, windowsHide: true, cwd, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed
          const detail = killed
            ? 'the planner took too long and was stopped'
            : ((stderr || (err as Error).message || '').trim().split('\n')[0] ?? 'could not run')
          return resolve({ ok: false, error: detail.slice(0, 200) })
        }
        const tasks = parseTasks(`${stdout}`)
        if (!tasks) return resolve({ ok: false, error: 'Claude answered, but not with a task list — try again' })
        resolve({ ok: true, tasks })
      }
    )
    child.stdin?.write(prompt)
    child.stdin?.end()
  })
}

export function registerTaskPlannerHandlers(): void {
  ipcMain.handle(IPC.tasksPlan, (_e, goal: string, projectName: string, cwd: string, brain: TaskPlanBrainRequest) => {
    const g = String(goal).trim()
    if (!g) return { ok: false as const, error: 'Nothing to plan' }
    const name = String(projectName)
    if (brain && brain.kind === 'gemini') {
      const key = typeof brain.key === 'string' ? brain.key.trim() : ''
      const model = typeof brain.model === 'string' ? brain.model.trim() : ''
      if (!key) return { ok: false as const, error: 'No Gemini key — add one in Settings › Models & keys' }
      return planWithGemini(g.slice(0, MAX_TASK_TEXT), name, { key, model })
    }
    return planTasks(g.slice(0, MAX_TASK_TEXT), name, String(cwd))
  })
}
