/**
 * A spoken yes or no to a waiting confirm, by code — never by a model, and
 * never by a sentence that only starts with one of the words. One copy for
 * every voice that answers confirms: the desk voice agent
 * (src/lib/brainConfirmVoice.ts re-exports it) and Claude Live in main
 * (electron/live/index.ts). Pure, no DOM, no Electron.
 */

const YES = new Set([
  'yes',
  'yeah',
  'yep',
  'yes please',
  'do it',
  'go ahead',
  'allow',
  'allow it',
  'yes go ahead',
  'yeah go ahead',
  'yep go ahead',
  'yes do it',
  'yeah do it'
])
const NO = new Set(['no', 'nope', 'no thanks', 'dont', 'do not', 'cancel', 'stop', 'no dont', 'no do not'])

/** Lower case, no punctuation, one space between words. "Yes, please." → "yes please"; "Don't!" → "dont". */
function plain(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Is this utterance, all of it, a yes or a no? Anything longer or different —
 * "yes but wait", "no I meant the other one", "yesterday" — is null: not an
 * answer, and it goes on to the commands and the brain like any other words.
 */
export function parseConfirmAnswer(text: string): 'yes' | 'no' | null {
  const t = plain(text)
  if (YES.has(t)) return 'yes'
  if (NO.has(t)) return 'no'
  return null
}
