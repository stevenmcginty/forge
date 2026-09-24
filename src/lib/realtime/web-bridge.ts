import { providerSpec, resolveVoice } from '@shared/realtime'
import type { Settings } from '@shared/types'
import type { WebVoiceAskEvent, WebVoiceAskReply, WebVoiceSetup } from '@shared/web'
import { currentVoiceAgentToolDeps } from '../agenttools'
import { CONTEXT_MIN_GAP_MS } from './context'
import { normaliseIdleTimeout } from './conversation'
import { buildRealtimeInstructions } from './persona'
import { REALTIME_TOOLS, runRealtimeTool } from './tools'

/**
 * The renderer's half of Forge Web's voice agent (web/src/deck/voiceAgent.ts).
 *
 * A desktop browser runs the same GeminiLiveSession the voice hub runs, with
 * its own microphone and speakers; what makes it the SAME agent is answered
 * here, with the functions src/state/VoiceHubController.tsx's `startRealtime`
 * uses — `buildRealtimeInstructions`, `resolveVoice`, `REALTIME_TOOLS`, the
 * registered deps' `getAppContext` — and every tool call goes through the same
 * `runRealtimeTool`, so a call from the browser does exactly what the same call
 * from the desk would. Main forwards the asks (electron/web-host.ts's
 * `askVoice`); src/components/WebVoiceBridge.tsx answers them.
 *
 * No React here, so scripts/realtime-check.mjs can import it.
 */

/**
 * Told to a browser session only, after the persona: where it is, and why a
 * tool takes a beat. The desk's own sessions never get it.
 */
export const WEB_VOICE_NOTE =
  "# WHERE YOU ARE\nYou are running in Forge Web in the user's browser, away from the desktop. You hear and speak through the browser. Your tools run on the desktop: each call is relayed there and the answer comes back, so allow a moment. Panes, projects and the screen you read are the desktop's."

/** The app context as the voice hub would send it now; '' before the agent's deps are up. */
export function webVoiceContext(): string {
  return currentVoiceAgentToolDeps()?.getAppContext?.() ?? ''
}

/** Everything but the token, for a browser starting (or rolling over) a Gemini Live session. */
export function buildWebVoiceSetup(
  settings: Pick<Settings, 'voiceHubVoice' | 'agentIdleTimeoutMs'>,
  carryover: string | null,
  context: string = webVoiceContext()
): WebVoiceSetup {
  const spec = providerSpec('gemini-live')
  const vendor = spec.vendor ?? 'gemini'
  return {
    provider: 'gemini-live',
    model: spec.model,
    voice: resolveVoice(vendor, settings.voiceHubVoice?.[vendor]),
    instructions: `${buildRealtimeInstructions(carryover)}\n\n${WEB_VOICE_NOTE}`,
    tools: REALTIME_TOOLS,
    context,
    contextMinGapMs: CONTEXT_MIN_GAP_MS,
    idleTimeoutMs: normaliseIdleTimeout(settings.agentIdleTimeoutMs)
  }
}

/** One ask from main, answered. Never rejects: a failure is an `error` sentence. */
export async function answerWebVoiceAsk(
  ask: WebVoiceAskEvent,
  settings: Pick<Settings, 'voiceHubVoice' | 'agentIdleTimeoutMs'>
): Promise<WebVoiceAskReply> {
  const requestId = ask.requestId
  try {
    switch (ask.op) {
      case 'setup':
        return { requestId, setup: buildWebVoiceSetup(settings, ask.carryover) }
      case 'tool':
        return { requestId, answer: await runRealtimeTool(String(ask.name ?? ''), ask.args ?? {}) }
      case 'context':
        return { requestId, context: webVoiceContext() }
      default:
        return { requestId, error: 'This desktop does not know that voice request.' }
    }
  } catch (err) {
    return { requestId, error: err instanceof Error ? err.message : String(err) }
  }
}
