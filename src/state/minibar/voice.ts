import { useEffect, useMemo, useRef, useState } from 'react'
import type { MiniBarCall, MiniBarState } from '@shared/minibar'
import { listenState, useHubView } from '@/components/hub/hubView'
import { useKeymap } from '@/hooks/useHub'
import { miniCommandScope } from '@/hooks/useShortcuts'
import { miniBox, setMiniDictationSink } from '@/lib/miniBarDictation'
import { createRemoteKeyFeed } from '@/lib/miniBarKeys'
import { TALK_AGENT_ID } from '@/lib/shortcutCommands'
import { useApp } from '@/state/AppState'
import { useDictation } from '@/state/Dictation'
import type { MiniBarPart } from './part'

/** The big bar's review: the words wait this long, with Undo, before they send. */
const REVIEW_MS = 1500

/** Shortcuts the mini bar's window does itself (focus its box, open its project list): nothing to run here. */
const VIEW_COMMANDS = new Set(['voice.hubCard', 'rail.toggle'])

/**
 * The mini bar's voice: dictation into its box, the mic button, Listen, the
 * talk keys and the shortcuts it honours (docs/MINI-BAR.md, 4.4, 4.5, 5.5).
 *
 *   dictation  every phrase, from a talk key or the mic, goes into the box
 *              (useDictation hands it over through src/lib/miniBarDictation.ts).
 *              When the dictation ends: "Sending..." for 1.5 s with Undo, then
 *              the box's send. With Dictate's "press Enter after each phrase"
 *              on, a talk key's phrases send one by one as they land, as they
 *              do in a pane.
 *   Listen     the hub's, unchanged (hub.start / hub.stop).
 *   talk keys  raw presses from the bar and from the global hook, replayed
 *              into useDictation's second attachment (src/lib/miniBarKeys.ts).
 *   keymap     the commands of useShortcuts' mini table, with Steve's chords.
 */
export function useMiniVoice(): MiniBarPart {
  const { state, actions } = useApp()
  const hub = useHubView()
  const keymap = useKeymap()
  const dictation = useDictation()
  const ls = listenState(hub)
  const listenOn = ls.on
  const speaking = ls.look === 'speaking'
  const muted = hub.muted
  const dictateKey = state.settings.sttHotkey || 'AltRight'
  const listenKey = keymap.commands.find((c) => c.id === TALK_AGENT_ID)?.keys[0] ?? 'ShiftRight'

  const live = useRef({ state, actions, hub, keymap, dictation })
  live.current = { state, actions, hub, keymap, dictation }

  /* ---- dictation into the box ---- */

  /** When the running countdown sends, or null. */
  const [review, setReview] = useState<number | null>(null)
  const reviewTimer = useRef(0)
  /** The dictation now running has put words in the box that are not sent yet. */
  const heard = useRef(false)
  const fromMic = useRef(false)
  const autoSend = useRef(state.settings.dictateAutoSend)
  autoSend.current = state.settings.dictateAutoSend

  useEffect(() => {
    const sendNow = (): void => {
      const box = miniBox()
      if (!box) return
      const text = box.text()
      if (!text.trim()) return
      // Empty first: a send that fails gives the words back to the box.
      box.setText('')
      box.send(text)
    }
    const startReview = (): void => {
      window.clearTimeout(reviewTimer.current)
      setReview(Date.now() + REVIEW_MS)
      reviewTimer.current = window.setTimeout(() => {
        reviewTimer.current = 0
        setReview(null)
        sendNow()
      }, REVIEW_MS)
    }
    const off = setMiniDictationSink({
      start: (mic) => {
        // A new dictation joins words still counting down: they all send at its end.
        const waiting = reviewTimer.current !== 0
        window.clearTimeout(reviewTimer.current)
        reviewTimer.current = 0
        setReview(null)
        fromMic.current = mic
        heard.current = waiting
      },
      phrase: (words) => {
        const box = miniBox()
        if (!box) return
        const prev = box.text()
        box.setText(prev.trim() ? `${prev.replace(/\s+$/, '')} ${words}` : words)
        if (!fromMic.current && autoSend.current) {
          sendNow()
          return
        }
        heard.current = true
      },
      done: (ok) => {
        const said = heard.current
        heard.current = false
        if (ok && said) startReview()
      }
    })
    return () => {
      off()
      window.clearTimeout(reviewTimer.current)
      reviewTimer.current = 0
    }
  }, [])

  /* ---- the talk keys from the bar and the global hook ---- */

  const [feed] = useState(createRemoteKeyFeed)
  useEffect(() => {
    const host = window.forge.minibarHost
    const off =
      typeof host?.onRemoteKey === 'function'
        ? host.onRemoteKey((k) => {
            if (k && typeof k === 'object') feed.feed(k)
          })
        : undefined
    return () => {
      off?.()
      // Forge is back: a key still held here is let go, as the hook does when it stops.
      feed.reset()
    }
  }, [feed])

  /* ---- the view's calls ---- */

  const handle = useMemo(() => {
    const endReview = (): void => {
      window.clearTimeout(reviewTimer.current)
      reviewTimer.current = 0
      heard.current = false
      setReview(null)
    }
    const command = (id: string): void => {
      if (!miniCommandScope(id) || VIEW_COMMANDS.has(id)) return
      const { state: s, actions: a, keymap: k } = live.current
      // Ctrl+T's chooser would open in a window nobody can see: the project's default agent instead.
      if (id === 'tab.new') {
        if (s.activeProjectId) a.newTab()
        return
      }
      k.run(id)
    }
    return (c: MiniBarCall): boolean => {
      switch (c.t) {
        case 'dictate':
          live.current.dictation.dictateIntoBar()
          return true
        case 'undoSend':
          // The words stay in the box to edit.
          endReview()
          return true
        case 'listen': {
          const h = live.current.hub
          if (listenState(h).on) h.stop()
          else void h.start()
          return true
        }
        case 'command':
          if (typeof c.id === 'string') command(c.id)
          return true
        case 'talkKey':
        case 'otherKey':
          feed.feed(c)
          return true
        case 'send':
          // Sent by hand during the countdown: no second send. The host still sends this one.
          endReview()
          return false
        default:
          return false
      }
    }
  }, [feed])

  /* ---- what to publish ---- */

  const commands = keymap.commands
  const miniKeymap = useMemo<MiniBarState['keymap']>(
    () =>
      commands.flatMap((c) => {
        const scope = miniCommandScope(c.id)
        if (!scope || !c.available) return []
        return c.keys.map((chord) => ({ command: c.id, chord, scope }))
      }),
    [commands]
  )

  // The sidecar is the agent's while Listen holds it: that is not dictation.
  const mine = !state.agentListening
  const sttPhase = dictation.status.phase
  const level = dictation.status.level
  const phase: MiniBarState['dictation']['phase'] =
    review !== null ? 'sending' : mine && sttPhase === 'listening' ? 'listening' : mine && sttPhase === 'finishing' ? 'writing' : 'off'

  return useMemo(() => {
    const slice: Partial<MiniBarState> = {
      dictation:
        phase === 'sending' && review !== null
          ? { phase, sendInMs: Math.max(0, review - Date.now()) }
          : phase === 'listening'
            ? { phase, level }
            : { phase },
      listen: { on: listenOn, speaking, muted },
      keymap: miniKeymap,
      talkKeys: { dictate: dictateKey, listen: listenKey }
    }
    return { slice, handle }
  }, [phase, review, level, listenOn, speaking, muted, miniKeymap, dictateKey, listenKey, handle])
}
