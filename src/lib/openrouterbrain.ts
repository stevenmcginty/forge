import type { OpenRouterCallRequest, OpenRouterCallResult } from '@shared/types'
import { parseBrainJson, salvagePartialJson } from './brainjson'
import type { BrainContext, BrainReply, BrainStatus, VoiceBrain } from './voicebrain'

/**
 * The second live brain: any model on OpenRouter.
 *
 * Why bother when GeminiBrain exists — because one key buys every model family
 * at once. Steve already has an OpenRouter key on disk (`~/.kimi-key`, the one
 * `kimi` runs Claude Code on), so switching the voice agent onto a different
 * model is a dropdown, not a signup. It is also the fallback when Google's free
 * tier runs out mid-afternoon.
 *
 * The contract is identical to GeminiBrain's: the capability manifest goes in as
 * the system message, the session's conversation follows, and the reply must be
 * one JSON object matching the shape the manifest describes. Everything after
 * that — parsing, salvaging a truncated draft, dropping invented actions — is
 * the shared machinery in brainjson.ts, so the two brains cannot diverge in how
 * defensively they read a model.
 *
 * What differs is only the wire format. OpenRouter speaks the OpenAI
 * chat-completions API, which has no `responseSchema`, so strictness comes from
 * `response_format: { type: 'json_object' }` plus the manifest's own
 * instructions. That is weaker than Gemini's schema, which is exactly why the
 * "one nudge, then salvage" path below matters more here, not less.
 *
 * The request itself is made in the main process (electron/voice-bridge.ts): the
 * renderer's CSP allows no external hosts, and a key is better off never
 * reaching page script.
 */

export type OpenRouterTransport = (req: OpenRouterCallRequest) => Promise<OpenRouterCallResult>

/** History sent per request — enough context, bounded cost. */
export const HISTORY_LIMIT = 20

const JSON_NUDGE =
  'Your last reply was not valid JSON. Reply again with the JSON object only — no prose, no markdown fence.'

/**
 * OpenAI-compatible JSON mode refuses a request whose messages never mention
 * JSON. The manifest does say so, but a hand-edited one might not, and a 400
 * over a missing word would be a baffling failure.
 */
const JSON_REMINDER = '\n\nReply with a single JSON object and nothing else.'

function defaultTransport(req: OpenRouterCallRequest): Promise<OpenRouterCallResult> {
  return window.forge.voice.openrouter(req)
}

export class OpenRouterBrain implements VoiceBrain {
  readonly name = 'OpenRouter'

  private readonly apiKey: string
  private readonly model: string
  private readonly transport: OpenRouterTransport

  constructor(apiKey: string, model: string, transport: OpenRouterTransport = defaultTransport) {
    this.apiKey = apiKey
    this.model = model
    this.transport = transport
  }

  ready(): BrainStatus {
    if (!this.apiKey) {
      return {
        ok: false,
        reason: 'no-key',
        detail: 'No OpenRouter key set — paste one in settings, or import the key you already use for Kimi.'
      }
    }
    return {
      ok: true,
      label: this.model,
      detail: `Live on ${this.model} via OpenRouter. Your words and Forge's state go to OpenRouter when you speak.`
    }
  }

  async interpret(transcript: string, context: BrainContext): Promise<BrainReply> {
    const history = (context.history ?? []).slice(-HISTORY_LIMIT)
    const turns: OpenRouterCallRequest['turns'] = history.map((t) => ({
      role: t.role === 'agent' ? 'assistant' : 'user',
      text: t.text
    }))
    turns.push({ role: 'user', text: transcript })

    const base: OpenRouterCallRequest = {
      key: this.apiKey,
      model: this.model,
      system: `${context.manifest ?? ''}${JSON_REMINDER}`,
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
      understood: 'OpenRouter replied, but not in the JSON shape I asked for',
      say: (retry.ok ? retry.text : first.text).slice(0, 1200),
      confidence: 'low'
    }
  }
}

/** OpenRouter's errors are useful; make them readable without hiding them. */
function friendly(error: string): string {
  if (/401|No auth credentials|User not found|invalid.*api key/i.test(error)) {
    return `OpenRouter refused the key — check it in settings. (${error})`
  }
  if (/402|credit|insufficient|quota|429|rate.?limit/i.test(error)) {
    return `OpenRouter is out of credit or rate-limiting this key. (${error})`
  }
  if (/did not answer/i.test(error)) {
    return `OpenRouter took too long — try again, or ask for something smaller. (${error})`
  }
  if (/ENOTFOUND|EAI_AGAIN|reach OpenRouter|network/i.test(error)) {
    return `OpenRouter didn't answer — check your connection. (${error})`
  }
  if (/404|not a valid model|No endpoints found/i.test(error)) {
    return `That model id is not on OpenRouter, or has no provider right now. (${error})`
  }
  return `OpenRouter failed: ${error}`
}
