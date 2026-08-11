import { useMemo, type CSSProperties, type ReactNode } from 'react'
import type { LayoutNode, PaneLeaf, SplitDirection } from '@shared/types'
import { PaneView } from './PaneView'

/**
 * A pane layout tree, drawn flat.
 *
 * ## Why flat, when the tree is nested
 *
 * This used to recurse the way src/components/SplitView.tsx does, nesting a
 * `.split` inside a `.split__side` inside a `.split` and letting flex do the
 * arithmetic. That is right on the desktop and wrong here, for a reason that has
 * nothing to do with layout: the desktop's terminals live in `terminalHost`,
 * outside React, so React unmounting a pane costs it nothing. In the browser the
 * xterm instance *is* the component's, and unmounting one disposes a live
 * emulator, detaches from the session and buys a fresh replay when it comes back.
 *
 * Recursion made that happen constantly. React reconciles children by position
 * and element *type*, and splitting a pane changes the type at a position — the
 * `<PaneView>` that was the first child of a side becomes a `<div className=
 * "split">` with the old pane inside it. React cannot see that as "the same pane,
 * one level deeper"; it unmounts the subtree and builds a new one. So splitting
 * or closing one pane wiped and re-replayed every *other* pane in the tab, and
 * the person watching saw the whole tab flash.
 *
 * Flattening removes the problem rather than working around it. Every leaf is a
 * direct child of one container, keyed on `leaf.id`, so its position in the
 * children array is the only thing that changes when the tree is reshaped and
 * React keeps the instance. What the nesting was doing — the arithmetic — is
 * done here instead, as CSS length expressions composed down the tree, and the
 * result is the same geometry the flex version produced: each side gets its
 * share of the box minus half the divider, and the divider sits in the gap.
 *
 * ## The divider
 *
 * Still here, still not draggable, and that is decision 5 rather than an
 * omission: a ratio is layout the desktop owns and persists, and
 * `WEB_LAYOUT_OPS` carries no verb for setting one — so a drag here could only
 * mutate a local copy and hope, which is exactly what the mirror rule forbids.
 * What it keeps is the 6px gap that *is* the shape of the split, the separator
 * role, and the sentence explaining where ratios are set. What it drops is the
 * grip: `styles.css` has drawn it at `opacity: 0` since the day this client was
 * written, and its size came from a `.split[data-direction] >` rule that a flat
 * tree no longer has a parent for, so keeping the element would be markup that
 * could never paint.
 */

/** The desktop's divider width, from `.split[data-direction='row'] > .split__divider`. */
const DIVIDER_PX = 6

/**
 * Where one node sits, as CSS length expressions rather than numbers.
 *
 * Expressions rather than percentages because a percentage inside an absolutely
 * positioned box resolves against the *container*, not against the parent split
 * — so "half of the left half" has to be carried down as `100% * 0.5 * 0.5`
 * rather than restated as `50%`. Every one of these is relative to the same
 * `.panes` box, which is what makes them composable at all.
 */
interface Box {
  left: string
  top: string
  width: string
  height: string
}

interface PlacedPane {
  leaf: PaneLeaf
  box: Box
}

interface PlacedDivider {
  /** The split's own id, so React keeps the element when a sibling moves. */
  id: string
  direction: SplitDirection
  box: Box
}

/** Two decimal places of a percent, exactly as the nested version rounded to. */
const ratioOf = (ratio: number): number => Math.round(ratio * 10000) / 10000

function place(node: LayoutNode, box: Box, panes: PlacedPane[], dividers: PlacedDivider[]): void {
  if (node.type === 'leaf') {
    panes.push({ leaf: node, box })
    return
  }

  const first = ratioOf(node.ratio)
  const second = ratioOf(1 - node.ratio)
  const half = DIVIDER_PX / 2

  if (node.direction === 'row') {
    const span = box.width
    place(node.a, { ...box, width: `(${span}) * ${first} - ${half}px` }, panes, dividers)
    dividers.push({
      id: node.id,
      direction: node.direction,
      box: { ...box, left: `(${box.left}) + (${span}) * ${first} - ${half}px`, width: `${DIVIDER_PX}px` }
    })
    place(
      node.b,
      { ...box, left: `(${box.left}) + (${span}) * ${first} + ${half}px`, width: `(${span}) * ${second} - ${half}px` },
      panes,
      dividers
    )
    return
  }

  const span = box.height
  place(node.a, { ...box, height: `(${span}) * ${first} - ${half}px` }, panes, dividers)
  dividers.push({
    id: node.id,
    direction: node.direction,
    box: { ...box, top: `(${box.top}) + (${span}) * ${first} - ${half}px`, height: `${DIVIDER_PX}px` }
  })
  place(
    node.b,
    { ...box, top: `(${box.top}) + (${span}) * ${first} + ${half}px`, height: `(${span}) * ${second} - ${half}px` },
    panes,
    dividers
  )
}

function styleFor(box: Box): CSSProperties {
  return {
    left: `calc(${box.left})`,
    top: `calc(${box.top})`,
    width: `calc(${box.width})`,
    height: `calc(${box.height})`
  }
}

export function SplitView({
  node,
  activePaneId,
  onScreen
}: {
  node: LayoutNode
  activePaneId: string
  /**
   * Whether this tab is the one on screen. Every tab of the active project stays
   * mounted (see `Workspace`), so a pane has to know whether it is the visible
   * one before it takes the caret away from whatever is.
   */
  onScreen: boolean
}): ReactNode {
  const { panes, dividers } = useMemo(() => {
    const placedPanes: PlacedPane[] = []
    const placedDividers: PlacedDivider[] = []
    place(node, { left: '0px', top: '0px', width: '100%', height: '100%' }, placedPanes, placedDividers)
    return { panes: placedPanes, dividers: placedDividers }
  }, [node])

  const onlyPane = panes.length === 1

  return (
    <div className="panes">
      {panes.map(({ leaf, box }) => (
        <div className="panes__slot" key={leaf.id} style={styleFor(box)}>
          <PaneView leaf={leaf} focused={leaf.id === activePaneId} onlyPane={onlyPane} onScreen={onScreen} />
        </div>
      ))}
      {dividers.map(({ id, direction, box }) => (
        <div
          key={id}
          className="split__divider panes__divider"
          role="separator"
          aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
          aria-label="Pane divider"
          data-fixed="true"
          title="Split ratios are set at the desk — this browser mirrors them"
          style={styleFor(box)}
        />
      ))}
    </div>
  )
}
