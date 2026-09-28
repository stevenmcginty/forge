import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AgentBadge } from '@/components/AgentBadge'
import { Icon } from '@/components/Icon'
import { chatLeafOf } from '@/lib/splitTree'
import type { ChatLeaf, TerminalTab } from '@shared/types'
import { AgentChooser } from '../components/AgentChooser'
import { ChatTabChip } from '../components/ChatBadge'
import { useActiveProject, useForge, useWorkspace } from '../state'
import { AgentStateChip, bringForward, useDeckAgents, type DeckAgent } from './agents'
import { DeckSheet, deckSheet, useDeckSheet } from './sheet'
import type { DeckView } from './view'

/**
 * The top bar's Agents menu: which agent is on screen, and every other one in
 * the project a click away.
 *
 * The button names the agent the dock talks to and its state, in words. The
 * list drops from it: every pane in the project, across every tab, with its
 * state and a close behind a confirm; New agent at its foot. Picking a row puts
 * that agent on the whole stage (focus view). ↑↓ and Enter move through the
 * rows, 1–9 jump.
 *
 * Beside it, only when it is true: which *other* agent is waiting on you, as a
 * button that goes straight to it — with one agent on screen, nothing else
 * would say so. And a + that opens the agent chooser without opening the list.
 */
export function AgentsMenu({ onView }: { onView: (view: DeckView) => void }): ReactNode {
  const { state, actions } = useForge()
  const workspace = useWorkspace()
  const project = useActiveProject()
  const { agents, current, tabCount } = useDeckAgents()
  const open = useDeckSheet() === 'agents'
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  const activeTabId = (workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? workspace.tabs[0])?.id ?? null
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const [chooserOpen, setChooserOpen] = useState(false)

  const waiting = agents.filter((a) => a.leaf.id !== current?.leaf.id && state.asking.has(a.leaf.id))
  /** Chat tabs (shared/chatbots.ts) have no agent in them, so they are listed on their own. */
  const chats = workspace.tabs.flatMap((tab) => {
    const chat = chatLeafOf(tab)
    return chat ? [{ tab, chat }] : []
  })
  const frontChat = chats.find((c) => c.tab.id === activeTabId)?.chat ?? null

  const goChat = async (tab: TerminalTab): Promise<void> => {
    deckSheet.set(null)
    onView('focus')
    if (!live || tab.id === activeTabId) return
    const refused = await actions.layout({ op: 'select-tab', tabId: tab.id })
    if (refused) actions.setNotice(refused)
  }

  const go = async (agent: DeckAgent): Promise<void> => {
    deckSheet.set(null)
    onView('focus')
    if (!live) return
    const refused = await bringForward(actions, activeTabId, agent)
    if (refused) actions.setNotice(refused)
  }

  if (!project) return null

  return (
    <div className="dk-agents">
      <span className="dk-agents__anchor">
        <button
          ref={anchorRef}
          type="button"
          className="dk-agents__btn"
          data-open={open ? 'true' : undefined}
          data-sheet-toggle="agents"
          aria-expanded={open}
          aria-haspopup="dialog"
          title={`Agents — ${agents.length} in ${project.name}. Pick one to put it on the whole screen`}
          style={current ? ({ '--pane-accent': current.profile.accent } as CSSProperties) : undefined}
          onClick={() => deckSheet.toggle('agents')}
        >
          {frontChat ? (
            <ChatTabChip bot={frontChat.bot} size="sm" />
          ) : current ? (
            <>
              <AgentBadge profile={current.profile} size="sm" />
              <span className="dk-agents__name truncate">{current.name}</span>
              <AgentStateChip paneId={current.leaf.id} compact />
            </>
          ) : (
            <span className="dk-agents__name dk-agents__name--none">No agents</span>
          )}
          <span className="dk-agents__count mono" aria-label={`${agents.length} agents`}>
            {agents.length}
          </span>
          <Icon name="chevronDown" size={11} className="dk-agents__chev" />
        </button>
        <DeckSheet id="agents" className="dk-sheet--agents" label="Agents">
          <AgentsList
            agents={agents}
            chats={chats}
            activeTabId={activeTabId}
            onPickChat={(tab) => void goChat(tab)}
            currentId={current?.leaf.id ?? null}
            tabCount={tabCount}
            projectName={project.name}
            open={open}
            live={live}
            onPick={(agent) => void go(agent)}
            onNew={() => {
              deckSheet.set(null)
              setChooserOpen(true)
            }}
          />
        </DeckSheet>
      </span>


      {waiting.length > 0 ? (
        <button
          type="button"
          className="dk-agents__ask"
          title={`Waiting on you: ${waiting.map((a) => a.name).join(', ')}. Go to ${waiting[0].name}`}
          onClick={() => void go(waiting[0])}
        >
          <span className="dk-agents__ask-glyph" aria-hidden="true">
            ◆
          </span>
          <span className="truncate">
            {waiting.length === 1 ? `${waiting[0].name} needs you` : `${waiting.length} need you`}
          </span>
        </button>
      ) : null}

      <AgentChooser
        anchor={anchorRef.current}
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        onPick={(profileId, permissionMode) => {
          setChooserOpen(false)
          onView('focus')
          void actions.layout({ op: 'create-tab', profileId, permissionMode })
        }}
        onChat={(bot) => {
          setChooserOpen(false)
          onView('focus')
          void actions.layout({ op: 'newChatTab', bot }).then((refused) => {
            if (refused) actions.setNotice(refused)
          })
        }}
        selectedId={project.defaultProfileId}
      />
    </div>
  )
}

function AgentsList({
  agents,
  chats,
  activeTabId,
  onPickChat,
  currentId,
  tabCount,
  projectName,
  open,
  live,
  onPick,
  onNew
}: {
  agents: DeckAgent[]
  chats: Array<{ tab: TerminalTab; chat: ChatLeaf }>
  activeTabId: string | null
  onPickChat: (tab: TerminalTab) => void
  currentId: string | null
  tabCount: number
  projectName: string
  open: boolean
  live: boolean
  onPick: (agent: DeckAgent) => void
  onNew: () => void
}): ReactNode {
  const { actions } = useForge()
  const [cursor, setCursor] = useState(0)
  /** The row showing its close confirm, if any. */
  const [closing, setClosing] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Only on opening: moving the cursor must not snap back to the current row.
  const openedAt = useRef({ agents, currentId })
  openedAt.current = { agents, currentId }
  useEffect(() => {
    if (!open) return
    const { agents: list, currentId: here } = openedAt.current
    const i = list.findIndex((a) => a.leaf.id === here)
    setCursor(i < 0 ? 0 : i)
    setClosing(null)
    requestAnimationFrame(() => listRef.current?.focus())
  }, [open])

  const close = (agent: DeckAgent): void => {
    setClosing(null)
    // The last pane of a tab takes the tab with it; say so to the desk in its own verb.
    const alone = agents.filter((a) => a.tab.id === agent.tab.id).length === 1
    void actions
      .layout(alone ? { op: 'close-tab', tabId: agent.tab.id } : { op: 'close-pane', paneId: agent.leaf.id })
      .then((refused) => {
        if (refused) actions.setNotice(refused)
      })
  }

  return (
    <>
      <header className="dk-sheet__head">
        <span className="dk-sheet__eyebrow">Agents</span>
        <span className="dk-sheet__count mono">
          {agents.length} in {projectName}
          {tabCount > 1 ? ` · ${tabCount} tabs` : ''}
        </span>
      </header>

      <div
        ref={listRef}
        className="dk-sheet__list"
        role="listbox"
        aria-label="Agents"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (closing) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const step = e.key === 'ArrowDown' ? 1 : -1
            setCursor((c) => (agents.length ? (c + step + agents.length) % agents.length : 0))
            return
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            const agent = agents[cursor]
            if (agent) onPick(agent)
            return
          }
          if (/^[1-9]$/.test(e.key)) {
            const agent = agents[Number(e.key) - 1]
            if (agent) {
              e.preventDefault()
              onPick(agent)
            }
          }
        }}
      >
        {agents.length === 0 && chats.length === 0 ? (
          <div className="dk-sheet__empty">No agents open in this project yet.</div>
        ) : null}
        {agents.map((agent, i) => {
          const here = agent.leaf.id === currentId
          const confirming = closing === agent.leaf.id
          return (
            <div
              key={agent.leaf.id}
              role="option"
              aria-selected={i === cursor}
              className="dk-arow"
              data-current={here ? 'true' : undefined}
              data-cursor={i === cursor ? 'true' : undefined}
              data-confirming={confirming ? 'true' : undefined}
              style={{ '--pane-accent': agent.profile.accent } as CSSProperties}
              onPointerEnter={() => setCursor(i)}
            >
              <button type="button" className="dk-arow__go" tabIndex={-1} disabled={confirming} onClick={() => onPick(agent)}>
                <span className="dk-arow__mark mono" aria-hidden="true">
                  {here ? (
                    <svg width="8" height="9" viewBox="0 0 8 9">
                      <path d="M1 0.8 L7.2 4.5 L1 8.2 Z" fill="currentColor" />
                    </svg>
                  ) : i < 9 ? (
                    i + 1
                  ) : (
                    ''
                  )}
                </span>
                <AgentBadge profile={agent.profile} size="sm" />
                <span className="dk-arow__text">
                  <span className="dk-arow__name truncate">{agent.name}</span>
                  <span className="dk-arow__kind truncate">{agent.title}</span>
                </span>
                {here ? <span className="dk-arow__here">Active</span> : null}
                <AgentStateChip paneId={agent.leaf.id} />
              </button>
              {confirming ? (
                <span className="dk-arow__confirm" role="group" aria-label={`Close ${agent.name}?`}>
                  <span className="dk-arow__confirm-q">Close?</span>
                  <button type="button" className="dk-arow__yes" onClick={() => close(agent)}>
                    Close
                  </button>
                  <button type="button" className="dk-arow__no" onClick={() => setClosing(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="dk-arow__close"
                  disabled={!live}
                  aria-label={`Close ${agent.name}`}
                  title={live ? `Close ${agent.name} — asks first` : 'The desktop is not answering, so it cannot close one'}
                  onClick={() => setClosing(agent.leaf.id)}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
          )
        })}
        {chats.map(({ tab, chat }) => {
          const here = tab.id === activeTabId
          const confirming = closing === chat.id
          return (
            <div
              key={chat.id}
              role="option"
              aria-selected={false}
              className="dk-arow"
              data-current={here ? 'true' : undefined}
              data-confirming={confirming ? 'true' : undefined}
            >
              <button
                type="button"
                className="dk-arow__go"
                tabIndex={-1}
                disabled={confirming}
                onClick={() => onPickChat(tab)}
              >
                <span className="dk-arow__mark mono" aria-hidden="true" />
                <ChatTabChip bot={chat.bot} />
                <span className="dk-arow__text" />
                {here ? <span className="dk-arow__here">Active</span> : null}
              </button>
              {confirming ? (
                <span className="dk-arow__confirm" role="group" aria-label={`Close ${chat.title} chat?`}>
                  <span className="dk-arow__confirm-q">Close?</span>
                  <button
                    type="button"
                    className="dk-arow__yes"
                    onClick={() => {
                      setClosing(null)
                      void actions.layout({ op: 'close-tab', tabId: tab.id }).then((refused) => {
                        if (refused) actions.setNotice(refused)
                      })
                    }}
                  >
                    Close
                  </button>
                  <button type="button" className="dk-arow__no" onClick={() => setClosing(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="dk-arow__close"
                  disabled={!live}
                  aria-label={`Close ${chat.title} chat`}
                  title={live ? `Close ${chat.title} chat — asks first` : 'The desktop is not answering, so it cannot close one'}
                  onClick={() => setClosing(chat.id)}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>

      <footer className="dk-sheet__foot">
        <button
          type="button"
          className="cta-btn dk-sheet__new"
          disabled={!live}
          title={live ? 'Open a new agent or terminal in this project' : 'The desktop is not answering, so it cannot open one'}
          onClick={onNew}
        >
          <Icon name="plus" size={13} />
          New agent
        </button>
        <span className="dk-sheet__keys mono">↑↓ pick · 1–9 jump · Enter go</span>
      </footer>
    </>
  )
}
