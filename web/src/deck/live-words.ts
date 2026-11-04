import type { LiveJob } from '@shared/live'

/**
 * Claude Live in Forge Web, the pure half (./liveVoice.ts is the rest): how a
 * reply is cut into clauses to speak, the acks, and which jobs are cards. No
 * React, no DOM, so scripts/realtime-check.mjs can hold them.
 */

/** Longest run allowed to wait for a clause or a full stop (src/lib/tts.ts SPEAK_CHUNK_MAX's role). */
const CHUNK_MAX = 220
/** A first chunk cut at a clause has at least this many words (src/lib/tts.ts FIRST_CLAUSE_MIN_WORDS). */
const FIRST_CLAUSE_MIN_WORDS = 4
/** The spoken acks (src/lib/tts.ts ACK_LINES; that module reaches for the desktop's preload). */
export const LIVE_ACK_LINES: readonly string[] = ['Okay.', 'Sure.', 'One sec.', 'Let me check.']

const SENTENCE_END = /[.!?]["')\]]?(?=\s)/
const CLAUSE_END = /(?:[,;:]|\s[—–-])(?=\s)/g

function clauseCut(text: string, limit: number): number {
  CLAUSE_END.lastIndex = 0
  for (let m = CLAUSE_END.exec(text); m; m = CLAUSE_END.exec(text)) {
    const end = m.index + m[0].length
    if (limit >= 0 && end >= limit) return -1
    const words = text.slice(0, end).split(/\s+/).filter((w) => /\w/.test(w)).length
    if (words >= FIRST_CLAUSE_MIN_WORDS) return end
  }
  return -1
}

/**
 * The finished chunks at the front of a growing reply, and the rest to keep:
 * src/lib/tts.ts's `takeSpeechChunks` with `firstClause`, restated (that
 * module cannot be built into this page). With `firstClause` the first chunk
 * may end at a clause of four words or more, so Kokoro starts before the
 * full stop is written; every later chunk is a sentence.
 */
export function takeClauses(buffer: string, firstClause: boolean, max: number = CHUNK_MAX): { chunks: string[]; rest: string } {
  const chunks: string[] = []
  let rest = buffer
  for (;;) {
    const hit = SENTENCE_END.exec(rest)
    let cut = hit ? hit.index + hit[0].length : -1
    if (firstClause && chunks.length === 0) {
      const clause = clauseCut(rest, cut)
      if (clause > 0 && clause <= max) cut = clause
    }
    if (cut < 0) {
      if (rest.length <= max) break
      const window = rest.slice(0, max)
      const soft = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' '))
      cut = soft > 0 ? soft + 1 : max
    }
    const head = rest.slice(0, cut).trim()
    rest = rest.slice(cut)
    if (head) chunks.push(head)
  }
  return { chunks, rest }
}

/** A finished job stays a card this long after it last moved. */
export const LIVE_CARD_DONE_MS = 30 * 60_000

/** Which jobs are cards, in order: needs-you (newest first), then done and failed of the last half hour. */
export function liveCardsOf(jobs: readonly LiveJob[], now: number, hidden: ReadonlySet<string> = new Set()): LiveJob[] {
  const key = (j: LiveJob): string => `${j.id}:${j.updatedAt}`
  const needs = jobs.filter((j) => j.state === 'needs-you' && !hidden.has(key(j)))
  const done = jobs.filter(
    (j) => (j.state === 'done' || j.state === 'failed') && now - j.updatedAt <= LIVE_CARD_DONE_MS && !hidden.has(key(j))
  )
  const newest = (a: LiveJob, b: LiveJob): number => b.updatedAt - a.updatedAt
  return [...needs.sort(newest), ...done.sort(newest)]
}
