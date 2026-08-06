import { closeSync, openSync, readSync, statSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

/**
 * Following a JSONL file another process is appending to.
 *
 * This is the machinery the tasks panel has been using since it learned to
 * overhear its planning session, lifted out of electron/planner-watcher.ts
 * unchanged so that the activity tracker can have it too. Nothing here is
 * clever, but every line of it is the answer to something that went wrong once:
 *
 *  - **Byte offsets, not a stream.** The file is opened, read from where the
 *    last read stopped, and closed again. A held handle on a file the CLI may
 *    replace is a handle pointing at a file that no longer exists.
 *  - **A carry buffer of bytes, not text.** A read boundary can land in the
 *    middle of a multi-byte character as easily as in the middle of a line, and
 *    decoding half of one yields a replacement character that no longer parses
 *    as JSON. So partial lines are carried as bytes and decoded once whole.
 *  - **Truncation and replacement.** A file that is now shorter than our offset
 *    is a different file — a fork, a hand-edit, a rotated log. Reading on from
 *    an offset that has come to mean something else is worse than starting over.
 *  - **A read ceiling.** "Whatever is on disk" is not a size this process gets
 *    to choose, and the first read after a watch starts is the whole file.
 *  - **The watch is on the directory.** The file very often does not exist when
 *    the caller asks to follow it, and a watch on a path that is not there is a
 *    watch that never fires.
 *  - **A poll backstop.** It attaches the real watcher once the folder appears,
 *    and carries on slowly in case a handle dies quietly — a folder moved out
 *    from under us, a network path, an OS that dropped the notification.
 *
 * The one thing the second caller needed that the first did not is
 * `initialTailBytes`. The planner reads from zero because it wants the last plan
 * in the file, however far back that is. Activity wants the *recent* past, and a
 * project whose Claude pane has been going all week has a transcript hundreds of
 * megabytes long — read from zero, opening that project would cost four
 * megabytes per pane before the first frame. Seeding the offset near the end and
 * skipping to the first newline costs one read of half a megabyte instead.
 */

/** Coalesce the burst of change events one CLI write produces. */
const SETTLE_MS = 200

/** The backstop tick: attaches a watcher that could not attach, and re-reads. */
const POLL_MS = 1000

/**
 * Read ceiling per drain, and the longest a partial line may grow to before it
 * is treated as junk rather than as something we are waiting to complete.
 */
export const TAIL_MAX_CHUNK = 4 * 1024 * 1024

export interface TailOptions {
  /** Absolute path. It does not have to exist yet. */
  file: string
  /** One complete line, decoded. Never called with a trailing newline. */
  onLine: (line: string) => void
  /**
   * Start this far back from the end of the file instead of at zero, dropping
   * the partial line that lands on. Zero (the default) reads the whole file.
   */
  initialTailBytes?: number
  /** Overridden only by scripts/tail-check.mjs, so the ceiling can be tested cheaply. */
  maxChunk?: number
  /** Prefixes the one error this module ever prints. */
  label?: string
}

export interface Tail {
  /** Attach the watcher, start the backstop, and read what is already there. */
  start(): void
  stop(): void
  /**
   * Read whatever has appeared since the last read, now.
   *
   * The watcher, the backstop and `start` all funnel through this, and it is on
   * the handle rather than hidden so scripts/tail-check.mjs can drive the whole
   * of the interesting behaviour — truncation, the ceiling, the carry, the seed
   * — synchronously, with no timers and no waiting on the filesystem to notice.
   */
  drain(): void
}

type TailState = {
  file: string
  onLine: (line: string) => void
  initialTailBytes: number
  maxChunk: number
  label: string
  watcher: FSWatcher | null
  poll: NodeJS.Timeout | null
  settle: NodeJS.Timeout | null
  stopped: boolean
  /** Bytes already consumed. */
  offset: number
  /** The tail of the last read, up to but not including its newline. */
  carry: Buffer
  /** Has the initial offset been chosen yet? */
  seeded: boolean
  /** The next chunk starts mid-line, so everything before its first newline goes. */
  skipPartial: boolean
}

export function createTail(options: TailOptions): Tail {
  const s: TailState = {
    file: options.file,
    onLine: options.onLine,
    initialTailBytes: Math.max(0, options.initialTailBytes ?? 0),
    maxChunk: Math.max(1, options.maxChunk ?? TAIL_MAX_CHUNK),
    label: options.label ?? 'tail',
    watcher: null,
    poll: null,
    settle: null,
    stopped: false,
    offset: 0,
    carry: Buffer.alloc(0),
    seeded: false,
    skipPartial: false
  }

  return {
    start: () => start(s),
    stop: () => stop(s),
    drain: () => drain(s)
  }
}

/* ------------------------------------------------------------------ reading */

function drain(s: TailState): void {
  let size = 0
  try {
    const stat = statSync(s.file)
    if (!stat.isFile()) return
    size = stat.size
  } catch {
    // Not written yet, or gone. Either way there is nothing to read; the next
    // tick will find it if it appears.
    return
  }

  // Where to begin, decided once. A seek is only worth it when there is
  // genuinely more file than we want — on a short file, skipping to the first
  // newline would throw away its first line for nothing.
  if (!s.seeded) {
    s.seeded = true
    if (s.initialTailBytes > 0 && size > s.initialTailBytes) {
      s.offset = size - s.initialTailBytes
      s.skipPartial = true
    }
  }

  // Truncated or replaced (a fork, a hand-edit): start again rather than read
  // from an offset that now means something else.
  if (size < s.offset) {
    s.offset = 0
    s.carry = Buffer.alloc(0)
    s.skipPartial = false
  }
  if (size === s.offset) return

  // Skipping ahead means landing mid-line, so the first partial line is dropped
  // along with anything carried from before the jump.
  const jumped = size - s.offset > s.maxChunk
  const from = jumped ? size - s.maxChunk : s.offset
  const length = size - from

  let buf: Buffer
  let fd: number | null = null
  try {
    fd = openSync(s.file, 'r')
    buf = Buffer.allocUnsafe(length)
    const read = readSync(fd, buf, 0, length, from)
    if (read < length) buf = buf.subarray(0, read)
    s.offset = from + read
  } catch (err) {
    console.error(`[${s.label}] could not read the transcript:`, err)
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

  const partial = jumped || s.skipPartial
  s.skipPartial = false

  let chunk = partial ? buf : Buffer.concat([s.carry, buf])
  if (partial) {
    const nl = chunk.indexOf(0x0a)
    chunk = nl === -1 ? Buffer.alloc(0) : chunk.subarray(nl + 1)
  }

  let startAt = 0
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] !== 0x0a) continue
    s.onLine(chunk.subarray(startAt, i).toString('utf8'))
    startAt = i + 1
  }
  const tail = chunk.subarray(startAt)
  // A "line" longer than the whole read ceiling is not a line we are waiting to
  // complete, it is junk that would otherwise grow without bound.
  s.carry = tail.length > s.maxChunk ? Buffer.alloc(0) : tail
}

/* ---------------------------------------------------------------- lifecycle */

function schedule(s: TailState): void {
  if (s.settle || s.stopped) return
  s.settle = setTimeout(() => {
    s.settle = null
    if (s.stopped) return
    drain(s)
  }, SETTLE_MS)
}

/**
 * Watch the *folder*, not the file. The transcript often does not exist when a
 * caller asks to follow it — the session has been started but not yet spoken to
 * — and a watch on a path that is not there yet never fires.
 */
function attach(s: TailState): void {
  if (s.watcher || s.stopped) return
  const dir = dirname(s.file)
  const name = basename(s.file)
  try {
    s.watcher = watch(dir, (_event, filename) => {
      // Windows reports the basename; a null filename means "something in here
      // changed", which is worth a look either way.
      if (filename && basename(String(filename)) !== name) return
      schedule(s)
    })
    s.watcher.on('error', () => {
      // The folder went away, or the handle died. Drop it; the tick re-attaches.
      detach(s)
    })
  } catch {
    // The folder is not there yet. The tick will try again.
    s.watcher = null
  }
}

function detach(s: TailState): void {
  try {
    s.watcher?.close()
  } catch {
    /* best effort */
  }
  s.watcher = null
}

function start(s: TailState): void {
  if (s.poll) return
  s.stopped = false
  s.poll = setInterval(() => {
    attach(s)
    schedule(s)
  }, POLL_MS)
  attach(s)
  // Read what is already there, so anything written before the caller asked to
  // follow arrives immediately rather than after the next append.
  drain(s)
}

function stop(s: TailState): void {
  s.stopped = true
  detach(s)
  if (s.poll) clearInterval(s.poll)
  s.poll = null
  if (s.settle) clearTimeout(s.settle)
  s.settle = null
}
