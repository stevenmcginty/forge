import { providerSpec, resolveVoice } from '@shared/realtime'
import type { Settings } from '@shared/types'
import type { WebVoiceAskEvent, WebVoiceAskReply, WebVoiceProvider, WebVoiceSetup } from '@shared/web'
import { currentVoiceAgentToolDeps } from '../agenttools'
import { CONTEXT_MIN_GAP_MS } from './context'
import { normaliseIdleTimeout } from './conversation'
import { buildRealtimeInstructions } from './persona'
import { REALTIME_TOOLS, runRealtimeTool } from './tools'

/**
 * The renderer's half of Forge Web's voice agent (web/src/deck/voiceAgent.ts).
 *
 * A desktop browser runs the same GeminiLiveSession or OpenAIRealtimeSession
 * the voice hub runs, with its own microphone and speakers; what makes it the
 * SAME agent is answered
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

/** The providers a browser runs as a realtime session: every one but Claude. */
export type WebVoiceRealtimeProvider = Exclude<WebVoiceProvider, 'claude'>

/**
 * Claude's setup, for a browser. Claude is no realtime session: its persona and
 * tools live in its session on the desktop (electron/voice-agent/ipc.ts's
 * `openWebVoiceAgent`), and main adds the context to each turn — so what the
 * browser needs is the idle clock, the desk's Claude model and Edge voice to
 * name, and nothing to send.
 */
export function buildWebClaudeSetup(
  settings: Partial<Pick<Settings, 'voiceClaudeModel' | 'voiceEdgeVoice' | 'agentIdleTimeoutMs'>>
): WebVoiceSetup {
  return {
    provider: 'claude',
    model: settings.voiceClaudeModel?.trim() || 'opus',
    voice: settings.voiceEdgeVoice?.trim() ?? '',
    instructions: '',
    tools: [],
    context: '',
    contextMinGapMs: 0,
    idleTimeoutMs: normaliseIdleTimeout(settings.agentIdleTimeoutMs)
  }
}

/**
 * Everything but the connect, for a browser starting (or rolling over) a
 * Gemini Live or GPT Realtime session. The tools go in the neutral shape; each
 * session converts them to its vendor's (./tool-format.ts), as on the desk.
 */
export function buildWebVoiceSetup(
  settings: Pick<Settings, 'voiceHubVoice' | 'agentIdleTimeoutMs'>,
  carryover: string | null,
  context: string = webVoiceContext(),
  provider: WebVoiceRealtimeProvider = 'gemini-live'
): WebVoiceSetup {
  const spec = providerSpec(provider)
  const vendor = spec.vendor ?? 'gemini'
  return {
    provider,
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
  settings: Pick<Settings, 'voiceHubVoice' | 'agentIdleTimeoutMs' | 'voiceClaudeModel' | 'voiceEdgeVoice'>
): Promise<WebVoiceAskReply> {
  const requestId = ask.requestId
  try {
    switch (ask.op) {
      case 'setup': {
        // Absent from an older main: that one only ever asked for Gemini Live.
        const provider = ask.provider ?? 'gemini-live'
        if (provider === 'claude') return { requestId, setup: buildWebClaudeSetup(settings) }
        return { requestId, setup: buildWebVoiceSetup(settings, ask.carryover, webVoiceContext(), provider) }
      }
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
