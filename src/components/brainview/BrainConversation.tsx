import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatBlock, ChatTurn } from '@shared/chat'
import { applyChatUpdate, EMPTY_CHAT, type ChatFeed } from '../../../web/src/lib/chat-turns'

/**
 * Forge Brain's conversation, read-only: the brain on the left, Steve on the
 * right, plain words. Folded from the transcript main already streams
 * (`window.forge.brain.watchTranscript` + `onTranscript`) with the same helper
 * Forge Web uses, so both show the same turns. Claude engine only — the others
 * keep no transcript Forge can read, and the view says so.
 */
export function BrainConversation({ sessionId, engine }: { sessionId: string | null; engine: string }): ReactNode {
  const [feed, setFeed] = useState<ChatFeed>(EMPTY_CHAT)
  const [ready, setReady] = useState<boolean | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const api = window.forge?.brain
    if (!api) {
      setReady(false)
      return undefined
    }
    let live = true
    setFeed(EMPTY_CHAT)
    const off = api.onTranscript?.((update) => {
      if (!live || !update || !Array.isArray(update.turns)) return
      setFeed((f) => applyChatUpdate(f, update))
      setReady(true)
    })
    void api
      .watchTranscript?.()
      ?.then((ok) => {
        if (live) setReady((r) => r || ok === true)
      })
      ?.catch(() => {
        if (live) setReady(false)
      })
    return () => {
      live = false
      off?.()
      void api.stopTranscript?.()?.catch(() => {})
    }
  }, [sessionId])

  // Keep the newest turn in view.
  useLayoutEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [feed])

  const turns = feed.turns.filter((t) => t && Array.isArray(t.blocks) && t.blocks.some(shown))
  if (turns.length === 0) {
    return (
      <div className="bmap-talk bmap-talk--empty">
        <p>
          {engine && engine !== 'claude'
            ? 'This engine keeps no conversation Forge can read. Its terminal shows everything.'
            : ready === false
              ? 'Nothing said yet. The conversation shows here once the brain has had its first message.'
              : 'Nothing said yet.'}
        </p>
      </div>
    )
  }
  return (
    <div className="bmap-talk" ref={listRef}>
      {feed.truncated ? <div className="bmap-talk__cut">Earlier turns are not shown</div> : null}
      {turns.map((turn) => (
        <Turn key={turn.id} turn={turn} />
      ))}
    </div>
  )
}

function shown(block: ChatBlock): boolean {
  return block?.kind === 'text' ? typeof block.text === 'string' && block.text.trim() !== '' : block?.kind === 'tool'
}

function Turn({ turn }: { turn: ChatTurn }): ReactNode {
  const mine = turn.role === 'user'
  const when = turn.at ? new Date(turn.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : (turn.clock ?? '')
  const tools = turn.blocks.filter((b): b is Extract<ChatBlock, { kind: 'tool' }> => b?.kind === 'tool')
  const words = turn.blocks.filter((b): b is Extract<ChatBlock, { kind: 'text' }> => b?.kind === 'text' && typeof b.text === 'string')
  return (
    <div className="bmap-talk__turn" data-who={mine ? 'you' : 'brain'}>
      <div className="bmap-talk__bubble">
        {tools.length ? (
          <div className="bmap-talk__tools">
            Used {tools.map((t) => String(t.name ?? '').replace(/^mcp__forge__/, '').replace(/_/g, ' ')).join(', ')}
          </div>
        ) : null}
        {words.map((b, i) => (
          <p key={i} className="bmap-talk__text">
            {b.text}
          </p>
        ))}
        {when ? <span className="bmap-talk__when">{when}</span> : null}
      </div>
    </div>
  )
}
