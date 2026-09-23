/**
 * The carry-over for a rolled-over realtime session.
 *
 * OpenAI cuts a session at 60 minutes and nothing crosses a reconnect on its
 * side, so the new session is started with a short text account of the old
 * one — his words, the replies, and what was done — seeded into its
 * instructions. Kept small on purpose: every character here is re-read on
 * every turn of the next hour, and the conversation that matters is the
 * recent end, so it is cut from the front.
 *
 * Pure, so scripts/realtime-check.mjs holds it to that.
 */

export interface SummaryCaption {
  role: 'user' | 'assistant'
  text: string
  final: boolean
}

export interface SummaryAction {
  label: string
  status: 'running' | 'ok' | 'failed' | 'planned'
}

export const ROLLOVER_SUMMARY_MAX_CHARS = 2400
const LINE_MAX_CHARS = 300
const MAX_ACTIONS = 8

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function buildRolloverSummary(
  captions: SummaryCaption[],
  actions: SummaryAction[],
  opts: { maxChars?: number; appState?: string } = {}
): string {
  const max = opts.maxChars ?? ROLLOVER_SUMMARY_MAX_CHARS

  const done = actions
    .filter((a) => a.status !== 'running' && a.label.trim())
    .slice(-MAX_ACTIONS)
    .map((a) => `- ${a.status === 'failed' ? 'FAILED: ' : a.status === 'planned' ? 'PLANNED, NOT RUN: ' : ''}${clip(a.label, 160)}`)
  const doneBlock = done.length ? `Recently done:\n${done.join('\n')}` : ''

  const state = (opts.appState ?? '').trim()
  const stateBlock = state ? `Forge at the handover (call get_app_state for the current picture):\n${clip(state, 600)}` : ''

  const tail = [doneBlock, stateBlock].filter(Boolean).join('\n\n')
  const budget = Math.max(0, max - tail.length - 2)

  // Newest first until the budget is spent, then put back in order.
  const lines: string[] = []
  let used = 0
  for (let i = captions.length - 1; i >= 0; i--) {
    const c = captions[i]!
    if (!c.final || !c.text.trim()) continue
    const line = `${c.role === 'user' ? 'Steve' : 'You'}: ${clip(c.text, LINE_MAX_CHARS)}`
    if (used + line.length + 1 > budget) break
    lines.push(line)
    used += line.length + 1
  }
  lines.reverse()

  const talk = lines.length ? `Conversation:\n${lines.join('\n')}` : ''
  const out = [talk, tail].filter(Boolean).join('\n\n')
  return out.length > max ? out.slice(out.length - max) : out
}
