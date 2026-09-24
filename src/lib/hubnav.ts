import { resolvePaneTarget, type ActionPane } from './appactions'

/**
 * "Go to Zeb", "go to panel four", "the claude one", "the board", "the
 * wall" — one resolver for voice and keyboard alike.
 *
 * Two places that are not panes: the Wall (every terminal at once — the
 * mosaic view) and the Board (agent images and artifacts). "Canvas" used to
 * name the board and got confused with the Wall when spoken, so the word no
 * longer goes anywhere: it comes back `which_view`, and the brain asks "the
 * Wall or the Board?".
 *
 * Order: the Wall, the Board and "canvas", then everything `resolvePaneTarget`
 * understands — a terminal's one name ("Zeb", "Zeb 2", a near miss like
 * "Zed"), then a number, "this" or an agent. Numbers are the executor's own
 * handles — tabs in order, panes in each tab in order — understood when said
 * and never printed. Two equally good answers come back `ambiguous`, never
 * guessed.
 *
 * Pure: no DOM, no React. The focus side effects live in hubRuntime.ts.
 */

/** A pane the navigator can reach — by its one name, `name`. */
export type NavPane = ActionPane

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
  // "panel" is the word the hub uses; the executor knows "pane". Same thing.
  const hit = resolvePaneTarget(text.replace(/\bpanels?\b/gi, 'pane'), all, focusedPaneId)
  if (hit.kind === 'pane') return { kind: 'pane', pane: hit.pane as NavPane }
  if (hit.kind === 'ambiguous') return { kind: 'ambiguous', candidates: hit.candidates as NavPane[] }
  return { kind: 'none', candidates: all }
}

/** One line per pane, for the model and for "which one?" answers: "Zeb (Claude Code), focused". */
export function describeNavPane(p: NavPane): string {
  return `${p.name} (${p.profileName})${p.focused ? ', focused' : ''}`
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
  | {
      kind: 'pane'
      paneId: string
      tabId: string
      number: number
      /** The terminal's one name. */
      name: string
      source: HubFocusSource
    }
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
