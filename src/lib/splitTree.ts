import type { LayoutNode, PaneLeaf, SplitDirection } from '@shared/types'
import { makeId } from './ids'

/**
 * Pure operations on a pane layout: a binary tree where every leaf is a
 * terminal and every branch is a split with a ratio. All functions return new
 * trees — nothing is mutated, so React sees real changes.
 */

export function makeLeaf(profileId: string, title = ''): PaneLeaf {
  return { type: 'leaf', id: makeId('pane'), profileId, title }
}

export function collectLeaves(node: LayoutNode, out: PaneLeaf[] = []): PaneLeaf[] {
  if (node.type === 'leaf') {
    out.push(node)
  } else {
    collectLeaves(node.a, out)
    collectLeaves(node.b, out)
  }
  return out
}

export function countLeaves(node: LayoutNode): number {
  return node.type === 'leaf' ? 1 : countLeaves(node.a) + countLeaves(node.b)
}

export function findLeaf(node: LayoutNode, id: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null
  return findLeaf(node.a, id) ?? findLeaf(node.b, id)
}

/** Insert `leaf` next to `targetId`, splitting along `direction`. */
export function splitLeaf(
  node: LayoutNode,
  targetId: string,
  direction: SplitDirection,
  leaf: PaneLeaf
): LayoutNode {
  if (node.type === 'leaf') {
    if (node.id !== targetId) return node
    return { type: 'split', id: makeId('split'), direction, ratio: 0.5, a: node, b: leaf }
  }
  const a = splitLeaf(node.a, targetId, direction, leaf)
  const b = a === node.a ? splitLeaf(node.b, targetId, direction, leaf) : node.b
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

/** Remove a leaf, collapsing the split it lived in. Returns null if the tree empties. */
export function removeLeaf(node: LayoutNode, id: string): LayoutNode | null {
  if (node.type === 'leaf') return node.id === id ? null : node
  const a = removeLeaf(node.a, id)
  if (a === null) return node.b
  const b = removeLeaf(node.b, id)
  if (b === null) return a
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

export function updateLeaf(node: LayoutNode, id: string, patch: Partial<Omit<PaneLeaf, 'type' | 'id'>>): LayoutNode {
  if (node.type === 'leaf') return node.id === id ? { ...node, ...patch } : node
  const a = updateLeaf(node.a, id, patch)
  const b = a === node.a ? updateLeaf(node.b, id, patch) : node.b
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

export function setSplitRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.type === 'leaf') return node
  if (node.id === splitId) {
    const clamped = Math.min(0.88, Math.max(0.12, ratio))
    return clamped === node.ratio ? node : { ...node, ratio: clamped }
  }
  const a = setSplitRatio(node.a, splitId, ratio)
  const b = a === node.a ? setSplitRatio(node.b, splitId, ratio) : node.b
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

/**
 * The leaf that should take focus after `id` is closed: its sibling's
 * first leaf, or the first remaining leaf anywhere.
 */
export function neighbourAfterClose(root: LayoutNode, id: string): string | null {
  const sibling = findSibling(root, id)
  if (sibling) return collectLeaves(sibling)[0]?.id ?? null
  const remaining = collectLeaves(root).filter((l) => l.id !== id)
  return remaining[0]?.id ?? null
}

function findSibling(node: LayoutNode, id: string): LayoutNode | null {
  if (node.type === 'leaf') return null
  if (node.a.type === 'leaf' && node.a.id === id) return node.b
  if (node.b.type === 'leaf' && node.b.id === id) return node.a
  return findSibling(node.a, id) ?? findSibling(node.b, id)
}

/** Cheap structural sanity check used when loading a layout from disk. */
export function isValidLayout(node: unknown, depth = 0): node is LayoutNode {
  if (depth > 12 || !node || typeof node !== 'object') return false
  const n = node as Partial<LayoutNode>
  if (n.type === 'leaf') return typeof n.id === 'string' && typeof (n as PaneLeaf).profileId === 'string'
  if (n.type === 'split') {
    const s = n as { id?: unknown; direction?: unknown; ratio?: unknown; a?: unknown; b?: unknown }
    return (
      typeof s.id === 'string' &&
      (s.direction === 'row' || s.direction === 'column') &&
      typeof s.ratio === 'number' &&
      isValidLayout(s.a, depth + 1) &&
      isValidLayout(s.b, depth + 1)
    )
  }
  return false
}
