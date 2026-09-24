import { useState, type CSSProperties, type ReactNode } from 'react'
import type { AgentProfile } from '@shared/types'
import { AgentBadge } from '@/components/AgentBadge'
import { Icon } from '@/components/Icon'
import { badgeColor, isShellProfile } from '@/lib/agents'
import type { PaneStatus, PermissionMode } from '@/lib/rich'
import { useMobile } from '../lib/mobile'
import type { PaneFace } from '../lib/pane-status'
import { KeysToggle, StatusLine } from './StatusLine'

/** What the face button offers, named by the face it would give you. */
const VIEW_TITLE: Record<PaneFace, string> = {
  chat: 'Show the conversation (Chat)',
  feed: 'Show as cards (Output)',
  term: 'Show the terminal'
}

/**
 * A speech bubble icon, matching Icon weight.
 */
function ChatIcon(): ReactNode {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M13.4 9.2a1.4 1.4 0 0 1-1.4 1.4H6.2L3.4 13V4.2a1.4 1.4 0 0 1 1.4-1.4h7.2a1.4 1.4 0 0 1 1.4 1.4z" />
    </svg>
  )
}

/**
 * The agent's own footer, lifted out of the TUI and drawn as one strip between
 * the conversation and the box: who you are talking to, which model, which
 * permission mode is in effect, how much context is spent, and where it is
 * working. The mode chip is a readout — picking a different rung is the
 * Mode dropdown on the composer. Tap anywhere else on the strip to see the
 * raw footer lines the parser read this from.
 */

const MODE_LABEL: Record<PermissionMode, string> = {
  bypass: 'Bypass',
  'accept-edits': 'Accept edits',
  plan: 'Plan',
  default: 'Default',
  auto: 'Auto',
  unknown: 'Mode'
}

export function AgentStatus({
  profile,
  tab,
  status,
  live,
  view,
  onCycleMode,
  onFlipView,
  keysShown,
  onToggleKeys,
  chip
}: {
  profile: AgentProfile
  /**
   * The pane's tab by its own name ("Wanda"), set only where it says more than
   * the pane's name. The deck draws it beside the name; the phone ignores it.
   */
  tab?: string
  status?: PaneStatus
  /** False while the socket is down: the strip stays, the controls go quiet. */
  live: boolean
  view?: PaneFace
  onCycleMode?: () => void
  onFlipView?: () => void
  keysShown?: boolean
  onToggleKeys?: () => void
  /**
   * The phone's model chip ("Opus · High · Plan ▾"). It names the mode in
   * words, so where it is given it stands in for the mode readout.
   */
  chip?: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(false)
  const mobile = useMobile()
  // The phone draws its own line: a view switch, the pane's condition in words
  // and its context ring, and a sheet for the rest. See StatusLine.
  if (mobile) {
    return (
      <StatusLine
        profile={profile}
        status={status}
        live={live}
        view={view}
        onFlipView={onFlipView}
        keysShown={keysShown}
        onToggleKeys={onToggleKeys}
        chip={chip}
      />
    )
  }
  const shell = isShellProfile(profile)
  const accent = badgeColor(profile)
  const mode = status?.mode ?? 'unknown'
  const nextView: PaneFace = view === 'chat' ? 'feed' : view === 'feed' ? 'term' : 'chat'
  const context = parseContext(status?.context)
  const place =
    status?.branch && status?.cwd
      ? `${shortPath(status.cwd)} · ${status.branch}`
      : status?.branch
        ? status.branch
        : status?.cwd
          ? shortPath(status.cwd)
          : ''
  const footer = status?.footer ?? []
  const canCycle = !shell && live && onCycleMode !== undefined

  return (
    <div
      className="astatus"
      data-busy={status?.busy ? 'true' : 'false'}
      data-live={live ? 'true' : 'false'}
      data-shell={shell ? 'true' : undefined}
      data-open={open ? 'true' : 'false'}
      style={{ '--pane-accent': accent } as CSSProperties}
    >
      <div
        className="astatus__row"
        role={footer.length ? 'button' : undefined}
        tabIndex={footer.length ? 0 : undefined}
        aria-expanded={footer.length ? open : undefined}
        onClick={() => footer.length && setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (!footer.length) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen((v) => !v)
          }
        }}
      >
        <span className="astatus__who">
          <AgentBadge profile={profile} size="sm" />
          <span className="astatus__name">{profile.name}</span>
          {tab ? <span className="astatus__tab">{tab}</span> : null}
          {status?.model ? <span className="astatus__model">{status.model}</span> : null}
        </span>

        {chip ? (
          chip
        ) : !shell ? (
          canCycle ? (
            <button
              type="button"
              className="astatus__mode"
              data-mode={mode}
              title={`${status?.modeLabel ?? MODE_LABEL[mode]} — tap to cycle (Shift+Tab)`}
              onClick={(event) => {
                event.stopPropagation()
                onCycleMode?.()
              }}
            >
              <span className="astatus__mode-dot" aria-hidden />
              {MODE_LABEL[mode]}
            </button>
          ) : (
            <span className="astatus__mode" data-mode={mode} title={status?.modeLabel ?? MODE_LABEL[mode]}>
              <span className="astatus__mode-dot" aria-hidden />
              {MODE_LABEL[mode]}
            </span>
          )
        ) : null}

        {context ? (
          <span className="astatus__ctx" title={`Context: ${status?.context}`}>
            <span className="astatus__meter" aria-hidden>
              {/*
                The fill is the whole bar, slid into view by however much of the
                context is gone — not a bar whose width is the reading. A width
                is a layout on every tick of a number that moves all through a
                streaming turn, and this strip sits directly under the pane
                whose smoothness is the point of the phone layout; a transform
                is the compositor's alone. `-100%` is a full bar's width, so the
                percentage lands on the same pixel the growing version did. See
                `.astatus__meter > span` in styles.css, which is the other half
                of this and cannot be read without it.
              */}
              <span
                style={{ transform: `translateX(${context.pct - 100}%)` }}
                data-hot={context.pct >= 80 ? 'true' : undefined}
              />
            </span>
            <span className="astatus__ctx-text">{context.label}</span>
          </span>
        ) : null}

        {place ? (
          <span
            className="astatus__place mono"
            title={`${status?.cwd ?? ''}${status?.branch ? ` on ${status.branch}` : ''}`}
          >
            {place}
          </span>
        ) : null}

        <span
          className="astatus__state"
          title={status?.busy ? (status.activity ?? 'Working') : live ? 'Idle' : 'Disconnected'}
        >
          <span className="astatus__state-dot" data-live={live ? 'true' : 'false'} aria-hidden />
          <span className="astatus__state-text">
            {!live ? 'Offline' : status?.busy ? (status.activity ?? 'Working') : 'Idle'}
          </span>
        </span>

        {onFlipView && !shell ? (
          <button
            type="button"
            className="ghost-btn astatus__view"
            title={VIEW_TITLE[nextView]}
            aria-label={VIEW_TITLE[nextView]}
            onClick={(event) => {
              event.stopPropagation()
              onFlipView()
            }}
          >
            {nextView === 'chat' ? <ChatIcon /> : <Icon name={nextView === 'term' ? 'terminal' : 'note'} size={12} />}
            <span className="astatus__view-label">{view === 'chat' ? 'Chat' : view === 'feed' ? 'Cards' : 'Terminal'}</span>
          </button>
        ) : null}

        {/* The deck's terminal keys, behind the phone's toggle: only in the
            Terminal view, and a word as well as the slash for its state. */}
        {onToggleKeys && (view ?? 'term') === 'term' ? (
          <KeysToggle
            shown={keysShown ?? false}
            word
            onClick={(event) => {
              event.stopPropagation()
              onToggleKeys()
            }}
          />
        ) : null}
      </div>

      {open && footer.length ? <pre className="astatus__footer mono">{footer.join('\n')}</pre> : null}
    </div>
  )
}

/** "23%" → 23; "128k left" → undefined (no percentage to draw). */
function parseContext(raw: string | undefined): { pct: number; label: string } | null {
  if (!raw) return null
  const m = /(\d{1,3})\s*%/.exec(raw)
  if (m) {
    const pct = Math.max(0, Math.min(100, Number(m[1])))
    return { pct, label: `${pct}%` }
  }
  return { pct: 0, label: raw }
}

function shortPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return trimmed
  return `…/${parts.slice(-2).join('/')}`
}
