import { useRef, useState, type ReactNode } from 'react'
import { countLeaves } from '@/lib/splitTree'
import { EmptyState } from '@/components/EmptyState'
import { Icon } from '@/components/Icon'
import { useNarrow } from '../lib/narrow'
import { useActiveProject, useForge, useWorkspace } from '../state'
import { AgentChooser } from './AgentChooser'
import { OfflineBanner } from './OfflineBanner'
import { Rail } from './Rail'
import { SplitView } from './Panes'
import { TabStrip } from './TabStrip'
import { TopBar } from './TopBar'

/**
 * Forge, as the browser draws it: the desktop's `.app` shell — titlebar, rail,
 * main — with the terminal grid inside it.
 *
 * The layout classes are the desktop's own, so this is the same application
 * furniture rather than a lookalike. What is missing from it is missing because
 * decision 7 says so: no screenshot tray, no voice hub, no overlay, no tasks
 * board, no settings page. A browser tab has none of the hardware any of those
 * are attached to, and a public URL that could reach them would be a different
 * risk class.
 */
export function Workspace(): ReactNode {
  const { state, actions } = useForge()
  const project = useActiveProject()
  const workspace = useWorkspace()
  const [railCollapsed, setRailCollapsed] = useState(false)
  const narrow = useNarrow()
  // Collapsed by the click, or collapsed by the window. One flag either way, so
  // the rail has one set of markup rather than a full row squeezed into 56px.
  const collapsed = railCollapsed || narrow
  const newTabRef = useRef<HTMLButtonElement | null>(null)
  const [chooserOpen, setChooserOpen] = useState(false)
  const offline = state.stage.kind === 'offline'

  const tab = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? workspace.tabs[0] ?? null

  // Nothing here listens for a window resize, on purpose: a window resize
  // changes every pane container's box, and each terminal's own ResizeObserver
  // (see lib/term.ts) already fits and reports on exactly that. A second
  // refit-everything path would send a duplicate `resize` per pane per drag.

  return (
    <div className="app" data-ready="true">
      <TopBar collapsed={collapsed} onToggleRail={() => setRailCollapsed((v) => !v)} />
      <OfflineBanner />
      <div className="app__body">
        <aside className="app__left" data-collapsed={collapsed}>
          <Rail collapsed={collapsed} />
        </aside>
        <main className="app__main">
          <div className="grid">
            <TabStrip />
            <div className="grid__body">
              {!project ? (
                <EmptyState
                  icon="folder"
                  eyebrow="Forge"
                  title="No project selected"
                  body="Pick one in the rail. Projects are added at the desk — a browser cannot choose a folder on somebody else’s disk."
                />
              ) : tab ? (
                <SplitView node={tab.root} activePaneId={tab.activePaneId} onlyPane={countLeaves(tab.root) === 1} />
              ) : (
                <EmptyState
                  icon="terminal"
                  eyebrow={project.name}
                  title="No terminals open"
                  body={
                    <>
                      Open one in <span className="mono">{project.path}</span>. It opens on the desktop too — this
                      browser mirrors that machine rather than running its own.
                    </>
                  }
                  action={
                    <button
                      ref={newTabRef}
                      type="button"
                      className="cta-btn"
                      disabled={offline}
                      onClick={() => setChooserOpen(true)}
                    >
                      <Icon name="plus" size={14} />
                      Open a terminal
                    </button>
                  }
                />
              )}
            </div>
          </div>
        </main>
      </div>

      {state.notice ? (
        <div className="notice" role="status">
          {state.notice}
        </div>
      ) : null}

      <AgentChooser
        anchor={newTabRef.current}
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        onPick={(profileId) => void actions.layout({ op: 'create-tab', profileId })}
        selectedId={project?.defaultProfileId}
      />
    </div>
  )
}
