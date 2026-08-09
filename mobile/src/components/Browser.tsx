import { useState } from 'react'
import type { ClaudePermissionMode, LayoutNode, PaneLeaf, Project, Workspace } from '@shared/types'
import type { MobileSession } from '@shared/mobile'
import type { LinkPicture } from '../lib/link'
import { NewTabSheet } from './NewTab'
import { SendToTvSheet } from './SendToTv'

/**
 * Projects → tabs → panes: the phone's way into the desktop.
 *
 * Splits are deliberately *not* rendered as splits. A pane tree that reads well
 * on a 27" monitor is four unreadable slivers on a phone, so a tab's layout is
 * flattened to its leaves in visual order and each becomes a row. The split
 * structure is still there on the desktop and untouched — this is a lens, not
 * an edit.
 */

/** A tab's panes, left-to-right / top-to-bottom, which is reading order. */
export function leavesOf(node: LayoutNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node]
  return [...leavesOf(node.a), ...leavesOf(node.b)]
}

export interface BrowserProps {
  picture: LinkPicture
  /** Null shows the project list; set shows that project's tabs. */
  projectId: string | null
  onOpenProject: (projectId: string) => void
  onOpenPane: (session: MobileSession, title: string) => void
  /** The chooser has already decided both of these; the caller only sends them. */
  onNewTab: (projectId: string, profileId: string, permissionMode?: ClaudePermissionMode) => void
  /** A YouTube id, already extracted, bound for whatever television is paired. */
  onSendToTv: (video: string) => void
  onBack: () => void
}

export function Browser({
  picture,
  projectId,
  onOpenProject,
  onOpenPane,
  onNewTab,
  onSendToTv,
  onBack
}: BrowserProps): React.JSX.Element {
  // Declared above the project-list branch below, because a hook cannot live
  // after an early return.
  const [choosing, setChoosing] = useState(false)
  const [flinging, setFlinging] = useState(false)
  const project = picture.projects.find((p) => p.id === projectId) ?? null

  if (!project) {
    return (
      <div className="screen">
        <header className="bar">
          <div className="bar-title">
            <strong>Forge</strong>
            <span className="bar-sub">{picture.projects.length} projects</span>
          </div>
          {/* The top of the app, where the phone is not yet inside anything.
              Sending a video has nothing to do with which project is open, and
              hanging it off a project's bar would imply that it did. */}
          <button type="button" className="bar-tv" onClick={() => setFlinging(true)}>
            Send to TV
          </button>
        </header>
        <ul className="list">
          {picture.projects.map((p) => (
            <ProjectRow key={p.id} project={p} picture={picture} onOpen={() => onOpenProject(p.id)} />
          ))}
          {picture.projects.length === 0 && <li className="empty">No projects open on the desktop.</li>}
        </ul>
        {flinging && (
          <SendToTvSheet
            onCancel={() => setFlinging(false)}
            onSend={(video) => {
              setFlinging(false)
              onSendToTv(video)
            }}
          />
        )}
      </div>
    )
  }

  const workspace: Workspace = picture.workspaces[project.id] ?? { tabs: [], activeTabId: null }
  const live = new Set(picture.sessions.map((s) => s.id))
  const sessionOf = (id: string): MobileSession | undefined => picture.sessions.find((s) => s.id === id)

  return (
    <div className="screen">
      <header className="bar">
        <button type="button" className="bar-back" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <div className="bar-title">
          <strong style={{ color: project.color }}>{project.name}</strong>
          <span className="bar-sub">
            {workspace.tabs.length} {workspace.tabs.length === 1 ? 'tab' : 'tabs'}
          </span>
        </div>
      </header>

      <ul className="list">
        {workspace.tabs.map((tab) => {
          const leaves = leavesOf(tab.root)
          return (
            <li key={tab.id} className="tab-group">
              <div className="tab-head">
                <span className="tab-dot" style={{ background: tab.color ?? project.color }} />
                <span className="tab-name">{tab.title || 'Tab'}</span>
                {tab.id === workspace.activeTabId && <span className="tab-active">on screen</span>}
              </div>
              {leaves.map((leaf) => {
                const session = sessionOf(leaf.id)
                const profile = picture.profiles.find((p) => p.id === leaf.profileId)
                const running = live.has(leaf.id)
                return (
                  <button
                    type="button"
                    key={leaf.id}
                    className="pane-row"
                    disabled={!running}
                    onClick={() => session && onOpenPane(session, leaf.title || profile?.name || 'Terminal')}
                  >
                    <span className="pane-badge" style={{ background: profile?.accent ?? '#444' }}>
                      {profile?.badge ?? '··'}
                    </span>
                    <span className="pane-name">{leaf.title || profile?.name || 'Terminal'}</span>
                    <span className={`pane-state ${running ? 'is-live' : ''}`}>
                      {running ? `${session?.cols}×${session?.rows}` : 'not running'}
                    </span>
                  </button>
                )
              })}
            </li>
          )
        })}
        {workspace.tabs.length === 0 && <li className="empty">No tabs in this project yet.</li>}
      </ul>

      <div className="screen-foot">
        <button type="button" className="primary" onClick={() => setChoosing(true)}>
          New tab
        </button>
      </div>

      {choosing && (
        <NewTabSheet
          project={project}
          profiles={picture.profiles}
          onCancel={() => setChoosing(false)}
          onOpen={(profileId, permissionMode) => {
            setChoosing(false)
            onNewTab(project.id, profileId, permissionMode)
          }}
        />
      )}
    </div>
  )
}

function ProjectRow({
  project,
  picture,
  onOpen
}: {
  project: Project
  picture: LinkPicture
  onOpen: () => void
}): React.JSX.Element {
  const workspace = picture.workspaces[project.id]
  const tabs = workspace?.tabs.length ?? 0
  const live = new Set(picture.sessions.map((s) => s.id))
  const panes = (workspace?.tabs ?? []).flatMap((t) => leavesOf(t.root)).filter((l) => live.has(l.id)).length

  return (
    <li>
      <button type="button" className="project-row" onClick={onOpen}>
        <span className="project-dot" style={{ background: project.color }} />
        <span className="project-name">{project.name}</span>
        <span className="project-meta">
          {panes > 0 ? `${panes} live` : tabs > 0 ? `${tabs} tabs` : 'idle'}
        </span>
      </button>
    </li>
  )
}
