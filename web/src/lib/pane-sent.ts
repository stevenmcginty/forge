import { useSyncExternalStore } from 'react'
import { collectLeaves } from '@shared/splitTree'
import type { Workspace } from '@shared/types'
import type { WebRequest, WebResult } from '@shared/web'
import { paneNameInTab } from '@shared/workspace'

/**
 * "It went there", on the phone: a one-shot comet round a pane's edge the
 * moment words are sent into it. The phone's copy of the desktop's
 * src/lib/paneSent.ts (same attribute, same rule), kept here because Forge Web
 * never imports the desktop's modules.
 *
 * The comet only puts a data attribute on the pane's element and takes it off
 * when the CSS animation ends; phone-cues.css draws it on the phone,
 * deck/sent.css (the desk's two-lap comet) on the deck. No React, no loop:
 * between sends nothing runs, and PaneView's memo is never disturbed.
 *
 *   data-sent       'you' (the dictation violet) or 'agent' (the agent's lime)
 *   data-sent-beat  flips 0/1 each send, so a second send mid-lap restarts the
 *                   animation cleanly without forcing a layout
 *
 * A send that says what it sent also leaves its words here as a pending send
 * (`usePendingSends`), so the Chat view can show the bubble at once with one
 * tick, before the transcript has caught up; ChatView settles it when the
 * turn lands. The comet fires either way.
 */

export type SentBy = 'you' | 'agent'

/** A little over the longest lap (the agent's); the attribute never outlives a missed animationend. */
const SAFETY_MS = 3600
const running = new WeakMap<HTMLElement, { timer: number; onEnd: (e: AnimationEvent) => void }>()

function clear(el: HTMLElement): void {
  const run = running.get(el)
  if (run) {
    window.clearTimeout(run.timer)
    el.removeEventListener('animationend', run.onEnd)
    running.delete(el)
  }
  delete el.dataset['sent']
  delete el.dataset['sentBeat']
}

function flash(el: HTMLElement, by: SentBy): void {
  const beat = el.dataset['sentBeat'] === '0' ? '1' : '0'
  clear(el)
  el.dataset['sentBeat'] = beat
  el.dataset['sent'] = by
  // The phone's comet is the stage's ::after, its end bubbling up to the pane;
  // the deck's is the pane's own ::before.
  const onEnd = (e: AnimationEvent): void => {
    if (
      (e.pseudoElement === '::after' && e.animationName.startsWith('pcue-sent')) ||
      ((e.pseudoElement === '::before' || e.pseudoElement === '::after') && e.animationName.startsWith('dk-sent'))
    ) {
      clear(el)
    }
  }
  el.addEventListener('animationend', onEnd)
  running.set(el, { timer: window.setTimeout(() => clear(el), SAFETY_MS), onEnd })
}

function flashWhere(selector: string, by: SentBy): void {
  if (typeof document === 'undefined') return
  try {
    document.querySelectorAll<HTMLElement>(selector).forEach((el) => flash(el, by))
  } catch {
    /* a flash is decoration: never let it break a send */
  }
}

/**
 * Words were just sent into this pane: run the comet round its edge and, when
 * `text` says what went, hold it as a pending send until the transcript shows
 * it. Never throws, never blocks.
 */
export function announcePaneSent(paneId: string, text?: string, by: SentBy = 'you'): void {
  if (text && text.trim()) addPending(paneId, text)
  if (typeof CSS === 'undefined') return
  flashWhere(`.pane[data-pane-id="${CSS.escape(paneId)}"]`, by)
}

/* ------------------------------------------------------- pending sends */

export interface PendingSend {
  id: number
  text: string
  /** This phone's clock when it went. */
  at: number
}

/** A send the transcript never shows (a pane whose chat is not watched) is let go after this. */
const PENDING_TTL_MS = 180_000
/** More than this unsettled in one pane is a pane that is not reporting turns: keep the newest. */
const PENDING_MAX = 6
const NO_PENDING: readonly PendingSend[] = []
const pending = new Map<string, readonly PendingSend[]>()
const pendingListeners = new Set<() => void>()
let pendingSeq = 0

function emitPending(): void {
  for (const listener of pendingListeners) listener()
}

function addPending(paneId: string, text: string): void {
  const send: PendingSend = { id: ++pendingSeq, text, at: Date.now() }
  pending.set(paneId, [...(pending.get(paneId) ?? NO_PENDING), send].slice(-PENDING_MAX))
  emitPending()
  if (typeof window !== 'undefined') window.setTimeout(() => settlePendingSend(paneId, send.id), PENDING_TTL_MS)
}

/** The transcript has this send now (or it is too old to wait on): stop showing it as pending. */
export function settlePendingSend(paneId: string, id: number): void {
  const list = pending.get(paneId)
  if (!list?.some((send) => send.id === id)) return
  const rest = list.filter((send) => send.id !== id)
  if (rest.length) pending.set(paneId, rest)
  else pending.delete(paneId)
  emitPending()
}

function subscribePending(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => {
    pendingListeners.delete(listener)
  }
}

/** This pane's sends still waiting to show in its transcript, oldest first. */
export function usePendingSends(paneId: string | undefined): readonly PendingSend[] {
  return useSyncExternalStore(
    subscribePending,
    () => (paneId ? (pending.get(paneId) ?? NO_PENDING) : NO_PENDING),
    () => NO_PENDING
  )
}

/**
 * The voice agent's link, with its sends made visible: when the desktop
 * answers a `type_into_pane` that pressed Enter, the pane it went into gets
 * the agent's comet. The target is the pane's name, as the tool asks the model
 * to give it; a spoken handle this page cannot resolve ("the claude one") falls
 * back to the pane in focus, which the desktop moves to the pane it typed into
 * before it answers (src/lib/realtime/tools-main.ts `typeInto`). Nothing about
 * the request or its answer changes.
 */
export function withAgentSends(
  request: (body: WebRequest) => Promise<WebResult>,
  workspace: () => Workspace
): (body: WebRequest) => Promise<WebResult> {
  return async (body) => {
    const result = await request(body)
    try {
      if (
        body.kind === 'voice-tool' &&
        body.name === 'type_into_pane' &&
        body.args['submit'] === true &&
        result.kind === 'voice-tool' &&
        result.answer.ok
      ) {
        const paneId = paneByName(workspace(), String(body.args['target'] ?? ''))
        const text = typeof body.args['text'] === 'string' ? body.args['text'] : undefined
        // A frame later, so a focus the desktop pushed with its answer has landed.
        window.requestAnimationFrame(() => {
          if (paneId) announcePaneSent(paneId, text, 'agent')
          else flashWhere('.app:is([data-mobile], [data-face="deck"]) .pane[data-focused="true"]', 'agent')
        })
      }
    } catch {
      /* decoration only */
    }
    return result
  }
}

function paneByName(workspace: Workspace, target: string): string | null {
  const want = target.trim().toLowerCase()
  if (!want) return null
  for (const tab of workspace.tabs) {
    for (const leaf of collectLeaves(tab.root)) {
      if (paneNameInTab(tab, leaf.id).toLowerCase() === want) return leaf.id
    }
  }
  return null
}
