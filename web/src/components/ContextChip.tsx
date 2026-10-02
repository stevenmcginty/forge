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
 * Never colour alone: the number is always there, warn (80%) draws the ring and
 * the figure heavier, full (92%) fills the mark solid; the panel says the level
 * in words. No reading yet is a drawn dash in the figure's slot; a shell says
 * "Shell" where the model goes, so the bar never jumps between tabs.
 *
 * The mode is a shape: a solid warning triangle for Bypass (and a red rim),
 * Claude's own two bars for Plan, the chevron pair for Accept edits, nothing
 * for Default. The model and the effort picked from this phone (a five-step
 * meter) sit small beside or inside the ring — which, is the face on trial
 * (`ChipFace` below). The panel opens on the three pickers that change them
 * (ModelChip's SetupPicks, through the same senders and the same pick store as
 * the drawer's pill), above the context and the limits.
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
    <svg className="pctx__meter" width="12" height="9" viewBox="0 0 14 10" aria-hidden="true" focusable="false">
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

/** The effort as five pips in a row, the ones up to its step lit: the medallion's, under the figure. */
function EffortPips({ step }: { step: number }): ReactNode {
  return (
    <svg className="pctx__pips" width="19" height="4" viewBox="0 0 19 4" aria-hidden="true" focusable="false">
      {[0, 1, 2, 3, 4].map((i) => (
        <circle key={i} cx={1.7 + i * 3.9} cy="2" r={i < step ? 1.6 : 1.1} fill="currentColor" opacity={i < step ? 1 : 0.35} />
      ))}
    </svg>
  )
}

/**
 * The mode's shape. Bypass's is the warning triangle, drawn solid with the "!" cut out of it: at this size the sheet's
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
    <svg className="pctx__glyph" width="8" height="8" viewBox="0 0 9 9" aria-hidden="true" focusable="false">
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

/** The mode worn on the mark's shoulder: Bypass a solid red triangle, the others a small coin with their shape. Default wears none. */
function ModeBadge({ mark }: { mark: ModeMark }): ReactNode {
  if (mark === null) return null
  return (
    <span className="pctx__badge" data-mark={mark} aria-hidden="true">
      <ModeGlyph mark={mark} />
    </span>
  )
}

/** The model's name in its parts: "Claude Sonnet 4.6" is family "Sonnet", version "4.6", letter "S". */
function modelParts(name: string | null): { family: string; version: string; letter: string } | null {
  if (!name) return null
  const plain = name.replace(/^claude[\s-]+/i, '').trim()
  const match = /^(.*?)[\s-]*(\d+(?:\.\d+)*)/.exec(plain)
  const family = (match?.[1] ? match[1] : plain).trim() || plain
  return { family, version: match?.[1] ? match[2] : '', letter: family.charAt(0).toUpperCase() }
}

/**
 * The figure: the percent, its sign a size down. A shell, which has no context window, shows a prompt instead;
 * a pane with no reading yet a drawn dash, centred, never a stray glyph.
 */
function Figure({ pct, shell }: { pct: number | null; shell: boolean }): ReactNode {
  if (shell)
    return (
      <svg className="pctx__prompt" width="13" height="11" viewBox="0 0 13 11" aria-hidden="true" focusable="false">
        <path d="M1.6 2 5.4 5.5 1.6 9M7.2 9.4h4.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  if (pct === null) return <span className="pctx__dash" aria-hidden="true" />
  return (
    <span className="pctx__fig" data-wide={pct >= 100 ? 'true' : undefined}>
      {pct}
      <span className="pctx__pc">%</span>
    </span>
  )
}

/**
 * The state's shape riding the head of the context arc, on a disc of the bar's colour that cuts the ring under it.
 * Ready draws nothing: the ring alone is Ready.
 */
function ArcHead({ pct, size, stroke, state, paneId }: { pct: number; size: number; stroke: number; state: DeckAgentState; paneId: string | null }): ReactNode {
  if (state === 'idle') return null
  const r = (size - stroke) / 2
  const turn = (Math.max(0, Math.min(100, pct)) / 100) * 2 * Math.PI
  // In percent of the dial, so the dial can be drawn a size smaller on a narrow phone and the head still lands on the arc.
  const style = { left: `${50 + (100 * r * Math.sin(turn)) / size}%`, top: `${50 - (100 * r * Math.cos(turn)) / size}%` } as CSSProperties
  return (
    <span className="pctx__head" style={style} aria-hidden="true">
      <StateMark state={state} paneId={paneId} />
    </span>
  )
}

/**
 * Three faces on trial for the closed chip (Steve picks from the preview's screenshots; then the other two go):
 * - `dial`: the ring is a dial with the figure in its hole; the model in a quiet two-line caption beside it. No capsule.
 * - `medallion`: the ring alone, everything folded into it — the figure and the effort's pips in the hole, the mode on
 *   its shoulder, the model's letter on a coin at its foot. The narrowest.
 * - `lockup`: the capsule kept, the ring large with the state in its hole, the figure big beside it, the model small under.
 */
export type ChipFace = 'dial' | 'medallion' | 'lockup'

let chipFace: ChipFace = 'dial'

/** The preview's `&face=` only: which face the chips draw. */
export function setChipFace(face: ChipFace): void {
  chipFace = face
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
  const parts = shell ? null : modelParts(read.model)
  const pct = context?.usedPct ?? null
  // From warn up the ring is drawn heavier, so the level has a weight as well as a hue.
  const warm = level === 'warn' || level === 'full'
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
        data-face={chipFace}
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
        {chipFace === 'lockup' ? (
          <span className="pctx__face">
            <span className="pctx__ring">
              <Ring pct={pct ?? 0} size={30} stroke={warm ? 3.5 : 3} />
              <StateMark state={pane.state} paneId={paneId} />
            </span>
            <span className="pctx__stack" aria-hidden="true">
              <Figure pct={pct} shell={shell} />
              <span className="pctx__small">
                {shell ? (
                  <span className="pctx__fam pctx__fam--none">Shell</span>
                ) : parts ? (
                  <span className="pctx__fam">{parts.family}</span>
                ) : (
                  <span className="pctx__dash" />
                )}
                {read.step ? <EffortMeter step={read.step} /> : null}
              </span>
            </span>
            <ModeBadge mark={read.mark} />
          </span>
        ) : chipFace === 'medallion' ? (
          <span className="pctx__face">
            <span className="pctx__dial">
              <span className="pctx__hole" />
              <Ring pct={pct ?? 0} size={40} stroke={warm ? 4 : 3} />
              <span className="pctx__core" aria-hidden="true">
                <Figure pct={pct} shell={shell} />
                {read.step ? <EffortPips step={read.step} /> : null}
              </span>
              <ModeBadge mark={read.mark} />
              {parts ? (
                <span className="pctx__coin" aria-hidden="true">
                  {parts.letter}
                </span>
              ) : null}
            </span>
          </span>
        ) : (
          <span className="pctx__face">
            <span className="pctx__dial">
              <span className="pctx__hole" />
              <Ring pct={pct ?? 0} size={36} stroke={warm ? 4 : 3} />
              <span className="pctx__core" aria-hidden="true">
                <Figure pct={pct} shell={shell} />
              </span>
              <ArcHead pct={pct ?? 0} size={36} stroke={warm ? 4 : 3} state={pane.state} paneId={paneId} />
              <ModeBadge mark={read.mark} />
            </span>
            {/* The model, quietly: its family over its version and the effort. A shell says so; a pane yet to print one keeps a dash. */}
            <span className="pctx__cap" aria-hidden="true">
              {shell ? (
                <span className="pctx__fam pctx__fam--none">Shell</span>
              ) : parts ? (
                <>
                  <span className="pctx__fam">{parts.family}</span>
                  {parts.version || read.step ? (
                    <span className="pctx__sub">
                      {parts.version ? <span>{parts.version}</span> : null}
                      {read.step ? <EffortMeter step={read.step} /> : null}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="pctx__dash" />
              )}
            </span>
          </span>
        )}
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
