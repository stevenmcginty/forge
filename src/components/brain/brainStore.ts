import { useSyncExternalStore } from 'react'
import type { BrainEngine, BrainStatus } from '@shared/brain'

/**
 * Forge Brain's status on the desktop, for everything that draws it: the top
 * bar's icon, Settings → Forge Brain, and the voice agent picker's Forge Brain
 * row.
 *
 * One module-level copy of B1's BrainStatus, fed by `startBrainFeed` (reference
 * counted; the icon holds it for the life of the window). Everything that
 * talks to main goes through `window.forge.brain?.…`: a renderer that outlives
 * its preload (dev HMR) simply sees no brain.
 */

export interface BrainSnapshot {
  /** Null until main has answered once (or when this preload has no brain). */
  status: BrainStatus | null
}

let snap: BrainSnapshot = { status: null }
const listeners = new Set<() => void>()

function onStatus(status: BrainStatus): void {
  snap = { status }
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

let started = 0
let stopFeed: (() => void) | null = null

/**
 * Start listening to main. Reference-counted: each user calls it on mount and
 * the returned stop on unmount, and only the last stop lets go.
 */
export function startBrainFeed(): () => void {
  started++
  if (started === 1) {
    const brain = window.forge.brain
    if (brain) {
      stopFeed = brain.onStatus(onStatus)
      void brain
        .status()
        .then(onStatus)
        .catch(() => undefined)
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

/** Turn it on. Null when it started (or is starting); otherwise why not, in words. */
export async function turnBrainOn(): Promise<string | null> {
  const brain = window.forge.brain
  if (!brain) return 'This window cannot reach Forge Brain — restart Forge.'
  try {
    const status = await brain.enable()
    onStatus(status)
    return status.state === 'error' ? (status.error ?? 'Forge Brain could not start.') : null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export async function turnBrainOff(): Promise<void> {
  const status = await window.forge.brain?.disable().catch(() => null)
  if (status) onStatus(status)
}

/**
 * A fresh start (main's `freshStartBrain`): the brain writes HANDOFF.md, then
 * restarts on a new conversation that reads it first. Null when it restarted;
 * otherwise why not, in words.
 */
export async function freshStartBrain(): Promise<string | null> {
  const fresh = window.forge.brain?.freshStart
  if (!fresh) return 'This window cannot reach a fresh start — restart Forge.'
  try {
    const result = await fresh()
    return result.ok ? null : result.error
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export async function pickBrainEngine(engine: BrainEngine): Promise<void> {
  const status = await window.forge.brain?.setEngine(engine).catch(() => null)
  if (status) onStatus(status)
}
