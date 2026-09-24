import type { BrowserAppKeys, BrowserPageKey } from '@shared/browser'
import { getKeymapView, subscribeKeymap, type KeymapView } from '@/lib/keymapRegistry'
import { browserBridge } from './bridge'

/**
 * Forge's keys, from inside a web page.
 *
 * A page is a native view: while it has the keyboard, the renderer's keydown
 * listeners (useShortcuts, the voice keys' gesture engine) hear nothing. So
 * main is told which keys are Forge's, takes those from the page, and sends
 * them back here, where they are replayed as keyboard events on the document —
 * the very listeners that handle them everywhere else handle them now, with
 * their own scope rules. Replayed on <body>, never on the focused element, so
 * a terminal's textarea is never typed into by a replay.
 */

/**
 * Keys a page keeps even though Forge binds them: copying and pasting in the
 * page, zooming it, and the two that close a pane or tab you are not looking at.
 */
const PAGE_KEEPS = /^(clipboard\.|font\.|pane\.close$|tab\.close$)/

export function appKeysOf(view: KeymapView): BrowserAppKeys {
  const combos = new Set<string>()
  const talk = new Set<string>()
  for (const command of view.commands) {
    if (command.kind === 'talk') {
      for (const key of command.keys) talk.add(key)
      continue
    }
    if (!command.available || PAGE_KEEPS.test(command.id)) continue
    for (const key of command.keys) combos.add(key)
  }
  return { combos: [...combos], talk: [...talk] }
}

export function replayPageKey(key: BrowserPageKey, doc: Document = document): void {
  const target = doc.body ?? doc.documentElement
  target.dispatchEvent(
    new KeyboardEvent(key.type === 'keyDown' ? 'keydown' : 'keyup', {
      code: key.code,
      key: key.key,
      ctrlKey: key.ctrl,
      altKey: key.alt,
      shiftKey: key.shift,
      metaKey: key.meta,
      repeat: key.repeat,
      location: key.location,
      bubbles: true,
      cancelable: true,
      composed: true
    })
  )
}

/** Keep main's copy of the keymap current and replay what it sends. Returns the undo. */
export function startAppKeys(): () => void {
  const api = browserBridge()
  // An older preload has neither: the page keeps every key, as before.
  if (!api?.setAppKeys || !api.onAppKey) return () => undefined
  const setAppKeys = api.setAppKeys
  let last = ''
  const push = (): void => {
    const keys = appKeysOf(getKeymapView())
    const sig = JSON.stringify(keys)
    if (sig === last) return
    last = sig
    setAppKeys(keys)
  }
  push()
  const offKeymap = subscribeKeymap(push)
  const offKey = api.onAppKey((key) => replayPageKey(key))
  return () => {
    offKeymap()
    offKey()
  }
}
