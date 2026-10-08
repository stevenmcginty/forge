import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { MiniBarAgent, MiniBarCall, MiniBarState } from '@shared/minibar'
import { Icon } from '@/components/Icon'
import { STATUS_WORD } from './format'
import { AgentMark, StateMark } from './glyphs'
import type { Panel } from './Stage'

/**
 * Who the words go to: Forge first (the round key with the house mark), then
 * every agent pane in the current project, as two-line instrument keys —
 * the pane's name over its state, said as a shape and a word.
 *
 * The chips get whatever the row can spare once the text box has its floor.
 * What does not fit folds into "+N more", which opens All agents; when all of
 * them fit, the same key reads "All". The target is never folded away.
 */
export function Chips({
  state,
  call,
  panel,
  open,
  toggle
}: {
  state: MiniBarState
  call: (c: MiniBarCall) => void
  panel: Panel
  open: (p: Panel) => void
  toggle: (p: Exclude<Panel, null>) => void
}): ReactNode {
  const projectId = state.project?.id
  const agents = state.agents.filter((a) => a.projectId === projectId)
  const targetPane = state.target.kind === 'pane' ? state.target.paneId : null
  const peekPane = panel === 'peek' ? (state.peek?.paneId ?? null) : null

  const zone = useRef<HTMLDivElement | null>(null)
  const ruler = useRef<HTMLDivElement | null>(null)
  const [fit, setFit] = useState(agents.length)

  const sig = `${state.project?.name}/${targetPane}/${state.dictation.phase === 'off'}/` + agents.map((a) => `${a.paneId}:${a.name}:${a.status}`).join('|')
  useLayoutEffect(() => {
    const z = zone.current
    const r = ruler.current
    const row = z?.parentElement
    if (!z || !r || !row) return
    const compute = (): void => {
      const rs = getComputedStyle(row)
      const gap = parseFloat(rs.columnGap) || 0
      let fixed = 0
      let others = 0
      for (const child of Array.from(row.children) as HTMLElement[]) {
        if (child === z) continue
        others += 1
        // The text well counts at its floor: it is the one that gives way.
        const cs = getComputedStyle(child)
        const margins = (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0)
        fixed += margins + (child.dataset['mbWell'] ? parseFloat(cs.minWidth) || 0 : child.getBoundingClientRect().width)
      }
      const inner = row.clientWidth - (parseFloat(rs.paddingLeft) || 0) - (parseFloat(rs.paddingRight) || 0)
      const room = inner - fixed - gap * others - 1
      const zgap = parseFloat(getComputedStyle(z).columnGap) || 0
      const widthOf = (sel: string): number => r.querySelector<HTMLElement>(sel)?.getBoundingClientRect().width ?? 0
      const forge = widthOf('[data-ruler="forge"]') + zgap
      const chips = Array.from(r.querySelectorAll<HTMLElement>('[data-ruler="chip"]')).map((e) => e.getBoundingClientRect().width + zgap)
      const all = widthOf('[data-ruler="all"]')
      const more = widthOf('[data-ruler="more"]')
      const total = chips.reduce((s, w) => s + w, 0)
      let n = chips.length
      if (forge + total + all > room) {
        n = 0
        let used = forge + more
        while (n < chips.length && used + chips[n]! <= room) used += chips[n++]!
      }
      setFit(n)
    }
    compute()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(compute)
    ro.observe(row)
    return () => ro.disconnect()
  }, [sig])

  // The first `fit`, with the target swapped into the last seat if it was folded.
  let shown = agents.slice(0, fit)
  const ti = targetPane ? agents.findIndex((a) => a.paneId === targetPane) : -1
  if (ti >= fit && fit > 0) shown = [...agents.slice(0, fit - 1), agents[ti]!]
  const hidden = agents.length - shown.length

  const pick = (a: MiniBarAgent): void => {
    if (peekPane === a.paneId) {
      open(null)
      return
    }
    call({ t: 'target', to: { kind: 'pane', paneId: a.paneId } })
    call({ t: 'peek', paneId: a.paneId })
  }

  return (
    <div ref={zone} className="mb-chips">
      <ForgeKey
        on={state.target.kind === 'forge'}
        open={panel === 'chat'}
        onClick={() => {
          call({ t: 'target', to: { kind: 'forge' } })
          toggle('chat')
        }}
      />
      {shown.map((a) => (
        <Chip key={a.paneId} agent={a} target={a.paneId === targetPane} peeking={a.paneId === peekPane} onClick={() => pick(a)} />
      ))}
      <MoreKey hidden={hidden} open={panel === 'all'} onClick={() => toggle('all')} />

      {/* The ruler: every chip at its natural width, unseen, so the fold can be measured. */}
      <div ref={ruler} className="mb-chips__ruler" aria-hidden="true">
        <ForgeKey on={false} open={false} ruler />
        {agents.map((a) => (
          <Chip key={a.paneId} agent={a} target={false} peeking={false} ruler />
        ))}
        <MoreKey hidden={0} open={false} ruler />
        <MoreKey hidden={Math.max(agents.length, 9)} open={false} ruler />
      </div>
    </div>
  )
}

function ForgeKey({ on, open, onClick, ruler = false }: { on: boolean; open: boolean; onClick?: () => void; ruler?: boolean }): ReactNode {
  return (
    <button
      type="button"
      className="mb-forge"
      data-ruler={ruler ? 'forge' : undefined}
      data-target={on ? 'true' : undefined}
      data-open={open ? 'true' : undefined}
      tabIndex={ruler ? -1 : undefined}
      title="Forge — talk to Forge itself; opens the chat"
      aria-label="Forge"
      aria-pressed={on}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icon name="forge" size={17} />
    </button>
  )
}

function Chip({
  agent,
  target,
  peeking,
  onClick,
  ruler = false
}: {
  agent: MiniBarAgent
  target: boolean
  peeking: boolean
  onClick?: () => void
  ruler?: boolean
}): ReactNode {
  const word = STATUS_WORD[agent.status]
  return (
    <button
      type="button"
      className="mb-chip"
      data-ruler={ruler ? 'chip' : undefined}
      data-status={agent.status}
      data-target={target ? 'true' : undefined}
      data-open={peeking ? 'true' : undefined}
      tabIndex={ruler ? -1 : undefined}
      title={`${agent.name} — ${word}${agent.line ? `: ${agent.line}` : ''}`}
      aria-label={`${agent.name}, ${word}`}
      aria-pressed={target}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <AgentMark brand={agent.brand} size={20} />
      <span className="mb-chip__text">
        <span className="mb-chip__name">{agent.name}</span>
        <span className="mb-chip__state">
          <StateMark key={agent.status} status={agent.status} size={9} />
          {word}
        </span>
      </span>
    </button>
  )
}

function MoreKey({ hidden, open, onClick, ruler = false }: { hidden: number; open: boolean; onClick?: () => void; ruler?: boolean }): ReactNode {
  return (
    <button
      type="button"
      className="mb-more"
      data-ruler={ruler ? (hidden ? 'more' : 'all') : undefined}
      data-folded={hidden ? 'true' : undefined}
      data-open={open ? 'true' : undefined}
      tabIndex={ruler ? -1 : undefined}
      title="All agents, in every project"
      aria-expanded={ruler ? undefined : open}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {hidden ? (
        <span className="mb-more__word">+{hidden} more</span>
      ) : (
        <>
          <Icon name="wall" size={13} />
          <span className="mb-more__word">All</span>
        </>
      )}
    </button>
  )
}
