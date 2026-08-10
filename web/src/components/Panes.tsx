import { type ReactNode } from 'react'
import type { LayoutNode } from '@shared/types'
import { PaneView } from './PaneView'

/**
 * A pane layout tree, drawn with the desktop's `.split` classes.
 *
 * One difference from src/components/SplitView.tsx, and it is decision 5 rather
 * than an omission: the divider is not draggable. A ratio is layout the desktop
 * owns and persists, and `WEB_LAYOUT_OPS` carries no verb for setting one — so a
 * drag here could only mutate a local copy and hope, which is exactly what the
 * mirror rule forbids. The hairline stays, because the *shape* of the split is
 * what the browser is mirroring; only the handle is gone.
 */
export function SplitView({
  node,
  activePaneId,
  onlyPane
}: {
  node: LayoutNode
  activePaneId: string
  onlyPane: boolean
}): ReactNode {
  if (node.type === 'leaf') {
    return <PaneView leaf={node} focused={node.id === activePaneId} onlyPane={onlyPane} />
  }

  const pct = Math.round(node.ratio * 10000) / 100
  return (
    <div className="split" data-direction={node.direction}>
      <div className="split__side" style={{ flexBasis: `calc(${pct}% - 3px)` }}>
        <SplitView node={node.a} activePaneId={activePaneId} onlyPane={false} />
      </div>
      <div
        className="split__divider"
        role="separator"
        aria-orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
        aria-label="Pane divider"
        data-fixed="true"
        title="Split ratios are set at the desk — this browser mirrors them"
      >
        <span className="split__grip" />
      </div>
      <div className="split__side" style={{ flexBasis: `calc(${100 - pct}% - 3px)` }}>
        <SplitView node={node.b} activePaneId={activePaneId} onlyPane={false} />
      </div>
    </div>
  )
}
