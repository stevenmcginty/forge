import { useEffect, useRef, type ReactNode } from 'react'
import type { FeedBlock } from '../lib/feed'

/**
 * The conversation cards drawn from a pane's captured screen.
 *
 * User turns sit in a bubble; agent text is just the words, the way the
 * Claude Code phone app does it. The PTY is still the source — this is a lens.
 */

export function Feed({
  blocks,
  asking,
  prompt,
  empty
}: {
  blocks: FeedBlock[]
  asking: boolean
  prompt: string
  empty: string
}): ReactNode {
  const end = useRef<HTMLDivElement | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)

  useEffect(() => {
    if (!stick.current) return
    end.current?.scrollIntoView({ block: 'end' })
  }, [blocks, asking, prompt])

  return (
    <div
      className="feed"
      ref={scroller}
      onScroll={() => {
        const el = scroller.current
        if (!el) return
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
    >
      {blocks.length === 0 ? <p className="feed__empty">{empty}</p> : null}
      {blocks.map((block) => (
        <article key={block.id} className="feed__block" data-role={block.role}>
          {block.role === 'user' ? <div className="feed__bubble">{block.text}</div> : <pre className="feed__text">{block.text}</pre>}
        </article>
      ))}
      {asking ? (
        <div className="feed__ask" role="status">
          <span className="feed__ask-label">Waiting</span>
          {prompt ? <p className="feed__ask-prompt">{prompt}</p> : <p className="feed__ask-prompt">This pane is asking a question — answer in the box, or Tab / Esc below.</p>}
        </div>
      ) : null}
      <div ref={end} />
    </div>
  )
}
