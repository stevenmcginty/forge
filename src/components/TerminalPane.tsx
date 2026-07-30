import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { PaneLeaf, Project } from '@shared/types'
import { paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { terminalHost, type PaneRuntime, type TerminalSpec } from '@/lib/terminals'
import { useApp } from '@/state/AppState'
import { AgentBadge } from './AgentBadge'
import { AgentChooser } from './AgentChooser'
import { Icon } from './Icon'
import './TerminalPane.css'

const ACTIVITY_HOLD_MS = 620

/**
 * One terminal: a slim header (badge, editable title, activity dot, split and
 * close affordances) over a live xterm. The xterm itself is owned by
 * terminalHost — this component only lends it a container.
 */
export function TerminalPane({
  leaf,
  project,
  focused,
  onlyPane
}: {
  leaf: PaneLeaf
  project: Project
  focused: boolean
  onlyPane: boolean
}): ReactNode {
  const { state, actions } = useApp()
  const profile = resolveProfile(state.settings.agentProfiles, leaf.profileId)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const dotRef = useRef<HTMLSpanElement | null>(null)
  const splitBtnRef = useRef<HTMLButtonElement | null>(null)
  const [chooser, setChooser] = useState<null | 'row' | 'column'>(null)
  const [runtime, setRuntime] = useState<PaneRuntime>(() => terminalHost.runtime(leaf.id))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(leaf.title)

  // The spec only matters on first attach; keep it in a ref so a font-size
  // change never tears the terminal down.
  const specRef = useRef<TerminalSpec>({
    cwd: project.path,
    bootstrapCommand: profile.command,
    fontSize: state.settings.terminalFontSize,
    fontFamily: state.settings.terminalFontFamily,
    accent: profile.accent
  })
  specRef.current = {
    cwd: project.path,
    bootstrapCommand: profile.command,
    fontSize: state.settings.terminalFontSize,
    fontFamily: state.settings.terminalFontFamily,
    accent: profile.accent
  }

  /* ------------------------------------------------------------- attach */

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    terminalHost.attach(leaf.id, el, specRef.current)
    return () => terminalHost.detach(leaf.id)
  }, [leaf.id])

  useEffect(() => {
    terminalHost.updateAccent(leaf.id, profile.accent)
  }, [leaf.id, profile.accent])

  /* ------------------------------------------------------- subscriptions */

  useEffect(() => {
    setRuntime(terminalHost.runtime(leaf.id))
    return terminalHost.subscribeRuntime(leaf.id, setRuntime)
  }, [leaf.id])

  useEffect(() => {
    let timer: number | undefined
    const unsub = terminalHost.subscribeActivity(leaf.id, () => {
      const dot = dotRef.current
      if (!dot) return
      dot.classList.add('is-active')
      if (timer) clearTimeout(timer)
      timer = window.setTimeout(() => dot.classList.remove('is-active'), ACTIVITY_HOLD_MS)
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [leaf.id])

  /* ------------------------------------------------------------- focus */

  useEffect(() => {
    if (focused) terminalHost.focus(leaf.id)
  }, [focused, leaf.id])

  const claimFocus = useCallback(() => {
    if (!focused) actions.focusPane(leaf.id)
  }, [actions, focused, leaf.id])

  /* -------------------------------------------------------------- title */

  const commitTitle = (): void => {
    setEditing(false)
    if (draft !== leaf.title) actions.renamePane(leaf.id, draft.trim())
  }

  const statusLabel =
    runtime.status === 'exited'
      ? `exited ${runtime.exitCode ?? ''}`.trim()
      : runtime.status === 'error'
        ? 'failed'
        : runtime.status === 'starting'
          ? 'starting'
          : runtime.status === 'live'
            ? runtime.pid && runtime.pid > 0
              ? `pid ${runtime.pid}`
              : 'live'
            : ''

  return (
    <section
      className="pane"
      data-pane-id={leaf.id}
      data-focused={focused}
      data-status={runtime.status}
      style={{ '--pane-accent': profile.accent } as React.CSSProperties}
      onPointerDownCapture={claimFocus}
      onFocusCapture={claimFocus}
    >
      <header className="pane__header">
        <AgentBadge profile={profile} size="sm" />

        {editing ? (
          <input
            className="pane__title-input"
            value={draft}
            autoFocus
            spellCheck={false}
            placeholder={profile.name}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitTitle()
              if (e.key === 'Escape') {
                setDraft(leaf.title)
                setEditing(false)
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="pane__title truncate"
            title="Click to rename"
            onClick={() => {
              setDraft(leaf.title)
              setEditing(true)
            }}
          >
            {paneDisplayTitle(profile, leaf.title)}
          </button>
        )}

        <span ref={dotRef} className="pane__dot" aria-hidden="true" />

        {statusLabel ? <span className="pane__status mono">{statusLabel}</span> : null}

        <div className="pane__actions">
          {runtime.status === 'exited' || runtime.status === 'error' ? (
            <button
              type="button"
              className="ghost-btn pane__action"
              title="Relaunch this pane"
              onClick={() => actions.restartPane(leaf.id)}
            >
              <Icon name="restart" size={13} />
            </button>
          ) : null}
          <button
            ref={splitBtnRef}
            type="button"
            className="ghost-btn pane__action"
            title="Split right (Ctrl+Shift+→)"
            onClick={() => setChooser('row')}
          >
            <Icon name="splitRight" size={13} />
          </button>
          <button
            type="button"
            className="ghost-btn pane__action"
            title="Split down (Ctrl+Shift+↓)"
            onClick={() => setChooser('column')}
          >
            <Icon name="splitDown" size={13} />
          </button>
          <button
            type="button"
            className="ghost-btn pane__action"
            data-danger="true"
            title={onlyPane ? 'Close tab (Ctrl+W)' : 'Close pane (Ctrl+W)'}
            onClick={() => actions.closePane(leaf.id)}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </header>

      <div className="pane__terminal" ref={containerRef} />

      <AgentChooser
        anchor={splitBtnRef.current}
        open={chooser !== null}
        align="end"
        title={chooser === 'column' ? 'Split down with' : 'Split right with'}
        onClose={() => setChooser(null)}
        onPick={(profileId) => {
          if (chooser) actions.splitPane(leaf.id, chooser, profileId)
        }}
      />
    </section>
  )
}
