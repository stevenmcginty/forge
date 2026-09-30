import { remoteControlName } from '@shared/remote'
import type { Project, Workspace } from '@shared/types'
import { paneNameInTab } from '@shared/workspace'
import { collectLeaves } from '@/lib/splitTree'
import { registerWorker } from './push'

/**
 * The tab's own OS notifications, and the tidying of every Forge notification
 * this browser is showing — the pushed ones from `public/sw.js` included.
 *
 * ## Why through the worker
 *
 * `new Notification(...)` is the obvious call and the wrong one on the phone
 * this page is mostly used on: Android Chrome throws `TypeError: Illegal
 * constructor` from it, full stop, and only lets a page notify through
 * `ServiceWorkerRegistration.showNotification`. The old path caught that throw
 * and so never showed anything there. So the registration is used whenever
 * there is one, and the constructor is only the fallback for a browser that has
 * no worker to hand (an insecure LAN origin, where `registerWorker` answers
 * null) — which is also why a click still lands in the worker's
 * `notificationclick` and goes straight to the pane.
 *
 * ## One wording, two copies
 *
 * `public/sw.js` words a pushed notification the same way `noteWords` does
 * here, and builds the same `data` and the same de-dupe. It cannot import this
 * file (it is plain JS served as-is), so a change to either is a change to both.
 *
 * Nothing here throws. No permission, no worker, a browser that refuses: each
 * is a quiet no-op, because the pill and the pane's own badge are the truthful
 * record either way.
 */

/** A second, identical notification inside this window replaces the first silently. */
const QUIET_REPEAT_MS = 60_000

/** 'asking' — a question is waiting; 'done' — the pane went quiet with no question. */
export type NoteState = 'asking' | 'done'

export interface LocalNote {
  sessionId: string
  /** "project — pane", from `paneLabel`. */
  label: string
  state: NoteState
  /** The question line, when asking. */
  prompt?: string
  /** When it happened, ms epoch. Defaults to now. */
  at?: number
}

/** What every Forge notification carries in `data` — sw.js writes the same shape. */
interface NoteData {
  sessionId?: string
  key?: string
  at?: number
}

/**
 * `NotificationOptions` as the browsers take it. `renotify` and `timestamp`
 * are real (Chrome honours both) but have dropped out of TypeScript's DOM lib.
 */
type ShowOptions = NotificationOptions & { renotify?: boolean; timestamp?: number }

/** Title and body. Mirrored in public/sw.js — keep the two the same. */
export function noteWords(label: string, state: NoteState, prompt = ''): { title: string; body: string } {
  const name = label.trim() || 'A pane'
  if (state === 'done') return { title: `${name} finished`, body: 'Ready for your next message.' }
  const line = prompt.trim()
  return { title: `${name} needs you`, body: line || 'Waiting for your answer.' }
}

/**
 * The name a pane goes by in a notification or the banner: "project — pane",
 * the same rule the desktop uses for its pushes (`remoteControlName`), read off
 * the picture this page already holds. 'Forge' for a pane in no workspace.
 */
export function paneLabel(projects: Project[], workspaces: Record<string, Workspace>, paneId: string): string {
  for (const project of projects) {
    const tab = workspaces[project.id]?.tabs.find((t) => collectLeaves(t.root).some((leaf) => leaf.id === paneId))
    if (tab) return remoteControlName(project.name, paneNameInTab(tab, paneId))
  }
  return 'Forge'
}

function granted(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted'
}

function dataOf(note: Notification): NoteData {
  const data: unknown = note.data
  return data && typeof data === 'object' ? (data as NoteData) : {}
}

/**
 * Show a pane's notification. Resolves true when one was shown.
 *
 * Tagged by session, so a pane replaces its own notification rather than
 * stacking. The same question again inside QUIET_REPEAT_MS (the desktop's push
 * and this tab both saying it, or a prompt re-sent) replaces it with
 * `renotify: false` — on screen, but no second buzz.
 */
export async function showLocal(note: LocalNote): Promise<boolean> {
  if (!granted()) return false
  const { title, body } = noteWords(note.label, note.state, note.prompt)
  const tag = note.sessionId || 'forge'
  const key = `${note.state}|${(note.prompt ?? '').trim()}`
  let at = note.at || Date.now()

  const registration = await registerWorker()
  if (!registration) {
    try {
      const shown = new Notification(title, { body, tag, icon: '/icons/icon-192.png' })
      shown.onclick = () => {
        window.focus()
        shown.close()
      }
      return true
    } catch {
      return false
    }
  }

  try {
    let renotify = true
    const open = await registration.getNotifications({ tag }).catch(() => [] as Notification[])
    const same = open.find((n) => {
      const data = dataOf(n)
      return data.key === key && typeof data.at === 'number' && Date.now() - data.at < QUIET_REPEAT_MS
    })
    if (same) {
      renotify = false
      // Keep the first one's time, so the quiet window does not slide forever.
      at = dataOf(same).at ?? at
    }
    const options: ShowOptions = {
      body,
      tag,
      renotify,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      timestamp: at,
      data: { sessionId: note.sessionId, key, at } satisfies NoteData
    }
    await registration.showNotification(title, options)
    return true
  } catch {
    return false
  }
}

/** Every Forge notification this origin's worker is showing. Empty without one. */
async function openNotes(): Promise<Notification[]> {
  if (typeof Notification === 'undefined') return []
  const registration = await registerWorker()
  if (!registration) return []
  try {
    return await registration.getNotifications()
  } catch {
    return []
  }
}

/**
 * A pane stopped asking: put its question away. Only a question — a "finished"
 * note on the same tag is news the pane just made, not a stale one.
 */
export async function closeFor(sessionId: string): Promise<void> {
  if (!sessionId) return
  for (const note of await openNotes()) {
    const data = dataOf(note)
    if (note.tag !== sessionId && data.sessionId !== sessionId) continue
    if (data.key?.startsWith('done|')) continue
    note.close()
  }
}

/**
 * Put away what is no longer true: every notification whose pane is not
 * asking now. With `finished`, every "finished" one too — the person is
 * looking at the page, so it has been seen.
 */
export async function closeStale(asking: ReadonlySet<string>, finished: boolean): Promise<void> {
  for (const note of await openNotes()) {
    const data = dataOf(note)
    const done = data.key?.startsWith('done|') ?? false
    if (done) {
      if (finished) note.close()
      continue
    }
    if (!data.sessionId || !asking.has(data.sessionId)) note.close()
  }
}
