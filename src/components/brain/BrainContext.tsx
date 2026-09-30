import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { BRAIN_CONTEXT_WARN_PCT } from '@shared/brain'
import { usePaneUsage } from '@/lib/paneUsage'
import { usePresence } from '@/lib/motion'
import { useAppSelector } from '@/state/AppState'
import { freshStartBrain, useBrain } from './brainStore'
import './Brain.css'

/**
 * How full Forge Brain's context window is, wherever the brain is drawn: the
 * top bar's icon, the map's centre and the voice bar's chip while Forge Brain
 * is the voice agent. Steve does not want the brain's CLI running its context
 * up unseen.
 *
 * The number is the pane's own usage frame (src/lib/paneUsage.ts), the same
 * one every agent pane's bar reads: for Claude, what Claude Code hands its
 * statusLine command. No frame yet, or an engine that reports none: "?", never 0.
 *
 * Past `Settings.brainContextWarnPct` the ring becomes a warning triangle —
 * a shape of its own, apart from the round "!" of a question waiting — and
 * `BrainContextNotice` says so once per conversation, with a Fresh start.
 * Always the % in words beside the shape: never colour alone.
 */

export interface BrainContextView {
  /** The brain is on and has a pane: there is something to show. */
  shown: boolean
  /** Whole percent of the context window in use, or null when not known. */
  pct: number | null
  /** At or past the warning line. */
  over: boolean
  /** The warning line, in percent. */
  limit: number
}

export function useBrainContext(): BrainContextView {
  const { status } = useBrain()
  const limit = useAppSelector((s) => s.settings.brainContextWarnPct) ?? BRAIN_CONTEXT_WARN_PCT
  const paneId = status?.enabled ? status.paneId : null
  const usage = usePaneUsage(paneId)
  const raw = usage?.context?.usedPct
  const pct = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : null
  return { shown: paneId !== null, pct, over: pct !== null && pct >= limit, limit }
}

/** The view in words, for a title or an accessible name. */
export function contextWords(view: BrainContextView): string {
  if (view.pct === null) return 'context use not known yet'
  return view.over ? `context ${view.pct}% full, past ${view.limit}%` : `context ${view.pct}% full`
}

/** A ring filling with the context in use; a dashed ring when it is not known. */
function Ring({ pct }: { pct: number | null }): ReactNode {
  return (
    <svg className="bctx__shape" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <circle className="bctx__track" cx="6" cy="6" r="4.5" data-unknown={pct === null ? 'true' : undefined} />
      {pct !== null && pct > 0 ? (
        <circle
          className="bctx__fill"
          cx="6"
          cy="6"
          r="4.5"
          pathLength={100}
          strokeDasharray={`${pct} 100`}
          transform="rotate(-90 6 6)"
        />
      ) : null}
    </svg>
  )
}

/** Past the line: a warning triangle, never round like the question badge. */
export function WarnShape(): ReactNode {
  return (
    <svg className="bctx__shape" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path className="bctx__warn" d="M6 1.2 11 10.4H1Z" />
      <path className="bctx__warn-mark" d="M6 4.6v2.6M6 8.7v.1" />
    </svg>
  )
}

/** The ring (or triangle) and the % in words. Nothing while the brain is off. */
export function ContextRing({ view }: { view: BrainContextView }): ReactNode {
  if (!view.shown) return null
  return (
    <span className="bctx" data-over={view.over ? 'true' : undefined} title={`Forge Brain: ${contextWords(view)}`}>
      {view.over ? <WarnShape /> : <Ring pct={view.pct} />}
      <span className="bctx__pct">{view.pct === null ? '?' : `${view.pct}%`}</span>
    </span>
  )
}

/** Conversations already told, for the life of the window: once per crossing, not every turn. */
const told = new Set<string>()

/** A notice that is not acted on goes by itself after this long; the icon keeps the triangle. */
const NOTICE_MS = 30_000

/**
 * The one notice per conversation: the brain's context is past the line, with
 * a Fresh start (the brain writes HANDOFF.md; its pane restarts on a new
 * conversation that reads it first). Mounted once, by the top bar's icon, and
 * drawn as the app's own notice tile (DeckToast's `.dtoast`).
 */
export function BrainContextNotice(): ReactNode {
  const view = useBrainContext()
  const { status } = useBrain()
  const conversation = status?.enabled ? (status.sessionId ?? status.paneId) : null
  const [open, setOpen] = useState<{ pct: number } | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!conversation || !view.over || view.pct === null || told.has(conversation)) return
    told.add(conversation)
    setError(null)
    setOpen({ pct: view.pct })
  }, [conversation, view.over, view.pct])

  // Goes by itself, unless a fresh start is running or it has something to say.
  useEffect(() => {
    if (!open || working || error) return undefined
    const t = window.setTimeout(() => setOpen(null), NOTICE_MS)
    return () => window.clearTimeout(t)
  }, [open, working, error])

  const { mounted, closing } = usePresence(open !== null, 200)
  const [shown, setShown] = useState(open)
  useEffect(() => {
    if (open) setShown(open)
  }, [open])

  const fresh = async (): Promise<void> => {
    setWorking(true)
    setError(null)
    const why = await freshStartBrain()
    setWorking(false)
    if (why) setError(why)
    else setOpen(null)
  }

  if (!mounted || !shown) return null
  // To the body: the top bar's glass would otherwise hold a fixed tile inside it.
  return createPortal(
    <div className="dtoast bctx-toast" data-state={closing ? 'closing' : 'open'} role="status" aria-live="polite">
      <span className="bctx-toast__mark" aria-hidden="true">
        <WarnShape />
      </span>
      <span className="bctx-toast__text">
        {working
          ? 'Forge Brain is writing its handoff, then starting fresh…'
          : error
            ? `× Fresh start did not finish: ${error}`
            : `Forge Brain's context is ${shown.pct}% full (your line is ${view.limit}%).`}
      </span>
      <button type="button" className="bctx-toast__btn" disabled={working} onClick={() => void fresh()}>
        Fresh start
      </button>
      <button
        type="button"
        className="bctx-toast__close"
        aria-label="Not now"
        title="Not now"
        disabled={working}
        onClick={() => setOpen(null)}
      >
        ×
      </button>
    </div>,
    document.body
  )
}
