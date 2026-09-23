/**
 * The choices an agent's question offers, read off the words it asked with.
 *
 * The desktop hands an asking pane's question over as one flattened line —
 * `Do you want to overwrite web/src/styles.css? ❯ 1. Yes 2. Yes, and don't ask
 * again this session 3. No, and tell Claude what to do differently` — capped at
 * 200 characters on its way out, so a long question can arrive with its last
 * option cut. The pane's own screen still has the menu whole, one row per
 * option, so that is read too and the fuller of the two wins.
 *
 * Pure and dependency-free on purpose: the answer card is the only caller, and
 * a parser this tolerant is one to exercise by hand with node.
 */

export interface AnswerOption {
  /** The number the menu printed — what a digit key picks. */
  n: number
  /** The option in its own words, hints and all. */
  label: string
}

export interface ParsedAsk {
  /** Everything before the first option; empty when nothing preceded it. */
  question: string
  /** Numbered 1..N in order, or empty when no menu could be found. */
  options: AnswerOption[]
  /** Which option the menu's cursor sits on, 0-based. 0 when none is marked. */
  cursor: number
}

/** The row markers the CLIs draw beside the selected option. */
const CURSOR = '❯›▶►●>'
const ITEM = new RegExp(`(^|\\s)([${CURSOR}]\\s*)?(\\d{1,2})[.)]\\s+`, 'g')
/** A TUI's key hints trailing the last option in a flattened line. */
const TRAILING_HINT = /\s+(?:Esc to cancel|Enter to confirm|Press enter|↑\/?↓ to (?:navigate|select)).*$/i
/** Box-drawing borders around a menu row on screen. */
const BORDER = /^[\s│┃|╭╮╰╯─━]+|[\s│┃|╭╮╰╯─━]+$/g

const tidy = (text: string): string => text.replace(/\s+/g, ' ').trim()
const stripCursor = (text: string): string => text.replace(new RegExp(`[${CURSOR}]\\s*$`), '').trim()

/**
 * A flattened question: find the longest run of `1. … 2. … 3. …` in order and
 * cut the labels between them. A lone `1.` or numbers out of order are prose,
 * not a menu — "step 2. then" does not become a button.
 */
export function parsePrompt(text: string): ParsedAsk {
  const flat = tidy(text)
  const hits: { at: number; end: number; n: number; cursor: boolean }[] = []
  for (const m of flat.matchAll(ITEM)) {
    const at = (m.index ?? 0) + m[1]!.length
    hits.push({ at, end: (m.index ?? 0) + m[0].length, n: Number(m[3]), cursor: Boolean(m[2]) })
  }
  let best: typeof hits = []
  for (let i = 0; i < hits.length; i++) {
    if (hits[i]!.n !== 1) continue
    const chain = [hits[i]!]
    for (let j = i + 1; j < hits.length; j++) {
      if (hits[j]!.n === chain[chain.length - 1]!.n + 1) chain.push(hits[j]!)
    }
    // The longest chain; on a tie the later one, which is nearer the menu.
    if (chain.length >= 2 && chain.length >= best.length) best = chain
  }
  if (best.length < 2) return { question: flat, options: [], cursor: 0 }
  const options = best.map((hit, i) => {
    const next = best[i + 1]
    const raw = flat.slice(hit.end, next ? next.at : undefined)
    const label = stripCursor(next ? raw : raw.replace(TRAILING_HINT, ''))
    return { n: hit.n, label: tidy(label) }
  })
  if (options.some((o) => !o.label)) return { question: flat, options: [], cursor: 0 }
  const marked = best.findIndex((hit) => hit.cursor)
  return { question: stripCursor(flat.slice(0, best[0]!.at)), options, cursor: marked < 0 ? 0 : marked }
}

const ROW = new RegExp(`^([${CURSOR}]\\s*)?(\\d{1,2})[.)]\\s+(.+)$`)

/**
 * The pane's screen, one string per row, newest last. The menu is the last run
 * of numbered rows that has a cursor on one of them — a numbered list in the
 * agent's own prose has no cursor and is passed over. Null when there is none.
 */
export function parseScreen(lines: string[]): ParsedAsk | null {
  const rows = lines.map((line) => line.replace(BORDER, ''))
  let cursorRow = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = ROW.exec(rows[i]!)
    if (m && m[1]) {
      cursorRow = i
      break
    }
  }
  if (cursorRow < 0) return null
  // Walk out from the cursor row over the option rows either side of it. A
  // description line under an option, or a blank one, does not end the menu;
  // two of them in a row does.
  const items = new Map<number, { n: number; label: string; cursor: boolean }>()
  const take = (i: number): boolean => {
    const m = ROW.exec(rows[i]!)
    if (!m) return false
    items.set(i, { n: Number(m[2]), label: tidy(m[3]!), cursor: Boolean(m[1]) })
    return true
  }
  take(cursorRow)
  for (const step of [-1, 1]) {
    let misses = 0
    for (let i = cursorRow + step; i >= 0 && i < rows.length && misses < 2; i += step) {
      misses = take(i) ? 0 : misses + 1
    }
  }
  const ordered = [...items.entries()].sort((a, b) => a[0] - b[0])
  const first = ordered.findIndex(([, item]) => item.n === 1)
  if (first < 0) return null
  const chain: { n: number; label: string; cursor: boolean }[] = []
  const firstRow = ordered[first]![0]
  for (const [, item] of ordered.slice(first)) {
    if (item.n === chain.length + 1) chain.push(item)
  }
  if (chain.length < 2) return null
  let question = ''
  for (let i = firstRow - 1; i >= 0 && i >= firstRow - 6; i--) {
    const line = tidy(rows[i]!)
    if (line) {
      question = line
      break
    }
  }
  const marked = chain.findIndex((item) => item.cursor)
  return {
    question,
    options: chain.map(({ n, label }) => ({ n, label })),
    cursor: marked < 0 ? 0 : marked
  }
}

/** A shell-style yes/no: `[y/N]`, `(y/n)`, `[Y/n]`, `yes/no`, in any case. */
const YES_NO = /[[(]\s*y\s*\/\s*n\s*[\])]|\byes\s*\/\s*no\b/i

/**
 * Whether a question with no menu is asked the way a shell asks — `[y/N]` and
 * the like — which takes a bare `y` or `n`. Anything else is prose, which an
 * agent answers from its own input box, in words.
 */
export function isYesNo(question: string): boolean {
  return YES_NO.test(question)
}

/**
 * The prompt's reading, unless the screen has a fuller one — the flattened
 * line is capped and the screen is not.
 */
export function readAsk(prompt: string, screen: string[]): ParsedAsk {
  const fromPrompt = parsePrompt(prompt)
  const fromScreen = parseScreen(screen)
  if (fromScreen && fromScreen.options.length > fromPrompt.options.length) {
    return { ...fromScreen, question: fromPrompt.options.length ? fromPrompt.question : fromScreen.question || fromPrompt.question }
  }
  return fromPrompt
}
