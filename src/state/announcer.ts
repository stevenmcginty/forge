import { speakable } from '../lib/speech'

/**
 * Forge speaking up on its own while it is minimised (docs/MINI-BAR.md, 4.11):
 * "Jonah is done. Jonah says: fixed the login redirect, and tests pass."
 *
 * Every line is a template plus the agent's own words: no model call, so it is
 * instant and free. Always the pane's name, never "he" or "she".
 *
 * The rules that make it bearable live here, with no React and no DOM, so
 * scripts/announcer-check.mjs can hold them to account:
 *
 *   quiet     nothing is said while Steve dictates, while Listen hears him, or
 *             while Forge is already speaking; lines wait in a queue;
 *   gather    a line waits until the news has been still for GATHER_MS, so a
 *             few agents finishing together are said once;
 *   merge     one line per pane (its newest news), and three or more of one
 *             kind become one: "Three agents are done: Jonah, Ruth and Ivy.";
 *   stale     anything older than STALE_MS is dropped, never said late;
 *   brain     a pane Forge Brain opened is left to the Brain, which reports on
 *             its own panes in its own words; it is never said twice.
 *
 * The caller (src/state/minibar/news.ts) owns the clock: it calls `tick` on a
 * timer while anything waits, and `say` is the voice hub's `say`, which uses
 * the brain's voice, its queue and `voiceReplyMode`.
 */

export type NewsKind = 'done' | 'asking' | 'stopped'

export interface NewsItem {
  kind: NewsKind
  paneId: string
  /** The pane's display name: "Jonah". */
  name: string
  /** `Date.now()` when it happened. */
  at: number
  /** 'done' on a Claude pane: the reply it just finished, whole. */
  reply?: string
  /** 'asking': the one-line question (`terminalHost.attentionPrompt`). */
  prompt?: string
}

/** News older than this is dropped, never said late. */
export const STALE_MS = 60_000
/** News waits until nothing new has come for this long, so a burst is said once. */
export const GATHER_MS = 1500
/** This many of one kind at once are said as one line. */
export const BURST_MIN = 3

/** A spoken question is cut here; the toast has the rest. */
const PROMPT_MAX = 160

/**
 * Code, links and paths: never read aloud. The same pattern Forge Brain's
 * spoken replies use (`spokenBrainReply`, src/state/VoiceAgent.tsx), so an
 * agent's words are trimmed the same way the brain's are.
 */
const UNSPEAKABLE =
  /```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+|\b[A-Za-z]:\\[^\s,;)]+|(?:^|\s)(?:\.{0,2}\/)(?:[\w.-]+\/)*[\w.-]+|(?:^|\s)(?:[\w.-]+\/){2,}[\w.-]+/g

/**
 * The first one or two sentences of an agent's reply, as they would be said:
 * `spokenBrainReply`'s trimming — the opening paragraph before any list or
 * code, cut to two sentences, in plain words — without its "the details are
 * in the text" (the toast and Peek have the details).
 */
export function replyGist(text: string): string {
  const whole = String(text ?? '').trim()
  if (!whole) return ''
  const lead = whole.split(/\n\s*\n|\n\s*(?:[-*•]|\d+[.)])\s|```/)[0] ?? ''
  const clean = (s: string): string => speakable(s.replace(UNSPEAKABLE, ' '), 400)
  let said = clean(lead) || clean(whole)
  const sentences = said.match(/[^.!?]+[.!?]+(?=\s|$)/g)
  if (sentences && sentences.length > 2) said = sentences.slice(0, 2).join('').trim()
  return said
}

/** A full stop on a line that has no ending of its own. */
function ended(text: string): string {
  const t = text.trim()
  return !t || /[.!?…:]$/.test(t) ? t : `${t}.`
}

/** The question in plain words: no menu cursor or box chrome, and short. */
function spokenPrompt(prompt: string): string {
  return speakable(String(prompt ?? '').replace(/[❯›▶►●│┃╭╮╰╯─━]/g, ' '), PROMPT_MAX)
}

/** "Jonah is done. Jonah says: …", "Ruth is asking: …", "Ivy stopped." */
export function lineFor(item: NewsItem): string {
  const name = item.name.trim() || 'An agent'
  if (item.kind === 'done') {
    const gist = item.reply ? replyGist(item.reply) : ''
    return gist ? `${name} is done. ${name} says: ${ended(gist)}` : `${name} is done.`
  }
  if (item.kind === 'asking') {
    const q = item.prompt ? spokenPrompt(item.prompt) : ''
    return q ? `${name} is asking: ${ended(q)}` : `${name} is asking.`
  }
  return `${name} stopped.`
}

const COUNT_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']

/** "Jonah, Ruth and Ivy". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** "Three agents are done: Jonah, Ruth and Ivy." */
export function burstLine(kind: NewsKind, names: string[]): string {
  const count = COUNT_WORDS[names.length] ?? String(names.length)
  const verb = kind === 'done' ? 'are done' : kind === 'asking' ? 'are asking' : 'stopped'
  return `${count} agents ${verb}: ${listNames(names)}.`
}

/**
 * Everything waiting, as one thing to say: the newest news per pane, three or
 * more of one kind as one burst line, the rest one line each, oldest first.
 */
export function speechFor(items: NewsItem[]): string {
  const newest = new Map<string, NewsItem>()
  for (const item of items) {
    const had = newest.get(item.paneId)
    if (!had || item.at >= had.at) newest.set(item.paneId, item)
  }
  const kept = [...newest.values()].sort((a, b) => a.at - b.at)
  const out: { at: number; text: string }[] = []
  for (const kind of ['done', 'asking', 'stopped'] as const) {
    const group = kept.filter((i) => i.kind === kind)
    if (group.length >= BURST_MIN) out.push({ at: group[0]!.at, text: burstLine(kind, group.map((i) => i.name.trim() || 'an agent')) })
    else for (const i of group) out.push({ at: i.at, text: lineFor(i) })
  }
  return out
    .sort((a, b) => a.at - b.at)
    .map((o) => o.text)
    .join(' ')
}

export interface AnnouncerDeps {
  now(): number
  /** The mini bar is switched on (`miniBar`), mini mode is on and "Speak updates" is on. */
  on(): boolean
  /** Nobody is talking: no dictation, Listen hears no one, Forge is not speaking. */
  quiet(): boolean
  /** Forge Brain opened this pane and is running: it reports on it itself. */
  brainOwns(paneId: string): boolean
  say(text: string): void
}

export interface Announcer {
  push(item: NewsItem): void
  /** Say what is waiting, if the moment is right. Call on a timer while `pending()`. */
  tick(): void
  pending(): number
  clear(): void
}

export function createAnnouncer(deps: AnnouncerDeps): Announcer {
  let queue: NewsItem[] = []
  return {
    push(item) {
      if (!deps.on() || deps.brainOwns(item.paneId)) return
      queue.push(item)
    },
    tick() {
      const now = deps.now()
      queue = queue.filter((i) => now - i.at <= STALE_MS)
      if (!deps.on()) {
        queue = []
        return
      }
      if (queue.length === 0 || !deps.quiet()) return
      const newest = Math.max(...queue.map((i) => i.at))
      if (now - newest < GATHER_MS) return
      const text = speechFor(queue)
      queue = []
      if (text) deps.say(text)
    },
    pending() {
      return queue.length
    },
    clear() {
      queue = []
    }
  }
}
