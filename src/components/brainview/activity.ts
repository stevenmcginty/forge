import type { ActivityState } from '@/lib/paneActivity'
import { terminalHost } from '@/lib/terminals'

/**
 * What each agent on the map is doing, sampled — and the moments it changes,
 * which is what the map's pulses are made of.
 *
 * The same facts and the same rules as src/lib/paneActivity.ts (busy and
 * attention from terminalHost, "done" after a long stretch of work goes quiet),
 * kept here rather than borrowed because that module only updates while its
 * own hook is mounted somewhere, and the map needs the transitions themselves,
 * not just the current word.
 */

export interface Transition {
  paneId: string
  from: ActivityState
  to: ActivityState
}

export interface Sampled {
  state: ActivityState
  /** Epoch ms the current state began. */
  since: number
}

const DONE_HOLD_MS = 6000
const DONE_MIN_WORK_MS = 8000

interface Track {
  busy: boolean
  attention: boolean
  busySince: number
  quietSince: number
  doneUntil: number
  state: ActivityState
  since: number
}

export class ActivityTracker {
  private tracks = new Map<string, Track>()

  /** Sample every pane; return the ones whose state moved since last time. */
  sample(paneIds: Iterable<string>, now: number): Transition[] {
    const out: Transition[] = []
    const seen = new Set<string>()
    for (const paneId of paneIds) {
      seen.add(paneId)
      const status = terminalHost.runtime(paneId).status
      const busy = terminalHost.isBusy(paneId)
      const attention = terminalHost.isAttention(paneId)
      let t = this.tracks.get(paneId)
      if (!t) {
        t = { busy, attention, busySince: busy ? now : 0, quietSince: now, doneUntil: 0, state: 'dormant', since: now }
        this.tracks.set(paneId, t)
        t.state = this.stateOf(t, status, now)
        continue
      }
      if (busy && !t.busy) t.busySince = now
      if (!busy && t.busy) {
        t.quietSince = now
        if (!attention && now - t.busySince >= DONE_MIN_WORK_MS) t.doneUntil = now + DONE_HOLD_MS
      }
      if (attention && !t.attention) t.quietSince = now
      t.busy = busy
      t.attention = attention
      const next = this.stateOf(t, status, now)
      if (next !== t.state) {
        out.push({ paneId, from: t.state, to: next })
        t.state = next
        t.since = next === 'working' ? t.busySince || now : now
      }
    }
    for (const id of [...this.tracks.keys()]) if (!seen.has(id)) this.tracks.delete(id)
    return out
  }

  get(paneId: string): Sampled {
    const t = this.tracks.get(paneId)
    return t ? { state: t.state, since: t.since } : { state: 'dormant', since: Date.now() }
  }

  private stateOf(t: Track, status: string, now: number): ActivityState {
    if (status === 'error') return 'failed'
    if (status === 'exited') return 'exited'
    if (status === 'idle') return 'dormant'
    if (status === 'starting') return 'starting'
    if (t.busy) return 'working'
    if (t.attention) return 'attention'
    if (t.doneUntil > now) return 'done'
    return 'idle'
  }
}

/**
 * The last thing an agent said, as a line or two for the hover card: its
 * screen's tail with the furniture taken out — blank rows, box-drawing rules,
 * the composer's frame and hints. Honest about what it is: text off the
 * screen, not a summary.
 */
export function lastLines(paneId: string, want = 2): string[] {
  const text = terminalHost.snapshotText(paneId, 40)
  if (!text) return []
  const lines = text.split('\n')
  const keep: string[] = []
  for (let i = lines.length - 1; i >= 0 && keep.length < want; i--) {
    const raw = lines[i]!.replace(/\s+/g, ' ').trim()
    if (raw.length < 3) continue
    const boxy = (raw.match(/[─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║╔╗╚╝▔▁▏▕░▒▓█]/g) ?? []).length
    if (boxy / raw.length > 0.3) continue
    const inner = raw.replace(/^[│┃║>❯›$#]\s*/, '').replace(/\s*[│┃║]$/, '').trim()
    if (inner.length < 3) continue
    if (/^\?\s*for shortcuts|^esc to interrupt|shift\+tab to cycle|^PS [A-Z]:\\/i.test(inner)) continue
    keep.unshift(inner.length > 140 ? `${inner.slice(0, 139)}…` : inner)
  }
  return keep
}
