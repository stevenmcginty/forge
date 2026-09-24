/**
 * One terminal, one name.
 *
 * THE RULE: a terminal's name is the name on its tab — "Zeb". It is the only
 * name it has, the one Steve reads on screen, the one every brain is shown and
 * the one every tool resolves. A second pane split into Zeb's tab is "Zeb 2"
 * until someone renames it. The agent kind ("Claude Code", "Codex") is what
 * runs in a terminal, never a name for it; numbers and agent words are still
 * understood when said ("terminal two", "the codex one") but never printed.
 *
 * Pure: no React, no Electron — read by the renderer, the browser and main.
 */

/**
 * A terminal's name from where it sits: the first pane in a tab is the tab's
 * name; any later one is its own title if it was given one, else "Zeb 2",
 * "Zeb 3" by position.
 */
export function terminalName(tabTitle: string, leafTitle: string, indexInTab: number): string {
  if (indexInTab <= 0) return tabTitle
  return leafTitle.trim() || `${tabTitle} ${indexInTab + 1}`
}

export type TerminalResolution<T> =
  | { kind: 'one'; pane: T }
  /** Several equally good answers. Never guessed between — always asked about. */
  | { kind: 'ambiguous'; matches: T[] }
  | { kind: 'none' }

export interface ResolveTerminalOptions<T> {
  /**
   * What the caller understood before names existed — a bare number, "this",
   * an agent word — tried only once no name matches.
   */
  fallback?: (query: string) => TerminalResolution<T>
  /**
   * True for a word that names an agent kind ("qwen", "ki"). Such a word is
   * never read as the start of a name or a misspelt one — "qwen" is one letter
   * from "Gwen", "ki" starts "Kira" — only an exact name beats it.
   */
  isKindWord?: (word: string) => boolean
}

/** Lower case, letters and digits only: "Zeb 2", "zeb2" and "ZEB-2" are one name. */
export function nameKey(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

/** Levenshtein distance. The one copy — appactions.ts imports it from here. */
export function distance(a: string, b: string): number {
  if (a === b) return 0
  const rows = a.length + 1
  const cols = b.length + 1
  let prev = new Array<number>(cols)
  let curr = new Array<number>(cols)
  for (let j = 0; j < cols; j++) prev[j] = j
  for (let i = 1; i < rows; i++) {
    curr[0] = i
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[cols - 1]!
}

/** Words said around a name that are not part of it: "the Zeb one", "terminal Zeb", "go to Zeb". */
const AROUND_A_NAME = new Set([
  'the',
  'a',
  'to',
  'in',
  'into',
  'terminal',
  'terminals',
  'pane',
  'panel',
  'tab',
  'window',
  'session',
  'one',
  'called',
  'named'
])

/** Spoken numbers as digits, so "Zeb two" is "Zeb 2". */
const DIGITS: Record<string, string> = {
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12'
}

/** The ways one query could be spelling a name, most literal first. */
function nameCandidates(query: string): string[] {
  const words = String(query ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]+/g, ' ')
    .replace(/'s\b/g, '')
    .split(/[\s-]+/)
    .filter(Boolean)
  const kept = words.filter((w) => !AROUND_A_NAME.has(w))
  // "one" is gone by now ("the Zeb one" is Zeb), so it never becomes a digit.
  const spelled = kept.map((w) => DIGITS[w] ?? w)
  const out = [nameKey(words.join('')), nameKey(kept.join('')), nameKey(spelled.join(''))]
  return [...new Set(out.filter(Boolean))]
}

function decide<T>(hits: T[]): TerminalResolution<T> | null {
  if (hits.length === 1) return { kind: 'one', pane: hits[0]! }
  if (hits.length > 1) return { kind: 'ambiguous', matches: hits }
  return null
}

/**
 * A spoken or typed target → one terminal, by its name.
 *
 * Exact name (case and spacing ignored), then a unique prefix ("Vig" for
 * Viggo), then whatever `opts.fallback` understands (a number, "this", an
 * agent word), and last a unique close match ("Zed" for Zeb). The fallback
 * goes before the close match so a handle is never mistaken for a misheard
 * name: "the last one" is not "Lars". Two equally good answers come back
 * `ambiguous`: a brief sent to the wrong agent is worse than being asked.
 */
export function resolveTerminal<T extends { name: string }>(
  query: string,
  panes: readonly T[],
  opts: ResolveTerminalOptions<T> = {}
): TerminalResolution<T> {
  const all = [...(panes ?? [])]
  const fallback = (): TerminalResolution<T> => opts.fallback?.(query) ?? { kind: 'none' }
  if (all.length === 0) return fallback()
  const keys = nameCandidates(query)
  const keyOf = (p: T): string => nameKey(p.name)

  for (const q of keys) {
    const exact = decide(all.filter((p) => keyOf(p) === q))
    if (exact) return exact
  }
  for (const q of keys) {
    if (q.length < 2 || /^\d+$/.test(q) || opts.isKindWord?.(q)) continue
    const prefix = decide(all.filter((p) => keyOf(p).startsWith(q)))
    if (prefix) return prefix
  }
  const through = fallback()
  if (through.kind !== 'none') return through
  for (const q of keys) {
    if (q.length < 3 || /^\d+$/.test(q) || opts.isKindWord?.(q)) continue
    const near = decide(
      all.filter((p) => {
        const n = keyOf(p)
        return n.length >= 3 && distance(q, n) <= (Math.max(q.length, n.length) <= 5 ? 1 : 2)
      })
    )
    if (near) return near
  }
  return { kind: 'none' }
}

/** "Zeb (Claude Code), Viggo (Antigravity)" — every terminal by its one name, with its kind. */
export function listTerminals(panes: readonly { name: string; profileName: string }[]): string {
  return panes.map((p) => `${p.name} (${p.profileName})`).join(', ')
}
