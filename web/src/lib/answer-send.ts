import type { ParsedAsk } from './answer-options'
import { answerKeys, plainReplies } from '../components/AnswerCard'

/**
 * Answering an asking pane from somewhere other than the answer card — a
 * spoken "yes", "no" or "option two".
 *
 * The keys, the pacing and the question's reading all come from the card
 * (components/AnswerCard.tsx), so a spoken answer lands exactly where the
 * matching button would. This file only maps a spoken option to the card's
 * keys.
 */

export { answerKeys, readPaneAsk, sendAnswerKeys } from '../components/AnswerCard'

/**
 * The keys for option `n` (1-based, as the menu numbers it), or null when the
 * question has no such option. A question with no menu takes the card's own
 * plain Yes.
 */
export function optionKeys(ask: ParsedAsk, n: number, digits: boolean): { keys: string[]; label: string } | null {
  if (ask.options.length) {
    const index = ask.options.findIndex((option) => option.n === n)
    if (index < 0) return null
    return { keys: answerKeys(ask, index, digits), label: `${n}. ${ask.options[index]!.label}` }
  }
  if (n === 1) return { keys: plainReplies(ask.question)[0]!.keys, label: 'Yes' }
  return null
}

/**
 * The keys for "No": the menu's last option that starts with "No"; with no
 * menu, the card's own plain No; a menu without a No row, Esc.
 */
export function noKeys(ask: ParsedAsk, digits: boolean): { keys: string[]; label: string } {
  for (let index = ask.options.length - 1; index >= 0; index--) {
    const option = ask.options[index]!
    if (/^no\b/i.test(option.label)) return { keys: answerKeys(ask, index, digits), label: `${option.n}. ${option.label}` }
  }
  if (!ask.options.length) return { keys: plainReplies(ask.question)[1]!.keys, label: 'No' }
  return { keys: ['\x1b'], label: 'No (Esc)' }
}
