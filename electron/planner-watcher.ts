import { ipcMain, type WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import { isSessionId } from '@shared/session'
import type { PlannerUpdate } from '@shared/types'
import { transcriptPath } from './bridge/claude-transcripts'
import { createTail, type Tail } from './jsonl-tail'
import { parsePlan } from './task-planner'

/**
 * The tasks panel's eyes on its own planning session.
 *
 * The panel is a real, visible `claude` pane, not a hidden one-shot call (that
 * is the old tray's brain — electron/task-planner.ts). So Forge cannot read the
 * model's answer out of a pipe: the answer goes to a terminal the user is
 * watching. What it *can* read is the transcript Claude Code keeps for every
 * session at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, which is
 * exactly the file resume-on-restore already depends on.
 *
 * So the deal with the model is a fence. A plan reply ends with
 *
 *   ```tasks
 *   {"plan": "…", "tasks": ["…", "…"]}
 *   ```
 *
 * and this module tails the transcript, pulls the last such block out of each
 * new assistant message, and pushes it at the window that asked. The pane stays
 * a conversation the user can argue with; the panel just overhears it.
 *
 * Nothing here starts, prompts or kills a terminal, and nothing here writes.
 *
 * **The tailing lives elsewhere.** Byte offsets, the carry buffer, truncation
 * detection, the read ceiling, the directory watch and the poll backstop are all
 * in electron/jsonl-tail.ts now — the activity tracker follows the same files
 * for a different reason, and two copies of that would have been two places to
 * fix the next time one of them turned out to be subtly wrong. What is left here
 * is the only part that was ever about planning: the fence, and what to do with
 * what is inside it.
 */

/** The fence the planner session is told to answer in. */
const TASKS_BLOCK = /```tasks[ \t]*\r?\n([\s\S]*?)```/g

type PlannerWatch = {
  projectId: string
  target: WebContents
  tail: Tail
  seq: number
  /** The assistant message that produced the last push, so re-reads cannot repeat it. */
  lastUuid: string
}

/** One watch per project — the panel only ever has one planning session open. */
const watches = new Map<string, PlannerWatch>()

/* ------------------------------------------------------------------ reading */

/** One content part of an assistant message, if it is one the user was shown. */
function textOf(part: unknown): string {
  if (!part || typeof part !== 'object') return ''
  const p = part as { type?: unknown; text?: unknown }
  return p.type === 'text' && typeof p.text === 'string' ? p.text : ''
}

/**
 * One transcript line. Every failure here is swallowed on purpose: the file is
 * appended to by another process while we read it, and it carries a dozen
 * record types this feature knows nothing about. A line we cannot use is not an
 * error, it is the normal case.
 */
function handleLine(w: PlannerWatch, line: string): void {
  const text = line.trim()
  if (!text) return

  let entry: unknown
  try {
    entry = JSON.parse(text)
  } catch {
    return
  }
  if (!entry || typeof entry !== 'object') return

  const record = entry as { type?: unknown; uuid?: unknown; message?: { content?: unknown } }
  if (record.type !== 'assistant') return

  const parts = record.message?.content
  if (!Array.isArray(parts)) return
  // Text parts only: the same message can carry `thinking` and `tool_use` parts,
  // and neither is something the model said to the user. The `tool_use` parts
  // skipped here are exactly what the activity tracker reads instead — see
  // toolUseEntries in shared/activity.ts, driven from electron/activity-watcher.ts.
  const said = parts
    .map(textOf)
    .filter((t) => t.length > 0)
    .join('\n')
  if (!said) return

  // The last block, not the first: a reply that talks through two attempts ends
  // on the one it means.
  let block: string | null = null
  for (const match of said.matchAll(TASKS_BLOCK)) block = match[1] ?? null
  if (block === null) return

  const parsed = parsePlan(block)
  if (!parsed) return

  const uuid = typeof record.uuid === 'string' ? record.uuid : ''
  if (uuid && uuid === w.lastUuid) return
  w.lastUuid = uuid

  w.seq += 1
  const update: PlannerUpdate = {
    projectId: w.projectId,
    plan: parsed.plan,
    tasks: parsed.tasks,
    seq: w.seq
  }
  if (!w.target.isDestroyed()) w.target.send(IPC.plannerUpdate, update)
}

/* ---------------------------------------------------------------- lifecycle */

function unwatch(projectId: string): void {
  const w = watches.get(projectId)
  if (!w) return
  watches.delete(projectId)
  w.tail.stop()
}

function start(projectId: string, cwd: string, sessionId: string, target: WebContents): void {
  // A second watch for the same panel replaces the first — the session id
  // changes when the user starts a new plan, and two tails on one project would
  // race their sequence numbers.
  unwatch(projectId)

  const w: PlannerWatch = {
    projectId,
    target,
    // From offset zero, deliberately: the panel wants the *last* plan in the
    // file however far back it is, so unlike the activity tracker this one has
    // no interest in seeking near the end.
    tail: createTail({
      file: transcriptPath(cwd, sessionId),
      label: 'planner',
      onLine: (line) => handleLine(w, line)
    }),
    seq: 0,
    lastUuid: ''
  }
  watches.set(projectId, w)
  // Reads what is already there before it returns, so a plan the session
  // produced before the panel was opened (or before Forge was restarted)
  // arrives immediately.
  w.tail.start()

  // A reloaded or closed window is a watch nobody will ever unwatch.
  target.once('destroyed', () => {
    if (watches.get(projectId) === w) unwatch(projectId)
  })
}

export function registerPlannerWatcherHandlers(): void {
  ipcMain.handle(IPC.plannerWatch, (event, req: { projectId?: unknown; cwd?: unknown; sessionId?: unknown }) => {
    const projectId = typeof req?.projectId === 'string' ? req.projectId.trim() : ''
    const cwd = typeof req?.cwd === 'string' ? req.cwd.trim() : ''
    const sessionId = typeof req?.sessionId === 'string' ? req.sessionId.trim() : ''
    if (!projectId) return { ok: false, error: 'No project to watch' }
    if (!cwd) return { ok: false, error: 'No project folder to watch' }
    // The id is what names the file on disk. Anything that is not a real UUID
    // could not be a transcript Claude Code wrote, so it is refused rather than
    // turned into a path.
    if (!isSessionId(sessionId)) return { ok: false, error: 'Not a Claude session id' }

    start(projectId, cwd, sessionId, event.sender)
    return { ok: true }
  })

  ipcMain.on(IPC.plannerUnwatch, (_e, projectId: string) => unwatch(String(projectId ?? '').trim()))
}

export function disposePlannerWatchers(): void {
  for (const w of watches.values()) w.tail.stop()
  watches.clear()
}
