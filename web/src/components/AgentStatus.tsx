import { useState, type CSSProperties, type ReactNode } from 'react'
import type { AgentProfile } from '@shared/types'
import { AgentBadge } from '@/components/AgentBadge'
import { badgeColor, isShellProfile } from '@/lib/agents'
import type { PaneStatus, PermissionMode } from '@/lib/rich'

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
  status,
  live,
  onCycleMode
}: {
  profile: AgentProfile
  status?: PaneStatus
  /** False while the socket is down: the strip stays, the controls go quiet. */
  live: boolean
  onCycleMode?: () => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const shell = isShellProfile(profile)
  const accent = badgeColor(profile)
  const mode = status?.mode ?? 'unknown'
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
          {status?.model ? <span className="astatus__model">{status.model}</span> : null}
        </span>

        {!shell ? (
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
