import { useSyncExternalStore } from 'react'
import type { ChatBlock, ChatTurn } from '@shared/chat'
import { getReadAloudVoice } from './voice-prefs'

/**
 * "Read aloud": the phone speaks an agent's latest reply with its own
 * on-device voice (the Web Speech API). Free by construction — no key, no
 * server, nothing leaves the phone — which is the whole point: it is for
 * listening to an answer away from the desk, not for a voice worth paying for.
 *
 * Three pieces: what a reply *is* (`replyText`), what of it is worth hearing
 * (`toSpeech`), and a one-slot store of which pane is speaking, so the button
 * under the pane can turn into a stop button and back.
 */

/* ------------------------------------------------------------ the words */

/**
 * The latest reply's words, as markdown.
 *
 * A reply is the assistant turns since the person last spoke, and it is
 * usually narration ("Let me check the config") with tools between, then the
 * answer. The answer is what is worth hearing, so this is the text after the
 * last tool. A reply that ends on a tool call (still working, or stopped
 * mid-way) has no answer yet, so the most recent run of assistant text stands
 * in — better than a button that does nothing.
 */
export function replyText(turns: ChatTurn[]): string {
  let start = turns.length
  while (start > 0 && turns[start - 1].role === 'assistant') start--
  const reply = turns.slice(start).flatMap((turn) => turn.blocks)
  let lastTool = -1
  reply.forEach((block, i) => {
    if (block.kind === 'tool') lastTool = i
  })
  const answer = texts(reply.slice(lastTool + 1))
  if (answer.length) return answer.join('\n\n')

  // The fallback: walk back to the last assistant text, then gather the text
  // that runs into it, stopping at a tool or at the person's own turn.
  const run: string[] = []
  for (let t = turns.length - 1; t >= 0; t--) {
    const turn = turns[t]
    if (turn.role !== 'assistant') {
      if (run.length) break
      continue
    }
    for (let b = turn.blocks.length - 1; b >= 0; b--) {
      const block = turn.blocks[b]
      if (block.kind === 'tool' && run.length) return run.reverse().join('\n\n')
      if (block.kind === 'text' && block.text.trim()) run.push(block.text.trim())
    }
  }
  return run.reverse().join('\n\n')
}

function texts(blocks: ChatBlock[]): string[] {
  const out: string[] = []
  for (const block of blocks) if (block.kind === 'text' && block.text.trim()) out.push(block.text.trim())
  return out
}

/**
 * Markdown, cut down to what a voice should say.
 *
 * Code is the big one: a fenced block read aloud is a minute of punctuation,
 * so it is announced ("Code block.") and skipped. Inline code keeps its words
 * — a file name mid-sentence is part of the sentence. Links read as their
 * words and a bare URL as "link". Every line becomes a sentence of its own,
 * so a list or a table row gets a pause rather than running into the next.
 */
export function toSpeech(markdown: string): string {
  const kept: string[] = []
  const keep = (text: string): string => `\u0000${kept.push(text) - 1}\u0000`

  let s = markdown.replace(/\r\n?/g, '\n')
  // Fenced code, closed or running to the end of the reply.
  s = s.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n?[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, '\nCode block.\n')
  // Inline code: its text, shielded from the emphasis rules below (`snake_case`).
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, code: string) => keep(code.trim()))
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  s = s.replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, '$1')
  s = s.replace(/<(?:https?|mailto):[^>\s]+>/g, 'link')
  s = s.replace(/\b(?:https?:\/\/|www\.)[^\s<>()\]]+/g, 'link')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '')

  const lines: string[] = []
  for (const raw of s.split('\n')) {
    let line = raw.trim()
    // Rules and table separator rows: `---`, `|:--|--:|`.
    if (/^([-*_])(\s*\1){2,}$/.test(line)) continue
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line) && /-/.test(line)) continue
    line = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/\s+#+$/, '')
      .replace(/^(>\s?)+/, '')
      .replace(/^([-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
    if (line.includes('|') && (line.startsWith('|') || line.endsWith('|') || / \| /.test(line))) {
      line = line
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(', ')
    }
    line = line
      .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
      .replace(/~~(?=\S)([^\n]*?\S)~~/g, '$1')
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
      .replace(/\s+/g, ' ')
      .trim()
    if (!line) continue
    lines.push(/[.!?:;,]$/.test(line) ? line : `${line}.`)
  }
  return lines.join(' ').replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)] ?? '')
}

/**
 * The cleaned text in pieces a voice will finish. Chrome drops a long
 * utterance part-way (a single one stalls after ~15 seconds), so each piece is
 * a sentence or a few, kept under ~200 characters; a sentence longer than
 * that is broken at its last space before the limit.
 */
function chunks(text: string, max = 200): string[] {
  const out: string[] = []
  let current = ''
  for (let sentence of text.split(/(?<=[.!?])\s+/)) {
    while (sentence.length > max) {
      const cut = sentence.lastIndexOf(' ', max)
      const at = cut > max / 2 ? cut : max
      if (current) out.push(current)
      current = ''
      out.push(sentence.slice(0, at).trim())
      sentence = sentence.slice(at).trim()
    }
    if (!sentence) continue
    if (current && current.length + 1 + sentence.length > max) {
      out.push(current)
      current = sentence
    } else {
      current = current ? `${current} ${sentence}` : sentence
    }
  }
  if (current) out.push(current)
  return out
}

/* ----------------------------------------------------------- the speaker */

let speaking: string | null = null
/** Bumped on every start and stop, so a cancelled queue's late events are ignored. */
let session = 0
/**
 * The queued utterances, held so they are not collected mid-queue: Chrome
 * never fires `end` on an utterance that was garbage-collected, and the button
 * would then read "Stop" forever.
 */
let queue: SpeechSynthesisUtterance[] = []
const listeners = new Set<() => void>()

function setSpeaking(paneId: string | null): void {
  if (speaking === paneId) return
  speaking = paneId
  if (paneId === null) queue = []
  for (const listener of listeners) listener()
}

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function'
}

/**
 * The voice picked in the ⋯ sheet, while the phone still has it; otherwise a
 * voice in the phone's own language, on-device first. `getVoices()` is
 * often empty until the browser has loaded its list (`voiceschanged`); rather
 * than wait on that, an empty list means the browser's default voice, told
 * the language through `utterance.lang`.
 */
function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices()
  const saved = getReadAloudVoice()
  const chosen = saved ? voices.find((voice) => voice.voiceURI === saved) : undefined
  if (chosen) return chosen
  const want = (navigator.language || 'en').toLowerCase()
  const base = want.split('-')[0]
  let best: SpeechSynthesisVoice | null = null
  let bestScore = 0
  for (const voice of voices) {
    const lang = voice.lang.toLowerCase().replace('_', '-')
    const match = lang === want ? 4 : lang.split('-')[0] === base ? 2 : 0
    if (!match) continue
    const score = match + (voice.localService ? 1 : 0)
    if (score > bestScore) {
      best = voice
      bestScore = score
    }
  }
  return best
}

/**
 * Read `markdown` aloud as `paneId`'s reply, cutting off whatever was being
 * read before. Everything up to `speak()` is synchronous on purpose: mobile
 * browsers only let speech start inside the tap that asked for it.
 */
export function speakReply(paneId: string, markdown: string): void {
  if (!speechSupported()) return
  const synth = window.speechSynthesis
  const mine = ++session
  synth.cancel()
  const pieces = chunks(toSpeech(markdown))
  if (!pieces.length) {
    setSpeaking(null)
    return
  }
  const voice = pickVoice()
  queue = pieces.map((text, i) => {
    const utterance = new SpeechSynthesisUtterance(text)
    if (voice) utterance.voice = voice
    utterance.lang = voice?.lang ?? navigator.language
    const done = (): void => {
      if (session !== mine) return
      session++
      setSpeaking(null)
    }
    if (i === pieces.length - 1) utterance.onend = done
    // `error` also covers a cancel from outside (another page taking the voice).
    utterance.onerror = () => {
      if (session === mine) synth.cancel()
      done()
    }
    return utterance
  })
  for (const utterance of queue) synth.speak(utterance)
  setSpeaking(paneId)
}

export function stopSpeaking(): void {
  session++
  if (speechSupported()) window.speechSynthesis.cancel()
  setSpeaking(null)
}

const SAMPLE = 'This is how Forge will read replies to you.'

/**
 * One sentence in `voice` (null: the automatic pick), so a voice can be heard
 * before it reads a reply. It cuts off any reply being read and belongs to no
 * pane, so the status strip's button goes back from Stop. Synchronous for the
 * same reason `speakReply` is.
 */
export function speakSample(voice: SpeechSynthesisVoice | null): void {
  if (!speechSupported()) return
  const synth = window.speechSynthesis
  const mine = ++session
  synth.cancel()
  setSpeaking(null)
  const spoken = voice ?? pickVoice()
  const utterance = new SpeechSynthesisUtterance(SAMPLE)
  if (spoken) utterance.voice = spoken
  utterance.lang = spoken?.lang ?? navigator.language
  // Held like a reply's queue, so Chrome does not collect it mid-sentence.
  const done = (): void => {
    if (session === mine) queue = []
  }
  utterance.onend = done
  utterance.onerror = done
  queue = [utterance]
  synth.speak(utterance)
}

function subscribe(listener: () => void): () => void {
  // Asking once is what makes the browser start loading its voices, so the
  // list is usually there by the first tap.
  if (!listeners.size && speechSupported()) window.speechSynthesis.getVoices()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The pane being read aloud, or null. */
export function useSpeakingPane(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => speaking,
    () => null
  )
}

/* ------------------------------------------------------------ the voices */

const NO_VOICES: SpeechSynthesisVoice[] = []
let voiceList: SpeechSynthesisVoice[] = NO_VOICES

/**
 * The device's voices as one stable array. `getVoices()` hands back a new
 * array on every call, so it is kept until the list itself changes — a store
 * snapshot that differs on every read would re-render for ever.
 */
function currentVoices(): SpeechSynthesisVoice[] {
  if (!speechSupported()) return NO_VOICES
  const now = window.speechSynthesis.getVoices()
  const same = now.length === voiceList.length && now.every((voice, i) => voice.voiceURI === voiceList[i].voiceURI)
  if (!same) voiceList = now.length ? now : NO_VOICES
  return voiceList
}

function subscribeVoices(listener: () => void): () => void {
  if (!speechSupported()) return () => {}
  const synth = window.speechSynthesis
  synth.addEventListener('voiceschanged', listener)
  return () => synth.removeEventListener('voiceschanged', listener)
}

/** The voices this device can speak in — empty until the browser has loaded them. */
export function useVoices(): SpeechSynthesisVoice[] {
  return useSyncExternalStore(subscribeVoices, currentVoices, () => NO_VOICES)
}
