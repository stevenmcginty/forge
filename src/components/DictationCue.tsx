import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { paneNameInTab } from '@shared/workspace'
import { hotkeyLabel } from '@/hooks/useDictation'
import {
  barDictationSink,
  clearKeyDictationPressed,
  useBarDictationPhase,
  useDictationReview,
  useKeyDictationPressedAt
} from '@/lib/barDictation'
import { resolveInsertTarget, type InsertTarget } from '@/lib/dictation'
import { setPaneSentSender } from '@/lib/paneSent'
import { usePresence } from '@/lib/motion'
import { useActiveTab, useAppSelector } from '@/state/AppState'
import { useDictation } from '@/state/Dictation'
import { listenState, useHubView } from './hub/hubView'
import { CueStrip, PaneCue, type CueModel, type CuePhase } from './DictationCueView'

/**
 * Where the Dictate key's words are going, made impossible to miss.
 *
 * The status bar's pill was the only sign a dictation was running, and it is
 * too small to notice from the chair. This lights the place the words will
 * land — the same place useDictation's engine types them (resolveInsertTarget:
 * the focused terminal, else the bar or another text box, else the pane last
 * active) — and says the state there in words:
 *
 *   a pane on screen   its whole edge rings, and a strip under its header
 *   the bar            the whole voice bar tints and says it (Composer, via
 *                      useBarCue) — the bar's own mic button, always, and the
 *                      key when the bar's box has focus
 *   anywhere else      a band across the top of the stage (a text box, the
 *                      clipboard, a pane that is not on screen)
 *
 * From the press ("Getting the mic ready…", before the sidecar answers)
 * through listening and finishing, and for a pane the bar's "Sending in 1.5 s"
 * countdown after (the bar shows its own). Never while the agent has the mic.
 *
 * `DictationCueHost` runs once (App) and decides; each pane and Wall tile
 * mounts `DictationCue`, which draws only when it is the one chosen.
 */

export type CueWhere = { kind: 'pane'; paneId: string } | { kind: 'bar' } | { kind: 'window' }

interface Cue {
  where: CueWhere
  model: CueModel
}

/* ----------------------------------------------------------------- stores */

let current: Cue | null = null
let micLevel = 0
const cueListeners = new Set<() => void>()

function subscribeCue(fn: () => void): () => void {
  cueListeners.add(fn)
  return () => {
    cueListeners.delete(fn)
  }
}

function publishCue(next: Cue | null): void {
  if (next === current) return
  current = next
  cueListeners.forEach((fn) => fn())
}

/** The synthesizer's feed: the sidecar's mic level, read in its own rAF loop. */
export function readCueLevels(): { mic: number; out: number } {
  return { mic: micLevel, out: 0 }
}

/** Panes and tiles on screen that can show the cue — a target not among them gets the band. */
const cuePanes = new Map<string, number>()
let cuePanesVersion = 0
const paneListeners = new Set<() => void>()

function subscribePanes(fn: () => void): () => void {
  paneListeners.add(fn)
  return () => {
    paneListeners.delete(fn)
  }
}

function registerCuePane(paneId: string): () => void {
  cuePanes.set(paneId, (cuePanes.get(paneId) ?? 0) + 1)
  cuePanesVersion++
  paneListeners.forEach((fn) => fn())
  return () => {
    const n = (cuePanes.get(paneId) ?? 1) - 1
    if (n > 0) cuePanes.set(paneId, n)
    else cuePanes.delete(paneId)
    cuePanesVersion++
    paneListeners.forEach((fn) => fn())
  }
}

/** Keep the last cue drawn while it plays out. */
function useShown(cue: Cue | null, exitMs = 170): { shown: Cue | null; closing: boolean } {
  const { mounted, closing } = usePresence(cue !== null, exitMs)
  const last = useRef<Cue | null>(cue)
  if (cue) last.current = cue
  return { shown: mounted ? last.current : null, closing }
}

/* ------------------------------------------------------------ in a pane */

/** Mounted inside every terminal pane and Wall tile; draws when the words are going there. */
export function DictationCue({ paneId }: { paneId: string }): ReactNode {
  useEffect(() => registerCuePane(paneId), [paneId])
  const cue = useSyncExternalStore(subscribeCue, () =>
    current && current.where.kind === 'pane' && current.where.paneId === paneId ? current : null
  )
  const { shown, closing } = useShown(cue)
  if (!shown) return null
  return <PaneCue cue={shown.model} closing={closing} readLevels={readCueLevels} />
}

/** The bar's dictation cue, for Composer: null unless the bar is the one showing it. */
export function useBarCue(): CueModel | null {
  return useSyncExternalStore(subscribeCue, () => (current && current.where.kind === 'bar' ? current.model : null))
}

/** The voice bar, mounted and laid out (top bar or bottom dock): while it is, it is the only cue. */
function barOnScreen(): boolean {
  if (!barDictationSink()) return false
  const el = document.querySelector<HTMLElement>('.dock__composer.comp')
  return !!el && el.getClientRects().length > 0
}

/* ----------------------------------------------------------------- the host */

/** How long a press waits for the mic before the cue gives up on it. */
const PRESS_WAIT_MS = 20_000

export function DictationCueHost(): ReactNode {
  const { status } = useDictation()
  const agentListening = useAppSelector((s) => s.agentListening)
  const sttHotkey = useAppSelector((s) => s.settings.sttHotkey)
  const autoSend = useAppSelector((s) => s.settings.dictateAutoSend)
  const tab = useActiveTab()
  const hubOn = listenState(useHubView()).on
  const barPhase = useBarDictationPhase()
  const review = useDictationReview()
  const pressedAt = useKeyDictationPressedAt()
  useSyncExternalStore(subscribePanes, () => cuePanesVersion)
  const [, onFocusMoved] = useReducer((n: number) => n + 1, 0)

  const phase = status.phase
  useEffect(() => {
    micLevel = status.level
  }, [status.level])

  // The press is answered once the mic opens, fails, or never does.
  useEffect(() => {
    if (phase === 'listening' || phase === 'finishing' || phase === 'error') clearKeyDictationPressed()
  }, [phase])
  useEffect(() => {
    if (pressedAt === null) return undefined
    const t = window.setTimeout(clearKeyDictationPressed, PRESS_WAIT_MS)
    return () => window.clearTimeout(t)
  }, [pressedAt])

  // Never the agent's microphone. The bar's mic button: from its press, in the bar.
  const agentOwnsMic = agentListening || hubOn
  const barMic = !agentOwnsMic && barPhase !== 'off'
  let cuePhase: CuePhase | null = null
  if (barMic) {
    cuePhase = barPhase === 'armed' ? 'starting' : phase === 'listening' ? 'listening' : 'finishing'
  } else if (!agentOwnsMic) {
    if (phase === 'listening') cuePhase = 'listening'
    else if (phase === 'finishing') cuePhase = 'finishing'
    else if (pressedAt !== null && phase !== 'error') cuePhase = 'starting'
  }

  /* Where the words go: the engine's own rule, re-read as focus moves. */
  const activePaneId = tab?.activePaneId ?? null
  const remembered = useRef<InsertTarget>({ kind: 'none' })
  useEffect(() => {
    if (pressedAt !== null) remembered.current = resolveInsertTarget(activePaneId)
    // Captured at the press, as the engine does; the pane changing later is read live below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pressedAt])

  const dictating = cuePhase !== null

  // The "sent" flash on a pane (lib/paneSent): the agent's colour when he has
  // the mic, dictation's otherwise, and none while a dictation still listens —
  // the bar's edge is the one cue until the mic shuts. Read on each send, from refs.
  const senderRef = useRef<'agent' | 'dictation' | null>('dictation')
  senderRef.current = agentOwnsMic ? 'agent' : cuePhase === 'listening' || cuePhase === 'starting' ? null : 'dictation'
  useEffect(() => setPaneSentSender(() => senderRef.current), [])
  useEffect(() => {
    if (!dictating) return undefined
    const moved = (): void => onFocusMoved()
    document.addEventListener('focusin', moved)
    document.addEventListener('focusout', moved)
    return () => {
      document.removeEventListener('focusin', moved)
      document.removeEventListener('focusout', moved)
    }
  }, [dictating])

  const nameOf = (paneId: string): string => (tab ? paneNameInTab(tab, paneId) : 'the pane')

  /*
   * One cue at a time. While the voice bar is on screen it is the cue for every
   * dictation — its own mic button's and the key's alike — and says where the
   * words go; the pane frame and strip, and the band, are only for when there is
   * no bar to show it (they used to both show, which doubled it).
   */
  const bar = barOnScreen()
  let dictWhere = ''
  let into: string | null = null
  if (barMic) dictWhere = 'bar'
  else if (dictating) {
    let target = resolveInsertTarget(activePaneId)
    if (target.kind === 'none') target = remembered.current
    if (target.kind === 'terminal') {
      into = `into ${nameOf(target.paneId)}`
      dictWhere = bar ? 'bar' : cuePanes.has(target.paneId) ? `pane:${target.paneId}` : 'window'
      if (dictWhere.startsWith('pane:')) into = null
    } else if (target.kind === 'field') {
      const intoBar = bar && barDictationSink()?.ownsField(target.el)
      into = intoBar ? null : 'into this text box'
      dictWhere = bar ? 'bar' : 'window'
    } else {
      into = 'to the clipboard'
      dictWhere = bar ? 'bar' : 'window'
    }
  }

  /* The send countdown for a pane, when there is no bar: the bar shows its own. */
  let whereKey = dictWhere
  let endsAt: number | null = null
  if (!dictating && !bar && review && review.paneId !== null) {
    whereKey = cuePanes.has(review.paneId) ? `pane:${review.paneId}` : 'window'
    if (whereKey === 'window') into = `into ${nameOf(review.paneId)}`
    cuePhase = 'sending'
    endsAt = review.endsAt
  }

  const keyLabel = sttHotkey ? hotkeyLabel(sttHotkey) : ''
  // The bar's mic always ends in the bar's send; the key's unless Enter already follows each phrase.
  const sends = barMic || !autoSend
  const cue = useMemo<Cue | null>(() => {
    if (!cuePhase || !whereKey) return null
    const where: CueWhere = whereKey.startsWith('pane:')
      ? { kind: 'pane', paneId: whereKey.slice(5) }
      : whereKey === 'bar'
        ? { kind: 'bar' }
        : { kind: 'window' }
    return { where, model: { phase: cuePhase, keyLabel, sends, endsAt, into } }
  }, [cuePhase, whereKey, keyLabel, sends, endsAt, into])

  useEffect(() => publishCue(cue), [cue])
  useEffect(() => () => publishCue(null), [])

  // The pane and the bar draw themselves; only the band is drawn here.
  const band = cue && cue.where.kind === 'window' ? cue : null
  const { shown, closing } = useShown(band)
  if (!shown) return null
  return <WindowStrip model={shown.model} closing={closing} />
}

/* ------------------------------------------------------ away from a pane */

/** A band across the top of the stage. */
function WindowStrip({ model, closing }: { model: CueModel; closing: boolean }): ReactNode {
  const [top, setTop] = useState<number | null>(null)
  useLayoutEffect(() => {
    const measure = (): void => {
      const stage = document.querySelector<HTMLElement>('.deck__stage')
      setTop(stage ? Math.max(0, stage.getBoundingClientRect().top) : 38)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  if (top === null) return null
  return (
    <div className="dcue-window" data-closing={closing ? 'true' : undefined} style={{ top }}>
      <CueStrip cue={model} readLevels={readCueLevels} />
    </div>
  )
}
