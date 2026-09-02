import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import {
  capHandoffBody,
  emptyHandoff,
  formatHandoff,
  handoffFileName,
  handoffTemplate,
  isHandoffId,
  newHandoffId,
  parseHandoff
} from '@shared/handoff'
import { tidyTitle } from '@shared/share'
import type { HandoffBody, HandoffRecord, HandoffStartRequest, HandoffStatus } from '@shared/types'

/**
 * The handoff packs on disk, and the two things this module refuses to do:
 * **write outside `<project>\.forge\handoff`, and rewrite a body it is only
 * meant to be re-heading.**
 *
 *   <project>\.forge\handoff\20260902-141233-9f0a.md   one pack
 *
 * Inside the project, beside `.forge\share`, and for the same reason: the whole
 * feature is an agent reading and writing the pack with the file tools it already
 * has, and `.forge/handoff/<id>.md` is a relative path inside its own workspace —
 * no permission prompt, no sandbox argument, no absolute path pasted into a
 * prompt. `.forge/` is already in this clone's `.git/info/exclude` (ShareStore
 * puts it there), so nothing here is committed.
 *
 * Deliberately free of any `electron` import — it is handed a project path rather
 * than reaching for one, which is what lets scripts/handoff-check.mjs drive the
 * real module against `mkdtempSync()` instead of a copy. The `ipcMain` half, the
 * watcher and the debouncing all live in electron/handoff-watcher.ts, and the
 * format lives in shared/handoff.ts.
 *
 * Nothing here throws at the caller. A pack that cannot be read is a pack that is
 * not in the list; the worst case is a row that is missing, which is where the
 * feature started.
 */

/** `<project>\.forge\handoff` — the only directory this module ever writes in. */
export function handoffDir(projectPath: string): string {
  return join(resolve(String(projectPath ?? '')), '.forge', 'handoff')
}

/**
 * Is the directory we are about to write in genuinely inside the project?
 *
 * The belt to `isHandoffId`'s braces. `join` cannot escape a project from a
 * literal `.forge/handoff`, but the project path itself arrives from main's own
 * list, and a store that writes outside the folder it was named for is the one
 * failure worth an explicit refusal rather than a comment.
 */
function inProject(projectPath: string): boolean {
  const base = resolve(String(projectPath ?? ''))
  if (!base) return false
  const dir = resolve(handoffDir(base))
  return dir !== base && (dir + sep).startsWith(base + sep)
}

/** The path of one pack, or null for anything that is not an id. */
export function handoffPath(projectPath: string, id: string): string | null {
  if (!isHandoffId(id) || !inProject(projectPath)) return null
  return join(handoffDir(projectPath), handoffFileName(id))
}

/* ------------------------------------------------------------------- write */

/** Temp file then rename, so a reader never sees half a pack. Same as ShareStore. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/**
 * Create a pack: the header Forge knows, and the template the agent fills.
 *
 * The file exists before the prompt is typed, which is the whole sequencing of
 * the feature — the prompt names a path that is already there, so an agent never
 * has to decide where to put anything, and the watcher has something to watch
 * from the first moment.
 */
export function startHandoff(
  projectPath: string,
  req: HandoffStartRequest,
  now: number = Date.now()
): HandoffRecord | null {
  if (!inProject(projectPath)) return null

  const id = newHandoffId(now)
  const path = handoffPath(projectPath, id)
  if (!path) return null

  const title = tidyTitle(req?.title ?? '') || 'Untitled'
  const body = handoffTemplate(title)
  const record: HandoffRecord = {
    ...emptyHandoff(id, now),
    title,
    status: 'open',
    from: String(req?.from ?? ''),
    fromAgent: String(req?.fromAgent ?? ''),
    fromTitle: String(req?.fromTitle ?? ''),
    to: String(req?.to ?? ''),
    toAgent: String(req?.toAgent ?? ''),
    toTitle: String(req?.toTitle ?? ''),
    origin: String(req?.origin ?? ''),
    transcript: String(req?.transcript ?? '')
  }

  try {
    mkdirSync(handoffDir(projectPath), { recursive: true })
    writeAtomic(path, formatHandoff(record, body))
  } catch (err) {
    console.error(`[handoff] could not write ${path}:`, err)
    return null
  }

  return readHandoff(projectPath, id)?.record ?? null
}

/**
 * Rewrite the header, and only the header.
 *
 * The body is read and written back byte for byte, because it is the agent's
 * work and Forge marking a pack `taken` must not so much as re-wrap it. That is
 * also why this takes a patch of exactly four fields: everything else in the
 * header is decided once, at creation.
 */
export function markHandoff(
  projectPath: string,
  id: string,
  patch: Partial<Pick<HandoffRecord, 'status' | 'to' | 'toAgent' | 'toTitle'>>,
  now: number = Date.now()
): HandoffRecord | null {
  const path = handoffPath(projectPath, id)
  if (!path) return null
  // The *raw* body, not the capped one: `markHandoff` re-heads a file and must
  // leave its body byte-identical, and a pack over the cap is still the agent's
  // work rather than something to trim on its way past.
  const current = readRaw(projectPath, id)
  if (!current) return null

  const status: HandoffStatus = patch?.status ?? current.record.status
  const next: HandoffRecord = {
    ...current.record,
    status,
    to: patch?.to ?? current.record.to,
    toAgent: patch?.toAgent ?? current.record.toAgent,
    toTitle: patch?.toTitle ?? current.record.toTitle,
    updatedAt: now
  }

  try {
    writeAtomic(path, formatHandoff(next, current.body))
  } catch (err) {
    console.error(`[handoff] could not update ${path}:`, err)
    return null
  }

  return readHandoff(projectPath, id)?.record ?? null
}

/* -------------------------------------------------------------------- read */

/**
 * One pack, header and body. Null when there is no file, and equally when there
 * is one that cannot be read — a caller opening a pack wants "there is nothing
 * here", and there is no second place for the reason to go.
 *
 * `capBody` is applied to what comes back rather than to what is on disk: the cap
 * bounds what Forge structured-clones and pastes into a prompt, and truncating
 * somebody's file because it was read would be a read with a side effect.
 */
export function readHandoff(projectPath: string, id: string): HandoffBody | null {
  const raw = readRaw(projectPath, id)
  if (!raw) return null
  return { record: raw.record, body: capHandoffBody(raw.body) }
}

/** The file exactly as it is. The only reader that does not cap. */
function readRaw(projectPath: string, id: string): HandoffBody | null {
  const path = handoffPath(projectPath, id)
  if (!path || !existsSync(path)) return null
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return null
    return parseHandoff(id, readFileSync(path, 'utf8'), stat.mtimeMs)
  } catch {
    return null
  }
}

/**
 * Every pack in the project, newest first.
 *
 * The directory listing *is* the index — ids sort chronologically by
 * construction, so "newest first" is a reversed sort of the filenames with
 * `updatedAt` as the tie-break for a pack somebody hand-edited. Files whose name
 * is not an id are somebody else's and are skipped rather than repaired.
 */
export function listHandoffs(projectPath: string): HandoffRecord[] {
  const dir = handoffDir(projectPath)
  if (!inProject(projectPath) || !existsSync(dir)) return []

  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  const records: HandoffRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const id = name.slice(0, -3)
    if (!isHandoffId(id)) continue
    // The raw reader: a list wants headers, and capping a body it is about to
    // throw away is work for nothing.
    const read = readRaw(projectPath, id)
    if (read) records.push(read.record)
  }

  return records.sort((a, b) => (b.id < a.id ? -1 : b.id > a.id ? 1 : b.updatedAt - a.updatedAt))
}
