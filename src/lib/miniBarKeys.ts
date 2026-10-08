import type { RemoteKey } from '@shared/minibar'
import { isModifierHotkey } from './stt-gesture'

/**
 * The talk keys while Forge is minimised (docs/MINI-BAR.md, 5.5).
 *
 * The main window cannot hear a key it does not have focus for, so two
 * things hear them for it and send the raw presses over: the mini bar's own
 * window while it has focus, and the global hook (electron/global-keys.ts)
 * while another app has. Neither judges a gesture. The host replays what they
 * send as synthetic key events into `miniTalkKeyTarget`, and useDictation
 * attaches the same `attachTalkKey` there that it attaches to `window`: tap,
 * hold, combos and the lone-modifier rule stay in one place
 * (src/lib/stt-gesture.ts).
 *
 * Pure (no DOM, no React), so scripts/minibar-keys-check.mjs can drive both
 * halves against the window path.
 */

/** Where the host replays remote talk keys. useDictation listens here as well as on `window`. */
export const miniTalkKeyTarget: EventTarget = new EventTarget()

/** The few KeyboardEvent fields the forwarder reads. */
export interface RawKey {
  code: string
  repeat: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}

export interface TalkKeyCodes {
  dictate: string
  listen: string
}

/** What one raw event becomes on the wire: nothing, or the presses to send. */
export type Forwarded = Exclude<RemoteKey, { t: 'summon' }>

/**
 * The same test stt-gesture makes on a talk key's press: a modifier other
 * than the key's own already held is a combo (Ctrl+Right Shift).
 */
function otherModifierHeld(code: string, e: RawKey): boolean {
  const own = code.replace(/(Left|Right)$/, '')
  return (
    (own !== 'Control' && e.ctrlKey === true) ||
    (own !== 'Alt' && e.altKey === true) ||
    (own !== 'Shift' && e.shiftKey === true) ||
    (own !== 'Meta' && e.metaKey === true)
  )
}

/**
 * The mini bar window's half: raw key events in, the presses to send out.
 *
 *   talk key down / up   sent as is, once (auto-repeat dropped). A modifier
 *                        talk key pressed with another modifier held is sent
 *                        with an `otherKey` behind it, which is how the
 *                        gesture hears "combo" without the modifier flags.
 *   any other key down   while a talk key is down, an `otherKey` with no key
 *                        identity; its auto-repeats are dropped, which is
 *                        what keeps AltGr's repeating fake Left Ctrl from
 *                        ending a hold.
 *   a mouse press        the same `otherKey` while a talk key is down.
 */
export interface KeyForwarder {
  keydown(e: RawKey): Forwarded[]
  keyup(e: RawKey): Forwarded[]
  pointer(): Forwarded[]
  /** A talk key's code (one of the two configured keys)? */
  isTalkKey(code: string): boolean
}

export function createKeyForwarder(codes: () => TalkKeyCodes | null | undefined): KeyForwarder {
  const held = new Set<string>()
  const isTalkKey = (code: string): boolean => {
    const k = codes()
    return !!code && !!k && (code === k.dictate || code === k.listen)
  }
  return {
    isTalkKey,
    keydown(e) {
      if (isTalkKey(e.code)) {
        if (e.repeat || held.has(e.code)) return []
        held.add(e.code)
        const out: Forwarded[] = [{ t: 'talkKey', code: e.code, phase: 'down' }]
        if (isModifierHotkey(e.code) && otherModifierHeld(e.code, e)) out.push({ t: 'otherKey' })
        return out
      }
      if (e.repeat || held.size === 0) return []
      return [{ t: 'otherKey' }]
    },
    keyup(e) {
      if (!held.has(e.code)) return []
      held.delete(e.code)
      return [{ t: 'talkKey', code: e.code, phase: 'up' }]
    },
    pointer() {
      return held.size > 0 ? [{ t: 'otherKey' }] : []
    }
  }
}

/** A key event `attachTalkKey` can read: a real KeyboardEvent in the renderer, a plain Event in Node. */
function talkKeyEvent(type: 'keydown' | 'keyup', code: string): Event {
  if (typeof KeyboardEvent === 'function') return new KeyboardEvent(type, { code })
  return Object.assign(new Event(type), { code, repeat: false, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })
}

/**
 * The host's half: remote presses in, synthetic key events into `target`.
 *
 * A press for a key already down is dropped (a repeat). A release for a key
 * that is not down is dropped too: the global hook sends a release when it
 * stops, and the bar may send one for the same press. `otherKey` with no talk
 * key down means nothing. `reset` lets go of every key still down, as the
 * hook does when it stops.
 */
export interface RemoteKeyFeed {
  feed(k: RemoteKey): void
  reset(): void
}

export function createRemoteKeyFeed(target: EventTarget = miniTalkKeyTarget): RemoteKeyFeed {
  const held = new Set<string>()
  return {
    feed(k) {
      if (k.t === 'talkKey') {
        if (typeof k.code !== 'string' || !k.code) return
        if (k.phase === 'down') {
          if (held.has(k.code)) return
          held.add(k.code)
          target.dispatchEvent(talkKeyEvent('keydown', k.code))
        } else if (k.phase === 'up') {
          if (!held.delete(k.code)) return
          target.dispatchEvent(talkKeyEvent('keyup', k.code))
        }
        return
      }
      if (k.t === 'otherKey') {
        if (held.size > 0) target.dispatchEvent(talkKeyEvent('keydown', ''))
      }
      // 'summon': main shows and focuses the bar itself; nothing to do here.
    },
    reset() {
      for (const code of [...held]) {
        held.delete(code)
        target.dispatchEvent(talkKeyEvent('keyup', code))
      }
    }
  }
}
