/**
 * A brain's error, in the few words the pill has room for — "Gemini: key
 * refused", "Gemini: free-tier limit (429)". The full text is kept alongside
 * (hub.error) for hover and copy; this is only the headline.
 *
 * Read off the sentences main and the sessions already write (electron/realtime/
 * tokens.ts `failure`, the Live socket's close reason, the sidecar's errors),
 * so nothing had to change at the source to get them.
 */

export type ErrorSource = 'gemini' | 'openai' | 'claude' | 'codex' | 'gemini-cli' | 'parakeet' | 'groq' | 'openrouter' | 'brain'

const VENDOR: Record<ErrorSource, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  claude: 'Claude',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
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
  // The microphone, before the key checks: getUserMedia says "Permission
  // denied", which is not a key being refused (V4). The sessions word it
  // through micError below; Parakeet has its own words further down.
  if (source !== 'parakeet' && /^microphone\b|notallowederror|notreadableerror|could not start audio source|requested device not found/.test(l)) {
    return /not found|notfounderror|no microphone/.test(l) ? `${who}: no mic` : `${who}: mic blocked`
  }
  // A CLI brain that is not there (electron/voice-agent/cli-brains.ts words it).
  if (/not installed|not found on path|codex not found|gemini not found|claude cli not found|\benoent\b/.test(l)) return `${who}: not installed`
  if (/\b429\b|resource.?exhausted|quota|rate.?limit|usage.?limit|too many requests/.test(l)) {
    return /free/.test(l) || source === 'gemini' ? `${who}: free-tier limit (429)` : `${who}: rate limit (429)`
  }
  if (/no (gemini|openai|groq|openrouter) key|key is set|needs? (a|this) key/.test(l)) return `${who}: no key`
  if (/refused \((401|403)\)|key was refused|api key not valid|invalid api key|incorrect api key|permission.?denied|unauthori[sz]ed|\b40[13]\b/.test(l)) {
    return `${who}: key refused`
  }
  // The live-session watchdog's words (src/lib/realtime/conversation.ts stuckReason).
  if (/did not answer|went quiet|no reply/.test(l)) return `${who}: no reply`
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

/**
 * A getUserMedia failure, reworded so errorReasonOf reads it as the mic and
 * not as a key: Chromium's "Permission denied" (Windows privacy has desktop
 * apps' microphone off) would otherwise say "key refused".
 */
export function micError(err: unknown): Error {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : ''
  const message = err instanceof Error ? err.message : String(err)
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new Error(`Microphone not found (${name}) — plug one in or pick one in Windows sound settings`)
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new Error(`Microphone blocked (${name}: ${message}) — check Windows Settings > Privacy > Microphone`)
  }
  return new Error(`Microphone unavailable (${name || 'error'}: ${message}) — another app may be using it`)
}
