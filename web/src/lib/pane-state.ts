import { useEffect, useState } from 'react'
import { useAgentState, type DeckAgentState } from '../deck/agents'
import { useForgeOptional } from '../state'

/**
 * A pane's state for the phone's status line: the deck's word and shape for
 * it (deck/agents.tsx `useAgentState`, itself the desktop StateChip's
 * vocabulary) plus, while it works, for how long — "Working 12m", the way the
 * desktop's pane header says it (src/lib/paneActivity.ts).
 *
 * The clock runs from the moment this phone saw the pane start working: the
 * desktop's `busy` frames (sustained output, the same fact the desktop's own
 * clock is kept on), or the pane's own screen if that said so first. A pane
 * already working when the link came up counts from then; the phone cannot
 * know any earlier.
 */

const busySince = new Map<string, number>()
const NO_BUSY: Set<string> = new Set()

/**
 * Every pane the desktop says is working, stamped the first time it is seen
 * so; `keep` is the pane on screen while its own screen says it works, which
 * holds its stamp even between the desktop's frames.
 */
function syncBusy(busy: Set<string>, keep: string | null, at: number): void {
  for (const id of busy) if (!busySince.has(id)) busySince.set(id, at)
  if (keep && !busySince.has(keep)) busySince.set(keep, at)
  for (const id of busySince.keys()) if (!busy.has(id) && id !== keep) busySince.delete(id)
}

/** "40s", "12m", "1h 04m"; nothing under five seconds. src/lib/paneActivity.ts `formatElapsed`. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 5) return ''
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

/** The desktop's heartbeat for a minutes-resolution clock (src/lib/paneActivity.ts). */
const TICK_MS = 15_000

export interface PhonePaneState {
  state: DeckAgentState
  word: string
  detail: string
  /** "12m" while working, else ''. */
  clock: string
}

export function usePhonePaneState(paneId: string | null): PhonePaneState {
  const forge = useForgeOptional()?.state ?? null
  const { state, word, detail } = useAgentState(paneId)
  const working = state === 'working'
  const [now, setNow] = useState(() => Date.now())

  const keep = working ? paneId : null
  useEffect(() => {
    syncBusy(forge?.busy ?? NO_BUSY, keep, Date.now())
  }, [forge?.busy, keep])

  // The clock ticks only while the pane on screen is working; idle, nothing runs.
  useEffect(() => {
    if (!keep) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now())
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [keep])

  const since = keep ? busySince.get(keep) : undefined
  const clock = since !== undefined ? formatElapsed(Math.max(0, now - since)) : ''
  return { state, word, detail: clock ? `Working for ${clock}` : detail, clock }
}
