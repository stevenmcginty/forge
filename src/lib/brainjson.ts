import type { AppAction } from './appactions'
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
  'edit_image'
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
      case 'close_pane':
        out.push({ kind: 'close_pane', which: 'focused' })
        break
      case 'close_tab':
        out.push({ kind: 'close_tab', which: 'current' })
        break
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
      default:
        break
    }
  }
  return out
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
