import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PaneLeaf, TerminalTab } from '@shared/types'
import { useCallSign, useCallSigns } from '@/hooks/useHub'
import { usePaneRuntime } from '@/hooks/usePaneRuntime'
import { NEW_TAB_EVENT } from '@/hooks/useShortcuts'
import { paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { HUB_COMPOSER_EVENT, type HubComposerDetail } from '@/lib/hubnav'
import { fireComet } from '@/lib/motion'
import { usePaneActivity } from '@/lib/paneActivity'
import { composerRouteNow, shellSheet, toolsHost, useDockVoice, useShellSheet } from '@/lib/shellSlots'
import { collectLeaves, findLeaf } from '@/lib/splitTree'
import { terminalHost } from '@/lib/terminals'
import { useUiCommand } from '@/lib/uiCommands'
import { useDictation } from '@/state/Dictation'
import { useActiveProject, useActiveTab, useActiveWorkspace, useApp, usePaneCount, useViewMode } from '@/state/AppState'
import { AgentBadge } from '../AgentBadge'
import { AgentButton } from '../AgentButton'
import { DictationPill } from '../DictationPill'
import { Icon } from '../Icon'
import { RailStack } from '../rail/RailStack'
import { Sheet, toggleSheet } from './Sheet'
import { StateChip } from './StateChip'
import './Dock.css'

/**
 * The dock: the whole of the deck's bottom edge, and nothing else.
 *
 *   project pill   which project you are in; opens the project sheet (every
 *                  project, with its tasks, git, activity and share sections —
 *                  everything the old left rail held).
 *   composer       type or speak. Enter sends to the pane you are in, the same
 *                  keystrokes a hand at that prompt would make; the mic is the
 *                  existing dictation engine.
 *   panes pill     how many panes, and a switcher over all of them.
 *   tools          the references that used to crowd a second toolbar row:
 *                  Skills, Commands, tab colours, canvas text size, reset.
 *   voice socket   the agent switch and the dictation pill — or, once the voice
 *                  hub plugs in (setDockVoice), whatever it puts here.
 *
 * It floats over the backdrop, below the stage, so it never covers a terminal
 * and its glass only ever blurs a still picture.
 */
export function Dock(): ReactNode {
  const project = useActiveProject()
  return (
    <div className="dock" role="toolbar" aria-label="Dock">
      <ProjectPill />
      {project ? <Composer /> : <div className="dock__composer dock__composer--idle">Add a project to start</div>}
      <PanesPill />
      <ToolsPill />
      <VoiceSocket />
      <ProjectSheet />
      <PanesSheet />
      <ToolsSheet />
    </div>
  )
}

/* ------------------------------------------------------------ project pill */

function ProjectPill(): ReactNode {
  const project = useActiveProject()
  const open = useShellSheet() === 'projects'
  useUiCommand('open-project-sheet', () => shellSheet.set('projects'))
  useUiCommand('close-project-sheet', () => {
    if (shellSheet.get() === 'projects') shellSheet.set(null)
  })
  useUiCommand('toggle-project-sheet', () => toggleSheet('projects'))

  return (
    <button
      type="button"
      className="dock__pill dock__project"
      data-open={open ? 'true' : undefined}
      data-sheet-toggle="projects"
      aria-expanded={open}
      title="Projects (Ctrl+Shift+B)"
      style={{ '--project': project?.color ?? 'var(--accent)' } as React.CSSProperties}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => toggleSheet('projects')}
    >
      <span className="dock__project-dot" aria-hidden="true" />
      <span className="dock__project-name truncate">{project?.name ?? 'No project'}</span>
      <Icon name="chevronDown" size={11} className="dock__chev" />
    </button>
  )
}

function ProjectSheet(): ReactNode {
  const { state } = useApp()
  // Picking a project is the end of the errand: the sheet goes, the way a menu
  // does, and the deck changes under it.
  const projectId = state.activeProjectId
  const lastProject = useRef(projectId)
  useEffect(() => {
    if (lastProject.current === projectId) return
    lastProject.current = projectId
    if (shellSheet.get() === 'projects') shellSheet.set(null)
  }, [projectId])
  // The rail's own sections carry their headers and add buttons; the sheet
  // adds nothing above them.
  return (
    <Sheet id="projects" className="sheet--projects" label="Projects" keepOpen={state.railExpanded !== null}>
      <div className="sheet__rail">
        <RailStack />
      </div>
    </Sheet>
  )
}

/* ---------------------------------------------------------------- composer */

/** Fire the keys a hand at the prompt would: the text, a beat, then Enter. */
function sendToPane(paneId: string, text: string): boolean {
  if (!terminalHost.has(paneId)) return false
  const ok = text.includes('\n') ? (terminalHost.paste(paneId, text), true) : terminalHost.type(paneId, text)
  if (!ok) return false
  // A beat between the text and the Enter: a TUI that has just taken a paste
  // needs a frame to settle before a carriage return means "send" to it.
  window.setTimeout(() => terminalHost.submit(paneId), 70)
  return true
}

function Composer(): ReactNode {
  const { state, actions } = useApp()
  const tab = useActiveTab()
  const dictation = useDictation()
  const [text, setText] = useState('')
  const fieldRef = useRef<HTMLTextAreaElement | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)

  const paneId = tab?.activePaneId ?? null
  const leaf = tab && paneId ? findLeaf(tab.root, paneId) : null
  const profile = leaf ? resolveProfile(state.settings.agentProfiles, leaf.profileId) : null
  const callSign = useCallSign(paneId ?? '')
  const targetName = leaf && profile ? (callSign ?? paneDisplayTitle(profile, leaf.title)) : null

  const listening = dictation.listening
  const level = listening ? Math.min(1, Math.max(0, dictation.status.level)) : 0

  // Grow upward with the text, one line at a time, to five; then scroll.
  useLayoutEffect(() => {
    const el = fieldRef.current
    if (!el) return
    // Border-box, so scrollHeight (content + padding) is the height to take.
    el.style.height = '0px'
    el.style.height = `${Math.min(Math.max(34, el.scrollHeight), 5 * 20 + 14)}px`
  }, [text])

  const focusField = (): void => fieldRef.current?.focus()
  useUiCommand('focus-composer', focusField)
  useUiCommand('blur-composer', () => {
    fieldRef.current?.blur()
    if (paneId) terminalHost.focus(paneId)
  })
  useUiCommand('toggle-composer', () => {
    if (document.activeElement === fieldRef.current) {
      fieldRef.current?.blur()
      if (paneId) terminalHost.focus(paneId)
    } else focusField()
  })

  const send = (raw: string): void => {
    const message = raw.replace(/\s+$/, '')
    if (!message.trim()) return
    const route = composerRouteNow()
    if (route?.({ text: message, paneId })) {
      setText('')
      return
    }
    if (!paneId) {
      actions.setNotice('Open a pane first — the composer types into the pane you are in')
      return
    }
    if (!sendToPane(paneId, message)) {
      actions.setNotice('That pane has no live shell to send to')
      return
    }
    setText('')
    const target = document.querySelector(`.pane[data-pane-id="${paneId}"], .mtile[data-pane-id="${paneId}"]`)
    if (target && shellRef.current) fireComet(shellRef.current, target, profile?.accent ?? '#c6ff4a')
  }

  // A saved prompt aimed at the composer lands here (B2's saved prompts).
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    const on = (e: Event): void => {
      const detail = (e as CustomEvent<HubComposerDetail>).detail
      if (!detail || typeof detail.text !== 'string') return
      if (detail.submit) {
        sendRef.current(detail.text)
        return
      }
      setText(detail.text)
      requestAnimationFrame(() => fieldRef.current?.focus())
    }
    window.addEventListener(HUB_COMPOSER_EVENT, on)
    return () => window.removeEventListener(HUB_COMPOSER_EVENT, on)
  }, [])

  const placeholder = listening
    ? 'Listening…'
    : targetName
      ? `Type or speak to ${targetName}`
      : 'Type or speak'

  return (
    <div
      ref={shellRef}
      className="dock__composer"
      data-listening={listening ? 'true' : undefined}
      data-empty={text ? undefined : 'true'}
      style={{ '--pane-accent': profile?.accent ?? 'var(--accent)', '--lvl': level } as React.CSSProperties}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
          focusField()
        }
      }}
    >
      {/*
        The mic. It never takes focus: pressing it leaves the keyboard wherever
        it was, so dictation lands in the pane you were typing in — or in this
        box, if that is where you were. Same engine, same Right Ctrl.
      */}
      <button
        type="button"
        className="dock__mic"
        data-on={listening ? 'true' : undefined}
        aria-pressed={listening}
        title={listening ? 'Stop dictation' : 'Dictate (Right Ctrl)'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => dictation.toggle()}
      >
        <span className="dock__bars" aria-hidden="true">
          {[0.55, 0.85, 1, 0.75, 0.5].map((w, i) => (
            <span key={i} style={{ '--w': w } as React.CSSProperties} />
          ))}
        </span>
        {listening ? <span className="dock__mic-word">Listening</span> : null}
      </button>

      <textarea
        ref={fieldRef}
        className="dock__field"
        rows={1}
        value={text}
        spellCheck
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send(text)
            return
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            fieldRef.current?.blur()
            if (paneId) terminalHost.focus(paneId)
          }
        }}
      />

      {targetName ? (
        <button
          type="button"
          className="dock__target"
          title="Sending to this pane — click to pick another"
          data-sheet-toggle="panes"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggleSheet('panes')}
        >
          <span className="dock__target-arrow" aria-hidden="true">
            →
          </span>
          <span className="truncate">{targetName}</span>
        </button>
      ) : null}
      <span className="dock__enter" aria-hidden="true">
        ⏎
      </span>
    </div>
  )
}

/* -------------------------------------------------------------- panes pill */

function PanesPill(): ReactNode {
  const { used, max } = usePaneCount()
  const workspace = useActiveWorkspace()
  const count = workspace.tabs.reduce((n, t) => n + collectLeaves(t.root).length, 0)
  const open = useShellSheet() === 'panes'
  useUiCommand('open-panes-switcher', () => shellSheet.set('panes'))
  useUiCommand('close-panes-switcher', () => {
    if (shellSheet.get() === 'panes') shellSheet.set(null)
  })
  useUiCommand('toggle-panes-switcher', () => toggleSheet('panes'))

  return (
    <button
      type="button"
      className="dock__pill dock__panes"
      data-open={open ? 'true' : undefined}
      data-sheet-toggle="panes"
      aria-expanded={open}
      title={`Panes in this project: ${count} · all projects ${used}/${max}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => toggleSheet('panes')}
    >
      <Icon name="viewMosaic" size={13} />
      <span className="dock__count">{count}</span>
      <span className="dock__pill-word">{count === 1 ? 'pane' : 'panes'}</span>
    </button>
  )
}

interface Row {
  leaf: PaneLeaf
  tab: TerminalTab
}

function PanesSheet(): ReactNode {
  const { state, actions } = useApp()
  const workspace = useActiveWorkspace()
  const viewMode = useViewMode()
  const { used, max } = usePaneCount()
  const open = useShellSheet() === 'panes'
  const { map: callSigns } = useCallSigns()
  const rows = useMemo<Row[]>(
    () => workspace.tabs.flatMap((tab) => collectLeaves(tab.root).map((leaf) => ({ leaf, tab }))),
    [workspace.tabs]
  )
  const activeTab = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? null
  const currentId = activeTab?.activePaneId ?? null
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Only on opening: moving the cursor must not snap back to the current pane.
  const openedAt = useRef({ rows, currentId })
  openedAt.current = { rows, currentId }
  useEffect(() => {
    if (!open) return
    const { rows: list, currentId: here } = openedAt.current
    const i = list.findIndex((r) => r.leaf.id === here)
    setCursor(i < 0 ? 0 : i)
    requestAnimationFrame(() => listRef.current?.focus())
  }, [open])

  const pick = (row: Row): void => {
    shellSheet.set(null)
    actions.revealPane(row.leaf.id)
    requestAnimationFrame(() => terminalHost.focus(row.leaf.id))
  }

  return (
    <Sheet id="panes" className="sheet--panes" label="Panes">
      <header className="sheet__head">
        <span className="sheet__eyebrow">Panes</span>
        <span className="sheet__count mono">
          {rows.length} here · {used}/{max} in all
        </span>
        <div className="sheet__seg" role="group" aria-label="View">
          <button
            type="button"
            data-active={viewMode === 'tabs' ? 'true' : undefined}
            onClick={() => actions.setViewMode('tabs')}
            title="Tab view (Ctrl+G)"
          >
            Tabs
          </button>
          <button
            type="button"
            data-active={viewMode === 'mosaic' ? 'true' : undefined}
            onClick={() => actions.setViewMode('mosaic')}
            title="Canvas — every pane at once (Ctrl+G)"
          >
            Canvas
          </button>
        </div>
      </header>
      <div
        ref={listRef}
        className="sheet__list"
        role="listbox"
        aria-label="Panes"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const step = e.key === 'ArrowDown' ? 1 : -1
            setCursor((c) => (rows.length ? (c + step + rows.length) % rows.length : 0))
            return
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            const row = rows[cursor]
            if (row) pick(row)
            return
          }
          if (/^[1-9]$/.test(e.key)) {
            const row = rows[Number(e.key) - 1]
            if (row) {
              e.preventDefault()
              pick(row)
            }
          }
        }}
      >
        {rows.length === 0 ? <div className="sheet__empty">No panes yet in this project.</div> : null}
        {rows.map((row, i) => (
          <PaneRow
            key={row.leaf.id}
            row={row}
            index={i}
            callSign={callSigns[row.leaf.id] ?? null}
            current={row.leaf.id === currentId}
            cursor={i === cursor}
            showTab={workspace.tabs.length > 1}
            profiles={state.settings.agentProfiles}
            onHover={() => setCursor(i)}
            onPick={() => pick(row)}
          />
        ))}
      </div>
      <footer className="sheet__foot">
        <button
          type="button"
          className="cta-btn sheet__new"
          onClick={() => {
            shellSheet.set(null)
            window.dispatchEvent(new CustomEvent(NEW_TAB_EVENT))
          }}
        >
          <Icon name="plus" size={13} />
          New agent
        </button>
        <span className="sheet__keys mono">↑↓ pick · 1–9 jump · Enter go</span>
      </footer>
    </Sheet>
  )
}

function PaneRow({
  row,
  index,
  callSign,
  current,
  cursor,
  showTab,
  profiles,
  onHover,
  onPick
}: {
  row: Row
  index: number
  callSign: string | null
  current: boolean
  cursor: boolean
  showTab: boolean
  profiles: Parameters<typeof resolveProfile>[0]
  onHover: () => void
  onPick: () => void
}): ReactNode {
  const profile = resolveProfile(profiles, row.leaf.profileId)
  const runtime = usePaneRuntime(row.leaf.id)
  const activity = usePaneActivity(row.leaf.id, runtime)
  const title = paneDisplayTitle(profile, row.leaf.title)
  return (
    <button
      type="button"
      role="option"
      aria-selected={cursor}
      className="prow"
      data-current={current ? 'true' : undefined}
      data-cursor={cursor ? 'true' : undefined}
      style={{ '--pane-accent': profile.accent } as React.CSSProperties}
      onPointerEnter={onHover}
      onClick={onPick}
    >
      <span className="prow__num mono">{index + 1}</span>
      <AgentBadge profile={profile} size="sm" />
      <span className="prow__name truncate">{callSign ?? title}</span>
      <span className="prow__kind truncate">
        {callSign ? title : title === profile.name ? '' : profile.name}
        {showTab ? ` · ${row.tab.title}` : ''}
      </span>
      <StateChip activity={activity} />
      {current ? <span className="prow__here">here</span> : null}
    </button>
  )
}

/* ------------------------------------------------------------------ tools */

function ToolsPill(): ReactNode {
  const open = useShellSheet() === 'tools'
  useUiCommand('toggle-tools', () => toggleSheet('tools'))
  return (
    <button
      type="button"
      className="dock__pill dock__tools"
      data-open={open ? 'true' : undefined}
      data-sheet-toggle="tools"
      aria-expanded={open}
      aria-label="Tools"
      title="Tools — Skills, Commands, tab colours, canvas text"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => toggleSheet('tools')}
    >
      <Icon name="dots" size={15} />
      <span className="dock__pill-word">Tools</span>
    </button>
  )
}

/**
 * The Tools sheet is only a host: TerminalGrid portals its reference buttons
 * into it (see toolsHost), so every one keeps its own flyout and behaviour.
 */
function ToolsSheet(): ReactNode {
  return (
    <Sheet id="tools" className="sheet--tools" label="Tools">
      <header className="sheet__head">
        <span className="sheet__eyebrow">Tools</span>
      </header>
      <div className="sheet__tools" ref={toolsHost.set}>
        <span className="sheet__tools-empty">Open Agents to use these.</span>
      </div>
    </Sheet>
  )
}

/* ------------------------------------------------------------ voice socket */

/**
 * The voice hub's dock. Today: the agent switch and the dictation pill, moved
 * here from the status bar unchanged (the pill is also where the floating hub
 * docks back to). The live voice hub replaces both with `setDockVoice`.
 */
function VoiceSocket(): ReactNode {
  const Plugged = useDockVoice()
  return (
    <div className="dock__voice" data-plugged={Plugged ? 'true' : undefined}>
      {Plugged ? (
        <Plugged />
      ) : (
        <>
          <AgentButton />
          <DictationPill />
        </>
      )}
    </div>
  )
}
