import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import type { VoiceHubMode } from '@shared/types'
import type { OverlayBounds } from '@shared/api'
import {
  firstOverlayPos,
  overlayBounds,
  type OverlayCall,
  type OverlaySnapshot,
  type OverlayThemePaint
} from '@/lib/overlaystate'
import { isFloatingHub } from '@/lib/voicehub'
import { useApp } from '@/state/AppState'
import { useVoiceAgent } from '@/state/VoiceAgent'

/**
 * The main window's half of the overlay.
 *
 * Renders nothing. It sits inside the providers, reads the one real voice agent
 * through `useVoiceAgent()`, and does three jobs:
 *
 *   1. opens and closes the overlay window as the hub is undocked and docked;
 *   2. pushes a snapshot of the agent out to it whenever anything changes;
 *   3. runs the callbacks the overlay sends back, against the real engine.
 *
 * That asymmetry is the entire design. The overlay is a second *renderer*, and
 * a second renderer that mounted VoiceAgentProvider would be a second agent:
 * two transcript subscriptions, two sidecar re-arm loops, and two voices saying
 * the same sentence a beat apart. The hub was built to make that impossible
 * within one window (see the header of src/state/VoiceAgent.tsx) and this keeps
 * the promise across two.
 *
 * So: nothing in this file interprets a phrase, and nothing in the overlay does
 * either. Both ends only ever move data.
 */

/** Level pushes per second. Enough for a smooth ring, cheap enough to ignore. */
const LEVEL_HZ = 15

/** Read back what `applyTheme` last painted onto this document. */
function currentTheme(): OverlayThemePaint {
  const root = document.documentElement
  const tokens: Record<string, string> = {}
  // The inline style *is* the applied theme — applyTheme writes every resolved
  // token onto the root element, so iterating it needs no knowledge of which
  // tokens exist and cannot go stale when one is added.
  for (let i = 0; i < root.style.length; i++) {
    const name = root.style.item(i)
    if (name.startsWith('--')) tokens[name.slice(2)] = root.style.getPropertyValue(name)
  }
  return {
    tokens,
    themeId: root.dataset['theme'] ?? '',
    appearance: root.dataset['appearance'] ?? 'dark',
    reducedMotion: root.dataset['reducedMotion'] === 'true'
  }
}

export function OverlayHost(): ReactNode {
  const { state, actions } = useApp()
  const agent = useVoiceAgent()

  const hub = state.settings.voiceHub
  const mode = hub.mode
  // Undocked *and* the overlay is switched on. With it off, the in-window hub
  // in src/components/VoiceHub.tsx draws the pill instead and no window opens.
  const wanted = isFloatingHub(mode) && state.settings.voiceOverlayWindow

  /** Bumped on every push so the overlay can drop a snapshot that overtook one. */
  const seq = useRef(0)
  /** True once the window exists, so we do not push into a closed relay. */
  const open = useRef(false)

  /* --------------------------------------------------------------- the window
   *
   * Opening is idempotent in the main process — it doubles as move/resize — so
   * this effect covers "undocked", "expanded into a card" and "dragged to the
   * other monitor and restarted" without three separate paths.
   */
  useEffect(() => {
    if (!wanted) {
      if (open.current) {
        open.current = false
        void window.forge.overlay.close()
      }
      return
    }
    // 0,0 is "undocked but never placed" — a fresh install, or a settings.json
    // carrying a mode and no position. Anywhere sensible beats the top-left
    // corner of the primary monitor.
    const placed = hub.x === 0 && hub.y === 0 ? firstOverlayPos(mode) : { x: hub.x, y: hub.y }
    const bounds = overlayBounds(mode, { ...placed, w: hub.w, h: hub.h })
    open.current = true
    void window.forge.overlay.open(bounds)
  }, [wanted, mode, hub.x, hub.y, hub.w, hub.h])

  // Docking is not the only way the window should go: quitting is too, and a
  // renderer teardown is the last moment we can say so.
  useEffect(() => {
    return () => {
      if (open.current) {
        open.current = false
        void window.forge.overlay.close()
      }
    }
  }, [])

  /* ------------------------------------------------------------- the snapshot
   *
   * Pushed on change rather than on a timer. `turns` is the big field and it
   * only moves when a turn lands, so an idle overlay costs nothing at all.
   */
  const snapshot = useCallback(
    (): OverlaySnapshot => ({
      seq: ++seq.current,
      mode,
      phase: agent.phase,
      armed: agent.armed,
      thinkingFor: agent.thinkingFor,
      sttError: agent.sttError,
      holding: agent.holding,
      turns: agent.turns,
      toolActivity: agent.toolActivity,
      draftPhrase: agent.draftPhrase,
      brainName: agent.brainName,
      brainStatus: agent.brainStatus,
      brainModel: agent.brainModel,
      replyMode: agent.replyMode,
      canSpeak: agent.canSpeak,
      wakeMode: agent.wakeMode,
      capturing: agent.capturing,
      dictating: agent.dictating,
      dictationBuffer: agent.dictationBuffer,
      theme: currentTheme()
    }),
    [
      mode,
      agent.phase,
      agent.armed,
      agent.thinkingFor,
      agent.sttError,
      agent.holding,
      agent.turns,
      agent.toolActivity,
      agent.draftPhrase,
      agent.brainName,
      agent.brainStatus,
      agent.brainModel,
      agent.replyMode,
      agent.canSpeak,
      agent.wakeMode,
      agent.capturing,
      agent.dictating,
      agent.dictationBuffer
    ]
  )

  useEffect(() => {
    if (!wanted || !open.current) return
    window.forge.overlay.pushState(snapshot())
  }, [wanted, snapshot, state.settings.themeId])

  /* ------------------------------------------------------------------ level
   *
   * On its own channel and its own clock. The level moves ten times a second;
   * folding it into the snapshot would re-render a whole conversation to
   * animate one ring, which is the mistake the in-window dial already avoids by
   * reading a ref inside a rAF loop.
   */
  useEffect(() => {
    if (!wanted) return undefined
    const tick = window.setInterval(() => {
      if (open.current) window.forge.overlay.pushLevel(agent.levelRef.current ?? 0)
    }, Math.round(1000 / LEVEL_HZ))
    return () => window.clearInterval(tick)
  }, [wanted, agent.levelRef])

  /* ------------------------------------------------------------- the callbacks
   *
   * Everything the overlay can do to the agent arrives here and is run against
   * the real one. Kept in a ref-free callback with the agent in its deps so a
   * stale closure cannot send a phrase to a brain that has since changed.
   */
  const handleCall = useCallback(
    (raw: unknown): void => {
      const call = raw as OverlayCall | null
      if (!call || typeof call.kind !== 'string') return
      switch (call.kind) {
        case 'hello':
          // The overlay just mounted. It has missed every push so far, so it
          // gets the current state rather than waiting for the next change —
          // without this, an overlay opened mid-conversation is blank until
          // somebody says something.
          window.forge.overlay.pushState(snapshot())
          return
        case 'toggleAgent':
          agent.toggleAgent()
          return
        case 'cancelHolds':
          agent.cancelAllHolds()
          return
        case 'setDraftPhrase':
          agent.setDraftPhrase(call.text)
          return
        case 'submitPhrase':
          agent.submitPhrase()
          return
        case 'setReplyMode':
          agent.setReplyMode(call.mode)
          return
        case 'setBrainModel':
          agent.setBrainModel(call.model)
          return
        case 'editDraft':
          agent.editDraft(call.turnId, call.draft)
          return
        case 'setMode':
          actions.setVoiceHub({ mode: call.mode as VoiceHubMode })
          return
        case 'openSettings':
          // The card's "set it up →" link. The settings page lives in the main
          // window, so this has to raise it — a link that silently opened a
          // page behind a minimised window would look broken.
          actions.openSettings(call.section as Parameters<typeof actions.openSettings>[0])
          window.forge.window.restoreAndFocus()
          return
        default:
          return
      }
    },
    [agent, actions, snapshot]
  )

  useEffect(() => window.forge.overlay.onCall(handleCall), [handleCall])

  /* ------------------------------------------------------------------ bounds
   *
   * The user dragged the window by its body, or pulled its edge. Windows owns
   * that gesture entirely — there is no pointermove handler anywhere for it —
   * so the only thing to do is write down where it ended up.
   */
  useEffect(() => {
    return window.forge.overlay.onBounds((b: OverlayBounds) => {
      // Only a card remembers its size; a pill is always a pill, and writing
      // 180×56 into w/h would shrink the card the next time it was expanded.
      if (mode === 'expanded') actions.setVoiceHub({ x: b.x, y: b.y, w: b.width, h: b.height })
      else actions.setVoiceHub({ x: b.x, y: b.y })
    })
  }, [mode, actions])

  return null
}
