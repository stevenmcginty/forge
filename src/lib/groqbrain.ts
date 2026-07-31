import type { GroqCallRequest, GroqCallResult } from '@shared/types'
import { parseBrainJson, salvagePartialJson, withProjectMemory } from './brainjson'
import type { BrainContext, BrainReply, BrainStatus, VoiceBrain } from './voicebrain'

/**
 * The third live brain: Groq.
 *
 * Here for money and for latency, in that order.
 *
 * Money: Gemini's free tier caps at twenty requests a minute, every spoken
 * phrase is one request, and when it runs out the whole turn dies with a red
 * block — there is no degraded mode for a brain the way there is for a voice.
 * Groq's free tier costs nothing and needs no card, and its paid tier is around
 * a pound a month at the volume one person talking can generate.
 *
 * Latency: Groq is the fastest thing available by some margin. For a voice agent
 * that is not a benchmark detail — the gap between "say what you want" and the
 * reply *is* the product, and a second saved there is felt every single turn.
 *
 * The wire format is OpenAI chat-completions, exactly as OpenRouter's is, so
 * this is deliberately close to OpenRouterBrain: same JSON-mode request, same
 * one-nudge-then-salvage recovery, same shared machinery from brainjson.ts. The
 * two are not merged because their *failures* differ — Groq rate-limits on
 * tokens-per-minute where OpenRouter runs out of credit, and `friendly()` below
 * is where that difference has to be explained to somebody mid-sentence.
 *
 * The request itself is made in the main process (electron/voice-bridge.ts): the
 * renderer's CSP allows no external hosts, and a key is better off never
 * reaching page script.
 */

export type GroqTransport = (req: GroqCallRequest) => Promise<GroqCallResult>

/**
 * History sent per request.
 *
 * Shorter than the other brains' twenty, and that is the whole point of running
 * on a free tier. Groq's limit is tokens-per-minute, not requests: the
 * capability manifest is already ~3,000 tokens of every turn, so history is the
 * only part Forge controls. Ten turns is still a real conversation and it
 * roughly halves what each exchange costs.
 */
export const HISTORY_LIMIT = 10

const JSON_NUDGE =
  'Your last reply was not valid JSON. Reply again with the JSON object only — no prose, no markdown fence.'

/** OpenAI-shaped JSON mode refuses a request whose messages never mention JSON. */
const JSON_REMINDER = '\n\nReply with a single JSON object and nothing else.'

function defaultTransport(req: GroqCallRequest): Promise<GroqCallResult> {
  return window.forge.voice.groq(req)
}

export class GroqBrain implements VoiceBrain {
  readonly name = 'Groq'

  private readonly apiKey: string
  private readonly model: string
  private readonly transport: GroqTransport

  constructor(apiKey: string, model: string, transport: GroqTransport = defaultTransport) {
    this.apiKey = apiKey
    this.model = model
    this.transport = transport
  }

  ready(): BrainStatus {
    if (!this.apiKey) {
      return {
        ok: false,
        reason: 'no-key',
        detail: 'No Groq key set — make one free at console.groq.com, no card needed, and paste it in settings.'
      }
    }
    return {
      ok: true,
      label: this.model,
      detail: `Live on ${this.model} via Groq. Your words and Forge's state go to Groq when you speak.`
    }
  }

  async interpret(transcript: string, context: BrainContext): Promise<BrainReply> {
    const history = (context.history ?? []).slice(-HISTORY_LIMIT)
    const turns: GroqCallRequest['turns'] = history.map((t) => ({
      role: t.role === 'agent' ? 'assistant' : 'user',
      text: t.text
    }))
    turns.push({ role: 'user', text: transcript })

    const base: GroqCallRequest = {
      key: this.apiKey,
      model: this.model,
      system: `${withProjectMemory(context.manifest ?? '', context.projectMemory)}${JSON_REMINDER}`,
      turns,
      json: true
    }

    const first = await this.transport(base)
    if (!first.ok) throw new Error(friendly(first.error))

    const reply = parseBrainJson(first.text)
    if (reply) return reply

    // Ran out of room mid-JSON? Keep what it did manage to say.
    if (first.finishReason === 'length') {
      const salvaged = salvagePartialJson(first.text, this.name)
      if (salvaged) return salvaged
    }

    // One nudge, then take what we are given rather than losing the answer.
    const retry = await this.transport({
      ...base,
      turns: [...turns, { role: 'assistant', text: first.text.slice(0, 2000) }, { role: 'user', text: JSON_NUDGE }]
    })
    if (retry.ok) {
      const second = parseBrainJson(retry.text)
      if (second) return second
      const salvaged = salvagePartialJson(retry.text, this.name)
      if (salvaged) return salvaged
    }

    const salvaged = salvagePartialJson(first.text, this.name)
    if (salvaged) return salvaged

    return {
      understood: 'Groq replied, but not in the JSON shape I asked for',
      say: (retry.ok ? retry.text : first.text).slice(0, 1200),
      confidence: 'low'
    }
  }
}

/**
 * Groq's errors, in words that say what to do next.
 *
 * The rate-limit case is the one that matters and the one that differs from
 * every other provider: Groq's free tier runs out of *tokens per minute* long
 * before it runs out of requests, and it says so in a header nobody reads. A
 * message that just said "rate limited" would send him to the wrong fix —
 * talking less often, rather than picking a model with a bigger bucket.
 */
function friendly(error: string): string {
  if (/401|invalid.*api.?key|Invalid API Key|unauthorized/i.test(error)) {
    return `Groq refused the key — check it in settings. (${error})`
  }
  if (/rate.?limit|429|tokens per minute|TPM/i.test(error)) {
    return (
      'Groq is rate-limiting this key — on the free tier that is usually tokens-per-minute, not requests. ' +
      `Wait a moment, or switch to a model with a bigger bucket in settings. (${error})`
    )
  }
  if (/quota|insufficient|billing|402/i.test(error)) {
    return `Groq says this key is out of quota or credit. (${error})`
  }
  if (/did not answer/i.test(error)) {
    return `Groq took too long — try again, or ask for something smaller. (${error})`
  }
  if (/ENOTFOUND|EAI_AGAIN|reach Groq|network|fetch failed/i.test(error)) {
    return `Groq didn't answer — check your connection. (${error})`
  }
  if (/404|does not exist|model.*not found|decommissioned/i.test(error)) {
    return `That model id is not on Groq, or has been retired. Pick another in settings. (${error})`
  }
  return `Groq failed: ${error}`
}
