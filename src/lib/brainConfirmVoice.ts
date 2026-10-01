/**
 * Forge Brain by voice, as pure decisions — so they are testable without React
 * (scripts/brain-confirm-check.mjs) and the hook and the check cannot drift.
 *
 * Two things, both used by src/state/VoiceAgent.tsx `runPhrase`:
 *
 *   the gate    A yes or a no to a waiting confirm (shared/brain.ts
 *               `BrainConfirmRequest`) is answered by code, from a short fixed
 *               list — never by a model, and never by a sentence that only
 *               starts with one of the words. A spoken one answers only the
 *               question he last heard said aloud, for a short while after it.
 *
 *   the gather  The recogniser cuts a phrase on a pause, so a thought said with
 *               a breath in it arrives as two or three: "It's a virtual world
 *               that." / "has uh agents" / "But um". Each used to be its own
 *               turn for the brain, which answered "that got cut off". A phrase
 *               that does not read as a whole sentence is held for a moment and
 *               joined with what follows.
 */

/* ------------------------------------------------------------------ the gate */

const YES = new Set(['yes', 'yeah', 'yep', 'yes please', 'do it', 'go ahead', 'allow', 'allow it'])
const NO = new Set(['no', 'nope', 'no thanks', 'dont', 'do not', 'cancel', 'stop'])

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

/**
 * How long after its question was said aloud a spoken yes or no still counts.
 * Past it the question is screen-only (the toast, the web card) until it times
 * out — at every risk level.
 */
export const CONFIRM_VOICE_WINDOW_MS = 20_000

/**
 * The question as it is said aloud, and whether a spoken answer will be taken.
 * With the mic not armed nobody is listening, so it points at the screen and
 * no voice record is made for it.
 */
export function confirmQuestion(what: string, armed: boolean): { line: string; byVoice: boolean } {
  const said = String(what ?? '').trim().replace(/[\s.?!]+$/, '') || 'an action'
  return { line: `Forge Brain asks: ${said}. ${armed ? 'Say yes or no.' : 'Press Yes or No on screen.'}`, byVoice: armed }
}

/**
 * Which waiting question a SPOKEN yes or no answers: the one whose question
 * finished being said aloud most recently, if that was within the window —
 * the one he heard, not blindly the oldest. `spokenAt` holds, per confirm id,
 * `Date.now()` when its question finished (only questions that really were
 * spoken, in full, with the mic armed). Null = none: a question never spoken
 * (text replies, a live realtime session, a "yeah" said before it arrived) or
 * spoken too long ago is answered on screen only.
 */
export function voiceConfirmTarget(pending: readonly string[], spokenAt: ReadonlyMap<string, number>, now: number): string | null {
  let target: string | null = null
  let latest = -Infinity
  for (const id of pending) {
    const at = spokenAt.get(id)
    if (at === undefined) continue
    const since = now - at
    if (since < 0 || since > CONFIRM_VOICE_WINDOW_MS) continue
    if (at >= latest) {
      target = id
      latest = at
    }
  }
  return target
}

/* ---------------------------------------------------------------- the gather */

/** How long a spoken phrase waits for the rest of its sentence before it is sent. */
export const GATHER_HOLD_MS = 900
/** After the pause that ends a phrase, how long its words take to arrive. */
export const GATHER_LAND_MS = 1200
/** The longest a phrase is held past its own arrival, whatever the room is doing. */
export const GATHER_MAX_MS = 8_000
/** Five words that end like a sentence are taken as one. */
const WHOLE_WORDS = 5

/**
 * Hold this phrase for what follows? False only when it reads as a whole
 * sentence: five or more words, ending with a full stop, ? or !.
 */
export function shouldHold(text: string): boolean {
  const t = String(text ?? '').trim()
  if (!t) return false
  const words = t.split(/\s+/).length
  return !(words >= WHOLE_WORDS && /[.?!]$/.test(t))
}

/**
 * Held phrases as one message, in the order they were said. A full stop the
 * recogniser put where he only paused ("…a virtual world that." / "has uh
 * agents") is dropped, so the brain reads one sentence, not two halves.
 */
export function joinPhrases(parts: readonly string[]): string {
  const said = parts.map((p) => String(p ?? '').trim()).filter(Boolean)
  return said
    .map((p, i) => {
      const next = said[i + 1]
      return next && /^[a-z]/.test(next) && /[^.]\.$/.test(p) ? p.slice(0, -1) : p
    })
    .join(' ')
}

export interface GatherClock {
  /** The newest held phrase. */
  last: string
  /** Milliseconds since it arrived. */
  sinceLast: number
  /** Milliseconds since the mic last heard a voice after it arrived; null = it has heard none. */
  sinceVoice: number | null
  /** The pause that ends a phrase in this session (Settings.agentSilenceMs). */
  pauseMs: number
}

/**
 * How much longer to hold, in milliseconds; 0 = send now. A whole sentence is
 * never held. Otherwise: the hold window from the phrase's arrival, and — once
 * the mic hears him speaking again — until that next phrase has had time to be
 * cut and land. Never past `GATHER_MAX_MS`: a television must not keep his
 * words from the brain.
 */
export function gatherWait(clock: GatherClock): number {
  if (!shouldHold(clock.last)) return 0
  const left = GATHER_MAX_MS - clock.sinceLast
  if (left <= 0) return 0
  const quiet = GATHER_HOLD_MS - clock.sinceLast
  const landing = clock.sinceVoice === null ? 0 : clock.pauseMs + GATHER_LAND_MS - clock.sinceVoice
  return Math.max(0, Math.min(left, Math.max(quiet, landing)))
}
