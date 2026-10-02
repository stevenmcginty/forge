import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AgentProfile } from '@shared/types'
import { AgentBadge } from '@/components/AgentBadge'
import { badgeColor, isShellProfile } from '@/lib/agents'
import { STATE_WORD, type DeckAgentState } from '../deck/agents'
import { useBackClose } from '../lib/back-stack'
import { useScreenPane } from '../lib/pane-screen'
import { usePhonePaneState, type PhonePaneState } from '../lib/pane-state'
import { usePaneStatus } from '../lib/pane-status'
import { usageLevel, usePaneUsage } from '../lib/usage'
import { useForge } from '../state'
import { CONDITION, PaneDetails, placeOf, Ring, StateMark, stateSaid } from './StatusLine'
import './ContextChip.css'

/**
 * The pane's context read-out, always on show in the phone's top bar: a small
 * capsule beside the link dot and "⋯" — the context ring with the state's
 * shape in its hole, and how full the window is in plain figures. It follows
 * the tab on screen, so the number changes as the tabs do.
 *
 * Tapped, a panel drops from under the bar (not a bottom sheet: it belongs to
 * the chip it hangs from) with what the pane's sheet holds — the state and its
 * clock, the context window, the plan limits, Copy screen and the raw footer.
 * Out by an outside tap, Back, Esc, or the chip again.
 *
 * Never colour alone: the number is always there, warn (80%) turns it heavy
 * and tints the capsule, full (92%) fills the capsule solid; the panel says
 * the level in words. No reading yet, or a shell, is a dash in the same slot,
 * so the bar never jumps between tabs.
 */

/** How long the panel takes to go before it unmounts. Matches the exit in ContextChip.css. */
const EXIT_MS = 200

/** The panel's gap under the bar and in from the screen edge. */
const DROP_GAP_PX = 6
const EDGE_PX = 8

interface Placement {
  /** The bar's bottom edge, where the scrim starts. */
  bar: number
  /** Distance from the panel's right edge to the chip's centre: the drop grows from there. */
  originRight: number
  maxHeight: number
}

export function ContextChip({ paneId, profile }: { paneId: string | null; profile: AgentProfile | null }): ReactNode {
  const { state } = useForge()
  const screen = useScreenPane()
  const shell = !!profile && isShellProfile(profile)
  const status = usePaneStatus(paneId)
  const usage = usePaneUsage(shell ? null : paneId, shell ? undefined : status)
  const agent = usePhonePaneState(shell ? null : paneId)
  const offline = state.stage.kind === 'offline'
  const live = !offline && state.connection.state === 'live'
  // A shell has no screen the phone reads a state from, but the desktop's busy
  // frames still say whether it is printing (the status line's own rule).
  const shellState: DeckAgentState = offline
    ? 'frozen'
    : !live
      ? 'reconnecting'
      : paneId && state.busy.has(paneId)
        ? 'working'
        : 'idle'
  const pane: PhonePaneState = shell
    ? { state: shellState, word: STATE_WORD[shellState], detail: STATE_WORD[shellState], clock: '' }
    : agent
  const context = shell ? null : usage.context
  const level = context ? usageLevel(context.usedPct) : null
  const onScreen = screen && screen.paneId === paneId ? screen : null
  const condition = onScreen?.condition ?? null
  const accent = profile ? badgeColor(profile) : undefined
  const usable = !!paneId && !!profile

  /* ------------------------------------------------------------ the drop */
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [shown, setShown] = useState(false)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const chipRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const scrimRef = useRef<HTMLDivElement | null>(null)
  const scrimArmed = useRef(false)
  const panelId = useId()

  const close = useCallback(() => setOpen(false), [])

  // Android Back closes the drop, as it closes a sheet.
  useBackClose(open, close)

  // No pane to read (the tab closed under it): nothing to hang a panel from.
  useEffect(() => {
    if (!usable) setOpen(false)
  }, [usable])

  useEffect(() => {
    if (open) {
      setMounted(true)
      // Two frames: mount at the resting (folded) shape, then drop.
      let second = 0
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setShown(true))
      })
      return () => {
        cancelAnimationFrame(first)
        cancelAnimationFrame(second)
      }
    }
    setShown(false)
    const timer = window.setTimeout(() => setMounted(false), EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  const measure = useCallback(() => {
    const chip = chipRef.current
    if (!chip) return
    const bar = (chip.closest('.ptop') ?? chip).getBoundingClientRect().bottom
    const rect = chip.getBoundingClientRect()
    const width = document.documentElement.clientWidth
    const height = window.visualViewport?.height ?? window.innerHeight
    setPlacement({
      bar,
      originRight: Math.max(24, width - EDGE_PX - (rect.left + rect.width / 2)),
      maxHeight: Math.max(160, height - bar - DROP_GAP_PX - EDGE_PX)
    })
  }, [])

  // Measured before the first paint of the panel, and again on a rotate.
  useLayoutEffect(() => {
    if (mounted) measure()
  }, [mounted, measure])

  useEffect(() => {
    if (!open) return undefined
    // A press anywhere outside — the bar's other buttons included — closes it.
    // The scrim closes on its own click instead, so the lift that follows
    // lands on the scrim and not on whatever was under it.
    const onDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target) || chipRef.current?.contains(target) || scrimRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setOpen(false)
      chipRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('resize', measure)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('resize', measure)
    }
  }, [open, measure])

  // Focus into the panel once it is down, for a keyboard and a screen reader.
  useLayoutEffect(() => {
    if (shown) panelRef.current?.focus({ preventScroll: true })
  }, [shown])

  const said = stateSaid(pane)
  const label = !usable
    ? 'No pane open'
    : context
      ? `Context ${context.usedPct}% used${level === 'calm' ? '' : level === 'warn' ? ', getting full' : ', nearly full'}. ${said}. Details`
      : shell
        ? `${profile?.name ?? 'Shell'}: ${said}. Details`
        : `No context reading yet. ${said}. Details`

  const where = placeOf(status)
  const appLayer =
    typeof document === 'undefined' ? null : ((document.querySelector('.app[data-shell="app"]') as HTMLElement | null) ?? document.body)

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="pctx"
        data-level={level ?? 'none'}
        data-state={pane.state}
        data-open={open ? 'true' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        title={usable ? pane.detail : undefined}
        disabled={!usable}
        onClick={() => setOpen((v) => !v)}
        data-testid="phone-context"
        style={accent ? ({ '--pane-accent': accent } as CSSProperties) : undefined}
      >
        <span className="pctx__face">
          <span className="pctx__ring">
            <Ring pct={context?.usedPct ?? 0} size={22} stroke={2.5} />
            <StateMark state={pane.state} paneId={paneId} />
          </span>
          {context ? (
            <span className="pctx__num">
              {context.usedPct}
              <span className="pctx__unit">%</span>
            </span>
          ) : (
            <span className="pctx__num pctx__num--none" aria-hidden="true">
              –
            </span>
          )}
        </span>
      </button>

      {mounted && profile && appLayer
        ? createPortal(
            <div
              className="pctx-layer"
              data-state={shown ? 'open' : 'closed'}
              data-testid="context-panel-layer"
              style={placement ? ({ '--pctx-bar': `${placement.bar}px` } as CSSProperties) : undefined}
            >
              <div
                ref={scrimRef}
                className="pctx-scrim"
                aria-hidden="true"
                onPointerDown={() => {
                  scrimArmed.current = true
                }}
                onClick={() => {
                  if (scrimArmed.current) close()
                  scrimArmed.current = false
                }}
              />
              <div
                ref={panelRef}
                id={panelId}
                className="pctx-panel"
                role="dialog"
                aria-label={`${profile.name}: context and limits`}
                tabIndex={-1}
                data-testid="context-panel"
                style={
                  {
                    '--pane-accent': accent,
                    maxHeight: placement ? `${placement.maxHeight}px` : undefined,
                    transformOrigin: placement ? `calc(100% - ${placement.originRight}px) 0` : undefined
                  } as CSSProperties
                }
              >
                <div className="pctx-head">
                  <AgentBadge profile={profile} size="sm" />
                  <span className="pctx-head__text">
                    <span className="pctx-head__name">{profile.name}</span>
                    {where ? <span className="pctx-head__place mono">{where}</span> : null}
                  </span>
                  <span className="pctx-state" data-state={pane.state}>
                    <StateMark state={pane.state} paneId={paneId} />
                    <span className="pctx-state__word">{pane.word}</span>
                    {pane.clock ? <span className="pctx-state__clock">{pane.clock}</span> : null}
                  </span>
                </div>
                {condition ? (
                  <p className="pctx-note" data-condition={condition}>
                    <span className="pctx-note__mark" aria-hidden="true">
                      {CONDITION[condition].mark}
                    </span>
                    <span>{CONDITION[condition].title}.</span>
                  </p>
                ) : shell ? (
                  <p className="pctx-note">A shell has no context window to read.</p>
                ) : !context ? (
                  <p className="pctx-note">No context reading yet. It shows once the agent draws its status line.</p>
                ) : null}
                <div className="pctx-body">
                  <PaneDetails
                    usage={shell ? { context: null, limits: null } : usage}
                    footer={status?.footer ?? []}
                    screen={onScreen}
                    onDone={close}
                    levelWord
                  />
                </div>
              </div>
            </div>,
            appLayer
          )
        : null}
    </>
  )
}
