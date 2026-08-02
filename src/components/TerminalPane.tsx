import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { PaneLeaf, Project } from '@shared/types'
import { isPaneDead, paneStatusLabel, usePaneRuntime } from '@/hooks/usePaneRuntime'
import {
  isClaudeCommand,
  launchCommand,
  leafPermissionMode,
  paneDisplayTitle,
  permissionChip,
  resolveProfile
} from '@/lib/agents'
import { droppedFilePaths } from '@/lib/paths'
import { terminalHost, type TerminalSpec } from '@/lib/terminals'
import { remoteControlName, REMOTE_CONTROL_URL } from '@shared/remote'
import { useApp } from '@/state/AppState'
import { ActivityDot } from './ActivityDot'
import { AgentBadge } from './AgentBadge'
import { AgentChooser } from './AgentChooser'
import { Icon } from './Icon'
import { Popover, PopoverDivider, PopoverRow } from './Popover'
import './TerminalPane.css'

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
  // The pane's own permission override beats the profile's default, and is what
  // actually goes on the command line — see launchCommand.
  const override = leafPermissionMode(leaf)
  const chip = permissionChip(profile, override)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const splitBtnRef = useRef<HTMLButtonElement | null>(null)
  const phoneBtnRef = useRef<HTMLButtonElement | null>(null)
  const menuAnchorRef = useRef<HTMLSpanElement | null>(null)
  const [chooser, setChooser] = useState<null | 'row' | 'column'>(null)
  const [phoneOpen, setPhoneOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null)
  const [dropping, setDropping] = useState(false)
  const runtime = usePaneRuntime(leaf.id)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(leaf.title)

  // The spec only matters on first attach; keep it in a ref so a font-size
  // change never tears the terminal down.
  const specRef = useRef<TerminalSpec>({
    cwd: project.path,
    bootstrapCommand: launchCommand(profile, override),
    fontSize: state.settings.terminalFontSize,
    fontFamily: state.settings.terminalFontFamily,
    accent: profile.accent,
    projectName: project.name,
    paneTitle: paneDisplayTitle(profile, leaf.title),
    sessionId: leaf.sessionId
  })
  specRef.current = {
    cwd: project.path,
    bootstrapCommand: launchCommand(profile, override),
    fontSize: state.settings.terminalFontSize,
    fontFamily: state.settings.terminalFontFamily,
    accent: profile.accent,
    projectName: project.name,
    paneTitle: paneDisplayTitle(profile, leaf.title),
    sessionId: leaf.sessionId
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

  /* ------------------------------------------------------------- focus */

  useEffect(() => {
    if (focused) terminalHost.focus(leaf.id)
  }, [focused, leaf.id])

  const claimFocus = useCallback(() => {
    if (!focused) actions.focusPane(leaf.id)
  }, [actions, focused, leaf.id])

  /**
   * Put the caret back in the terminal, whether or not React thinks anything
   * changed.
   *
   * `claimFocus` only dispatches when the pane is *not* the focused one, and
   * the effect above only fires when that flag moves — so a pane that is
   * already "focused" in app state but has lost DOM focus (you opened a
   * popover, renamed a tab, alt-tabbed away) had nothing left to hand the caret
   * back. That is the state where the cursor sits there as a still bar and
   * keystrokes go nowhere. Clicking the terminal now always re-asserts it.
   */
  const grabCaret = useCallback(() => {
    claimFocus()
    terminalHost.focus(leaf.id)
  }, [claimFocus, leaf.id])

  // Coming back to Forge from another app should land you where you left off,
  // not in a pane that is up but deaf.
  useEffect(() => {
    if (!focused) return
    const onWindowFocus = (): void => terminalHost.focus(leaf.id)
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [focused, leaf.id])

  /* -------------------------------------------------------------- title */

  const commitTitle = (): void => {
    setEditing(false)
    if (draft !== leaf.title) actions.renamePane(leaf.id, draft.trim())
  }

  /* ------------------------------------------------------- context menu */

  /** Every menu action hands focus straight back to the shell. */
  const runFromMenu = (fn: () => void): void => {
    fn()
    setMenu(null)
    terminalHost.focus(leaf.id)
  }

  /* --------------------------------------------------------- dropped files */

  /**
   * Whether a drag is worth taking. Deliberately generous: a drag whose
   * payload we cannot see yet counts as maybe-files.
   *
   * Being strict here is what made dropping an image a coin toss. The `drop`
   * event only fires at all if something called `preventDefault` on `dragover`
   * first — so any drag we decline mid-flight is a drop that never happens,
   * silently. An OS drag out of Explorer, and Electron's own `startDrag` from
   * the screenshot tray, do not always advertise `Files` in `types` on every
   * dragover. So we accept anything that is not plainly *not* a file, and sort
   * it out at drop time, where the real payload is finally readable.
   */
  const maybeFiles = (e: React.DragEvent): boolean => {
    const types = Array.from(e.dataTransfer.types)
    if (types.includes('Files')) return true
    // A tab being dragged around the strip is ours and is not a file.
    if (types.some((t) => t.startsWith('application/'))) return false
    return !types.includes('text/plain') && !types.includes('text/uri-list')
  }

  const acceptDrag = (e: React.DragEvent): void => {
    if (!maybeFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }

  /**
   * A file dropped on a pane types its quoted path at the cursor — which is
   * exactly what you want when you have just dragged a screenshot out of the
   * tray and onto an agent.
   *
   * Focus first, text second, and a frame between them. The path is delivered
   * as a bracketed paste, and an agent that has just been told the terminal
   * lost focus (xterm reports focus in/out to the program, DECSET 1004) can
   * drop the paste that follows — which is why this only ever worked reliably
   * on a pane you had already typed into. Now the pane is made focused, the
   * focus-in byte goes down the PTY, and the path arrives at a prompt that is
   * listening for it.
   */
  const onDropFiles = (e: React.DragEvent): void => {
    // Unconditional: an unprevented file drop makes Chromium navigate the
    // window to the file, which would take the whole app down with it.
    e.preventDefault()
    setDropping(false)
    const quoted = droppedFilePaths(e).map((p) => `"${p}"`)
    if (quoted.length === 0) return
    claimFocus()
    terminalHost.focus(leaf.id)
    requestAnimationFrame(() => terminalHost.paste(leaf.id, `${quoted.join(' ')} `))
  }

  const statusLabel = paneStatusLabel(runtime)

  /* ------------------------------------------------------ remote control */

  /**
   * Mirrors `wantsRemoteControl` in electron/bridge/remote-control.ts: the
   * app-wide switch, the profile flag, and a command that really is Claude
   * Code. Recomputed rather than reported back from main so the header updates
   * the moment the setting changes, without a round trip.
   */
  const remoteOn =
    state.settings.remoteControlDefault && profile.remoteControl === true && isClaudeCommand(profile.command)

  // The title the session was launched under, not the one it now wears — see
  // terminalHost.launchedAs.
  const launched = terminalHost.launchedAs(leaf.id)
  const remoteName = remoteControlName(
    launched?.projectName ?? project.name,
    launched?.paneTitle ?? paneDisplayTitle(profile, leaf.title)
  )

  // Claude prints its session URL once Remote Control connects, and the pane
  // reads it off its own screen (see terminalHost.scanForRemoteUrl). Until it
  // appears — not signed in, still starting, no network — the button falls back
  // to the session list, which is never wrong, only less direct.
  const remoteUrl = runtime.remoteUrl ?? REMOTE_CONTROL_URL
  const remoteConnected = runtime.remoteUrl !== null

  return (
    <section
      className="pane"
      data-pane-id={leaf.id}
      data-focused={focused}
      data-status={runtime.status}
      data-dropping={dropping ? 'true' : undefined}
      style={{ '--pane-accent': profile.accent } as React.CSSProperties}
      onPointerDownCapture={claimFocus}
      onFocusCapture={claimFocus}
      onDragEnter={acceptDrag}
      onDragOver={acceptDrag}
      onDragLeave={(e) => {
        // Ignore the flurry of leave events from crossing child elements.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropping(false)
      }}
      onDrop={onDropFiles}
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

        {/* A pane that never asks permission says so, always. */}
        {chip ? (
          <span
            className="pane__perm mono"
            data-danger={chip.danger ? 'true' : undefined}
            title={
              chip.danger
                ? 'Launched with --dangerously-skip-permissions: this agent will not ask before acting'
                : `Launched in ${chip.label.toLowerCase()} mode`
            }
          >
            {chip.label}
          </span>
        ) : null}

        <ActivityDot paneId={leaf.id} status={runtime.status} />

        {statusLabel ? <span className="pane__status mono">{statusLabel}</span> : null}

        {/* Outside .pane__actions: the actions strip only appears on hover, and
            "you can pick this up on your phone" is a property of the pane worth
            seeing at a glance. */}
        {remoteOn ? (
          <button
            ref={phoneBtnRef}
            type="button"
            className="ghost-btn pane__phone"
            data-open={phoneOpen ? 'true' : undefined}
            data-connected={remoteConnected ? 'true' : undefined}
            title={
              remoteConnected
                ? 'Remote Control is live — drivable from the Claude app'
                : 'Remote-controllable from the Claude app'
            }
            aria-label={`Remote control — this session appears as ${remoteName}`}
            onClick={() => setPhoneOpen((v) => !v)}
          >
            <Icon name="phone" size={12} />
          </button>
        ) : null}

        <div className="pane__actions">
          {isPaneDead(runtime) ? (
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

      <div
        className="pane__terminal"
        ref={containerRef}
        onPointerDown={grabCaret}
        onContextMenu={(e) => {
          e.preventDefault()
          claimFocus()
          setMenu({ x: e.clientX, y: e.clientY, hasSelection: terminalHost.hasSelection(leaf.id) })
        }}
      />

      {/* A zero-size anchor parked at the cursor, so the context menu is the
          same Popover primitive as every other menu in Forge. */}
      <span
        ref={menuAnchorRef}
        className="pane__menu-anchor"
        aria-hidden="true"
        style={menu ? { left: menu.x, top: menu.y } : undefined}
      />

      <Popover
        anchor={menu ? menuAnchorRef.current : null}
        open={menu !== null}
        onClose={() => setMenu(null)}
        width={186}
        label="Terminal actions"
      >
        <PopoverRow
          disabled={!menu?.hasSelection}
          onClick={() => runFromMenu(() => terminalHost.copySelectionToClipboard(leaf.id))}
        >
          <span className="pane__menu-name">Copy</span>
          <span className="pane__menu-keys mono">Ctrl+C</span>
        </PopoverRow>
        <PopoverRow onClick={() => runFromMenu(() => void terminalHost.pasteFromClipboard(leaf.id))}>
          <span className="pane__menu-name">Paste</span>
          <span className="pane__menu-keys mono">Ctrl+V</span>
        </PopoverRow>
        <PopoverDivider />
        <PopoverRow onClick={() => runFromMenu(() => terminalHost.selectAll(leaf.id))}>
          <span className="pane__menu-name">Select all</span>
        </PopoverRow>
        {/* For a TUI that has come out garbled: makes the program repaint,
            without touching the scrollback the way Clear does. */}
        <PopoverRow onClick={() => runFromMenu(() => terminalHost.redraw(leaf.id))}>
          <span className="pane__menu-name">Redraw</span>
        </PopoverRow>
        <PopoverRow onClick={() => runFromMenu(() => terminalHost.clear(leaf.id))}>
          <span className="pane__menu-name">Clear</span>
        </PopoverRow>
      </Popover>

      <Popover
        anchor={phoneBtnRef.current}
        open={phoneOpen}
        onClose={() => setPhoneOpen(false)}
        align="end"
        width={272}
        label="Remote control"
      >
        <div className="popover__hint pane__remote-body">
          <p>
            This session is remote-controllable — open the Claude app on your phone → <strong>Code</strong> tab.
          </p>
          <p>
            Sessions appear as <span className="mono pane__remote-name">{remoteName}</span>
          </p>
          <p className="pane__remote-note">
            While a Forge window has focus, notifications stay on this machine. Walk away and they follow you.
          </p>
          {remoteConnected ? null : (
            <p className="pane__remote-note">
              Waiting for Claude to connect — the direct link appears here once it has.
            </p>
          )}
        </div>
        <div className="popover__actions">
          <button
            type="button"
            className="cta-btn"
            title={remoteUrl}
            onClick={() => {
              setPhoneOpen(false)
              void window.forge.openExternal(remoteUrl)
            }}
          >
            {remoteConnected ? 'Open this session' : 'Open claude.ai/code'}
          </button>
        </div>
      </Popover>

      <AgentChooser
        anchor={splitBtnRef.current}
        open={chooser !== null}
        align="end"
        title={chooser === 'column' ? 'Split down with' : 'Split right with'}
        onClose={() => setChooser(null)}
        onPick={(profileId, permissionMode) => {
          if (chooser) actions.splitPane(leaf.id, chooser, profileId, permissionMode)
        }}
      />
    </section>
  )
}
