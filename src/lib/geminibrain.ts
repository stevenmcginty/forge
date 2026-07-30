import type { GeminiCallRequest, GeminiCallResult } from '@shared/types'
import type { AppAction } from './appactions'
import type { BrainContext, BrainReply, BrainStatus, VoiceBrain } from './voicebrain'

/**
 * The live brain: Google Gemini over REST.
 *
 * Shape of a turn: the capability manifest goes in as the system instruction,
 * the session's conversation goes in as `contents`, and Gemini is required to
 * answer in JSON matching `RESPONSE_SCHEMA`. Anything it returns in `actions`
 * runs through exactly the same executor the deterministic grammar uses, so a
 * model can never do more than the buttons can.
 *
 * The request itself is made in the main process (see electron/voice-bridge.ts):
 * the renderer's CSP allows no external hosts, and a key is better off never
 * reaching page script. Everything here is pure request-building and defensive
 * parsing, which is why it can be unit-tested with a fake transport.
 *
 * Defensive by design: models return fenced JSON, trailing prose, or invented
 * action kinds. So the parser strips fences, takes the outermost object, coerces
 * every field, drops unknown actions, and clamps counts. One retry with a
 * "JSON only" nudge; after that the raw text is shown rather than swallowed.
 */

export type GeminiTransport = (req: GeminiCallRequest) => Promise<GeminiCallResult>

/** History sent per request — enough context, bounded cost. */
export const HISTORY_LIMIT = 20

const ACTION_KINDS = new Set([
  'open_tabs',
  'open_panes',
  'close_pane',
  'close_tab',
  'switch_project',
  'focus_tab',
  'new_project_hint'
])

/** responseSchema for generationConfig — keeps Gemini inside the contract. */
export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    understood: { type: 'STRING' },
    say: { type: 'STRING' },
    questions: { type: 'ARRAY', items: { type: 'STRING' } },
    actions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING' },
          profileId: { type: 'STRING' },
          count: { type: 'INTEGER' },
          projectName: { type: 'STRING' },
          direction: { type: 'STRING' },
          which: { type: 'STRING' },
          name: { type: 'STRING' },
          index: { type: 'INTEGER' }
        },
        required: ['kind']
      }
    },
    draftPrompt: { type: 'STRING' },
    confidence: { type: 'STRING' }
  },
  required: ['understood', 'confidence']
} as const

const JSON_NUDGE =
  'Your last reply was not valid JSON. Reply again with the JSON object only — no prose, no markdown fence.'

/* ------------------------------------------------------------------ parse */

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

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function asCount(v: unknown, fallback = 1): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(64, Math.max(1, Math.floor(n)))
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

  const say = asString(o['say'])
  const understood = asString(o['understood']) ?? say ?? '(no summary)'
  const draftPrompt = asString(o['draftPrompt'])

  const reply: BrainReply = { understood, confidence }
  if (say) reply.say = say
  if (questions.length) reply.questions = questions
  if (actions.length) reply.actions = actions
  if (draftPrompt) reply.draftPrompt = draftPrompt
  return reply
}

/* ------------------------------------------------------------------ brain */

function defaultTransport(req: GeminiCallRequest): Promise<GeminiCallResult> {
  return window.forge.voice.gemini(req)
}

export class GeminiBrain implements VoiceBrain {
  readonly name = 'Gemini'

  private readonly apiKey: string
  private readonly model: string
  private readonly transport: GeminiTransport

  constructor(apiKey: string, model: string, transport: GeminiTransport = defaultTransport) {
    this.apiKey = apiKey
    this.model = model
    this.transport = transport
  }

  ready(): BrainStatus {
    if (!this.apiKey) {
      return { ok: false, reason: 'no-key', detail: 'No Gemini key set — import or paste one in settings.' }
    }
    return {
      ok: true,
      label: this.model,
      detail: `Live on ${this.model}. Your words and Forge's state go to Google when you speak.`
    }
  }

  async interpret(transcript: string, context: BrainContext): Promise<BrainReply> {
    const history = (context.history ?? []).slice(-HISTORY_LIMIT)
    const turns: GeminiCallRequest['turns'] = history.map((t) => ({
      role: t.role === 'agent' ? 'model' : 'user',
      text: t.text
    }))
    turns.push({ role: 'user', text: transcript })

    const base: GeminiCallRequest = {
      key: this.apiKey,
      model: this.model,
      system: context.manifest ?? '',
      turns,
      schema: RESPONSE_SCHEMA
    }

    const first = await this.transport(base)
    if (!first.ok) throw new Error(friendly(first.error))

    const reply = parseBrainJson(first.text)
    if (reply) return reply

    // One nudge, then take what we are given rather than losing the answer.
    const retry = await this.transport({
      ...base,
      turns: [...turns, { role: 'model', text: first.text.slice(0, 2000) }, { role: 'user', text: JSON_NUDGE }]
    })
    if (retry.ok) {
      const second = parseBrainJson(retry.text)
      if (second) return second
    }

    return {
      understood: 'Gemini replied, but not in the JSON shape I asked for',
      say: (retry.ok ? retry.text : first.text).slice(0, 1200),
      confidence: 'low'
    }
  }
}

/** Google's errors are useful; make them readable without hiding them. */
function friendly(error: string): string {
  if (/API key not valid|API_KEY_INVALID|401|403/i.test(error)) {
    return `Gemini refused the key — check it in settings. (${error})`
  }
  if (/quota|RESOURCE_EXHAUSTED|429/i.test(error)) {
    return `Gemini is out of quota for now. (${error})`
  }
  if (/did not answer|ENOTFOUND|EAI_AGAIN|reach Gemini|network/i.test(error)) {
    return `Gemini didn't answer — check your connection. (${error})`
  }
  if (/404|NOT_FOUND/i.test(error)) {
    return `That model is not available to this key. (${error})`
  }
  return `Gemini failed: ${error}`
}
