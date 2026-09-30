import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentProfile } from '@shared/types'
import { terminalHost, type TerminalSpec } from '@/lib/terminals'
import type { PaneActivity } from '@/lib/paneActivity'
import { AgentBadge } from '../AgentBadge'
import { Icon } from '../Icon'
import { StateChip } from '../shell/StateChip'
import { BrainGlyph } from './BrainGlyph'

/**
 * A door into one agent's terminal, opened from the map: the real pane, borrowed.
 *
 * terminalHost owns every xterm and moves its element between containers, so
 * the door is only a borrowing: note where the terminal was, attach it here,
 * and on the way out put it back exactly as it was — a Full screen or split
 * pane refitted to its own box, a Wall tile re-peeked at its own natural size
 * with WebGL off again. A Wall tile is borrowed as a peek too (scaled to fit,
 * never refitted), so a glance from the map can never reflow a pane on the Wall.
 *
 * If the grid takes the pane back while the door is open (a project switch from
 * the phone, say), the door lets it go: the grid's claim always wins, and the
 * door only restores what is still in its own hands.
 */

export interface DoorTarget {
  paneId: string
  name: string
  /** The project's name, or what the brain is. */
  subtitle: string
  profile: AgentProfile | null
  projectId: string | null
  spec: TerminalSpec
}

function wrapperOf(paneId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.terminal-surface[data-pane-id="${CSS.escape(paneId)}"]`)
}

export function PaneDoor({
  target,
  activity,
  accent,
  onBack,
  onGo,
  conversation
}: {
  target: DoorTarget
  activity: PaneActivity
  accent: string
  onBack: () => void
  onGo: (() => void) | null
  /** Forge Brain's door has two faces: its conversation (the default) and its terminal. */
  conversation?: ReactNode
}): ReactNode {
  const [view, setView] = useState<'conversation' | 'terminal'>(conversation ? 'conversation' : 'terminal')
  const talking = view === 'conversation' && conversation !== undefined

  // In the conversation there is no agent to hand Esc to: it goes back to the map.
  useEffect(() => {
    if (!talking) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onBack()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [talking, onBack])

  return (
    <div
      className="bmap-door"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onBack()
      }}
    >
      <section
        className="bmap-door__panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${target.name} — ${talking ? 'conversation' : 'terminal'}`}
        style={{ '--pane-accent': accent } as React.CSSProperties}
      >
        <header className="bmap-door__head">
          <button type="button" className="bmap-btn bmap-btn--ghost" onClick={onBack} title="Back to the map (it keeps running)">
            <Icon name="chevronLeft" size={13} />
            Map
          </button>
          <span className="bmap-door__who">
            {target.profile ? <AgentBadge profile={target.profile} /> : <BrainGlyph size={18} />}
            <span className="bmap-door__name">{target.name}</span>
            <span className="bmap-door__sub">{target.subtitle}</span>
          </span>
          <StateChip activity={activity} />
          {conversation !== undefined ? (
            <span className="bmap-door__seg" role="group" aria-label="View">
              <button type="button" aria-pressed={talking} data-on={talking ? 'true' : undefined} onClick={() => setView('conversation')}>
                Conversation
              </button>
              <button type="button" aria-pressed={!talking} data-on={!talking ? 'true' : undefined} onClick={() => setView('terminal')}>
                Terminal
              </button>
            </span>
          ) : null}
          <span className="bmap-door__hint">{talking ? 'Esc goes back to the map' : 'Esc goes to the agent'}</span>
          {onGo ? (
            <button type="button" className="bmap-btn bmap-btn--cta" onClick={onGo} title="Switch Forge to this project and pane, and close the map">
              Go to it
              <Icon name="chevronRight" size={13} />
            </button>
          ) : null}
        </header>
        {talking ? <div className="bmap-door__body bmap-door__body--talk">{conversation}</div> : <DoorTerminal target={target} />}
      </section>
    </div>
  )
}

/** The borrowed terminal: attached while mounted, handed back on unmount. */
function DoorTerminal({ target }: { target: DoorTarget }): ReactNode {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const naturalRef = useRef<HTMLDivElement | null>(null)
  const specRef = useRef(target.spec)
  specRef.current = target.spec

  useLayoutEffect(() => {
    const body = bodyRef.current
    const natural = naturalRef.current
    if (!body || !natural) return
    const id = target.paneId
    const before = wrapperOf(id)?.parentElement ?? null
    const wasPeek = before?.classList.contains('mtile__natural') ?? false
    const box = wasPeek ? natural : body
    let ro: ResizeObserver | null = null

    if (wasPeek) {
      // Laid out at the size it already has, and only the picture is scaled.
      const g = terminalHost.geometryFor(id)
      natural.style.width = `${g.width}px`
      natural.style.height = `${g.height}px`
      const fitScale = (): void => {
        const k = Math.min(body.clientWidth / g.width, body.clientHeight / g.height)
        natural.style.transform = `scale(${Math.max(0.2, k).toFixed(4)})`
      }
      fitScale()
      ro = new ResizeObserver(fitScale)
      ro.observe(body)
      terminalHost.attachPeek(id, natural, specRef.current)
    } else {
      terminalHost.attach(id, body, specRef.current)
    }
    requestAnimationFrame(() => terminalHost.focus(id))

    // Something else detached it from here without claiming it (the grid's
    // pane unmounting): take it back rather than show an empty door.
    const mo = new MutationObserver(() => {
      const w = wrapperOf(id)
      if (w && w.parentElement) return
      if (!terminalHost.has(id)) return
      if (wasPeek) terminalHost.attachPeek(id, natural, specRef.current)
      else terminalHost.attach(id, body, specRef.current)
    })
    mo.observe(box, { childList: true })

    return () => {
      mo.disconnect()
      ro?.disconnect()
      const w = wrapperOf(id)
      // The grid already has it back: nothing of ours to return.
      if (!w || w.parentElement !== box) return
      if (before && before.isConnected) {
        if (wasPeek) {
          terminalHost.attachPeek(id, before, specRef.current)
          terminalHost.setWebgl(id, false)
        } else {
          terminalHost.attach(id, before, specRef.current)
        }
      } else {
        terminalHost.detach(id)
      }
    }
  }, [target.paneId])

  // Put the caret back in the terminal whenever the window comes back to it.
  useEffect(() => {
    const onFocus = (): void => terminalHost.focus(target.paneId)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [target.paneId])

  return (
    <div className="bmap-door__body" ref={bodyRef}>
      <div className="bmap-door__natural" ref={naturalRef} />
    </div>
  )
}
