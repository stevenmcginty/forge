import { closeSync, openSync, readSync, statSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { ipcMain, type WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import { isSessionId } from '@shared/session'
import type { PlannerUpdate } from '@shared/types'
import { transcriptPath } from './bridge/claude-transcripts'
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
 */

/** Coalesce the burst of change events one CLI write produces. */
const SETTLE_MS = 200

/**
 * The backstop tick. fs.watch is the fast path, but it cannot watch a directory
 * that does not exist yet — and on the first plan of a fresh project, the
 * transcript folder is created by the CLI moments after the panel asks to
 * watch. This tick attaches the real watcher once the folder appears, and
 * carries on as a slow poll in case a watch handle dies quietly (a folder moved
 * out from under us, a network path, an OS that dropped the notification).
 */
const POLL_MS = 1000

/**
 * Read ceiling per drain. A planner transcript is small, but the first read
 * after a watch starts is the whole file, and "whatever is on disk" is not a
 * size this process gets to choose.
 */
const MAX_CHUNK = 4 * 1024 * 1024

/** The fence the planner session is told to answer in. */
const TASKS_BLOCK = /```tasks[ \t]*\r?\n([\s\S]*?)```/g

type PlannerWatch = {
  projectId: string
  file: string
  target: WebContents
  watcher: FSWatcher | null
  poll: NodeJS.Timeout | null
  settle: NodeJS.Timeout | null
  /** Bytes of the transcript already consumed. */
  offset: number
  /** The tail of the last read, up to but not including its newline. */
  carry: Buffer
  seq: number
  /** The assistant message that produced the last push, so re-reads cannot repeat it. */
  lastUuid: string
}

/** One watch per project — the panel only ever has one planning session open. */
const watches = new Map<string, PlannerWatch>()

/* ------------------------------------------------------------------ reading */

/**
 * Read whatever has been appended since the last drain and hand each complete
 * line on. Lines are carried as bytes rather than text: a read boundary can
 * land in the middle of a multi-byte character as easily as in the middle of a
 * line, and decoding half of one produces a replacement char that no longer
 * parses as JSON.
 */
function drain(w: PlannerWatch): void {
  let size = 0
  try {
    const stat = statSync(w.file)
    if (!stat.isFile()) return
    size = stat.size
  } catch {
    // Not written yet, or gone. Either way there is nothing to read; the next
    // tick will find it if it appears.
    return
  }

  // Truncated or replaced (a fork, a hand-edit): start again rather than read
  // from an offset that now means something else.
  if (size < w.offset) {
    w.offset = 0
    w.carry = Buffer.alloc(0)
  }
  if (size === w.offset) return

  // Skipping ahead means landing mid-line, so the first partial line is dropped
  // along with anything carried from before the jump.
  const jumped = size - w.offset > MAX_CHUNK
  const from = jumped ? size - MAX_CHUNK : w.offset
  const length = size - from

  let buf: Buffer
  let fd: number | null = null
  try {
    fd = openSync(w.file, 'r')
    buf = Buffer.allocUnsafe(length)
    const read = readSync(fd, buf, 0, length, from)
    if (read < length) buf = buf.subarray(0, read)
    w.offset = from + read
  } catch (err) {
    console.error('[planner] could not read the transcript:', err)
    return
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* best effort */
      }
    }
  }

  let chunk = jumped ? buf : Buffer.concat([w.carry, buf])
  if (jumped) {
    const nl = chunk.indexOf(0x0a)
    chunk = nl === -1 ? Buffer.alloc(0) : chunk.subarray(nl + 1)
  }

  let start = 0
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] !== 0x0a) continue
    handleLine(w, chunk.subarray(start, i).toString('utf8'))
    start = i + 1
  }
  const tail = chunk.subarray(start)
  // A "line" longer than the whole read ceiling is not a line we are waiting to
  // complete, it is junk that would otherwise grow without bound.
  w.carry = tail.length > MAX_CHUNK ? Buffer.alloc(0) : tail
}

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
  // and neither is something the model said to the user.
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

function schedule(w: PlannerWatch): void {
  if (w.settle) return
  w.settle = setTimeout(() => {
    w.settle = null
    if (watches.get(w.projectId) !== w) return
    drain(w)
  }, SETTLE_MS)
}

/**
 * Watch the *folder*, not the file: the transcript often does not exist when
 * the panel asks to watch (the session has been started but not yet spoken to),
 * and a watch on a path that is not there yet is a watch that never fires.
 */
function attach(w: PlannerWatch): void {
  if (w.watcher) return
  const dir = dirname(w.file)
  const name = basename(w.file)
  try {
    w.watcher = watch(dir, (_event, filename) => {
      // Windows reports the basename; a null filename means "something in here
      // changed", which is worth a look either way.
      if (filename && basename(String(filename)) !== name) return
      schedule(w)
    })
    w.watcher.on('error', () => {
      // The folder went away, or the handle died. Drop it; the tick re-attaches.
      detach(w)
    })
  } catch {
    // The folder is not there yet. The tick will try again.
    w.watcher = null
  }
}

function detach(w: PlannerWatch): void {
  try {
    w.watcher?.close()
  } catch {
    /* best effort */
  }
  w.watcher = null
}

function stop(w: PlannerWatch): void {
  detach(w)
  if (w.poll) clearInterval(w.poll)
  w.poll = null
  if (w.settle) clearTimeout(w.settle)
  w.settle = null
}

function unwatch(projectId: string): void {
  const w = watches.get(projectId)
  if (!w) return
  watches.delete(projectId)
  stop(w)
}

function start(projectId: string, cwd: string, sessionId: string, target: WebContents): void {
  // A second watch for the same panel replaces the first — the session id
  // changes when the user starts a new plan, and two tails on one project would
  // race their sequence numbers.
  unwatch(projectId)

  const w: PlannerWatch = {
    projectId,
    file: transcriptPath(cwd, sessionId),
    target,
    watcher: null,
    poll: null,
    settle: null,
    offset: 0,
    carry: Buffer.alloc(0),
    seq: 0,
    lastUuid: ''
  }
  watches.set(projectId, w)
  w.poll = setInterval(() => {
    attach(w)
    schedule(w)
  }, POLL_MS)
  attach(w)
  // Read what is already there, so a plan the session produced before the panel
  // was opened (or before Forge was restarted) arrives immediately.
  drain(w)

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
  for (const w of watches.values()) stop(w)
  watches.clear()
}
