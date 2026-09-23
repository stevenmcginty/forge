/**
 * A brain's error, in the few words the pill has room for — "Gemini: key
 * refused", "Gemini: free-tier limit (429)". The full text is kept alongside
 * (hub.error) for hover and copy; this is only the headline.
 *
 * Read off the sentences main and the sessions already write (electron/realtime/
 * tokens.ts `failure`, the Live socket's close reason, the sidecar's errors),
 * so nothing had to change at the source to get them.
 */

export type ErrorSource = 'gemini' | 'openai' | 'claude' | 'parakeet' | 'groq' | 'openrouter' | 'brain'

const VENDOR: Record<ErrorSource, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  claude: 'Claude',
  parakeet: 'Parakeet',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  brain: 'Brain'
}

export function errorReasonOf(source: ErrorSource, text: string | null | undefined): string | null {
  const t = String(text ?? '').trim()
  if (!t) return null
  const who = VENDOR[source]
  const l = t.toLowerCase()
  if (/\b429\b|resource.?exhausted|quota|rate.?limit|too many requests/.test(l)) {
    return /free/.test(l) || source === 'gemini' ? `${who}: free-tier limit (429)` : `${who}: rate limit (429)`
  }
  if (/no (gemini|openai|groq|openrouter) key|key is set|needs? (a|this) key/.test(l)) return `${who}: no key`
  if (/refused \((401|403)\)|key was refused|api key not valid|invalid api key|incorrect api key|permission.?denied|unauthori[sz]ed|\b40[13]\b/.test(l)) {
    return `${who}: key refused`
  }
  if (/setup|1007|1008|invalid argument|unsupported|not found for api version|model .*not (found|supported)/.test(l)) {
    return `${who}: setup rejected`
  }
  if (/could not reach|network|offline|enotfound|econn|fetch failed|timed? ?out/.test(l)) return `${who}: can't reach it`
  if (/not logged in|log ?in|sign ?in|credentials/.test(l)) return `${who}: not logged in`
  if (source === 'parakeet') {
    if (/model/.test(l) && /missing|not found|download/.test(l)) return 'Parakeet: model missing'
    if (/python/.test(l)) return 'Parakeet: Python missing'
    if (/microphone|mic |device|busy/.test(l)) return 'Parakeet: mic busy or missing'
    return 'Parakeet: speech engine error'
  }
  if (/closed|disconnected/.test(l)) return `${who}: connection closed`
  return `${who}: failed`
}
