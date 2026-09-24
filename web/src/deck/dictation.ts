import { useSyncExternalStore } from 'react'
import type { WebRequest, WebResult } from '@shared/web'
import { isDictationSupported, startRecording, transcribeOnDesktop, type Recording } from '../lib/dictate'
import { watchLevel, type LevelMonitor } from '../lib/voice-level'
import { getVoiceAutoStop } from '../lib/voice-prefs'
import { dictateIntoComposer, focusedField, insertAtCaret } from './composer'

/**
 * D: raw dictation. The words are typed, never sent.
 *
 * The same pipe the phone's mic uses, end to end — `startRecording` with the
 * pane as its target (so a desktop that announces `dictate-stream` hears it
 * while it is spoken), the same silence check before anything is uploaded,
 * `transcribeOnDesktop` with the same 75 s ceiling, the same opt-in auto-stop —
 * and the desktop picks the speech engine, as it does for the phone. What
 * differs is only the end: no spoken commands, no review beat, no send. The
 * words land at the caret of the text field that has the keyboard when the
 * recording stops, or, when none has, in the composer (which opens for them).
 *
 * A module store rather than component state, so the recording outlives its
 * button moving between the top bar and the dock.
 */

export type RawPhase = 'idle' | 'starting' | 'recording' | 'transcribing'

/** SessionComposer's TRANSCRIBE_TIMEOUT_MS: the phone waits this long for words. */
const TRANSCRIBE_TIMEOUT_MS = 75_000

export interface RawTarget {
  /** The pane the desktop files the words under (it checks the pane exists). */
  paneId: string
  request: (body: WebRequest) => Promise<WebResult>
  notice: (text: string) => void
}

let phase: RawPhase = 'idle'
const listeners = new Set<() => void>()
let recording: Recording | null = null
let monitor: LevelMonitor | null = null
let target: RawTarget | null = null
/** Bumped by every start and cancel, so a late answer for an old recording lands nowhere. */
let run = 0
/** Stop was asked for while the microphone was still opening. */
let stopWhenOpen = false

function setPhase(next: RawPhase): void {
  if (next === phase) return
  phase = next
  listeners.forEach((fn) => fn())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useRawDictation(): RawPhase {
  return useSyncExternalStore(subscribe, () => phase, () => phase)
}

export const rawDictationSupported = isDictationSupported

async function start(to: RawTarget): Promise<void> {
  const mine = ++run
  target = to
  stopWhenOpen = false
  setPhase('starting')
  try {
    const opened = await startRecording(
      () => {
        to.notice('Ten minutes is the most one recording takes — writing what was said.')
        void stop()
      },
      { sessionId: to.paneId, request: to.request }
    )
    if (mine !== run) {
      opened.cancel()
      return
    }
    recording = opened
    monitor = watchLevel(opened.stream, getVoiceAutoStop() ? () => void stop() : undefined)
    setPhase('recording')
    if (stopWhenOpen) void stop()
  } catch (err) {
    if (mine !== run) return
    setPhase('idle')
    to.notice(err instanceof Error ? err.message : 'Could not open the microphone.')
  }
}

async function stop(): Promise<void> {
  if (phase === 'starting') {
    stopWhenOpen = true
    return
  }
  const current = recording
  const to = target
  const level = monitor
  recording = null
  monitor = null
  if (!current || !to) return
  const mine = run
  // Where the words go is decided now, by what has the keyboard as you stop.
  const field = focusedField()
  setPhase('transcribing')
  try {
    const audio = await current.stop()
    const silent = level?.silent() ?? false
    level?.close()
    if (mine !== run) return
    if (audio.size === 0) return to.notice('Nothing was recorded.')
    if (silent) return to.notice('I heard nothing — check the mic (is it on Bluetooth?)')
    const text = await Promise.race([
      transcribeOnDesktop(audio, to.paneId, to.request),
      new Promise<never>((_, reject) =>
        window.setTimeout(() => reject(new Error('The desktop took too long to answer.')), TRANSCRIBE_TIMEOUT_MS)
      )
    ])
    if (mine !== run) return
    if (!text) return to.notice('The desktop heard nothing in that.')
    if (field && field.isConnected && !field.disabled) insertAtCaret(field, text)
    else if (!dictateIntoComposer(text)) to.notice(`Heard: “${text}” — but there is no box here to put it in.`)
  } catch (err) {
    if (mine === run) to.notice(err instanceof Error ? err.message : 'Dictation failed.')
  } finally {
    if (mine === run) setPhase('idle')
  }
}

/** Throw the recording (or the wait for its words) away. Nothing is typed. */
export function cancelRawDictation(): void {
  run++
  recording?.cancel()
  recording = null
  monitor?.close()
  monitor = null
  stopWhenOpen = false
  setPhase('idle')
}

/**
 * Press D: start, or stop and type. A press while the words are on their way
 * does nothing — a second tap of Right Ctrl must not throw a sentence away.
 */
export function toggleRawDictation(to: RawTarget | null): void {
  if (phase === 'recording' || phase === 'starting') {
    void stop()
    return
  }
  if (phase === 'transcribing' || !to) return
  void start(to)
}
