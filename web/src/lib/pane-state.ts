import { useEffect, useState, useSyncExternalStore } from 'react'
import { STATE_WORD, useAgentState, type DeckAgentState } from '../deck/agents'
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
  const agent = useAgentState(paneId)
  // A pane that finished while you were not looking says Done until you have.
  const unseen = useDoneUnseen(paneId ? [paneId] : NO_PANES)
  const { state, word, detail } =
    unseen && agent.state === 'idle' ? { state: 'done' as const, word: STATE_WORD.done, detail: DONE_UNSEEN_TITLE } : agent
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

/* ------------------------------------------------------------ done, unseen
 *
 * The status row's "Done" lasts six seconds (lib/pane-status.ts), which is
 * right for the pane you are watching and useless for one you are not: a tab
 * in the background, or the whole phone in a pocket, finishes and nobody ever
 * sees the word. So a pane that stops working while it is not on screen — or
 * while the phone is hidden — is marked "done, unseen" and keeps the mark until
 * it has been on screen, visible, for the same six seconds.
 *
 * Driven by the desktop's `busy` frames, the one working signal the phone gets
 * for every pane, not only the one on screen. A stretch shorter than the
 * desktop's eight seconds finishing is not news (src/lib/paneActivity.ts), and
 * nothing is judged while the link is down, when `busy` is only stale.
 */

/** A stretch shorter than this finishing is not news (lib/pane-status.ts, the desktop's number). */
const DONE_MIN_WORK_MS = 8000
/** How long a finished pane says Done once you are looking at it. */
const SEEN_HOLD_MS = 6000
const DONE_UNSEEN_TITLE = 'Finished while you were not looking'

const NO_PANES: readonly string[] = []
/** When each pane was first seen working, by the busy frames. */
const workedSince = new Map<string, number>()
/** Done, unseen: pane id → when it was first seen on screen since, or 0 while it has not been. */
const unseen = new Map<string, number>()
const unseenListeners = new Set<() => void>()
let seenTimer: number | undefined

function emitUnseen(): void {
  for (const listener of unseenListeners) listener()
}

/** Drop the marks that have been looked at for long enough, and wake again for the next. */
function expireSeen(at: number): boolean {
  let changed = false
  let next = Infinity
  for (const [id, seenAt] of unseen) {
    if (!seenAt) continue
    if (at - seenAt >= SEEN_HOLD_MS) {
      unseen.delete(id)
      changed = true
    } else next = Math.min(next, seenAt + SEEN_HOLD_MS - at)
  }
  if (seenTimer !== undefined) window.clearTimeout(seenTimer)
  seenTimer =
    next === Infinity
      ? undefined
      : window.setTimeout(() => {
          seenTimer = undefined
          if (expireSeen(Date.now())) emitUnseen()
        }, next + 30)
  return changed
}

function observeDone(busy: ReadonlySet<string>, live: boolean, onScreen: string | null, visible: boolean, at: number): void {
  let changed = false
  if (live) {
    for (const id of busy) {
      if (!workedSince.has(id)) workedSince.set(id, at)
      // Working again: whatever it finished before is old news.
      if (unseen.delete(id)) changed = true
    }
    for (const [id, since] of workedSince) {
      if (busy.has(id)) continue
      workedSince.delete(id)
      // The pane you are watching has the status row's own Done.
      if (at - since >= DONE_MIN_WORK_MS && !(visible && id === onScreen)) {
        unseen.set(id, 0)
        changed = true
      }
    }
  }
  for (const [id, seenAt] of unseen) {
    const shown = visible && id === onScreen
    if (shown && !seenAt) unseen.set(id, at)
    else if (!shown && seenAt) {
      // Looked at, then left: seen.
      unseen.delete(id)
      changed = true
    }
  }
  if (expireSeen(at)) changed = true
  if (changed) emitUnseen()
}

/**
 * Keeps the "done, unseen" marks. Mounted once, where the phone knows which
 * pane is on screen (the tab strip): `onScreen` is the active tab's pane.
 */
export function useTrackDone(onScreen: string | null): void {
  const forge = useForgeOptional()?.state ?? null
  const busy = forge?.busy ?? NO_BUSY
  const live = !!forge && forge.stage.kind === 'connected' && forge.connection.state === 'live'
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  useEffect(() => {
    const onChange = (): void => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  useEffect(() => {
    observeDone(busy, live, onScreen, visible, Date.now())
  }, [busy, live, onScreen, visible])
}

function subscribeUnseen(listener: () => void): () => void {
  unseenListeners.add(listener)
  return () => {
    unseenListeners.delete(listener)
  }
}

/** Whether any of these panes finished while nobody was looking, and has not been looked at since. */
export function useDoneUnseen(paneIds: readonly string[]): boolean {
  return useSyncExternalStore(
    subscribeUnseen,
    () => paneIds.some((id) => unseen.has(id)),
    () => false
  )
}
