import { useSyncExternalStore } from 'react'
import type { BrainStatus } from '@shared/brain'
import type { ChatTurn, ChatUpdate } from '@shared/chat'
import { applyChatUpdate, EMPTY_CHAT, type ChatFeed } from '../../../web/src/lib/chat-turns'

/**
 * Forge Brain on the desktop, as the top bar's icon and drop-down read it.
 *
 * One module-level store, fed once by `startBrainFeed` (the icon mounts it and
 * keeps it for the life of the window), so the icon can count news while the
 * drop-down is shut and the drop-down opens on a chat that is already there.
 * Everything that talks to main goes through `window.forge.brain?.…`: a
 * renderer that outlives its preload (dev HMR) simply sees no brain.
 *
 *   status    B1's BrainStatus, pushed on every change. Null until the first.
 *   feed      the brain pane's transcript (claude engine only), folded with
 *             Forge Web's own rule (web/src/lib/chat-turns.ts).
 *   sends     what Steve typed here, shown the moment it goes — "sending",
 *             then "sent" or "queued" (the brain was busy), "failed" with why —
 *             until the transcript shows the same words, when the bubble is
 *             the transcript's own.
 *   unread    brain replies that arrived while the drop-down was shut.
 */

export type BrainTab = 'chat' | 'cli'

export interface BrainSend {
  id: number
  text: string
  at: number
  phase: 'sending' | 'sent' | 'queued' | 'failed'
  error?: string
  /** Dictated, not typed: the reply to it is read aloud. */
  spoken: boolean
}

export interface BrainSnapshot {
  status: BrainStatus | null
  feed: ChatFeed
  sends: BrainSend[]
  open: boolean
  /** Chat or the CLI. Null = the engine's own default (Chat for Claude, the CLI otherwise). */
  tab: BrainTab | null
  unread: number
}

let snap: BrainSnapshot = { status: null, feed: EMPTY_CHAT, sends: [], open: false, tab: null, unread: 0 }
const listeners = new Set<() => void>()

function set(patch: Partial<BrainSnapshot>): void {
  snap = { ...snap, ...patch }
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function brainSnapshot(): BrainSnapshot {
  return snap
}

export function useBrain(): BrainSnapshot {
  return useSyncExternalStore(subscribe, brainSnapshot, brainSnapshot)
}

/* ------------------------------------------------------------ open / shut */

export function setBrainOpen(open: boolean): void {
  if (open === snap.open) return
  set(open ? { open, unread: 0 } : { open })
}

export function toggleBrainOpen(): void {
  setBrainOpen(!snap.open)
}

export function setBrainTab(tab: BrainTab): void {
  set({ tab })
}

/** The tab on screen: Steve's pick, else Chat for Claude (the one with a transcript) and the CLI otherwise. */
export function shownTab(s: BrainSnapshot): BrainTab {
  if (s.tab) return s.tab
  return !s.status || s.status.engine === 'claude' ? 'chat' : 'cli'
}

/* ------------------------------------------------------------------ news */

/** Brain replies already counted, so a reply growing a tool result is not news twice. */
const seenReplies = new Set<string>()
/** The first transcript of a watch is history, not news. */
let seeded = false

function isReply(turn: ChatTurn): boolean {
  return turn.role === 'assistant' && turn.blocks.some((b) => b.kind === 'text' && b.text.trim())
}

/* ------------------------------------------------------------ sends */

let nextSendId = 1

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function sameWords(prompt: string, sent: string): boolean {
  if (prompt === sent) return true
  const shorter = Math.min(prompt.length, sent.length)
  return shorter >= 24 && (prompt.startsWith(sent) || sent.startsWith(prompt))
}

function promptText(turn: ChatTurn): string {
  return squash(
    turn.blocks
      .filter((b): b is Extract<ChatTurn['blocks'][number], { kind: 'text' }> => b.kind === 'text')
      .map((b) => b.text)
      .join(' ')
  )
}

/** Sends the transcript now shows are done with: the transcript's bubble takes over. */
function settleSends(feed: ChatFeed, sends: BrainSend[]): BrainSend[] {
  if (!sends.length) return sends
  const prompts = feed.turns.filter((t) => t.role === 'user').map(promptText)
  const used = new Set<number>()
  const left = sends.filter((send) => {
    if (send.phase === 'failed' || send.phase === 'sending') return true
    const want = squash(send.text)
    for (let i = prompts.length - 1; i >= 0; i--) {
      if (used.has(i)) continue
      if (sameWords(prompts[i]!, want)) {
        used.add(i)
        return false
      }
    }
    return true
  })
  return left.length === sends.length ? sends : left
}

function patchSend(id: number, patch: Partial<BrainSend>): void {
  const sends = snap.sends.map((s) => (s.id === id ? { ...s, ...patch } : s))
  set({ sends: settleSends(snap.feed, sends) })
}

/**
 * The reply to the last dictated message is read aloud once it is in. Kept
 * here, not on the bubble: the prompt's bubble becomes the transcript's.
 */
let speakPending: { text: string; at: number } | null = null

/** The dictated message waiting for its spoken reply, if any. Cleared by `takeSpeakPending`. */
export function takeSpeakPending(): { text: string; at: number } | null {
  const out = speakPending
  speakPending = null
  return out
}

export function peekSpeakPending(): { text: string; at: number } | null {
  return speakPending
}

/**
 * Send a message to the brain. The bubble is on screen before main answers;
 * main's answer only moves its ticks (sent, or queued behind a busy brain) or
 * turns it into "Not sent" with the reason and a Try again.
 */
export function sendToBrain(raw: string, spoken = false): boolean {
  const text = raw.trim()
  if (!text) return false
  const send: BrainSend = { id: nextSendId++, text, at: Date.now(), phase: 'sending', spoken }
  set({ sends: [...snap.sends, send] })
  if (spoken) speakPending = { text, at: send.at }
  void deliver(send)
  return true
}

async function deliver(send: BrainSend): Promise<void> {
  const brain = window.forge.brain
  if (!brain) {
    patchSend(send.id, { phase: 'failed', error: 'This window cannot reach Forge Brain — restart Forge.' })
    return
  }
  try {
    const result = await brain.send(send.text)
    if (result.ok) patchSend(send.id, { phase: result.queued ? 'queued' : 'sent' })
    else patchSend(send.id, { phase: 'failed', error: result.error })
  } catch (err) {
    patchSend(send.id, { phase: 'failed', error: err instanceof Error ? err.message : String(err) })
  }
}

/** Send a failed message again, as a new send (it goes to the end, where it will land). */
export function retrySend(id: number): void {
  const send = snap.sends.find((s) => s.id === id)
  if (!send) return
  set({ sends: snap.sends.filter((s) => s.id !== id) })
  sendToBrain(send.text, send.spoken)
}

export function dropSend(id: number): void {
  set({ sends: snap.sends.filter((s) => s.id !== id) })
}

/* ------------------------------------------------------------------ feed */

let started = 0
let stopFeed: (() => void) | null = null
/** The watch the transcript is on: re-armed whenever the pane or the session changes. */
let watching: string | null = null

function watchKey(status: BrainStatus): string | null {
  if (!status.enabled || status.engine !== 'claude' || !status.paneId) return null
  return `${status.paneId}:${status.sessionId ?? ''}`
}

function onStatus(status: BrainStatus): void {
  const prev = snap.status
  const patch: Partial<BrainSnapshot> = { status }
  // Queued messages that have gone in are sent now, whether or not the
  // transcript has them yet (the other engines never will).
  if (status.queued === 0 && snap.sends.some((s) => s.phase === 'queued')) {
    patch.sends = snap.sends.map((s) => (s.phase === 'queued' ? { ...s, phase: 'sent' } : s))
  }
  // A new engine or a stopped brain is a new conversation: the old one's
  // bubbles would only mislead.
  if (prev && (prev.engine !== status.engine || (prev.enabled && !status.enabled))) {
    patch.feed = EMPTY_CHAT
    patch.sends = []
    patch.unread = 0
    speakPending = null
  }
  set(patch)
  const key = watchKey(status)
  if (key !== watching) {
    watching = key
    seeded = false
    const brain = window.forge.brain
    if (key) void brain?.watchTranscript().catch(() => undefined)
    else void brain?.stopTranscript().catch(() => undefined)
  }
}

function onTranscript(update: ChatUpdate): void {
  const feed = applyChatUpdate(snap.feed, update)
  if (feed === snap.feed) return
  let unread = snap.unread
  if (update.reset && !seeded) {
    // The first frame of a watch is what was already said.
    seeded = true
    for (const turn of feed.turns) if (isReply(turn)) seenReplies.add(turn.id)
  } else {
    for (const turn of update.turns) {
      if (!isReply(turn) || seenReplies.has(turn.id)) continue
      seenReplies.add(turn.id)
      if (!snap.open) unread++
    }
  }
  set({ feed, unread, sends: settleSends(feed, snap.sends) })
}

/**
 * Start listening to main. Reference-counted: the icon calls it on mount and
 * the returned stop on unmount, and only the last stop lets go.
 */
export function startBrainFeed(): () => void {
  started++
  if (started === 1) {
    const brain = window.forge.brain
    if (brain) {
      const offStatus = brain.onStatus(onStatus)
      const offTranscript = brain.onTranscript(onTranscript)
      void brain
        .status()
        .then(onStatus)
        .catch(() => undefined)
      stopFeed = () => {
        offStatus()
        offTranscript()
        if (watching) void brain.stopTranscript().catch(() => undefined)
        watching = null
      }
    }
  }
  return () => {
    started--
    if (started > 0) return
    stopFeed?.()
    stopFeed = null
  }
}

/* --------------------------------------------------------------- actions */

export async function turnBrainOn(): Promise<string | null> {
  const brain = window.forge.brain
  if (!brain) return 'This window cannot reach Forge Brain — restart Forge.'
  try {
    const status = await brain.enable()
    onStatus(status)
    return status.state === 'error' ? status.error ?? 'Forge Brain could not start.' : null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export async function turnBrainOff(): Promise<void> {
  const status = await window.forge.brain?.disable().catch(() => null)
  if (status) onStatus(status)
}

export async function pickBrainEngine(engine: BrainStatus['engine']): Promise<void> {
  const status = await window.forge.brain?.setEngine(engine).catch(() => null)
  if (status) onStatus(status)
}

export async function answerConfirm(id: string, allow: boolean): Promise<void> {
  await window.forge.brain?.confirm({ id, allow }).catch(() => false)
}
