import { MAX_VIDEO_SECONDS, MIN_VIDEO_SECONDS, VIDEO_ASPECT_RATIOS, type AppAction } from './appactions'
import type { BrainReply } from './voicebrain'

/**
 * The JSON contract every live brain answers in, and the defensive machinery
 * that turns a model's best effort into a `BrainReply`.
 *
 * This lives apart from any one engine because every brain hits exactly the same
 * three problems — fenced JSON, trailing prose, and replies cut off mid-object
 * by an output-token limit — and there is no reason for Gemini and OpenRouter to
 * solve them twice and differently. `geminibrain.ts` and `openrouterbrain.ts`
 * both build on these.
 *
 * The rule throughout: never throw away a usable answer, and never invent one.
 * Unknown action kinds are dropped rather than passed on, counts are clamped,
 * and a truncated reply is salvaged down to whatever complete fields it managed.
 */

/* ------------------------------------------------------------------- memory */

/**
 * The heading a project's memory arrives under in the system text. One string,
 * used by every brain, so the model sees the same section name whichever engine
 * is answering — and so voice-check can assert the fold-in really happened.
 */
export const MEMORY_HEADING = '# WHAT YOU REMEMBER ABOUT THIS PROJECT'

/** Memory beyond this is a bug upstream; clip rather than send a novel. */
const MEMORY_LIMIT = 12_000

/**
 * Append the project's memory to the manifest, if there is any.
 *
 * Deliberately additive: the manifest is built without knowing whether a memory
 * exists, and an empty memory must leave the system text byte-identical to what
 * it was before this feature landed. Nothing is invented — the markdown goes in
 * exactly as it sits on disk, which is why the file is worth keeping readable.
 */
export function withProjectMemory(system: string, memory?: string): string {
  const body = (memory ?? '').trim()
  if (!body) return system
  const clipped = body.length > MEMORY_LIMIT ? `${body.slice(0, MEMORY_LIMIT)}…` : body
  return `${system}\n\n${MEMORY_HEADING}\n${clipped}`
}

/* ------------------------------------------------------------------ actions */

/**
 * Every action kind a brain may return. Must stay in step with `AppAction` in
 * appactions.ts and with `ACTION_SPECS` in appmanifest.ts — the manifest tells
 * the model what exists, this decides what is honoured, and the executor does
 * it. voice-check asserts all three agree.
 */
export const ACTION_KINDS: ReadonlySet<string> = new Set([
  'open_tabs',
  'open_panes',
  'close_pane',
  'close_tab',
  'switch_project',
  'focus_tab',
  'new_project_hint',
  'make_image',
  'edit_image',
  'use_skill',
  'make_video',
  'send_prompt',
  'close_tabs',
  'create_project',
  'rename_tab',
  'set_view',
  'open_settings'
])

/** The settings sections `open_settings` will actually go to. */
const SETTINGS_SECTIONS: ReadonlySet<string> = new Set([
  'account',
  'appearance',
  'agents',
  'models',
  'voice',
  'shots',
  'advanced'
])

/** How much conversational reply is worth showing. */
const SAY_LIMIT = 420

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

export function asCount(v: unknown, fallback = 1, max = 64): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(1, Math.floor(n)))
}

/**
 * Does this reply *claim* to have driven the app?
 *
 * Models are not reliable about this. Asked for three Claude Code terminals,
 * gemini-2.5-flash has answered "Opening three Claude Code terminals for you."
 * with an empty `actions` array — a plain untruth, and an invisible one, because
 * a reply with no actions renders no outcome chips at all. So when a claim is
 * made and nothing was returned to back it, the panel says so rather than
 * leaving the sentence standing and Steve waiting for tabs that never come.
 *
 * Deliberately narrow: only verbs that mean an app action, and only in the
 * present or past. "I can open three tabs for you" is an offer, not a claim.
 */
const CLAIM =
  /\b(?:opening|opened|closing|closed|creating|created|made|making|switching|switched|renaming|renamed|sending|sent|splitting|split)\b/i
const OFFER = /\b(?:can|could|would|shall|will|want|like me to|should i|do you)\b/i

export function claimsCompletedAction(text: string | undefined): boolean {
  if (!text) return false
  return CLAIM.test(text) && !OFFER.test(text)
}

/**
 * What the phone gets back when it asked about a project Forge is not showing.
 *
 * The Companion can address any project in the rail, but the executor drives
 * the panes of the *active* one — so a request that needs an action against
 * some other project cannot be honoured from here, and pretending otherwise
 * would be the worst kind of quiet failure. The words and any drafted brief
 * still come back, because they cost nothing and are the useful part; the
 * refusal is one plain sentence on the end, and only when actions were
 * actually asked for. A pure question gets a pure answer with no nagging.
 */
export function companionReplyText(reply: BrainReply, projectName: string): string {
  const parts = [reply.say, ...(reply.questions ?? [])].filter(Boolean)
  const body = [parts.join(' ') || reply.understood || '']
  const draft = reply.draftPrompt?.trim()
  if (draft) body.push(draft)
  if ((reply.actions ?? []).length > 0) body.push(`Switch to ${projectName} in Forge to run app actions.`)
  return body.filter(Boolean).join('\n\n')
}

/**
 * Tame the `say` field. Models sometimes loop ("I'm ready when you are." over
 * and over) — collapse immediate repeats and cap the length, so a bad generation
 * costs a sentence rather than the whole card.
 */
export function tidySay(text: string): string {
  const collapsed = text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence, i, all) => i === 0 || sentence.trim() !== all[i - 1]?.trim())
    .join(' ')
    .trim()
  if (collapsed.length <= SAY_LIMIT) return collapsed
  const cut = collapsed.slice(0, SAY_LIMIT)
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return `${(lastStop > 120 ? cut.slice(0, lastStop + 1) : cut).trim()}…`
}

/** Pull the outermost JSON object out of whatever came back. */
export function extractJsonObject(raw: string): string | null {
  if (!raw) return null
  let text = raw.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence?.[1]) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return text.slice(start, end + 1)
}

function unescapeJsonString(body: string): string {
  try {
    return JSON.parse(`"${body}"`) as string
  } catch {
    return body
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
}

/**
 * Rescue a reply that ran out of output tokens mid-JSON.
 *
 * This happens for real: a long drafted prompt can hit the model's output limit,
 * leaving valid-but-unterminated JSON. Throwing that away would lose a perfectly
 * good draft, so each top-level string is pulled out on its own, allowing the
 * last one to be unterminated.
 */
export function salvagePartialJson(raw: string, label = 'Gemini'): BrainReply | null {
  if (!raw) return null
  let text = raw.trim()
  const fence = /```(?:json)?\s*([\s\S]*)$/i.exec(text)
  if (fence?.[1]) text = fence[1]!.trim()
  const start = text.indexOf('{')
  if (start < 0) return null
  text = text.slice(start)

  const field = (name: string): string | undefined => {
    const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)(?:"|$)`).exec(text)
    if (!m) return undefined
    const value = unescapeJsonString(m[1] ?? '').trim()
    return value ? value : undefined
  }

  const understood = field('understood')
  const say = field('say')
  const draftPrompt = field('draftPrompt')
  if (!understood && !say && !draftPrompt) return null

  const reply: BrainReply = {
    understood: understood ?? `${label}’s reply was cut off`,
    confidence: 'low'
  }
  const note = `${label} hit its length limit, so this was cut off.`
  reply.say = say ? `${note} ${tidySay(say)}` : note
  if (draftPrompt) reply.draftPrompt = draftPrompt
  return reply
}

/** Keep only actions the executor actually implements, with sane arguments. */
export function sanitiseActions(value: unknown): AppAction[] {
  if (!Array.isArray(value)) return []
  const out: AppAction[] = []
  for (const raw of value.slice(0, 8)) {
    if (!raw || typeof raw !== 'object') continue
    const a = raw as Record<string, unknown>
    const kind = asString(a['kind'])
    if (!kind || !ACTION_KINDS.has(kind)) continue
    switch (kind) {
      case 'open_tabs': {
        const profileId = asString(a['profileId'])
        if (!profileId) continue
        const action: AppAction = { kind: 'open_tabs', profileId, count: asCount(a['count']) }
        const projectName = asString(a['projectName'])
        if (projectName) action.projectName = projectName
        out.push(action)
        break
      }
      case 'open_panes': {
        const profileId = asString(a['profileId'])
        if (!profileId) continue
        const action: AppAction = { kind: 'open_panes', profileId, count: asCount(a['count']) }
        const direction = asString(a['direction'])
        if (direction === 'row' || direction === 'column') action.direction = direction
        out.push(action)
        break
      }
      // `which` is a spoken target now ("tab one", "notes"), not an enum — the
      // old literals still mean what they meant.
      case 'close_pane':
        out.push({ kind: 'close_pane', which: asString(a['which']) ?? 'focused' })
        break
      case 'close_tab':
        out.push({ kind: 'close_tab', which: asString(a['which']) ?? 'current' })
        break
      case 'close_tabs':
        out.push({ kind: 'close_tabs', which: asString(a['which']) ?? 'all' })
        break
      case 'create_project': {
        const name = asString(a['name'])
        if (!name) continue
        const action: AppAction = { kind: 'create_project', name }
        const parentDir = asString(a['parentDir'])
        if (parentDir) action.parentDir = parentDir
        out.push(action)
        break
      }
      case 'rename_tab': {
        const name = asString(a['name'])
        if (!name) continue
        out.push({ kind: 'rename_tab', which: asString(a['which']) ?? 'current', name })
        break
      }
      case 'set_view': {
        const mode = asString(a['mode'])?.toLowerCase()
        if (mode !== 'tabs' && mode !== 'mosaic') continue
        out.push({ kind: 'set_view', mode })
        break
      }
      case 'open_settings': {
        const section = asString(a['section'])?.toLowerCase()
        // An invented section would land him on a blank page; drop it and let
        // Settings open where it opens.
        out.push(section && SETTINGS_SECTIONS.has(section) ? { kind: 'open_settings', section } : { kind: 'open_settings' })
        break
      }
      case 'switch_project': {
        const name = asString(a['name'])
        if (!name) continue
        out.push({ kind: 'switch_project', name })
        break
      }
      case 'focus_tab': {
        const n = a['index']
        const index = typeof n === 'number' ? Math.floor(n) : Number.parseInt(String(n ?? ''), 10)
        if (!Number.isFinite(index) || index < 0 || index > 98) continue
        out.push({ kind: 'focus_tab', index })
        break
      }
      case 'new_project_hint':
        out.push({ kind: 'new_project_hint' })
        break
      case 'make_image': {
        const description = asString(a['description'])
        if (!description) continue
        // Four is the executor's ceiling too: each one is a separate API call.
        const action: AppAction = { kind: 'make_image', description, count: asCount(a['count'], 1, 4) }
        const aspect = asString(a['aspect'])
        if (aspect) action.aspect = aspect
        out.push(action)
        break
      }
      case 'edit_image': {
        const path = asString(a['path'])
        const instruction = asString(a['instruction'])
        if (!path || !instruction) continue
        out.push({ kind: 'edit_image', path, instruction })
        break
      }
      case 'use_skill': {
        // A model that writes "/writing" instead of "writing" meant the same
        // thing; the executor is the one place that decides what a name is.
        const name = asString(a['name'])?.replace(/^\//, '')
        if (!name) continue
        const action: AppAction = { kind: 'use_skill', name }
        // Same spoken handles as send_prompt, and the same default: no target
        // means the focused terminal, which resolvePaneTarget already does for
        // an empty string.
        const target = asString(a['target'])
        if (target) action.target = target
        out.push(action)
        break
      }
      case 'make_video': {
        const description = asString(a['description'])
        if (!description) continue
        const action: AppAction = { kind: 'make_video', description }
        // Veo takes landscape or portrait only, and 4-8 seconds. Anything else
        // is dropped rather than passed on: the API would refuse it anyway, and
        // a silently-corrected request is worse than a plain default.
        const aspect = asString(a['aspect'])
        if (aspect && VIDEO_ASPECT_RATIOS.includes(aspect)) action.aspect = aspect
        const rawDuration = a['duration']
        if (rawDuration !== undefined && rawDuration !== null) {
          const n = typeof rawDuration === 'number' ? rawDuration : Number(rawDuration)
          if (Number.isFinite(n)) {
            action.duration = Math.min(MAX_VIDEO_SECONDS, Math.max(MIN_VIDEO_SECONDS, Math.round(n)))
          }
        }
        out.push(action)
        break
      }
      case 'send_prompt': {
        // `text` may be blank on purpose: that means "the draftPrompt in this
        // same reply", which saves a model repeating a page of prose twice.
        // The panel fills it in; the executor refuses an empty one.
        const action: AppAction = {
          kind: 'send_prompt',
          target: asString(a['target']) ?? 'this',
          text: asString(a['text']) ?? ''
        }
        if (typeof a['flesh'] === 'boolean') action.flesh = a['flesh']
        if (a['submit'] === false) action.submit = false
        out.push(action)
        break
      }
      default:
        break
    }
  }
  return coalesceCounts(out)
}

/**
 * "Three tabs" as three actions is the same order as one action with count 3.
 *
 * Models really do this — gemini-2.5-flash, asked for three Claude terminals,
 * emitted `open_tabs` three times with no count at all, which then defaulted to
 * one apiece and looked to Steve like "I asked for three, it opened one". The
 * schema now requires `count`, but a model that regresses must not be able to
 * cost him the difference again, so identical neighbours are folded together.
 */
function coalesceCounts(actions: AppAction[]): AppAction[] {
  const out: AppAction[] = []
  for (const action of actions) {
    const last = out[out.length - 1]
    if (
      last &&
      action.kind === last.kind &&
      (action.kind === 'open_tabs' || action.kind === 'open_panes') &&
      sameTarget(last, action)
    ) {
      ;(last as { count: number }).count += action.count
      continue
    }
    out.push(action.kind === 'open_tabs' || action.kind === 'open_panes' ? { ...action } : action)
  }
  return out
}

function sameTarget(a: AppAction, b: AppAction): boolean {
  if (a.kind === 'open_tabs' && b.kind === 'open_tabs') {
    return a.profileId === b.profileId && (a.projectName ?? '') === (b.projectName ?? '')
  }
  if (a.kind === 'open_panes' && b.kind === 'open_panes') {
    return a.profileId === b.profileId && (a.direction ?? '') === (b.direction ?? '')
  }
  return false
}

/** Turn a model's text into a BrainReply, or null if it was not JSON at all. */
export function parseBrainJson(raw: string): BrainReply | null {
  const json = extractJsonObject(raw)
  if (!json) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>

  const confidenceRaw = asString(o['confidence'])?.toLowerCase()
  const confidence = confidenceRaw === 'high' || confidenceRaw === 'medium' ? confidenceRaw : 'low'

  const actions = sanitiseActions(o['actions'])
  const questions = Array.isArray(o['questions'])
    ? (o['questions'] as unknown[]).map(asString).filter((q): q is string => Boolean(q)).slice(0, 5)
    : []

  const rawSay = asString(o['say'])
  const say = rawSay ? tidySay(rawSay) : undefined
  const understood = asString(o['understood']) ?? say ?? '(no summary)'
  const draftPrompt = asString(o['draftPrompt'])

  const reply: BrainReply = { understood, confidence }
  if (say) reply.say = say
  if (questions.length) reply.questions = questions
  if (actions.length) reply.actions = actions
  if (draftPrompt) reply.draftPrompt = draftPrompt
  return reply
}
