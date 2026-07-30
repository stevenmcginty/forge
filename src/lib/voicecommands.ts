import type { SplitDirection } from '@shared/types'
import { matchProfile, matchProject, type ActionContext, type AppAction } from './appactions'
import type { BrainConfidence } from './voicebrain'

/**
 * Plain-English app control, with no engine involved.
 *
 * "open up three tabs of kimmy" is not a prompt to be interpreted — it is a
 * command, and Steve should not have to wait on a model (or pay for one) to have
 * it obeyed. So every utterance is run past this grammar first; if it matches,
 * the action is executed immediately and the brain never sees it.
 *
 * It is deliberately conservative: anything that is not obviously a command
 * returns null and falls through to the brain, because a false positive here
 * would fire real actions at Steve's terminals. Hence the word cap, the
 * requirement for both an intent word and an object, and no clever guessing.
 */

export interface CommandHit {
  action: AppAction
  confidence: BrainConfidence
}

export type CommandContext = Pick<ActionContext, 'profiles' | 'projects' | 'defaultProfileId'>

/** Commands are short. Long sentences are briefs, not orders. */
const MAX_COMMAND_WORDS = 12

const NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  couple: 2,
  few: 3,
  dozen: 12
}

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10
}

const TAB_WORDS = new Set([
  'tab',
  'tabs',
  'terminal',
  'terminals',
  'window',
  'windows',
  'instance',
  'instances',
  'shell',
  'shells',
  'session',
  'sessions'
])

const PANE_WORDS = new Set(['pane', 'panes', 'split', 'splits'])

const OPEN_WORDS = new Set([
  'open',
  'launch',
  'start',
  'fire',
  'spin',
  'boot',
  'give',
  'gimme',
  'get',
  'add',
  'create',
  'new',
  'run'
])

const FILLER = new Set([
  'up',
  'me',
  'a',
  'an',
  'the',
  'of',
  'and',
  'more',
  'another',
  'some',
  'please',
  'in',
  'into',
  'with',
  'for',
  'to',
  'on',
  'side',
  'by',
  'here',
  'now',
  'this',
  'that',
  'it',
  'project',
  'agent',
  'agents',
  'down',
  'right',
  'below',
  'under',
  'beside',
  'across',
  'vertically',
  'horizontally',
  'across'
])

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function numberIn(tokens: string[]): number | null {
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      const n = Number(t)
      if (n >= 0 && n <= 99) return n
    }
    const word = NUMBERS[t]
    if (word !== undefined) return word
  }
  return null
}

/** Trim the filler off a spoken name: "the forge project" → "forge". */
function cleanName(raw: string): string {
  return raw
    .replace(/^(?:the|my|a|an)\s+/i, '')
    .replace(/\s+(?:project|folder|repo|workspace)$/i, '')
    .replace(/^(?:project|folder|repo|workspace)\s+/i, '')
    .trim()
}

/* ---------------------------------------------------------------- parsing */

export function parseCommand(transcript: string, ctx: CommandContext): CommandHit | null {
  const text = transcript.trim().toLowerCase()
  if (!text) return null
  const tokens = words(text)
  if (tokens.length === 0 || tokens.length > MAX_COMMAND_WORDS) return null
  const has = (w: string): boolean => tokens.includes(w)

  /* --- focus a tab by position: "go to tab 2", "second tab", "tab 3" ----- */
  const focus = parseFocusTab(text, tokens)
  if (focus) return focus

  /* --- switch project: "switch to forge", "go to the 1 project" ---------- */
  const switched = parseSwitchProject(text)
  if (switched) return switched

  /* --- close: "close this pane", "close the tab" ------------------------- */
  if (has('close') || has('kill') || has('shut')) {
    if (tokens.some((t) => PANE_WORDS.has(t))) {
      return { action: { kind: 'close_pane', which: 'focused' }, confidence: 'high' }
    }
    if (has('tab') || has('tabs')) {
      return { action: { kind: 'close_tab', which: 'current' }, confidence: 'high' }
    }
    // "close this" / "close it" — a pane is the smaller, safer reading.
    return { action: { kind: 'close_pane', which: 'focused' }, confidence: 'medium' }
  }

  /* --- add a project: voice never opens a folder picker ------------------ */
  if (has('project') && tokens.some((t) => t === 'new' || t === 'add' || t === 'create')) {
    return { action: { kind: 'new_project_hint' }, confidence: 'high' }
  }

  /* --- open tabs / panes ------------------------------------------------- */
  return parseOpen(text, tokens, ctx)
}

function parseFocusTab(text: string, tokens: string[]): CommandHit | null {
  const navigating = /\b(?:switch|go|jump|focus|show|take me|move)\b/.test(text)

  // "tab 3" / "tab number 3"
  const digit = /\btabs?\s+(?:number\s+)?(\d+)\b/.exec(text)
  if (digit && (navigating || tokens.length <= 3)) {
    const n = Number(digit[1])
    if (n >= 1 && n <= 99) return { action: { kind: 'focus_tab', index: n - 1 }, confidence: 'high' }
  }

  // "the second tab"
  const ordinal = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+tab\b/.exec(text)
  if (ordinal) {
    const n = ORDINALS[ordinal[1]!]!
    return { action: { kind: 'focus_tab', index: n - 1 }, confidence: 'high' }
  }

  // "tab three"
  const spelled = /\btabs?\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/.exec(text)
  if (spelled && (navigating || tokens.length <= 3)) {
    const n = NUMBERS[spelled[1]!]!
    if (n >= 1) return { action: { kind: 'focus_tab', index: n - 1 }, confidence: 'high' }
  }

  return null
}

function parseSwitchProject(text: string): CommandHit | null {
  const m = /\b(?:switch|go|change|jump|move|take me|head)\s+(?:back\s+)?(?:to|over to|into|onto)\s+(.+)$/.exec(text)
  if (!m) return null
  const name = cleanName(m[1]!)
  if (!name) return null
  // "switch to a pane/tab" is navigation, not a project.
  const first = words(name)[0] ?? ''
  if (TAB_WORDS.has(first) || PANE_WORDS.has(first)) return null
  const explicit = /\bproject\b/.test(text)
  return { action: { kind: 'switch_project', name }, confidence: explicit ? 'high' : 'medium' }
}

function parseOpen(text: string, tokens: string[], ctx: CommandContext): CommandHit | null {
  const verbIndex = tokens.findIndex((t) => OPEN_WORDS.has(t))
  const nounIndex = tokens.findIndex((t) => PANE_WORDS.has(t) || TAB_WORDS.has(t))
  const noun = nounIndex >= 0 ? tokens[nounIndex]! : null
  const paneWord = noun && PANE_WORDS.has(noun) ? noun : null

  // A profile can be named anywhere: "three tabs of kimi", "two claude tabs".
  let profile: ReturnType<typeof matchProfile> = null
  for (const token of tokens) {
    if (FILLER.has(token) || NUMBERS[token] !== undefined || /^\d+$/.test(token)) continue
    if (OPEN_WORDS.has(token) || TAB_WORDS.has(token) || PANE_WORDS.has(token)) continue
    const hit = matchProfile(ctx.profiles, token)
    if (hit) {
      profile = hit
      break
    }
  }
  // "open a shell" — the noun itself names the agent.
  if (!profile && noun) profile = matchProfile(ctx.profiles, noun)

  /**
   * The guard that keeps "run the tests in the terminal" from opening a tab:
   * between the verb and the thing being opened there may only be filler,
   * numbers and agent names. A stray noun means this is a sentence, not an order.
   */
  const onlyFillerBetween = (from: number, to: number): boolean =>
    tokens.slice(from + 1, to).every(
      (t) =>
        FILLER.has(t) ||
        NUMBERS[t] !== undefined ||
        /^\d+$/.test(t) ||
        OPEN_WORDS.has(t) ||
        TAB_WORDS.has(t) ||
        PANE_WORDS.has(t) ||
        matchProfile(ctx.profiles, t) !== null
    )

  const explicitCount = numberIn(tokens)
  let confidence: BrainConfidence
  if (verbIndex >= 0 && nounIndex > verbIndex && onlyFillerBetween(verbIndex, nounIndex)) {
    confidence = 'high'
  } else if (nounIndex >= 0 && profile && (explicitCount !== null || tokens.length <= 4)) {
    // "three kimi tabs" — no verb, but unmistakable.
    confidence = 'medium'
  } else if (verbIndex >= 0 && nounIndex < 0 && profile && tokens.length <= 5) {
    // "fire up kimi" — no noun, so a tab is meant.
    confidence = 'medium'
  } else {
    return null
  }

  const count = explicitCount ?? 1
  if (count < 1) return null

  const profileId = profile?.id ?? ctx.defaultProfileId

  // "in the roma project" targets somewhere else.
  let projectName: string | undefined
  const inProject = /\bin\s+(?:the\s+)?(.+)$/.exec(text)
  if (inProject) {
    const candidate = cleanName(inProject[1]!)
    const match = candidate ? matchProject(ctx.projects, candidate) : null
    if (match) projectName = match.name
  }

  if (paneWord) {
    const direction: SplitDirection | undefined = /\b(down|below|under|beneath|vertically)\b/.test(text)
      ? 'column'
      : /\b(right|beside|across|horizontally|side)\b/.test(text)
        ? 'row'
        : undefined
    const action: AppAction = { kind: 'open_panes', profileId, count }
    if (direction) action.direction = direction
    return { action, confidence }
  }

  const action: AppAction = { kind: 'open_tabs', profileId, count }
  if (projectName) action.projectName = projectName
  return { action, confidence }
}
