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

/** One utterance may hold more than one order. */
export interface UtteranceHit {
  actions: AppAction[]
  confidence: BrainConfidence
}

export type CommandContext = Pick<ActionContext, 'profiles' | 'projects' | 'defaultProfileId'>

/** Commands are short. Long sentences are briefs, not orders. */
const MAX_COMMAND_WORDS = 12

/** Two or three orders in one breath is normal; a paragraph is not. */
const MAX_UTTERANCE_WORDS = 26

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

/** Throat-clearing that carries no instruction of its own. */
const ACK = new Set([
  'right',
  'ok',
  'okay',
  'so',
  'now',
  'also',
  'please',
  'yeah',
  'yep',
  'cheers',
  'thanks',
  'well',
  'actually',
  'oh',
  'hey',
  'and',
  'then',
  'go',
  'on'
])

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

const RANK: Record<BrainConfidence, number> = { low: 0, medium: 1, high: 2 }

/**
 * The entry point the panel uses. Handles "close this pane and open a shell" by
 * splitting on the joining words and requiring *every* clause to be an order —
 * obeying half of a sentence is worse than obeying none of it, so a mixed
 * utterance ("open two kimi tabs and make the login page pretty") is handed to
 * the brain whole, where it can be answered properly.
 */
export function parseUtterance(transcript: string, ctx: CommandContext): UtteranceHit | null {
  const text = transcript.trim()
  if (!text) return null

  const single = parseCommand(text, ctx)
  const asSingle = (): UtteranceHit | null =>
    single ? { actions: [single.action], confidence: single.confidence } : null

  // A dispatched prompt is one thing however many commas are in it — splitting
  // "in terminal two, build a landing page, then a menu page" into clauses would
  // throw the prompt away.
  if (single?.action.kind === 'send_prompt' || single?.action.kind === 'create_project') return asSingle()

  const clauses = text
    .split(/\s*(?:,|;|\band then\b|\bthen\b|\band also\b|\band\b|\bplus\b)\s*/i)
    .map((c) => c.trim())
    .filter(Boolean)
    // "right, open two kimi tabs" — drop the throat-clearing.
    .filter((clause) => {
      const w = words(clause)
      return w.length > 0 && !w.every((t) => ACK.has(t))
    })

  if (clauses.length < 2) return asSingle()
  if (words(text).length > MAX_UTTERANCE_WORDS) return asSingle()

  const hits: CommandHit[] = []
  for (const clause of clauses) {
    const hit = parseCommand(clause, ctx)
    if (!hit) return null // mixed intent — let the brain read the whole thing
    hits.push(hit)
  }
  const confidence = hits.reduce<BrainConfidence>(
    (worst, h) => (RANK[h.confidence] < RANK[worst] ? h.confidence : worst),
    'high'
  )
  return { actions: hits.map((h) => h.action), confidence }
}

export function parseCommand(transcript: string, ctx: CommandContext): CommandHit | null {
  const text = transcript.trim().toLowerCase()
  if (!text) return null

  /* --- dispatch: "in terminal two, build me a landing page" --------------
   *
   * Ahead of the word cap on purpose. Everything else here is a short order;
   * this one is an *address* followed by a prompt, and the prompt is as long as
   * it likes. The address is what has to be short and unmistakable.
   */
  const dispatch = parseDispatch(transcript.trim())
  if (dispatch) return dispatch

  /* --- create a project: also ahead of the cap ---------------------------
   * "Open up a new project called Tester Tester. Put the project file on the
   * desktop and then open it in the projects pane" is one order in twenty-two
   * words — he is saying where to put it and what to do next, not changing the
   * subject. The cap exists to stop *briefs* being obeyed, and this is not one.
   */
  const created = parseCreateProject(transcript.trim())
  if (created) return created

  const tokens = words(text)
  if (tokens.length === 0 || tokens.length > MAX_COMMAND_WORDS) return null
  const has = (w: string): boolean => tokens.includes(w)

  /* --- close: "close tab one", "close all three tabs", "close this pane" --
   *
   * The ordinal branch is here because of a real failure: "close tab one" used
   * to produce *focus_tab* — the closing actions took no target, so the only
   * action that could hold a number was the wrong one, and Forge cheerfully
   * switched to the tab he had asked it to get rid of.
   */
  if (has('close') || has('kill') || has('shut') || has('quit')) {
    const bulk = parseBulkClose(text, tokens)
    if (bulk) return bulk

    const targeted = /\b(?:tab|tabs|terminal|terminals|pane|panes|window|windows|split|splits)\s+(?:number\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|last)\b/.exec(
      text
    )
    const ordinalFirst = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\s+(tab|terminal|pane|window|split)\b/.exec(
      text
    )
    if (targeted || ordinalFirst) {
      const noun = targeted ? targeted[0].split(/\s+/)[0]! : ordinalFirst![2]!
      const which = targeted ? `${noun} ${targeted[1]}` : `${ordinalFirst![2]} ${ordinalFirst![1]}`
      const isPane = PANE_WORDS.has(noun) || noun === 'window' || noun === 'windows'
      return {
        action: isPane ? { kind: 'close_pane', which } : { kind: 'close_tab', which },
        confidence: 'high'
      }
    }

    if (tokens.some((t) => PANE_WORDS.has(t))) {
      return { action: { kind: 'close_pane', which: 'focused' }, confidence: 'high' }
    }
    if (has('tab') || has('tabs') || has('terminal') || has('terminals')) {
      return { action: { kind: 'close_tab', which: 'current' }, confidence: 'high' }
    }
    // "close this" / "close it" — a pane is the smaller, safer reading.
    return { action: { kind: 'close_pane', which: 'focused' }, confidence: 'medium' }
  }

  /* --- focus a tab by position: "go to tab 2", "second tab", "tab 3" -----
   * After closing, deliberately: "close tab one" names a tab and a number, and
   * the only difference between the two readings is the verb. */
  const focus = parseFocusTab(text, tokens)
  if (focus) return focus

  /* --- switch project: "switch to forge", "go to the 1 project" ---------- */
  const switched = parseSwitchProject(text)
  if (switched) return switched

  /* --- add a project without a name: still a hint ------------------------ */
  if (has('project') && tokens.some((t) => t === 'new' || t === 'add' || t === 'create')) {
    return { action: { kind: 'new_project_hint' }, confidence: 'high' }
  }

  /* --- open tabs / panes ------------------------------------------------- */
  return parseOpen(text, tokens, ctx)
}

/* ------------------------------------------------------------- dispatch */

/** Nouns that can be addressed: "terminal two", "the claude pane". */
const ADDRESS_NOUN = 'terminals?|tabs?|panes?|windows?|shells?|sessions?|instances?'
const ADDRESS_NUMBER = '\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve'
const ADDRESS_ORDINAL = 'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last'

/**
 * The guard that stops "the second tab is broken" being dispatched as the
 * prompt "is broken". If what follows the address reads as a *statement about*
 * that terminal rather than an *instruction to* it, this is conversation and
 * belongs to the brain.
 */
const PREDICATE_START = new Set([
  'is',
  'isnt',
  'was',
  'wasnt',
  'are',
  'arent',
  'were',
  'has',
  'hasnt',
  'have',
  'havent',
  'had',
  'looks',
  'look',
  'looking',
  'seems',
  'seem',
  'keeps',
  'keep',
  'does',
  'doesnt',
  'did',
  'didnt',
  'wont',
  'will',
  'would',
  'should',
  'shall',
  'can',
  'cant',
  'could',
  'might',
  'must',
  'needs',
  'shows',
  'says',
  'said',
  'went',
  'got',
  'gets',
  'goes',
  'still',
  'just',
  'why',
  'what',
  'whats',
  'when',
  'where',
  'who',
  'how',
  'which',
  'whether',
  'or',
  'but'
])

/**
 * Free-flow dispatch, straight past the brain.
 *
 * Steve says "open three claude terminals" and then, without pausing, "in
 * terminal two, this is the prompt…". The second half is not a sentence to be
 * interpreted — the address is explicit and the rest is his words. Sending that
 * to a model would cost five seconds and risk it being rewritten, so a named
 * terminal plus a remainder is dispatched verbatim.
 *
 * Deliberately *not* fleshed out here: that is the brain's job, and this is the
 * quick path. Everything without an explicit address falls through.
 */
function parseDispatch(original: string): CommandHit | null {
  const patterns: Array<{ re: RegExp; target: (m: RegExpExecArray) => string; rest: number; confidence: BrainConfidence }> = [
    // "in terminal two, <rest>" / "terminal 2: <rest>" / "on tab three <rest>"
    {
      re: new RegExp(
        `^(?:in|on|to|into|over in|over to)?\\s*(?:the\\s+)?(${ADDRESS_NOUN})\\s+(${ADDRESS_NUMBER})\\b\\s*[,;:.\\-–—]?\\s+(.+)$`,
        'is'
      ),
      target: (m) => `${m[1]} ${m[2]}`,
      rest: 3,
      confidence: 'high'
    },
    // "in the second terminal, <rest>" / "the last pane: <rest>"
    {
      re: new RegExp(
        `^(?:in|on|to|into)?\\s*(?:the\\s+)?(${ADDRESS_ORDINAL})\\s+(${ADDRESS_NOUN})\\b\\s*[,;:.\\-–—]?\\s+(.+)$`,
        'is'
      ),
      target: (m) => `${m[2]} ${m[1]}`,
      rest: 3,
      confidence: 'high'
    },
    // "tell the claude pane <rest>" / "tell claude terminal: <rest>"
    {
      re: new RegExp(`^(?:tell|ask|send to|give)\\s+(?:the\\s+)?(.{1,24}?)\\s+(?:${ADDRESS_NOUN}|one)\\s*[,;:.\\-–—]?\\s+(.+)$`, 'is'),
      target: (m) => m[1]!,
      rest: 2,
      confidence: 'high'
    },
    // "in the claude pane, <rest>" — a name rather than a number.
    {
      re: new RegExp(`^(?:in|on|to|into)\\s+(?:the\\s+)?(.{1,24}?)\\s+(?:${ADDRESS_NOUN})\\s*[,;:]\\s*(.+)$`, 'is'),
      target: (m) => m[1]!,
      rest: 2,
      confidence: 'medium'
    }
  ]

  for (const p of patterns) {
    const m = p.re.exec(original)
    if (!m) continue
    const rest = (m[p.rest] ?? '').trim().replace(/^(?:this is the prompt|the prompt is|prompt)\s*[,:.-]?\s*/i, '')
    if (!rest) continue
    // A bare address plus one filler word is not a prompt.
    const restWords = words(rest)
    if (restWords.length === 0 || restWords.every((w) => FILLER.has(w) || ACK.has(w))) continue
    if (PREDICATE_START.has(restWords[0]!)) continue
    return {
      action: { kind: 'send_prompt', target: p.target(m).trim(), text: rest, flesh: false },
      confidence: p.confidence
    }
  }
  return null
}

/**
 * "close everything", "close all three tabs", "close the kimi ones".
 *
 * Only fires with an explicit plural or an explicit "all/every/everything" —
 * "close the tab" must stay a single close, because bulk is the one that costs
 * you five agent sessions.
 */
function parseBulkClose(text: string, tokens: string[]): CommandHit | null {
  const everything = /\b(everything|all|every|the lot)\b/.test(text)
  const plural = /\b(tabs|terminals|panes|windows|sessions|ones)\b/.test(text)
  if (!everything && !plural) return null

  if (/\bothers?\b|\ball but this\b|\beverything else\b/.test(text)) {
    return { action: { kind: 'close_tabs', which: 'others' }, confidence: 'high' }
  }
  // "close the kimi ones" / "close all the claude tabs" — a named agent.
  const named = tokens.find(
    (t) =>
      !CLOSE_FILLER.has(t) &&
      !TAB_WORDS.has(t) &&
      !PANE_WORDS.has(t) &&
      NUMBERS[t] === undefined &&
      !/^\d+$/.test(t)
  )
  if (named) return { action: { kind: 'close_tabs', which: named }, confidence: 'high' }
  if (everything || plural) return { action: { kind: 'close_tabs', which: 'all' }, confidence: 'high' }
  return null
}

/**
 * "open up a new project called Tester Tester, put it on the desktop".
 *
 * The name is quoted back exactly as heard, capitals and all — a folder called
 * "tester tester" when he said "Tester Tester" is a small thing that reads as
 * the app not listening. Only an explicit "called/named X" counts; without a
 * name there is nothing to create and it falls through to the hint.
 */
function parseCreateProject(original: string): CommandHit | null {
  const text = original.toLowerCase()
  // The order has to be the *opening* of the sentence. "I'm thinking about a
  // new project called Roma, it would do X, Y and Z" is a brief, and creating a
  // folder off the back of it would be Forge acting on thinking aloud.
  if (
    !/^(?:right|ok|okay|so|now|please|hey)?[,\s]*(?:can you |could you |i want you to |i'?d like you to |let'?s )?(?:open up|open|create|make|start|set up|add|new)\b/.test(
      text
    )
  ) {
    return null
  }
  if (!/\b(new|create|make|start|set up|add)\b/.test(text)) return null
  if (!/\bproject\b/.test(text)) return null
  const m = /\b(?:called|named|call it|name it)\s+([^,.;]+)/i.exec(original)
  if (!m) return null

  // Stop at the next instruction: "called Tester Tester and put it on the desktop".
  const name = (m[1] ?? '')
    .replace(/\s+\b(?:and|then|please|put|in|on|under|inside|into)\b.*$/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim()
  if (!name || name.length > 60) return null

  const action: AppAction = { kind: 'create_project', name }
  if (/\bdesktop\b/i.test(original)) action.parentDir = 'desktop'
  else if (/\bdocuments?\b/i.test(original)) action.parentDir = 'documents'
  return { action, confidence: 'high' }
}

/** Words that carry no agent name in a close command. */
const CLOSE_FILLER = new Set([
  'close',
  'kill',
  'shut',
  'quit',
  'down',
  'all',
  'every',
  'everything',
  'the',
  'my',
  'a',
  'an',
  'of',
  'them',
  'ones',
  'one',
  'lot',
  'please',
  'off',
  'out'
])

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
