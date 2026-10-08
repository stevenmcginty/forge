import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { MiniBarCall, MiniBarPeek, MiniBarState, MiniBarViewApi } from '@shared/minibar'
import { Icon } from '@/components/Icon'
import { renderMarkdown } from '../../web/src/lib/markdown'
import { agentById, fmtAgo, projectName, STATUS_WORD } from './format'
import { AgentMark, StateMark } from './glyphs'
import { Sheet } from './Sheet'

const MAX_REPLY_H = 96

/**
 * Peek: what an agent said, without opening Forge (spec 4.10). A Claude pane
 * shows its last reply as formatted text; any other pane its last screen
 * lines. An agent that is asking shows the question first, with one key per
 * answer. The reply box at the foot sends to this agent.
 */
export function Peek({
  state,
  peek,
  call,
  api,
  now,
  focusReply,
  onReplyFocused
}: {
  state: MiniBarState
  peek: MiniBarPeek
  call: (c: MiniBarCall) => void
  api: MiniBarViewApi
  now: number
  focusReply: boolean
  onReplyFocused: () => void
}): ReactNode {
  const agent = agentById(state, peek.paneId)
  const name = agent?.name ?? 'Agent'
  const status = agent?.status ?? 'idle'
  const [reply, setReply] = useState('')
  const box = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!focusReply) return
    box.current?.focus()
    onReplyFocused()
  }, [focusReply, onReplyFocused])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(MAX_REPLY_H, el.scrollHeight)}px`
  }, [reply])

  // A new reply scrolls back to its top; a refresh of the same one keeps the reader's place.
  const scroller = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [peek.paneId])

  const send = (): void => {
    if (!reply.trim()) return
    call({ t: 'reply', paneId: peek.paneId, text: reply })
    setReply('')
  }

  const reveal = (): void => {
    if (agent) call({ t: 'reveal', projectId: agent.projectId, tabId: agent.tabId, paneId: agent.paneId })
    void api.openMain(false)
  }

  return (
    <Sheet
      className="mb-peek"
      label={`Peek: ${name}`}
      onClose={() => call({ t: 'closePeek' })}
      head={
        <>
          <AgentMark brand={agent?.brand ?? ''} size={22} />
          <span className="mb-peek__who">
            <span className="mb-peek__name">{name}</span>
            <span className="mb-peek__meta">
              {agent ? projectName(state, agent.projectId) : ''}
              <span className="mb-dot" aria-hidden="true" />
              {peek.source === 'reply' ? 'last reply' : 'screen'}, {fmtAgo(peek.at, now)}
            </span>
          </span>
          <span className="mb-statepill" data-status={status}>
            <StateMark key={status} status={status} size={9} />
            {STATUS_WORD[status]}
          </span>
          <button type="button" className="mb-btn mb-peek__open" title={`Open Forge on ${name}`} onClick={reveal}>
            Open
          </button>
        </>
      }
    >
      <div ref={scroller} className="mb-sheet__body mb-peek__body">
        {peek.asking ? (
          <div className="mb-ask" role="group" aria-label={`${name} is asking`}>
            <p className="mb-ask__q">
              <StateMark status="asking" size={12} />
              <span>{peek.asking.prompt}</span>
            </p>
            <div className="mb-ask__choices">
              {peek.asking.choices.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  className={`mb-btn${i === 0 ? ' mb-btn--solid' : ''}`}
                  onClick={() => call({ t: 'answer', paneId: peek.paneId, choiceId: c.id })}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {peek.source === 'reply' ? (
          <div className="mb-md">{renderMarkdown(peek.text)}</div>
        ) : (
          <pre className="mb-screen">{peek.text}</pre>
        )}
      </div>

      <div className="mb-reply">
        <textarea
          ref={box}
          className="mb-reply__box"
          rows={1}
          value={reply}
          placeholder={`Reply to ${name}…`}
          aria-label={`Reply to ${name}`}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            } else if (e.key === 'Escape' && reply) {
              // The first Esc clears the reply; the next one closes the Peek.
              e.stopPropagation()
              setReply('')
            }
          }}
        />
        <button type="button" className="mb-send" data-look="send" disabled={!reply.trim()} title={`Send to ${name} (Enter)`} aria-label="Send reply" onClick={send}>
          <Icon name="send" size={16} />
        </button>
      </div>
    </Sheet>
  )
}
