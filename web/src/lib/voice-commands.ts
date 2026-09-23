/**
 * The few things a dictation can *do* instead of type.
 *
 * Steve talks to the phone far from the desk, so "stop", "yes" and "option
 * two" have to act on the pane rather than land in the agent's box as words.
 * Only a short utterance that is one of these phrases whole counts — four
 * words at most once it is lower-cased and its punctuation dropped (the
 * desktop's speech-to-text writes "Stop." and "Option two."). Anything longer
 * is dictation, so "please stop the server and restart it" still reaches the
 * agent as a sentence.
 *
 * A phrase only acts where it means something: "stop" while the agent works,
 * "yes" / "no" / an option while it is asking. Said at any other moment it is
 * plain dictation and goes to the pane as words.
 *
 * Pure and dependency-free, so it can be exercised with node by hand.
 */

export type VoiceCommand =
  /** Interrupt the agent: Esc, the same key the Stop button sends. */
  | { kind: 'stop' }
  /** Pick option `n` (1-based) of the question the pane is asking. */
  | { kind: 'option'; n: number }
  /** Answer the question with its "No" option, or Esc when it has none. */
  | { kind: 'no' }
  /** Go to the next (1) or previous (-1) tab. */
  | { kind: 'tab'; step: 1 | -1 }

export interface VoiceCommandContext {
  /** The agent is working — the moment "stop" means Stop. */
  busy: boolean
  /** The pane is asking a question — the moment "yes", "no" and numbers answer it. */
  asking: boolean
}

export interface VoiceCommandMatch {
  command: VoiceCommand
  /** The phrase as it was heard, tidied — for the "Heard “stop”" notice. */
  heard: string
}

/** More words than this is a sentence, never a command. */
export const MAX_COMMAND_WORDS = 4

const NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9
}

const STOP = new Set(['stop', 'stop that', 'cancel'])
const NEXT = new Set(['next tab', 'next pane'])
const PREVIOUS = new Set(['previous tab', 'previous pane'])

/** Lower-case, punctuation out, one space between words. */
export function tidyUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function numberWord(word: string | undefined): number | null {
  if (!word) return null
  if (/^[1-9]$/.test(word)) return Number(word)
  return NUMBERS[word] ?? null
}

/** The command `text` is, in this moment — or null, meaning "type it". */
export function matchVoiceCommand(text: string, context: VoiceCommandContext): VoiceCommandMatch | null {
  const heard = tidyUtterance(text)
  if (!heard) return null
  const words = heard.split(' ')
  if (words.length > MAX_COMMAND_WORDS) return null

  if (STOP.has(heard)) return context.busy ? { command: { kind: 'stop' }, heard } : null
  if (NEXT.has(heard)) return { command: { kind: 'tab', step: 1 }, heard }
  if (PREVIOUS.has(heard)) return { command: { kind: 'tab', step: -1 }, heard }

  if (!context.asking) return null
  if (heard === 'yes') return { command: { kind: 'option', n: 1 }, heard }
  if (heard === 'no') return { command: { kind: 'no' }, heard }
  const n =
    words.length === 1
      ? numberWord(words[0])
      : words.length === 2 && (words[0] === 'option' || words[0] === 'number')
        ? numberWord(words[1])
        : null
  return n === null ? null : { command: { kind: 'option', n }, heard }
}
