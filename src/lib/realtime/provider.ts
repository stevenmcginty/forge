import {
  agentBrainSpec,
  DEFAULT_AGENT_BRAIN,
  isAgentBrainId,
  isRealtimeBrain,
  type AgentBrainId
} from '@shared/agent-brain'
import { providerSpec } from '@shared/realtime'
import type { Settings, VoiceHubProvider } from '@shared/types'
import type { RealtimeProviderId } from './session'

/**
 * Which brain the voice hub actually uses.
 *
 * The rule is small and it is the whole fallback: a realtime provider needs
 * its vendor's key, and without one the hub is the Claude path (Parakeet →
 * Claude Agent SDK → Edge TTS), which needs none. The reason is kept so the
 * UI can say why it is not the one he picked.
 */

export type ProviderKeys = Pick<Settings, 'geminiKey' | 'openaiKey'>

export const HUB_PROVIDERS: readonly VoiceHubProvider[] = ['claude', 'gemini-live', 'gpt-realtime-mini', 'gpt-realtime']

export function hasKeyFor(provider: VoiceHubProvider, keys: ProviderKeys): boolean {
  const vendor = providerSpec(provider).vendor
  if (vendor === null) return true
  if (vendor === 'gemini') return (keys.geminiKey ?? '').trim().length > 0
  return (keys.openaiKey ?? '').trim().length > 0
}

export function providerAvailability(keys: ProviderKeys): Record<VoiceHubProvider, boolean> {
  return {
    claude: true,
    'gemini-live': hasKeyFor('gemini-live', keys),
    'gpt-realtime': hasKeyFor('gpt-realtime', keys),
    'gpt-realtime-mini': hasKeyFor('gpt-realtime-mini', keys)
  }
}

export interface ResolvedProvider {
  provider: VoiceHubProvider
  /** Set when the provider in use is not the one asked for. */
  fallbackReason: string | null
}

export function resolveHubProvider(requested: VoiceHubProvider | undefined, keys: ProviderKeys): ResolvedProvider {
  const wanted: VoiceHubProvider = HUB_PROVIDERS.includes(requested as VoiceHubProvider)
    ? (requested as VoiceHubProvider)
    : 'claude'
  if (hasKeyFor(wanted, keys)) return { provider: wanted, fallbackReason: null }
  const vendor = providerSpec(wanted).vendor === 'gemini' ? 'Gemini' : 'OpenAI'
  return {
    provider: 'claude',
    fallbackReason: `No ${vendor} key — using Claude. Add one in Settings → Voice & Agent for ${providerSpec(wanted).label}.`
  }
}

/* ------------------------------------------------------------ Agent brain */

export type BrainKeys = Pick<Settings, 'geminiKey' | 'openaiKey' | 'groqKey' | 'openrouterKey'>

export interface ResolvedBrain {
  /** The adapter actually in use: a keyed brain with no key falls back to Claude. */
  brain: AgentBrainId
  /** Set when `brain` is a realtime adapter — the provider to open a session on. */
  realtime: RealtimeProviderId | null
  fallbackReason: string | null
}

export function brainHasKey(id: AgentBrainId, keys: Partial<BrainKeys>): boolean {
  const key = agentBrainSpec(id).key
  return key === null || String(keys[key] ?? '').trim().length > 0
}

/**
 * The ONE routing rule: `settings.agentBrain`, with a keyed adapter that has no
 * key falling back to Claude (which needs none) and saying why.
 */
export function resolveAgentBrain(requested: AgentBrainId | undefined, keys: Partial<BrainKeys>): ResolvedBrain {
  const wanted: AgentBrainId = isAgentBrainId(requested) ? requested : DEFAULT_AGENT_BRAIN
  const spec = agentBrainSpec(wanted)
  if (!brainHasKey(wanted, keys)) {
    const vendor = spec.auth.replace(/ key$/, '')
    return {
      brain: DEFAULT_AGENT_BRAIN,
      realtime: null,
      fallbackReason: `No ${vendor} key — using Claude. Add one in Settings → Voice & Agent for ${spec.label}.`
    }
  }
  return { brain: wanted, realtime: isRealtimeBrain(wanted) ? wanted : null, fallbackReason: null }
}
