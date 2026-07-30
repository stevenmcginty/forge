import type { GeminiCallRequest, GeminiCallResult } from '@shared/types'
import { parseBrainJson, salvagePartialJson, withProjectMemory } from './brainjson'
import type { BrainContext, BrainReply, BrainStatus, VoiceBrain } from './voicebrain'

/**
 * Re-exported so importers (and scripts/voice-check.mjs) can keep reaching for
 * them here. The implementations moved to brainjson.ts when OpenRouterBrain
 * arrived and needed exactly the same defensive parsing.
 */
export {
  claimsCompletedAction,
  extractJsonObject,
  parseBrainJson,
  salvagePartialJson,
  sanitiseActions,
  tidySay,
  withProjectMemory,
  ACTION_KINDS,
  MEMORY_HEADING
} from './brainjson'

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

/**
 * responseSchema for generationConfig — keeps Gemini inside the contract.
 *
 * Field order matters and is deliberate. A model that runs long (or, as
 * gemini-2.5-flash has been seen to do, falls into repeating a sentence) loses
 * whatever comes last. So the draft prompt is emitted *before* the chatty `say`:
 * if anything gets cut off it is the small talk, never the deliverable.
 */
export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  propertyOrdering: ['understood', 'confidence', 'actions', 'questions', 'draftPrompt', 'say'],
  properties: {
    understood: { type: 'STRING' },
    confidence: { type: 'STRING' },
    questions: { type: 'ARRAY', items: { type: 'STRING' } },
    actions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        /**
         * `count` is required, and that is not a nicety.
         *
         * It used to be optional, and gemini-2.5-flash, asked for "3 claude code
         * terminals", answered `understood: "three new tabs"` and then emitted
         * open_tabs with the count field simply absent — three times over, once
         * per tab. The sanitiser's fallback turned each of those into 1 and the
         * panel truthfully reported opening one tab. An optional integer in a
         * responseSchema is an integer the model may quietly decline to think
         * about; a required one is not. Ordering matters for the same reason a
         * long reply loses its tail: emit the count before the trimmings.
         */
        propertyOrdering: [
          'kind',
          'profileId',
          'count',
          'target',
          'text',
          'flesh',
          'projectName',
          'direction',
          'which',
          'name',
          'index',
          'parentDir',
          'mode',
          'section',
          'description',
          'aspect',
          'path',
          'instruction'
        ],
        properties: {
          kind: { type: 'STRING' },
          profileId: { type: 'STRING' },
          count: { type: 'INTEGER' },
          // send_prompt — which terminal, and what to say to it.
          target: { type: 'STRING' },
          text: { type: 'STRING' },
          flesh: { type: 'BOOLEAN' },
          projectName: { type: 'STRING' },
          direction: { type: 'STRING' },
          which: { type: 'STRING' },
          name: { type: 'STRING' },
          index: { type: 'INTEGER' },
          // create_project / set_view / open_settings.
          parentDir: { type: 'STRING' },
          mode: { type: 'STRING' },
          section: { type: 'STRING' },
          // make_image / edit_image. One flat property bag for every action
          // kind, because responseSchema has no union type — the executor's
          // sanitiser is what actually enforces per-kind requirements.
          description: { type: 'STRING' },
          aspect: { type: 'STRING' },
          path: { type: 'STRING' },
          instruction: { type: 'STRING' }
        },
        required: ['kind', 'count']
      }
    },
    draftPrompt: { type: 'STRING' },
    say: { type: 'STRING' }
  },
  required: ['understood', 'confidence']
} as const

const JSON_NUDGE =
  'Your last reply was not valid JSON. Reply again with the JSON object only — no prose, no markdown fence.'

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
      system: withProjectMemory(context.manifest ?? '', context.projectMemory),
      turns,
      schema: RESPONSE_SCHEMA
    }

    const first = await this.transport(base)
    if (!first.ok) throw new Error(friendly(first.error))

    const reply = parseBrainJson(first.text)
    if (reply) return reply

    // Ran out of room mid-JSON? Keep what it did manage to say.
    if (first.finishReason === 'MAX_TOKENS') {
      const salvaged = salvagePartialJson(first.text)
      if (salvaged) return salvaged
    }

    // One nudge, then take what we are given rather than losing the answer.
    const retry = await this.transport({
      ...base,
      turns: [...turns, { role: 'model', text: first.text.slice(0, 2000) }, { role: 'user', text: JSON_NUDGE }]
    })
    if (retry.ok) {
      const second = parseBrainJson(retry.text)
      if (second) return second
      const salvaged = salvagePartialJson(retry.text)
      if (salvaged) return salvaged
    }

    const salvaged = salvagePartialJson(first.text)
    if (salvaged) return salvaged

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
  if (/did not answer/i.test(error)) {
    return `Gemini took too long — try again, or ask for something smaller. (${error})`
  }
  if (/ENOTFOUND|EAI_AGAIN|reach Gemini|network/i.test(error)) {
    return `Gemini didn't answer — check your connection. (${error})`
  }
  if (/404|NOT_FOUND/i.test(error)) {
    return `That model is not available to this key. (${error})`
  }
  return `Gemini failed: ${error}`
}
