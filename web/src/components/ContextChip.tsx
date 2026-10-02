import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AgentProfile } from '@shared/types'
import { AgentBadge } from '@/components/AgentBadge'
import { badgeColor, isShellProfile } from '@/lib/agents'
import { STATE_WORD, type DeckAgentState } from '../deck/agents'
import { useBackClose } from '../lib/back-stack'
import { useScreenPane } from '../lib/pane-screen'
import { usePhonePaneState, type PhonePaneState } from '../lib/pane-state'
import { usePaneSetup, type PaneSetup } from '../lib/pane-setup'
import { usePaneStatus } from '../lib/pane-status'
import { usageLevel, usePaneUsage } from '../lib/usage'
import { useForge } from '../state'
import { SetupPicks } from './ModelChip'
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
 *
 * Beside the number, the permission mode as a shape: a solid warning triangle
 * for Bypass (the capsule's rim goes red round it), Claude's own two bars for
 * Plan and chevron pair for Accept edits, nothing for Default. Under it, in
 * small print, the model, and the effort picked from this phone as a five-step
 * meter (Low one bar, Max all five) — the bar is a phone's, and a word would
 * cost the project name its room. The panel opens on the three pickers that
 * change them (ModelChip's SetupPicks, through the same senders and the same
 * pick store as the drawer's pill), above the context and the limits.
 */

/** The effort's step on the chip's meter. */
const EFFORT_STEP: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }

type ModeMark = 'bypass' | 'plan' | 'edits' | 'auto' | null

interface SetupRead {
  model: string | null
  /** The effort in words, for the label; its step, for the meter. */
  effort: string | null
  step: number
  /** The mode in words, for the label. */
  mode: string | null
  mark: ModeMark
}

/** What the chip's small print says about a pane's setup. */
function setupRead(setup: PaneSetup): SetupRead {
  const model = setup.modelId ? (setup.roster.find((m) => m.id === setup.modelId)?.label ?? null) : null
  const spec = setup.currentModeId ? (setup.ladder.find((m) => m.id === setup.currentModeId) ?? null) : null
  const mark: ModeMark =
    spec?.danger === true
      ? 'bypass'
      : setup.currentModeId === 'plan'
        ? 'plan'
        : setup.currentModeId === 'acceptEdits'
          ? 'edits'
          : setup.rung === 'auto'
            ? 'auto'
            : null
  return {
    model: model ?? setup.modelText ?? null,
    effort: setup.effortId ? (setup.levels.find((l) => l.id === setup.effortId)?.label ?? null) : null,
    step: setup.effortId ? (EFFORT_STEP[setup.effortId] ?? 0) : 0,
    mode: spec?.label ?? setup.modeText ?? null,
    mark
  }
}

/** The effort as five rising bars, the ones up to its step filled. Shape and fill, no hue. */
function EffortMeter({ step }: { step: number }): ReactNode {
  return (
    <svg className="pctx__meter" width="14" height="10" viewBox="0 0 14 10" aria-hidden="true" focusable="false">
      {[0, 1, 2, 3, 4].map((i) => (
        <rect
          key={i}
          x={i * 2.9}
          y={8 - i * 2}
          width="2"
          height={2 + i * 2}
          rx="0.6"
          fill="currentColor"
          opacity={i < step ? 1 : 0.28}
        />
      ))}
    </svg>
  )
}

/**
 * The mode's shape, beside the number. Bypass's is the warning triangle, drawn solid with the "!" cut out of it: at this size the sheet's
 * outlined WarnMark is a hairline, and this one has to be seen at arm's length.
 */
function ModeGlyph({ mark }: { mark: ModeMark }): ReactNode {
  if (mark === null) return null
  if (mark === 'bypass')
    return (
      <svg className="pctx__glyph" width="13" height="12" viewBox="0 0 13 12" aria-hidden="true" focusable="false">
        <path
          fillRule="evenodd"
          fill="currentColor"
          d="M5.63.98a1 1 0 0 1 1.74 0l5.27 9.27A1 1 0 0 1 11.77 11.75H1.23A1 1 0 0 1 .36 10.25ZM5.75 4.1h1.5v3.6h-1.5Zm.75 4.5a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7Z"
        />
      </svg>
    )
  return (
    <svg className="pctx__glyph" width="9" height="9" viewBox="0 0 9 9" aria-hidden="true" focusable="false">
      {mark === 'plan' ? (
        <>
          <rect x="1.4" y="1" width="2.1" height="7" rx="0.6" fill="currentColor" />
          <rect x="5.5" y="1" width="2.1" height="7" rx="0.6" fill="currentColor" />
        </>
      ) : mark === 'edits' ? (
        <path
          d="M1 1.2 4 4.5 1 7.8M4.8 1.2l3 3.3-3 3.3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <circle cx="4.5" cy="4.5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      )}
    </svg>
  )
}

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
  // Model, effort and mode, and their senders: the drawer pill's own (SessionComposer).
  const setup = usePaneSetup(paneId, profile)
  const read = setupRead(setup)
  const picks = setup.agent && (setup.roster.length > 0 || setup.levels.length > 0 || setup.ladder.length > 0)

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
  const setupSaid = [read.model, read.effort ? `${read.effort} effort` : null, read.mode ? `${read.mode} mode` : null]
    .filter(Boolean)
    .join(', ')
  const setupPart = setupSaid ? `${setupSaid}. ` : ''
  const label = !usable
    ? 'No pane open'
    : context
      ? `Context ${context.usedPct}% used${level === 'calm' ? '' : level === 'warn' ? ', getting full' : ', nearly full'}. ${setupPart}${said}. Details`
      : shell
        ? `${profile?.name ?? 'Shell'}: ${said}. Details`
        : `No context reading yet. ${setupPart}${said}. Details`

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
        data-mode={read.mark ?? undefined}
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
          <span className="pctx__top">
            <span className="pctx__ring">
              <Ring pct={context?.usedPct ?? 0} size={20} stroke={2.5} />
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
            <ModeGlyph mark={read.mark} />
          </span>
          {/* The setup in small print, under the lot. A shell, or a pane yet to print its model, keeps the line with a dash. */}
          <span className="pctx__setup" aria-hidden="true">
            <span className={read.model ? 'pctx__model' : 'pctx__model pctx__model--none'}>{read.model ?? '–'}</span>
            {read.step ? <EffortMeter step={read.step} /> : null}
          </span>
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
                {picks && paneId ? (
                  <div className="pctx-setup">
                    <SetupPicks paneId={paneId} setup={setup} onPicked={close} />
                  </div>
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
