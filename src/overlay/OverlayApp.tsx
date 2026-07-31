import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { VoiceHubMode, VoiceReplyMode } from '@shared/types'
import type { OverlayCall, OverlaySnapshot } from '@/lib/overlaystate'
import { Icon } from '@/components/Icon'
import type { BrainStatus } from '@/lib/voicebrain'
import {
  BrainChip,
  LastLine,
  ReplyModeToggle,
  VoiceComposer,
  VoiceDial,
  VoiceLog,
  VoiceOnlyNote
} from '@/components/VoiceSurface'
import { VoiceAgentContext, type PaneOption, type VoiceAgentCtx } from '@/state/VoiceAgent'
import './OverlayApp.css'

/**
 * The overlay window's whole renderer.
 *
 * This is the undocked voice hub as an actual Windows window: always on top,
 * over Chrome, still there when Forge is minimised. It is a *view* — there is
 * one voice agent and it lives in the main window (src/state/VoiceAgent.tsx).
 *
 * The trick that makes this cheap is the last import above. Every part of the
 * hub already takes its data from `useVoiceAgent()` and nothing else, so rather
 * than reimplementing the dial, the log and the composer for a second window,
 * this builds a `VoiceAgentCtx` out of the mirrored snapshot and provides it.
 * `<VoiceDial/>` cannot tell the difference, and there is no second copy of any
 * of it to drift.
 *
 * The rule this file lives under, and the reason it is worth stating: NOTHING
 * HERE SUBSCRIBES TO ANYTHING REAL. No transcript bus, no `stt.on*`, no
 * `speakOnce`. Every value arrives over the relay and every action leaves over
 * it. An overlay that grew a microphone of its own would be a second agent, and
 * two agents means the same sentence answered twice in two voices a beat apart.
 */

/* --------------------------------------------------------------- the theme */

/** Replay onto this document exactly what `applyTheme` did to the host's. */
function paintTheme(theme: OverlaySnapshot['theme']): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(`--${name}`, value)
  }
  if (theme.themeId) root.dataset['theme'] = theme.themeId
  root.dataset['appearance'] = theme.appearance
  if (theme.reducedMotion) root.dataset['reducedMotion'] = 'true'
  else delete root.dataset['reducedMotion']
}

/* ---------------------------------------------------------------- the wire */

function send(call: OverlayCall): void {
  window.forge.overlay.call(call)
}

/**
 * The mirrored snapshot, as the context the hub's parts already speak.
 *
 * Two members of `VoiceAgentCtx` cannot cross a process boundary, and each is
 * handled rather than faked:
 *
 *   • `levelRef` is a real ref here too, fed by the level channel. The dial's
 *     rAF loop reads it exactly as it does in the main window, so the ring is
 *     driven by the actual microphone without a single re-render.
 *   • `paneOptions()` returns [] — the pane list is live terminal state and
 *     pushing it on every keystroke would be most of the payload. The overlay's
 *     "Send to pane" picker therefore shows the empty note, which is honest:
 *     the panes are in the window this is floating over, and that is where the
 *     draft should be sent from.
 */
function useMirroredAgent(snap: OverlaySnapshot | null, levelRef: React.RefObject<number>): VoiceAgentCtx {
  return useMemo<VoiceAgentCtx>(
    () => ({
      phase: snap?.phase ?? 'off',
      armed: snap?.armed ?? false,
      toggleAgent: () => send({ kind: 'toggleAgent' }),
      levelRef,
      thinkingFor: snap?.thinkingFor ?? 0,
      sttError: snap?.sttError ?? null,
      holding: snap?.holding ?? 0,
      cancelAllHolds: () => {
        send({ kind: 'cancelHolds' })
        // The real count is whatever the host says next; this is only the
        // return value, and no caller in the surface reads it.
        return snap?.holding ?? 0
      },

      turns: snap?.turns ?? [],
      editDraft: (turnId: string, draft: string) => send({ kind: 'editDraft', turnId, draft }),
      paneOptions: (): PaneOption[] => [],
      sendToPane: () => {
        /* see the note above — there are no panes on this side */
      },

      draftPhrase: snap?.draftPhrase ?? '',
      setDraftPhrase: (text: string) => send({ kind: 'setDraftPhrase', text }),
      submitPhrase: () => send({ kind: 'submitPhrase' }),

      brainName: snap?.brainName ?? '',
      brainStatus: snap?.brainStatus ?? { ok: false, detail: 'connecting…' },
      replyMode: snap?.replyMode ?? 'both',
      setReplyMode: (mode: VoiceReplyMode) => send({ kind: 'setReplyMode', mode }),
      canSpeak: snap?.canSpeak ?? false
    }),
    [snap, levelRef]
  )
}

/* ----------------------------------------------------------------- the app */

export function OverlayApp(): ReactNode {
  const [snap, setSnap] = useState<OverlaySnapshot | null>(null)
  const levelRef = useRef(0)
  /** The last seq applied, so a snapshot that overtook another is dropped. */
  const seen = useRef(0)

  useEffect(() => {
    const offState = window.forge.overlay.onState((raw: unknown) => {
      const next = raw as OverlaySnapshot | null
      if (!next || typeof next.seq !== 'number') return
      if (next.seq < seen.current) return
      seen.current = next.seq
      paintTheme(next.theme)
      setSnap(next)
    })
    const offLevel = window.forge.overlay.onLevel((raw: unknown) => {
      levelRef.current = typeof raw === 'number' ? raw : 0
    })
    // Ask for the state we were not here to receive. Without this the overlay
    // is blank until the next thing happens, which — for a hub opened to check
    // on a long-running turn — could be a minute of nothing.
    send({ kind: 'hello' })
    return () => {
      offState()
      offLevel()
    }
  }, [])

  const ctx = useMirroredAgent(snap, levelRef)
  const mode: VoiceHubMode = snap?.mode ?? 'floating'
  const voiceOnly = ctx.replyMode === 'voice'

  const setMode = useCallback((next: VoiceHubMode) => send({ kind: 'setMode', mode: next }), [])

  // Esc collapses the card, then sends the pill home — the same ladder the
  // in-window hub has. It never closes the window outright from expanded,
  // because a card you dismissed by accident is one you have to go and find
  // the status bar to get back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      setMode(mode === 'expanded' ? 'floating' : 'docked')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, setMode])

  return (
    <VoiceAgentContext.Provider value={ctx}>
      <div className="ovl" data-mode={mode} data-phase={ctx.phase}>
        {mode === 'expanded' ? (
          <OverlayCard voiceOnly={voiceOnly} status={ctx.brainStatus} setMode={setMode} />
        ) : (
          <OverlayPill setMode={setMode} />
        )}
      </div>
    </VoiceAgentContext.Provider>
  )
}

/* ---------------------------------------------------------------- the pill */

/**
 * The small shape: a round button, a line of status, and two chevrons.
 *
 * Its body is a drag region (`-webkit-app-region: drag` in the stylesheet), so
 * Windows moves the window itself — there is no pointermove handler in this
 * file at all, which is the one real simplification of being a window rather
 * than a div. Everything you can click is marked `no-drag` or it would be
 * swallowed by the drag region and never fire.
 */
function OverlayPill({ setMode }: { setMode: (m: VoiceHubMode) => void }): ReactNode {
  return (
    <div className="ovl__pill">
      <div className="ovl__grip" aria-hidden="true" />
      <div className="ovl__dial">
        <VoiceDial compact />
      </div>
      <div className="ovl__pillbody">
        <LastLine />
      </div>
      <div className="ovl__pillbtns">
        <button
          type="button"
          className="ovl__icon"
          title="Open the conversation"
          aria-label="Open the conversation"
          onClick={() => setMode('expanded')}
        >
          <Icon name="expand" size={12} />
        </button>
        <button
          type="button"
          className="ovl__icon"
          title="Send it back to the status bar"
          aria-label="Send it back to the status bar"
          onClick={() => setMode('docked')}
        >
          <Icon name="close" size={13} />
        </button>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- the card */

function OverlayCard({
  voiceOnly,
  status,
  setMode
}: {
  voiceOnly: boolean
  status: BrainStatus
  setMode: (m: VoiceHubMode) => void
}): ReactNode {
  return (
    <div className="ovl__card">
      <header className="ovl__head" onDoubleClick={() => setMode('floating')}>
        <span className="ovl__title">Voice</span>
        <BrainChip />
        <span className="ovl__spacer" />
        <div className="ovl__headbtns">
          <ReplyModeToggle />
          <button
            type="button"
            className="ovl__icon"
            title="Shrink to the pill"
            aria-label="Shrink to the pill"
            onClick={() => setMode('floating')}
          >
            <Icon name="chevronDown" size={13} />
          </button>
          <button
            type="button"
            className="ovl__icon"
            title="Send it back to the status bar"
            aria-label="Send it back to the status bar"
            onClick={() => setMode('docked')}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </header>

      <div className="ovl__dialrow">
        <VoiceDial />
      </div>

      <OverlayDegraded status={status} />

      {voiceOnly ? (
        <VoiceOnlyNote />
      ) : (
        <>
          <VoiceLog />
          <VoiceComposer />
        </>
      )}
    </div>
  )
}

/**
 * The card's own "no model key" line.
 *
 * `DegradedLink` in VoiceSurface.tsx cannot be reused here: it calls
 * `useApp()`, and mounting AppStateProvider in this window would put a second
 * writer on settings.json. Two processes racing to write one file is how a
 * project list goes missing, so the overlay reads no store at all — it asks the
 * host to open Settings, and to show itself while it is at it.
 */
function OverlayDegraded({ status }: { status: BrainStatus }): ReactNode {
  if (status.ok) return null
  return (
    <button
      type="button"
      className="voice__degraded"
      onClick={() => send({ kind: 'openSettings', section: 'models' })}
      title="Open Models & APIs in Forge"
    >
      <span className="voice__degraded-text">{status.detail ?? 'No model key — spoken commands still work'}</span>
      <span className="voice__degraded-go">Set it up →</span>
    </button>
  )
}
