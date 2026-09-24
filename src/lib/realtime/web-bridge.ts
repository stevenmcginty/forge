import { providerSpec, resolveVoice } from '@shared/realtime'
import type { Settings } from '@shared/types'
import { WEB_VOICE_NAV_ARG, type WebVoiceAskEvent, type WebVoiceAskReply, type WebVoiceSetup, type WebVoiceToolAnswer } from '@shared/web'
import { currentVoiceAgentToolDeps } from '../agenttools'
import { CONTEXT_MIN_GAP_MS } from './context'
import { normaliseIdleTimeout } from './conversation'
import { buildRealtimeInstructions } from './persona'
import { REALTIME_TOOLS, runRealtimeTool } from './tools'
import { runWebNavTool } from './web-nav'

/**
 * The renderer's half of Forge Web's voice agent (web/src/deck/voiceAgent.ts).
 *
 * A desktop browser runs the same GeminiLiveSession the voice hub runs, with
 * its own microphone and speakers; what makes it the SAME agent is answered
 * here, with the functions src/state/VoiceHubController.tsx's `startRealtime`
 * uses — `buildRealtimeInstructions`, `resolveVoice`, `REALTIME_TOOLS`, the
 * registered deps' `getAppContext` — and every tool call goes through the same
 * `runRealtimeTool`, so a call from the browser does exactly what the same call
 * from the desk would — bar navigation, which moves the browser's own screen
 * (`answerWebVoiceTool`). Main forwards the asks (electron/web-host.ts's
 * `askVoice`); src/components/WebVoiceBridge.tsx answers them.
 *
 * No React here, so scripts/realtime-check.mjs can import it.
 */

/**
 * Told to a browser session only, after the persona: where it is, why a tool
 * takes a beat, and which screen moving around moves (./web-nav.ts). The
 * desk's own sessions never get it. No provider named: any realtime brain run
 * in a browser gets the same note.
 */
export const WEB_VOICE_NOTE =
  "# WHERE YOU ARE\nYou are running in Forge Web in the user's browser, away from the desktop. You hear and speak through the browser. Your tools run on the desktop: each call is relayed there and the answer comes back, so allow a moment. Panes, projects and the work in them live on the desktop, and the state and screen you read are the desktop's. Moving around is the exception: set_view (the Wall or Full screen), focus_pane_by_name, focus_tab and switch_project change what the user's browser shows, not the desktop's view — so say it happened on his screen."

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

/**
 * One tool call from a browser. A page that sent `WEB_VOICE_NAV_ARG` applies
 * navigation itself, so that is answered with where to go and the desktop's
 * view is left alone; everything else, and everything from an older page, runs
 * through `runRealtimeTool` exactly as the desk's own call would.
 */
export async function answerWebVoiceTool(name: string, rawArgs: Record<string, unknown>): Promise<WebVoiceToolAnswer> {
  const { [WEB_VOICE_NAV_ARG]: navigates, ...args } = rawArgs
  const nav = navigates === true ? runWebNavTool(name, args, currentVoiceAgentToolDeps()) : null
  return nav ?? runRealtimeTool(name, args)
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
        return { requestId, answer: await answerWebVoiceTool(String(ask.name ?? ''), ask.args ?? {}) }
      case 'context':
        return { requestId, context: webVoiceContext() }
      default:
        return { requestId, error: 'This desktop does not know that voice request.' }
    }
  } catch (err) {
    return { requestId, error: err instanceof Error ? err.message : String(err) }
  }
}
