import { providerSpec } from '@shared/realtime'
import type { Settings, VoiceHubProvider } from '@shared/types'

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
    fallbackReason: `No ${vendor} key — using Claude. Add one in Settings → Models & APIs for ${providerSpec(wanted).label}.`
  }
}
