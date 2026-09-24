/**
 * The conversation's own words, as pure decisions (B11).
 *
 * One press opens a conversation with the main agent that stays open turn
 * after turn. This file decides the three things that are said *about* the
 * conversation rather than *to* the agent, so they never reach a brain:
 *
 *   stop phrases     "that's all", "stop listening" (and close variants) end it
 *   voice dictation  "type this into Zeb: …", "dictate into the Codex
 *                    pane …", "put this in the bar …" — raw words, no rewrite
 *   the idle clock   `agentIdleTimeoutMs` of quiet ends it, and says so
 *
 * No React, no DOM, no `@/` imports: scripts/agent-bar-check.mjs imports it
 * directly. The callers are src/state/VoiceAgent.tsx (Parakeet brains, before
 * the grammar and the brain) and src/state/VoiceHubController.tsx (realtime
 * captions, the idle timer, the ended note).
 */

/* ------------------------------------------------------------ normalising */

/** Lower case, straight apostrophes, no punctuation but apostrophes, single spaces. */
function plain(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ----------------------------------------------------------- stop phrases */

/** Said before the phrase and meaning nothing: "okay, that's all". */
const LEAD_FILLER = /^(?:(?:ok|okay|alright|all right|right|cool|great|good|thanks|thank you|cheers|well|so|yeah|yes|no|hey|forge|jarvis)\s+)+/

/** Said after it: "that's all for now, thanks". */
const TAIL_FILLER = /(?:\s+(?:thanks|thank you|cheers|forge|jarvis|for now|for today|for the moment|mate|then|please|bye|goodbye|now))+$/

/**
 * The phrases themselves, after the fillers are gone. The WHOLE utterance has
 * to be one of these: "that's all the files in there" is a sentence about
 * files, not a goodbye.
 */
const STOP_CORES = new Map<string, string>([
  ["that's all", "that's all"],
  ['thats all', "that's all"],
  ['that is all', "that's all"],
  ["that'll be all", "that's all"],
  ['that will be all', "that's all"],
  ["that's all i need", "that's all"],
  ["that's everything", "that's all"],
  ['stop listening', 'stop listening'],
  ['you can stop listening', 'stop listening'],
  ['stop listening to me', 'stop listening'],
  ['please stop listening', 'stop listening'],
  ['end the conversation', 'stop listening'],
  ['end conversation', 'stop listening'],
  ['goodbye', 'goodbye']
])

/**
 * The stop phrase this utterance is, in its canonical words ("that's all",
 * "stop listening" or "goodbye"), or null when it is anything else.
 */
export function stopPhraseOf(said: string): string | null {
  let t = plain(said)
  if (!t || t.length > 60) return null
  t = t.replace(LEAD_FILLER, '').replace(TAIL_FILLER, '').trim()
  return STOP_CORES.get(t) ?? null
}

export function isStopPhrase(said: string): boolean {
  return stopPhraseOf(said) !== null
}

/* -------------------------------------------------------- voice dictation */

export type VoiceDictation =
  /** Raw words into a pane. `target` is the words he used for it; `paneId` null = nobody by that name. */
  | { kind: 'pane'; target: string; paneId: string | null; text: string; submit: boolean }
  /** Into the bar's text box, to be read and fixed before sending. */
  | { kind: 'bar'; text: string }

/** Resolves spoken target words ("Zeb", "the Codex pane", "this pane") to a pane id, or null. */
export type TargetResolver = (spoken: string) => string | null

/** "okay, can you …" before the verb. */
const ASK_LEAD = /^(?:(?:ok|okay|alright|right|hey|forge|jarvis|please|now|and|so|can you|could you|would you|will you)[\s,]+)*/i

/** The verb, "this", and the "into" that introduces the target. */
const DICTATE_VERB =
  /^(?:type|dictate|write|put|paste)(?:\s+(?:this|that|these words|the following|out|in))?\s+(?:in|into|in to|to|onto|on)\s+(.+)$/i

/** "the bar", "the text box" — the composer rather than a pane. */
const BAR_TARGET = /^(?:the\s+)?(?:bar|agent bar|composer|text box|textbox|box|input|prompt box)\b[\s,:;.–—-]*(.*)$/i

/** "… and send it", "… then press enter", "… press enter": Enter after the text. A bare "send" is text. */
const SUBMIT_TAIL =
  /[\s,.;:]*(?:(?:and|then|and then)\s+(?:send it|send|submit it|submit|press enter|hit enter|press return|hit return)|(?:press|hit)\s+(?:enter|return))[.!]?$/i

/** Words that may follow the target's name and belong to it: "the Codex *pane*". */
const TARGET_SUFFIX = new Set(['pane', 'panel', 'terminal', 'one', 'window', 'tab', 'session', 'agent'])

/** Parakeet closes every phrase with a full stop; that stop is its, not his. */
function dropSentenceStop(text: string): string {
  return text.replace(/\s+$/, '').replace(/(?<!\.)\.$/, '')
}

/** The text, and whether he asked for Enter. */
function splitSubmit(text: string): { text: string; submit: boolean } {
  const trimmed = dropSentenceStop(text.trim())
  const m = SUBMIT_TAIL.exec(trimmed)
  if (m && m.index > 0) return { text: dropSentenceStop(trimmed.slice(0, m.index).trim()), submit: true }
  return { text: trimmed, submit: false }
}

/** "Zeb," → "Zeb": the separator after a spoken name. */
function bareWord(w: string): string {
  return w.replace(/^[\s"'“”]+|[\s,:;.!?"'“”–—-]+$/g, '')
}

/**
 * A spoken "type this into …", or null when the phrase is not one.
 *
 * The target is found two ways. With a separator — "type this into Zeb:
 * echo hi" — it is everything before the first colon, comma or dash. Without
 * one, which is what a recogniser usually writes, the shortest run of words
 * (up to four) that `resolve` knows is the target, plus any "pane" / "one"
 * that follows it, and the rest is the text.
 */
export function parseVoiceDictation(said: string, resolve: TargetResolver): VoiceDictation | null {
  const body = String(said ?? '').trim().replace(ASK_LEAD, '')
  const m = DICTATE_VERB.exec(body)
  if (!m) return null
  // "type" and "dictate" only ever mean this; "put" and "write" often do not
  // ("write to the log file that…"), so those need a pane that exists.
  const certain = /^(?:type|dictate)\b/i.test(body)
  const rest = m[1]!.trim()

  const bar = BAR_TARGET.exec(rest)
  if (bar) {
    const text = dropSentenceStop((bar[1] ?? '').trim())
    return text ? { kind: 'bar', text } : null
  }

  // A separator he (or the recogniser) put there: the target is before it.
  const sep = /^([^:,–—]{1,40}?)\s*[:,–—]\s*(.+)$/.exec(rest)
  if (sep) {
    const target = bareWord(sep[1]!)
    const paneId = target ? resolve(target) : null
    const { text, submit } = splitSubmit(sep[2]!)
    if (paneId && text) return { kind: 'pane', target, paneId, text, submit }
  }

  // No separator: the shortest run of words that names a pane.
  const words = rest.split(/\s+/)
  for (let n = 1; n <= Math.min(4, words.length - 1); n++) {
    const candidate = words.slice(0, n).map(bareWord).join(' ')
    if (/^(?:the|a|my)$/i.test(candidate)) continue
    const paneId = resolve(candidate)
    if (!paneId) continue
    let end = n
    while (end < words.length - 1 && TARGET_SUFFIX.has(bareWord(words[end]!).toLowerCase())) end++
    const target = words.slice(0, end).map(bareWord).join(' ')
    const { text, submit } = splitSubmit(words.slice(end).join(' '))
    if (!text) return null
    return { kind: 'pane', target, paneId, text, submit }
  }

  // "type this into Zebra: echo hi" with no Zebra: say so rather than guess.
  if (!certain) return null
  const target = sep ? bareWord(sep[1]!) : bareWord(words[0] ?? '')
  const { text, submit } = splitSubmit(sep ? sep[2]! : words.slice(1).join(' '))
  return target && text ? { kind: 'pane', target, paneId: null, text, submit } : null
}

/* ----------------------------------------------------------- the idle clock */

export const IDLE_TIMEOUT_DEFAULT_MS = 120_000
export const IDLE_TIMEOUT_MIN_MS = 30_000
export const IDLE_TIMEOUT_MAX_MS = 600_000

/** 0 = never; otherwise 30 s – 10 min, whole seconds. Mirrors electron/store.ts. */
export function normaliseIdleTimeout(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return IDLE_TIMEOUT_DEFAULT_MS
  if (v <= 0) return 0
  return Math.min(IDLE_TIMEOUT_MAX_MS, Math.max(IDLE_TIMEOUT_MIN_MS, Math.round(v / 1000) * 1000))
}

/**
 * How long until the quiet ends the conversation, or null when no clock runs:
 * never, or not listening (a reply being thought about or spoken is not quiet).
 */
export function idleRemainingMs(i: { open: boolean; listening: boolean; timeoutMs: number; lastActivityAt: number; now: number }): number | null {
  if (!i.open || !i.listening || !(i.timeoutMs > 0)) return null
  return Math.max(0, i.timeoutMs - (i.now - i.lastActivityAt))
}

/** "2 min", "30 s", "1.5 min". */
export function quietWords(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  const min = ms / 60_000
  return Number.isInteger(min) ? `${min} min` : `${min.toFixed(1)} min`
}

/* ------------------------------------------------------------- the ending */

export type ConversationEnd =
  | { kind: 'phrase'; phrase: string }
  | { kind: 'idle'; ms: number }
  | { kind: 'press' }
  /** The Agent brain setting moved while a live session was open (V6). */
  | { kind: 'switched' }

/** Why it ended, in the words listenNote shows. */
export function endedNote(end: ConversationEnd): string {
  const why =
    end.kind === 'phrase'
      ? `you said "${end.phrase}"`
      : end.kind === 'idle'
        ? `${quietWords(end.ms)} quiet`
        : end.kind === 'switched'
          ? 'brain changed'
          : 'you turned it off'
  return `Conversation ended — ${why}`
}

/**
 * A live session whose brain setting no longer names it: the bar would show
 * the new brain while the old one kept answering (V6). `picked` is the live
 * provider the setting resolves to now (null: a Parakeet brain, or no key).
 */
export function liveBrainSwitched(live: string | null, picked: string | null): boolean {
  return live !== null && live !== picked
}

/* ----------------------------------------------------------- the watchdog */

/** Starting… with no session after this long is a connection that is not coming. */
export const STUCK_CONNECTING_MS = 30_000
/** Thinking… with no tool running and no reply after this long is a session gone quiet. */
export const STUCK_THINKING_MS = 30_000

/**
 * How long a live phase may last before the watchdog ends the session, or
 * null when no watchdog runs. Listening is his to fill (the idle clock owns
 * it), speaking ends by itself, and a tool still running is not quiet — a
 * video takes minutes.
 */
export function stuckAfterMs(i: { phase: string; toolRunning: boolean }): number | null {
  if (i.phase === 'connecting') return STUCK_CONNECTING_MS
  if (i.phase === 'thinking' && !i.toolRunning) return STUCK_THINKING_MS
  return null
}

/** The watchdog's reason, for the pill (errorReasonOf reads it as "<vendor>: no reply"). */
export function stuckReason(label: string, phase: 'connecting' | 'thinking', ms: number): string {
  return phase === 'connecting'
    ? `${label} did not answer: no session after ${quietWords(ms)}`
    : `${label} went quiet: no reply for ${quietWords(ms)}`
}
