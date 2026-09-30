import type { ChatBlock, ChatTurn } from '@shared/chat'
import type { BrainSend } from './brainStore'

/**
 * The brain's transcript, cut into what the drop-down draws:
 *
 *   mine    Steve's message: a bubble on the right, two ticks (it is in the
 *           transcript, so the brain has it).
 *   note    a line Forge typed in for the brain (`[Forge] …` — a pane
 *           finished, a pane needs Steve): a small centred notice, not a
 *           bubble, because Steve did not say it.
 *   reply   everything the brain said between two prompts, one bubble on
 *           the left: its words, and the tools it used as one quiet line.
 *   send    a message from this window the transcript has not shown yet.
 */

type TextBlock = Extract<ChatBlock, { kind: 'text' }>
export type ToolBlock = Extract<ChatBlock, { kind: 'tool' }>

export type ReplyPiece = { kind: 'text'; key: string; text: string } | { kind: 'tools'; key: string; tools: ToolBlock[] }

export type BrainRow =
  | { kind: 'mine'; key: string; text: string; at: number; clock?: string }
  | { kind: 'note'; key: string; text: string; at: number }
  | { kind: 'reply'; key: string; at: number; clock?: string; pieces: ReplyPiece[]; text: string }
  | { kind: 'send'; key: string; send: BrainSend }

const NOTE = /^\s*\[Forge\]\s*/

function textOf(turn: ChatTurn): string {
  return turn.blocks
    .filter((b): b is TextBlock => b.kind === 'text')
    .map((b) => b.text)
    .join('\n\n')
    .trim()
}

export function toRows(turns: ChatTurn[], sends: BrainSend[]): BrainRow[] {
  const rows: BrainRow[] = []
  for (const turn of turns) {
    if (turn.role === 'user') {
      const text = textOf(turn)
      if (!text) continue
      if (NOTE.test(text)) rows.push({ kind: 'note', key: turn.id, text: text.replace(NOTE, ''), at: turn.at })
      else rows.push({ kind: 'mine', key: turn.id, text, at: turn.at, clock: turn.clock })
      continue
    }
    if (!turn.blocks.some((b) => b.kind === 'text' || b.kind === 'tool')) continue
    let reply = rows[rows.length - 1]
    if (!reply || reply.kind !== 'reply') {
      reply = { kind: 'reply', key: turn.id, at: turn.at, clock: turn.clock, pieces: [], text: '' }
      rows.push(reply)
    }
    if (turn.at) reply.at = turn.at
    if (turn.clock) reply.clock = turn.clock
    turn.blocks.forEach((block, i) => {
      const key = `${turn.id}:${i}`
      if (block.kind === 'text') {
        if (!block.text.trim()) return
        reply.pieces.push({ kind: 'text', key, text: block.text })
        reply.text = reply.text ? `${reply.text}\n\n${block.text}` : block.text
      } else if (block.kind === 'tool') {
        const last = reply.pieces[reply.pieces.length - 1]
        if (last && last.kind === 'tools') last.tools.push(block)
        else reply.pieces.push({ kind: 'tools', key, tools: [block] })
      }
    })
  }
  for (const send of sends) rows.push({ kind: 'send', key: `send-${send.id}`, send })
  return rows
}

/**
 * The brain's answer to the last prompt with these words, once it has one:
 * every reply row after that prompt, as one text. Null while there is none.
 */
export function replyTo(rows: BrainRow[], words: string): { key: string; text: string } | null {
  const want = words.replace(/\s+/g, ' ').trim()
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (row.kind !== 'mine') continue
    const said = row.text.replace(/\s+/g, ' ').trim()
    if (said !== want && !(Math.min(said.length, want.length) >= 24 && (said.startsWith(want) || want.startsWith(said)))) continue
    const after = rows.slice(i + 1).filter((r): r is Extract<BrainRow, { kind: 'reply' }> => r.kind === 'reply' && !!r.text)
    if (!after.length) return null
    return { key: after[after.length - 1]!.key, text: after.map((r) => r.text).join('\n\n') }
  }
  return null
}

/** A tool's name as a person reads it: `mcp__forge__open_agent_pane` → "open agent pane". */
export function toolWords(name: string): string {
  return name
    .replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
}

export function timeOf(at: number, clock?: string): string {
  if (clock) return clock
  if (!at) return ''
  try {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}
