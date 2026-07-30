import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { LayoutNode, Project } from '@shared/types'
import { useApp } from '@/state/AppState'
import { TerminalPane } from './TerminalPane'
import './SplitView.css'

/**
 * Renders a pane layout tree. Splits are flex rows/columns with a draggable
 * hairline divider; leaves are terminals.
 */
export function SplitView({
  node,
  project,
  activePaneId,
  onlyPane
}: {
  node: LayoutNode
  project: Project
  activePaneId: string
  onlyPane: boolean
}): ReactNode {
  if (node.type === 'leaf') {
    return (
      <TerminalPane
        leaf={node}
        project={project}
        focused={node.id === activePaneId}
        onlyPane={onlyPane}
      />
    )
  }
  return <Split node={node} project={project} activePaneId={activePaneId} />
}

function Split({
  node,
  project,
  activePaneId
}: {
  node: Extract<LayoutNode, { type: 'split' }>
  project: Project
  activePaneId: string
}): ReactNode {
  const { actions } = useApp()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const frame = useRef<number | null>(null)
  const [dragging, setDragging] = useState(false)

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const host = hostRef.current
      if (!host) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(true)

      const rect = host.getBoundingClientRect()
      const horizontal = node.direction === 'row'

      const apply = (clientX: number, clientY: number): void => {
        if (frame.current !== null) cancelAnimationFrame(frame.current)
        frame.current = requestAnimationFrame(() => {
          frame.current = null
          const span = horizontal ? rect.width : rect.height
          if (span <= 0) return
          const offset = horizontal ? clientX - rect.left : clientY - rect.top
          actions.setRatio(node.id, offset / span)
        })
      }

      const onMove = (ev: PointerEvent): void => apply(ev.clientX, ev.clientY)
      const onUp = (): void => {
        setDragging(false)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [actions, node.direction, node.id]
  )

  const pct = Math.round(node.ratio * 10000) / 100

  return (
    <div className="split" data-direction={node.direction} data-dragging={dragging} ref={hostRef}>
      <div className="split__side" style={{ flexBasis: `calc(${pct}% - 3px)` }}>
        <SplitView node={node.a} project={project} activePaneId={activePaneId} onlyPane={false} />
      </div>
      <div
        className="split__divider"
        role="separator"
        aria-orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
        aria-label="Resize panes"
        onPointerDown={onPointerDown}
        onDoubleClick={() => actions.setRatio(node.id, 0.5)}
      >
        <span className="split__grip" />
      </div>
      <div className="split__side" style={{ flexBasis: `calc(${100 - pct}% - 3px)` }}>
        <SplitView node={node.b} project={project} activePaneId={activePaneId} onlyPane={false} />
      </div>
    </div>
  )
}
