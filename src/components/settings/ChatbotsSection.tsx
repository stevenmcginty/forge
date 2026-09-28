import { useState, type ReactNode } from 'react'
import { CHATBOT_ORDER, CHATBOTS, type ChatBotId } from '@shared/chatbots'
import { chatBridge, openChatTab, refreshChatStatus, signInWord, useChatSignIn } from '@/lib/chat'
import { useActiveWorkspace, useApp } from '@/state/AppState'
import { ChatMark } from '../ChatMark'
import { Card, Row, Section, StateChip } from './parts'

/**
 * Chatbots: whether Forge is signed in to ChatGPT, Gemini and Claude, and the
 * way in and out of each without leaving Forge.
 *
 * "Sign in" opens (or goes to) a chat tab for that bot, where the site shows
 * its own login — Forge never sees a password. Every chat tab and the built-in
 * browser share the one session, so signing in once covers them all, and the
 * status here follows the cookies as they arrive.
 */
export function ChatbotsSection(): ReactNode {
  return (
    <Section title="Chatbots" blurb="Chatbots open as tabs beside your CLI panes. Sign in once here; every chat tab uses it.">
      <Card>
        {CHATBOT_ORDER.map((bot) => (
          <BotRow key={bot} bot={bot} />
        ))}
      </Card>
    </Section>
  )
}

function BotRow({ bot }: { bot: ChatBotId }): ReactNode {
  const { state, actions } = useApp()
  const workspace = useActiveWorkspace()
  const status = useChatSignIn(bot)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const entry = CHATBOTS[bot]
  const projectId = state.activeProjectId

  /** Go to this bot's chat tab in the project on screen, or open one. */
  const signIn = async (): Promise<void> => {
    if (!projectId) {
      actions.setNotice('Open a project first — a chat opens as one of its tabs')
      return
    }
    const existing = workspace.tabs.find((t) => t.root.type === 'chat' && t.root.bot === bot)
    const tabId = existing ? existing.id : await openChatTab(projectId, bot, workspace.tabs.length, actions.setNotice)
    if (!tabId) return
    if (existing) actions.selectTab(existing.id)
    actions.setViewMode('tabs')
    actions.closeSettings()
  }

  const signOut = async (): Promise<void> => {
    setConfirming(false)
    setBusy(true)
    try {
      await chatBridge()?.signOut?.(bot)
    } finally {
      setBusy(false)
      refreshChatStatus()
    }
  }

  const tone = status === 'signed-in' ? 'ok' : status === 'signed-out' ? 'off' : 'soon'

  return (
    <Row
      label={
        <span className="schat__label">
          <ChatMark bot={bot} />
          {entry.name}
        </span>
      }
      hint={
        <>
          <StateChip tone={tone}>{signInWord(status)}</StateChip>
          {bot === 'gemini' ? (
            <span className="schat__note">Signing out of Gemini signs you out of Google in the Forge browser too.</span>
          ) : null}
        </>
      }
    >
      {confirming ? (
        <div className="schat__confirm" role="group" aria-label={`Sign out of ${entry.name}`}>
          <span className="schat__ask">Sign out of {entry.name} in Forge?</span>
          <button type="button" className="sbtn" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button type="button" className="sbtn sbtn--danger" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      ) : (
        <div className="schat__actions">
          <button type="button" className="sbtn" onClick={() => void signIn()}>
            Sign in
          </button>
          <button
            type="button"
            className="sbtn sbtn--danger"
            disabled={busy || status === 'signed-out'}
            onClick={() => setConfirming(true)}
          >
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </Row>
  )
}
