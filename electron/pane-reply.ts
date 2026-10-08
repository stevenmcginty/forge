import { open, stat } from 'node:fs/promises'
import type { Workspace } from '@shared/types'
import { findLeaf } from '@shared/splitTree'
import { transcriptPath } from './bridge/claude-transcripts'

/**
 * What a Claude pane last said, read off the end of its session JSONL.
 *
 * Lifted out of electron/brain/host.ts and electron/brain/home.ts so two
 * readers share one: Forge Brain's "a pane you opened has stopped" note, and
 * the mini bar's Peek (`panes:lastReply`, docs/MINI-BAR.md 4.10). Async, so a
 * Peek on a pane with a 50 MB transcript never stalls the main process; the
 * read is still capped at the last 512 KB.
 *
 * No Electron import and no store import: brain/home.ts re-exports `paneWords`,
 * and its check script loads that file head-less. The caller hands in the
 * projects to look through.
 */

/** How much of a pane's transcript end is read. */
export const PANE_TAIL_BYTES = 512 * 1024

/** Where a pane may live: a project's folder and its saved layout. */
export interface PanePlace {
  path: string
  workspace: Workspace | null
}

/** A Claude pane's transcript, from the saved layout that holds the pane: the project's folder and the leaf's session. */
export async function paneTranscript(paneId: string, places: Iterable<PanePlace>): Promise<string | null> {
  for (const place of places) {
    for (const tab of place.workspace?.tabs ?? []) {
      const leaf = findLeaf(tab.root, paneId)
      if (!leaf) continue
      if (!leaf.sessionId) return null
      const file = transcriptPath(place.path, leaf.sessionId)
      try {
        return (await stat(file)).isFile() ? file : null
      } catch {
        return null
      }
    }
  }
  return null
}

/** The last `bytes` of a file as text, or '' when it cannot be read. */
export async function readTail(file: string, bytes: number = PANE_TAIL_BYTES): Promise<string> {
  try {
    const handle = await open(file, 'r')
    try {
      const size = (await handle.stat()).size
      const length = Math.min(size, bytes)
      const chunk = Buffer.alloc(length)
      await handle.read(chunk, 0, length, size - length)
      return chunk.toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

/** What a Claude pane's transcript says about its stop. */
export interface PaneWords {
  /** Its last reply's text, or ''. */
  lastWords: string
  /** Background agents it started that have not reported back. */
  agents: number
}

/**
 * A Claude pane's last words and its background agents still out, from the end
 * of its transcript (`body`: the tail, whose first line may be cut in half).
 * An agent started in the background is a tool result marked
 * `async_launched`; it is over once a `<task-notification>` names its id
 * (record shapes read from Claude Code 2.1.287 transcripts).
 */
export function paneWords(body: string): PaneWords {
  let lastWords = ''
  const launched = new Set<string>()
  const over = new Set<string>()
  for (const line of body.split('\n')) {
    let record: {
      type?: unknown
      isSidechain?: unknown
      message?: { content?: unknown }
      toolUseResult?: { status?: unknown; agentId?: unknown }
    } | null
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!record || typeof record !== 'object' || record.isSidechain === true) continue
    const content = record.message?.content
    if (record.type === 'assistant') {
      const blocks = Array.isArray(content) ? (content as Array<{ type?: unknown; text?: unknown }>) : []
      const text = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => String(b.text).trim())
        .filter(Boolean)
        .join(' ')
      if (text) lastWords = text
      continue
    }
    if (record.type !== 'user') continue
    const launch = record.toolUseResult
    if (launch?.status === 'async_launched' && typeof launch.agentId === 'string') launched.add(launch.agentId)
    if (typeof content === 'string' && content.startsWith('<task-notification>')) {
      const id = /<task-id>([^<]+)<\/task-id>/.exec(content)?.[1]
      if (id) over.add(id)
    }
  }
  return { lastWords, agents: [...launched].filter((id) => !over.has(id)).length }
}

/**
 * A Claude pane's last reply and when its transcript was last written. Null
 * for a pane with no transcript (any agent that is not Claude, a plain shell)
 * and for one that has not replied yet.
 */
export async function lastReply(paneId: string, places: Iterable<PanePlace>): Promise<{ text: string; at: number } | null> {
  const file = await paneTranscript(paneId, places)
  if (!file) return null
  const [body, info] = await Promise.all([readTail(file), stat(file).catch(() => null)])
  const text = paneWords(body).lastWords
  if (!text) return null
  return { text, at: info ? Math.round(info.mtimeMs) : Date.now() }
}
