import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import type { AgentProfile } from '@shared/types'
import { AgentBadge } from '@/components/AgentBadge'
import { Icon } from '@/components/Icon'
import { badgeColor, isShellProfile } from '@/lib/agents'
import type { PaneStatus } from '@/lib/rich'
import { AgentStateGlyph, STATE_WORD, type DeckAgentState } from '../deck/agents'
import { useScreenPane, type ScreenPane } from '../lib/pane-screen'
import { usePhonePaneState, type PhonePaneState } from '../lib/pane-state'
import type { PaneFace } from '../lib/pane-status'
import { fmtReset, fmtTokens, usageLevel, usePaneUsage, type PaneUsage, type UsageLimit } from '../lib/usage'
import { useForge, useForgeOptional } from '../state'
import { BottomSheet, SheetRow, SheetSection } from './BottomSheet'
import './StatusLine.css'

/**
 * The phone's status line: the one row under the conversation that says what
 * this pane is and changes how it is shown.
 *
 *   [ Chat | Cards | Terminal ]            ◉ Working   Opus · Plan ▾
 *                                            12m · 42%
 *   [ Chat | Cards | Terminal ]                       (!) Needs you
 *
 * Left, the view switch — three labelled segments, the face on screen raised,
 * any face one tap away. Right, what the pane is: its state in the desktop's
 * words (Working 12m / Done / Ready) over how full its context window is, and
 * the model chip — or, while something is wrong with the pane, just the word
 * for it (Needs you / Reconnecting / Frozen). The ring (the agent's badge
 * before there is a reading; the word while there is one) opens the pane's
 * sheet: tokens, plan limits, "Copy screen" and the raw footer the reading
 * came from — so the row itself is no longer a hidden button, and nothing on
 * it does two things.
 *
 * A horizontal swipe along the row changes tab, the way the tab strip does.
 *
 * Held at 52px in every view (see ModelChip.css): the Terminal view's keys no
 * longer take this row's place, they float above the dock over a band the
 * terminal keeps free in every face — see "the keys" in styles.css.
 */

/* Each face is drawn as a shape (bubble, stacked cards, prompt) and named in
   its label, so the switch stays narrow and never leans on colour. The deck's
   own switch (deck/Deck.tsx `FaceSwitch`) draws the same shapes. */
export const FACES: { face: PaneFace; label: string; icon: ReactNode }[] = [
  {
    face: 'chat',
    label: 'Chat',
    icon: <path d="M6.5 3.5h7A2.5 2.5 0 0 1 16 6v5a2.5 2.5 0 0 1-2.5 2.5H10l-3.5 3v-3A2.5 2.5 0 0 1 4 11V6a2.5 2.5 0 0 1 2.5-2.5z" />
  },
  {
    face: 'feed',
    label: 'Cards',
    icon: (
      <>
        <rect x="3.5" y="3.5" width="13" height="5.5" rx="1.5" />
        <rect x="3.5" y="11" width="13" height="5.5" rx="1.5" />
      </>
    )
  },
  { face: 'term', label: 'Terminal', icon: <path d="M4.5 6l4 4-4 4M10.5 14.5h5" /> }
]

/** The pane's condition in one word, when it has one worth a word. */
type Condition = 'waiting' | 'reconnecting' | 'frozen'

/* "Needs you", not "Waiting": the desktop's StateChip word for the same state,
   so the phone and the desk say one thing for it. */
const CONDITION: Record<Condition, { word: string; mark: string; title: string }> = {
  waiting: { word: 'Needs you', mark: '!', title: 'This pane has settled on a question and is waiting on an answer' },
  reconnecting: {
    word: 'Reconnecting',
    mark: '',
    title: 'The link dropped — this is where the pane had got to, and it repaints when it comes back'
  },
  frozen: { word: 'Frozen', mark: '', title: 'The desktop is away — this is the last screen this browser was sent' }
}

/** How far a finger must travel along the row, and how level, to change tab. */
const SWIPE_PX = 56
const SWIPE_SLOP_PX = 12

export function StatusLine({
  profile,
  status,
  live,
  view,
  onFlipView,
  keysShown = false,
  onToggleKeys,
  chip,
  variant = 'row',
  onPickView,
  onPicked
}: {
  profile: AgentProfile
  status?: PaneStatus
  live: boolean
  view?: PaneFace
  onFlipView?: () => void
  keysShown?: boolean
  onToggleKeys?: () => void
  chip?: ReactNode
  /**
   * `drawer`: drawn in the PowerDraw's pane slot instead of under the
   * conversation — the state and the model on one line, the view switch
   * full width under them, the terminal keys as a switch.
   */
  variant?: 'row' | 'drawer'
  /** Where a view pick goes when there is no screen pane to take it (the preview). */
  onPickView?: (face: PaneFace) => void
  /** After a view is picked in the drawer: the drawer goes, so the view can be seen. */
  onPicked?: () => void
}): ReactNode {
  const screen = useScreenPane()
  const shell = isShellProfile(profile)
  const paneId = screen?.paneId ?? null
  const usage = usePaneUsage(shell ? null : paneId, shell ? undefined : status)
  const [sheet, setSheet] = useState(false)
  const condition = screen?.condition ?? null
  const context = usage.context
  const place = placeOf(status)
  const pane = usePhonePaneState(shell ? null : paneId)
  // A shell has no screen the phone reads a state from, but the desktop's busy
  // frames still say whether it is printing: a long build is Working, not idle.
  const busy = useForgeOptional()?.state.busy
  const shellState: DeckAgentState | null =
    shell && live && paneId ? (busy?.has(paneId) ? 'working' : 'idle') : null

  /* ------------------------------------------------------------ the swipe */
  const swipe = useRef<{ id: number; x: number; y: number; moving: boolean } | null>(null)
  const swallowClick = useRef(false)
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!screen || event.pointerType === 'mouse') return
    swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moving: false }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const s = swipe.current
    if (!s || s.id !== event.pointerId) return
    const dx = event.clientX - s.x
    const dy = event.clientY - s.y
    if (!s.moving && Math.abs(dx) > SWIPE_SLOP_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      s.moving = true
      // The row keeps the finger, so the segment it started on does not also
      // read the lift as a tap.
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const s = swipe.current
    swipe.current = null
    if (!s || s.id !== event.pointerId || !s.moving) return
    swallowClick.current = true
    window.setTimeout(() => (swallowClick.current = false), 0)
    const dx = event.clientX - s.x
    if (Math.abs(dx) >= SWIPE_PX) screen?.stepTab(dx < 0 ? 1 : -1)
  }

  const lead = shell ? (
    <button
      type="button"
      className="pstat__who"
      onClick={() => setSheet(true)}
      data-state={shellState ?? undefined}
      title={shellState ? STATE_WORD[shellState] : undefined}
      aria-label={`${profile.name}${shellState ? `: ${STATE_WORD[shellState]}` : ''} — details and Copy screen`}
    >
      <AgentBadge profile={profile} size="sm" />
      {shellState ? <AgentStateGlyph state={shellState} /> : null}
      <span className="pstat__name">{profile.name}</span>
      {place ? <span className="pstat__place mono">{place}</span> : null}
    </button>
  ) : context ? (
    <button
      type="button"
      className="pstat__ctx"
      data-level={usageLevel(context.usedPct)}
      data-state={pane.state}
      onClick={() => setSheet(true)}
      title={pane.detail}
      aria-label={`${stateSaid(pane)}. Context ${context.usedPct}% used — details`}
    >
      {/* The ring is the context gauge and the state's frame at once: its
          hole holds the state's shape — a dot working, a tick done, empty
          (the desktop's ring) ready. */}
      <span className="pstat__ring">
        <Ring pct={context.usedPct} size={20} />
        <StateMark state={pane.state} paneId={paneId} />
      </span>
      {/* The word over the numbers: while it works, its clock leads the
          context figure on the second line, so the word itself is never cut. */}
      <span className="pstat__lines">
        <StateWords pane={pane} clock={false} />
        <span className="pstat__pct">
          {pane.clock ? <span className="pstat__clock">{pane.clock} · </span> : null}
          {context.usedPct}%
        </span>
      </span>
    </button>
  ) : (
    <button
      type="button"
      className="pstat__badge"
      data-state={pane.state}
      onClick={() => setSheet(true)}
      title={pane.detail}
      aria-label={`${profile.name}: ${stateSaid(pane)} — details and Copy screen`}
    >
      <AgentBadge profile={profile} size="sm" />
      <span className="pstat__lines">
        <span className="pstat__glyphline">
          <AgentStateGlyph state={pane.state} />
          <StateWords pane={pane} />
        </span>
      </span>
    </button>
  )

  const sheetEl = (
    <PaneSheet
      open={sheet}
      onClose={() => setSheet(false)}
      profile={profile}
      place={place}
      usage={shell ? { context: null, limits: null } : usage}
      footer={status?.footer ?? []}
      screen={screen}
    />
  )

  if (variant === 'drawer') {
    const pickView = screen?.showView ?? onPickView
    const face = view ?? 'chat'
    return (
      <section
        className="pdpane"
        aria-label={`This pane: ${profile.name}`}
        data-busy={status?.busy ? 'true' : 'false'}
        data-live={live ? 'true' : 'false'}
        data-shell={shell ? 'true' : undefined}
        data-condition={condition ?? undefined}
        style={{ '--pane-accent': badgeColor(profile) } as CSSProperties}
      >
        <div className="pdpane__top">
          {condition ? (
            <button
              type="button"
              className="pstat__cond"
              data-condition={condition}
              title={CONDITION[condition].title}
              aria-label={`${CONDITION[condition].word} — ${CONDITION[condition].title}. Details`}
              onClick={() => setSheet(true)}
            >
              <span className="pstat__mark" aria-hidden="true">
                {CONDITION[condition].mark}
              </span>
              <span className="pstat__word">{CONDITION[condition].word}</span>
            </button>
          ) : (
            lead
          )}
        </div>
        {/* Model, effort and permission mode: always on show in the drawer,
            greyed while the pane cannot take a pick. */}
        {chip ?? null}
        {!shell && onFlipView && pickView ? (
          <Segments
            view={face}
            labelled
            onPick={(next) => {
              pickView(next)
              onPicked?.()
            }}
          />
        ) : null}
        {onToggleKeys && face === 'term' ? <KeysSwitch shown={keysShown} onClick={onToggleKeys} /> : null}
        {sheetEl}
      </section>
    )
  }

  return (
    <div
      className="astatus pstat"
      data-busy={status?.busy ? 'true' : 'false'}
      data-live={live ? 'true' : 'false'}
      data-shell={shell ? 'true' : undefined}
      data-condition={condition ?? undefined}
      style={{ '--pane-accent': badgeColor(profile) } as CSSProperties}
    >
      <div
        className="astatus__row pstat__row"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (swipe.current = null)}
        onClickCapture={(event) => {
          if (!swallowClick.current) return
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        {!shell && onFlipView && screen ? <Segments view={view ?? 'chat'} onPick={screen.showView} /> : null}
        {onToggleKeys && (view ?? 'term') === 'term' ? <KeysToggle shown={keysShown} onClick={onToggleKeys} /> : null}
        {/* Read aloud lives on the reply itself now (the chat bubble's menu). */}
        {shell ? lead : null}
        <span className="pstat__gap" />
        {/* A condition is the news, so while there is one it is the whole of the
            right side: the ring and the chip step aside (a pane waiting on an
            answer or out of reach has nothing for the chip to change), and the
            word itself opens the sheet the ring would have. */}
        {condition ? (
          <button
            type="button"
            className="pstat__cond"
            data-condition={condition}
            title={CONDITION[condition].title}
            aria-label={`${CONDITION[condition].word} — ${CONDITION[condition].title}. Details`}
            onClick={() => setSheet(true)}
          >
            <span className="pstat__mark" aria-hidden="true">
              {CONDITION[condition].mark}
            </span>
            <span className="pstat__word">{CONDITION[condition].word}</span>
          </button>
        ) : null}
        {!shell && !condition ? lead : null}
        {/* No process behind the pane: nothing for the chip to change, so
            "Not running" has its room. */}
        {chip && !condition && (shell || pane.state !== 'dormant') ? chip : null}
      </div>

      {sheetEl}
    </div>
  )
}

/* ---------------------------------------------------------- keys toggle */

/**
 * The terminal-keys toggle, drawn the same wherever it sits: the phone's status
 * line, and the deck's pane status row (AgentStatus) beside its "Terminal"
 * button. With `word`, the state is also a word beside the shape ("Keys on" /
 * "Keys off") — the deck's rule; the phone keeps its narrow, shape-only face.
 */
export function KeysToggle({
  shown,
  onClick,
  word = false
}: {
  shown: boolean
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void
  word?: boolean
}): ReactNode {
  const title = shown ? 'Hide terminal keys' : 'Show terminal keys'
  return (
    <button
      type="button"
      className="pkeys-toggle"
      aria-pressed={shown}
      aria-label={word ? `Keys ${shown ? 'on' : 'off'} — ${shown ? 'hide' : 'show'} the terminal keys` : title}
      title={title}
      onClick={onClick}
    >
      {/* Off is a shape, not a colour: a slash draws across the keyboard,
          cutting a clean gap through it, and draws back out when on. */}
      <span className="pkeys-toggle__face">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <mask id="pkeys-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="20" height="20">
            <rect width="20" height="20" fill="#fff" stroke="none" />
            <path className="pkeys-toggle__slash" d="M3.5 3.5l13 13" pathLength={1} stroke="#000" strokeWidth="4.5" />
          </mask>
          <g mask="url(#pkeys-cut)">
            <rect x="2.5" y="5" width="15" height="10" rx="2.5" />
            <path d="M6 8.25h.01M8.67 8.25h.01M11.33 8.25h.01M14 8.25h.01M7 12h6" />
          </g>
          <path className="pkeys-toggle__slash" d="M3.5 3.5l13 13" pathLength={1} />
        </svg>
      </span>
      {word ? (
        <span className="pkeys-toggle__word" aria-hidden="true">
          Keys {shown ? 'on' : 'off'}
        </span>
      ) : null}
    </button>
  )
}

/* -------------------------------------------------------------- segments */

function Segments({
  view,
  onPick,
  labelled = false
}: {
  view: PaneFace
  onPick: (face: PaneFace) => void
  /** The drawer's switch: each face named under its shape, and a lamp that slides to the one on screen. */
  labelled?: boolean
}): ReactNode {
  const at = Math.max(
    0,
    FACES.findIndex((f) => f.face === view)
  )
  return (
    <div
      className="pseg"
      role="radiogroup"
      aria-label="Show this pane as"
      data-labelled={labelled ? 'true' : undefined}
      style={labelled ? ({ '--seg-at': at } as CSSProperties) : undefined}
    >
      {labelled ? <span className="pseg__lamp" aria-hidden="true" /> : null}
      {FACES.map(({ face, label, icon }) => (
        <button
          key={face}
          type="button"
          role="radio"
          aria-checked={view === face}
          aria-label={label}
          title={label}
          className="pseg__btn"
          data-face={face}
          data-on={view === face ? 'true' : 'false'}
          onClick={() => {
            if (view !== face) onPick(face)
          }}
        >
          <span className="pseg__face">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              {icon}
            </svg>
          </span>
          {labelled ? <span className="pseg__label">{label}</span> : null}
        </button>
      ))}
    </div>
  )
}

/** The drawer's keys control: the toggle's keyboard, its name, and a switch that says on or off. */
function KeysSwitch({ shown, onClick }: { shown: boolean; onClick: () => void }): ReactNode {
  return (
    <button type="button" role="switch" aria-checked={shown} className="pdkeys" onClick={onClick}>
      <span className="pdkeys__icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
          <rect x="2.5" y="5" width="15" height="10" rx="2.5" />
          <path d="M6 8.25h.01M8.67 8.25h.01M11.33 8.25h.01M14 8.25h.01M7 12h6" />
        </svg>
      </span>
      <span className="pdkeys__text">
        <span className="pdkeys__label">Terminal keys</span>
        <span className="pdkeys__sub">Esc, Tab, Ctrl and arrows</span>
      </span>
      <span className="pdkeys__track" aria-hidden="true">
        <span className="pdkeys__thumb" />
      </span>
    </button>
  )
}

/* ----------------------------------------------------------------- state */

/** "Working, 12m" for a screen reader; the row shows the same in a word and a shape. */
function stateSaid(pane: PhonePaneState): string {
  return pane.clock ? `${pane.word}, ${pane.clock}` : pane.word
}

/**
 * The state's word, and its clock while it works. Keyed on the state, so a
 * change rises in (one short glide) and nothing moves between changes.
 */
function StateWords({ pane, clock = true }: { pane: PhonePaneState; clock?: boolean }): ReactNode {
  return (
    <span key={pane.state} className="pstat__state" data-state={pane.state}>
      <span className="pstat__sword">{pane.word}</span>
      {clock && pane.clock ? <span className="pstat__clock">{pane.clock}</span> : null}
    </span>
  )
}

/** How long the dot holds its beat after a burst of output (the desktop ActivityDot's). */
const PULSE_HOLD_MS = 620

/**
 * The state's shape, drawn in the ring's hole: the desktop StateGlyph's dot,
 * tick and diamond; Ready is the ring itself, so its hole stays empty. While
 * working, the dot beats when the pane prints (the desktop's output pulse):
 * a class put straight on the node, no render per burst, and no listener at
 * all unless the pane is working.
 */
function StateMark({ state, paneId }: { state: DeckAgentState; paneId: string | null }): ReactNode {
  const { actions } = useForge()
  const ref = useRef<SVGSVGElement | null>(null)
  const working = state === 'working'

  useEffect(() => {
    if (!working || !paneId) return undefined
    let timer: number | undefined
    const stop = actions.onData(paneId, (_data, replay) => {
      const dot = ref.current
      if (replay || !dot) return
      dot.classList.add('is-active')
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => dot.classList.remove('is-active'), PULSE_HOLD_MS)
    })
    return () => {
      stop()
      if (timer) window.clearTimeout(timer)
    }
  }, [actions, paneId, working])

  return (
    <svg ref={ref} className="pstat__mark-in" data-state={state} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      {state === 'working' ? <circle className="pstat__beat" cx="5" cy="5" r="3" fill="currentColor" /> : null}
      {state === 'attention' ? <path d="M5 1.2 L8.8 5 L5 8.8 L1.2 5 Z" fill="currentColor" /> : null}
      {state === 'done' ? (
        <path d="M1.8 5.3 L4.1 7.5 L8.3 2.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
      {state === 'dormant' ? <rect x="2" y="4.2" width="6" height="1.6" rx="0.8" fill="currentColor" /> : null}
      {state === 'reconnecting' || state === 'frozen' ? (
        <rect
          x="2.4"
          y="2.4"
          width="5.2"
          height="5.2"
          rx="1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeDasharray={state === 'reconnecting' ? '1.6 1.2' : undefined}
        />
      ) : null}
    </svg>
  )
}

/* ------------------------------------------------------------------ ring */

/**
 * A ring filled to `pct`. The number always sits beside it in words — the
 * colour is the third signal, never the first.
 */
function Ring({ pct, size, stroke = 2.5 }: { pct: number; size: number; stroke?: number }): ReactNode {
  const r = (size - stroke) / 2
  const fill = Math.max(0, Math.min(100, pct))
  return (
    <svg className="pring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
      <circle className="pring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
      {[0, 1, 2, 3].map((quarter) => {
        const start = quarter * 25
        const length = Math.max(0, Math.min(25, fill - start))
        return length > 0 ? (
          <circle
            key={quarter}
            className={`pring__arc pring__arc--q${quarter + 1}`}
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={stroke}
            pathLength={100}
            strokeDasharray={`${length} 100`}
            strokeDashoffset={-start}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null
      })}
    </svg>
  )
}

/* ----------------------------------------------------------------- sheet */

function PaneSheet({
  open,
  onClose,
  profile,
  place,
  usage,
  footer,
  screen
}: {
  open: boolean
  onClose: () => void
  profile: AgentProfile
  place: string
  usage: PaneUsage
  footer: string[]
  screen: ScreenPane | null
}): ReactNode {
  const [showFooter, setShowFooter] = useState(false)
  const { context, limits } = usage
  return (
    <BottomSheet
      open={open}
      onClose={() => {
        setShowFooter(false)
        onClose()
      }}
      label={`${profile.name} details`}
      title={profile.name}
      subtitle={place ? <span className="mono">{place}</span> : undefined}
      testId="pane-sheet"
    >
      {context ? (
        <SheetSection title="Context window">
          <div className="pgauge" data-level={usageLevel(context.usedPct)}>
            <Ring pct={context.usedPct} size={48} stroke={4} />
            <div className="pgauge__text">
              <span className="pgauge__big">{context.usedPct}% used</span>
              <span className="pgauge__sub">
                {context.from === 'frame'
                  ? context.usedTokens !== undefined && context.windowTokens
                    ? `${fmtTokens(context.usedTokens)} of ${fmtTokens(context.windowTokens)} tokens`
                    : `${100 - context.usedPct}% left before the window is full`
                  : 'Read off the agent’s footer on screen, so approximate'}
              </span>
            </div>
          </div>
        </SheetSection>
      ) : null}
      {limits && (limits.fiveHour || limits.week) ? (
        <SheetSection title="Plan limits">
          {limits.fiveHour ? <LimitRow label="5-hour limit" limit={limits.fiveHour} /> : null}
          {limits.week ? <LimitRow label="Weekly limit" limit={limits.week} /> : null}
        </SheetSection>
      ) : null}
      <SheetSection title="This pane">
        <SheetRow
          icon={<Icon name="clipboard" size={20} />}
          label="Copy screen"
          secondary="The terminal’s visible text, as plain text"
          disabled={!screen}
          onClick={() => {
            screen?.copyScreen()
            onClose()
          }}
          testId="copy-screen"
        />
        {footer.length ? (
          <SheetRow
            icon={<Icon name="terminal" size={20} />}
            label={showFooter ? 'Hide the agent’s footer' : 'Show the agent’s footer'}
            secondary="The raw lines this status is read from"
            onClick={() => setShowFooter((v) => !v)}
          />
        ) : null}
        {showFooter && footer.length ? <pre className="psheet__footer mono">{footer.join('\n')}</pre> : null}
      </SheetSection>
    </BottomSheet>
  )
}

function LimitRow({ label, limit }: { label: string; limit: UsageLimit }): ReactNode {
  const used = Math.round(limit.usedPct)
  return (
    <div
      className="plimit"
      data-level={usageLevel(used)}
      role="progressbar"
      aria-label={label}
      aria-valuenow={used}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="plimit__head">
        <span className="plimit__label">{label}</span>
        <span className="plimit__pct">{used}% used</span>
      </div>
      <span className="plimit__bar" aria-hidden="true">
        <span style={{ transform: `translateX(${Math.min(100, used) - 100}%)` }} />
      </span>
      {limit.resetsAt ? <span className="plimit__reset">{fmtReset(limit.resetsAt)}</span> : null}
    </div>
  )
}

/* --------------------------------------------------------------- helpers */

function placeOf(status: PaneStatus | undefined): string {
  if (status?.branch && status?.cwd) return `${shortPath(status.cwd)} · ${status.branch}`
  if (status?.branch) return status.branch
  if (status?.cwd) return shortPath(status.cwd)
  return ''
}

function shortPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return trimmed
  return `…/${parts.slice(-2).join('/')}`
}
