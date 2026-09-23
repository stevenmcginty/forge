import { callSignKey } from '@shared/hub'
import { resolvePaneTarget, type ActionPane } from './appactions'

/**
 * "Go to Everest", "go to panel four", "the claude one", "the board", "the
 * wall" — one resolver for voice and keyboard alike.
 *
 * Two places that are not panes: the Wall (every terminal at once — the
 * mosaic view) and the Board (agent images and artifacts). "Canvas" used to
 * name the board and got confused with the Wall when spoken, so the word no
 * longer goes anywhere: it comes back `which_view`, and the brain asks "the
 * Wall or the Board?".
 *
 * Order: the Wall, the Board and "canvas", then an exact call-sign, then everything
 * `resolvePaneTarget` already understands (a number, a pane title, an agent),
 * then a near-miss call-sign ("Everist"). Numbers are the executor's own
 * spoken handles — tabs in order, panes in each tab in order — so "panel 4" is
 * the same pane the manifest calls Terminal 4. Two equally good answers come
 * back `ambiguous`, never guessed.
 *
 * Pure: no DOM, no React. The focus side effects live in hubRuntime.ts.
 */

export interface NavPane extends ActionPane {
  /** The pane's call-sign, if it has one yet. */
  callSign?: string
}

export type NavTarget =
  /** The Board (agent images and artifacts). Internal name kept: `canvas`. */
  | { kind: 'canvas' }
  /** The Wall: every terminal at once (view mode `mosaic`). */
  | { kind: 'wall' }
  /** He said "canvas": the Wall or the Board? Never guessed. */
  | { kind: 'which_view' }
  | { kind: 'pane'; pane: NavPane }
  | { kind: 'ambiguous'; candidates: NavPane[] }
  | { kind: 'none'; candidates: NavPane[] }

/** Leading verbs and fillers that carry no target: "go to", "switch over to", "show me". */
const LEAD = /^(?:(?:please|ok(?:ay)?|hey|jarvis)[\s,]+)*(?:(?:go|jump|switch|move|take me|bring me|flick|head)(?:\s+(?:over|back))?\s+to|focus(?:\s+on)?|show(?:\s+me)?|open|select)\s+/i

const BOARD = /^(?:the\s+)?(?:(?:image|images|artifact|artifacts|agent)\s+)?board$/i
const WALL = /^(?:(?:the|my)\s+)?(?:(?:terminal|terminals)\s+)?wall$|^(?:all|every)\s+(?:of\s+)?(?:the\s+|my\s+)?(?:terminals?|panes?|panels?)(?:\s+at\s+once)?$/i
/** Any mention of a canvas, alone or with "board" ("the canvas board"). */
const CANVAS_WORD = /^(?:the\s+)?(?:canvas(?:\s+board)?|canvases)$/i

function tidy(spoken: string): string {
  return String(spoken ?? '')
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(LEAD, '')
    .trim()
}

export function resolveNavTarget(spoken: string, panes: readonly NavPane[], focusedPaneId: string | null): NavTarget {
  const text = tidy(spoken)
  if (CANVAS_WORD.test(text)) return { kind: 'which_view' }
  if (WALL.test(text)) return { kind: 'wall' }
  if (BOARD.test(text)) return { kind: 'canvas' }

  const all = [...(panes ?? [])]
  const bare = text.replace(/^(?:the\s+)/i, '').replace(/\s+(?:pane|panel|terminal|one)$/i, '')
  const key = callSignKey(bare)

  if (key) {
    const exact = all.filter((p) => p.callSign && callSignKey(p.callSign) === key)
    if (exact.length === 1) return { kind: 'pane', pane: exact[0]! }
  }

  // "panel" is the word the hub uses; the executor knows "pane". Same thing.
  const generic = resolvePaneTarget(text.replace(/\bpanels?\b/gi, 'pane'), all, focusedPaneId)
  if (generic.kind === 'pane') return { kind: 'pane', pane: generic.pane as NavPane }
  if (generic.kind === 'ambiguous') return { kind: 'ambiguous', candidates: generic.candidates as NavPane[] }

  if (key.length >= 3) {
    const near = all.filter((p) => p.callSign && close(callSignKey(p.callSign), key))
    if (near.length === 1) return { kind: 'pane', pane: near[0]! }
    if (near.length > 1) return { kind: 'ambiguous', candidates: near }
  }
  return { kind: 'none', candidates: all }
}

/** One line per pane, for the model and for "which one?" answers. */
export function describeNavPane(p: NavPane): string {
  const name = p.callSign ? `${p.callSign} (panel ${p.number})` : `Panel ${p.number}`
  const tab = p.tabTitle && p.tabTitle !== p.title ? `, tab "${p.tabTitle}"` : ''
  return `${name} — ${p.title}${p.profileName && p.profileName !== p.title ? ` [${p.profileName}]` : ''}${tab}${p.focused ? ', focused' : ''}`
}

/* ---------------------------------------------------------------- events */

/**
 * Fired on `window` whenever the hub moves focus — by voice, keyboard or a
 * click that goes through `focusNavTarget`. D2 animates on it (a flash on the
 * pane, a fly-to on the board). The move has already happened when it fires.
 */
export const HUB_FOCUS_EVENT = 'forge:hub-focus'

export type HubFocusSource = 'voice' | 'keyboard' | 'ui'

export type HubFocusDetail =
  | { kind: 'pane'; paneId: string; tabId: string; number: number; callSign: string | null; source: HubFocusSource }
  | { kind: 'canvas'; source: HubFocusSource }
  | { kind: 'wall'; source: HubFocusSource }

/**
 * Fired when a saved prompt targets the composer. Whoever owns the dock's
 * composer (D1/D2) puts `text` in it; nothing else listens.
 */
export const HUB_COMPOSER_EVENT = 'forge:composer-insert'

export interface HubComposerDetail {
  text: string
  submit: boolean
}

/** Fired for the cheat-sheet shortcut (Ctrl+/ by default). D2's overlay toggles on it. */
export const HUB_CHEAT_SHEET_EVENT = 'forge:cheat-sheet'

/* --------------------------------------------------------------- helpers */

function close(a: string, b: string): boolean {
  if (!a || !b) return false
  const limit = Math.max(a.length, b.length) <= 5 ? 1 : 2
  return distance(a, b) <= limit
}

function distance(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = curr
  }
  return prev[b.length]!
}
