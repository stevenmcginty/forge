import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { AgentProfile } from '@shared/types'
import { AgentBadge } from '@/components/AgentBadge'
import { Icon } from '@/components/Icon'
import { badgeColor, isShellProfile } from '@/lib/agents'
import type { PaneStatus } from '@/lib/rich'
import { useScreenPane, type ScreenPane } from '../lib/pane-screen'
import type { PaneFace } from '../lib/pane-status'
import { fmtReset, fmtTokens, usageLevel, usePaneUsage, type PaneUsage, type UsageLimit } from '../lib/usage'
import { BottomSheet, SheetRow, SheetSection } from './BottomSheet'
import './StatusLine.css'

/**
 * The phone's status line: the one row under the conversation that says what
 * this pane is and changes how it is shown.
 *
 *   [ Chat | Cards | Terminal ]              ◔ 42%   Opus · Plan ▾
 *   [ Chat | Cards | Terminal ]                         (!) Waiting
 *
 * Left, the view switch — three labelled segments, the face on screen raised,
 * any face one tap away. Right, what the pane is: how full its context window
 * is and the model chip — or, while something is wrong with the pane, just the
 * word for it (Waiting / Reconnecting / Frozen). The ring (the agent's badge
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

const FACES: { face: PaneFace; label: string }[] = [
  { face: 'chat', label: 'Chat' },
  { face: 'feed', label: 'Cards' },
  { face: 'term', label: 'Terminal' }
]

/** The pane's condition in one word, when it has one worth a word. */
type Condition = 'waiting' | 'reconnecting' | 'frozen'

const CONDITION: Record<Condition, { word: string; mark: string; title: string }> = {
  waiting: { word: 'Waiting', mark: '!', title: 'This pane has settled on a question and is waiting on an answer' },
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
  chip
}: {
  profile: AgentProfile
  status?: PaneStatus
  live: boolean
  view?: PaneFace
  onFlipView?: () => void
  keysShown?: boolean
  onToggleKeys?: () => void
  chip?: ReactNode
}): ReactNode {
  const screen = useScreenPane()
  const shell = isShellProfile(profile)
  const paneId = screen?.paneId ?? null
  const usage = usePaneUsage(shell ? null : paneId, shell ? undefined : status)
  const [sheet, setSheet] = useState(false)
  const condition = screen?.condition ?? null
  const context = usage.context
  const place = placeOf(status)

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
      aria-label={`${profile.name} — details and Copy screen`}
    >
      <AgentBadge profile={profile} size="sm" />
      <span className="pstat__name">{profile.name}</span>
      {place ? <span className="pstat__place mono">{place}</span> : null}
    </button>
  ) : context ? (
    <button
      type="button"
      className="pstat__ctx"
      data-level={usageLevel(context.usedPct)}
      onClick={() => setSheet(true)}
      aria-label={`Context ${context.usedPct}% used — details`}
    >
      <Ring pct={context.usedPct} size={20} />
      <span className="pstat__pct">{context.usedPct}%</span>
    </button>
  ) : (
    <button
      type="button"
      className="pstat__badge"
      onClick={() => setSheet(true)}
      aria-label={`${profile.name} — details and Copy screen`}
    >
      <AgentBadge profile={profile} size="sm" />
    </button>
  )

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
        {onToggleKeys && (view ?? 'term') === 'term' ? (
          <button
            type="button"
            className="pkeys-toggle"
            aria-pressed={keysShown}
            aria-label={keysShown ? 'Hide terminal keys' : 'Show terminal keys'}
            title={keysShown ? 'Hide terminal keys' : 'Show terminal keys'}
            onClick={onToggleKeys}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <rect x="2" y="3" width="14" height="12" rx="2" />
              <path d="M5 6h1M8.5 6h1M12 6h1M5 9h1M8.5 9h1M12 9h1M5 12h8" />
            </svg>
            <span className="pkeys-toggle__mark" aria-hidden="true">{keysShown ? 'On' : 'Off'}</span>
          </button>
        ) : null}
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
        {chip && !condition ? chip : null}
      </div>

      <PaneSheet
        open={sheet}
        onClose={() => setSheet(false)}
        profile={profile}
        place={place}
        usage={shell ? { context: null, limits: null } : usage}
        footer={status?.footer ?? []}
        screen={screen}
      />
    </div>
  )
}

/* -------------------------------------------------------------- segments */

function Segments({ view, onPick }: { view: PaneFace; onPick: (face: PaneFace) => void }): ReactNode {
  return (
    <div className="pseg" role="radiogroup" aria-label="Show this pane as">
      {FACES.map(({ face, label }) => (
        <button
          key={face}
          type="button"
          role="radio"
          aria-checked={view === face}
          className="pseg__btn"
          data-on={view === face ? 'true' : 'false'}
          onClick={() => {
            if (view !== face) onPick(face)
          }}
        >
          <span className="pseg__face">{label}</span>
        </button>
      ))}
    </div>
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
    <div className="plimit" data-level={usageLevel(used)}>
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
