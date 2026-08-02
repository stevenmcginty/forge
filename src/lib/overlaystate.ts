import type { VoiceHubMode, VoiceReplyMode } from '@shared/types'
import type { OverlayBounds } from '@shared/api'
import type { BrainStatus } from './voicebrain'
import type { AgentPhase, Turn } from '@/state/VoiceAgent'

/**
 * The wire between the two windows.
 *
 * The overlay (src/overlay/OverlayApp.tsx) is a *view* of the one voice agent
 * living in the main window. It renders the same VoiceSurface parts, so what
 * has to cross the process boundary is precisely `VoiceAgentCtx` split in two:
 * the values become a snapshot pushed one way, and the callbacks become named
 * messages sent the other.
 *
 * Both windows run the same renderer bundle, which is why these types can be
 * exact rather than `unknown`. The main process in between is a wire — it
 * forwards the payload and never looks inside it (see electron/overlay-window.ts).
 *
 * Everything here must survive the structured clone algorithm. That rules out
 * the two members of VoiceAgentCtx that are not data:
 *
 *   • `levelRef` — a React ref. It rides its own channel as a bare number,
 *     because the level moves ten times a second and putting it in the
 *     snapshot would re-render a conversation at 10Hz to animate one ring.
 *   • `paneOptions()` — a function returning live terminal state. The overlay
 *     asks for it on demand instead; a list of panes pushed on every keystroke
 *     would be most of the payload and stale by the time it was read.
 */

/** Everything the overlay draws, as plain data. Pushed on change. */
export interface OverlaySnapshot {
  /** Bumped on every push, so a late-arriving stale snapshot can be dropped. */
  seq: number
  /** Which shape to draw. `docked` never reaches here — the window is closed. */
  mode: VoiceHubMode

  /* --------------------------------------------------------------- the dial */
  phase: AgentPhase
  armed: boolean
  thinkingFor: number
  sttError: string | null
  holding: number

  /* ---------------------------------------------------------------- the log */
  turns: Turn[]

  /* ----------------------------------------------------------- the composer */
  draftPhrase: string

  /* -------------------------------------------------------------- the state */
  brainName: string
  brainStatus: BrainStatus
  /** `voiceClaudeModel` — the alias the Claude session runs. See VoiceAgentCtx. */
  brainModel: string
  replyMode: VoiceReplyMode
  canSpeak: boolean
  /** Monitoring for "hey Jarvis" rather than dictating. See VoiceAgentCtx. */
  wakeMode: boolean
  /** Audio is on its way to the speech engine right now. */
  capturing: boolean
  /** Buffer mode is on: every word is held until "stop dictation". */
  dictating: boolean
  /** Everything held since dictation began, as one live string. */
  dictationBuffer: string

  /**
   * The theme, as the resolved token map `applyTheme` already produces.
   *
   * The overlay cannot read the store to work this out for itself: a second
   * AppStateProvider would be a second writer to settings.json, and two
   * processes racing to write one file is how a project list goes missing. It
   * cannot re-derive it either — a theme Steve made in the editor ten seconds
   * ago exists only in the host's memory until it is saved.
   *
   * So the host sends what it painted, and the overlay replays it with the same
   * `setProperty` loop. Sending the whole map rather than a hand-picked five is
   * what stops the overlay drifting out of the theme system the next time a
   * token is added: there is no list here to forget to update.
   */
  theme: OverlayThemePaint
}

/** Exactly what `applyTheme` does to the root element, as data. */
export interface OverlayThemePaint {
  /** Token name (without the leading `--`) to CSS value. */
  tokens: Record<string, string>
  themeId: string
  appearance: string
  reducedMotion: boolean
}

/**
 * A callback, as a message.
 *
 * One discriminated union rather than a channel each: adding a button to the
 * overlay should be a case here and a case in the host's handler, not two more
 * IPC names to keep in sync across four files.
 */
export type OverlayCall =
  | { kind: 'toggleAgent' }
  | { kind: 'cancelHolds' }
  | { kind: 'setDraftPhrase'; text: string }
  | { kind: 'submitPhrase' }
  | { kind: 'setReplyMode'; mode: VoiceReplyMode }
  | { kind: 'setBrainModel'; model: string }
  | { kind: 'editDraft'; turnId: string; draft: string }
  | { kind: 'setMode'; mode: VoiceHubMode }
  | { kind: 'openSettings'; section: string }
  /** The overlay just mounted and wants the current state, not the next change. */
  | { kind: 'hello' }

/* ------------------------------------------------------------------ bounds */

/**
 * The floating orb form, in screen pixels.
 *
 * Bigger than HUB_PILL_SIZE on purpose: the in-window pill sits over Forge's
 * own chrome, but this is Jarvis on the desktop — a 64px sphere with a readout
 * plate beside it, drawn by OverlayApp against a transparent window. The
 * height is the orb plus its breathing room; the width is two clamped lines of
 * "what was said".
 */
export const OVERLAY_PILL = { width: 300, height: 88 }
/** The expanded card. Matches HUB_CARD_SIZE. */
export const OVERLAY_CARD = { width: 420, height: 560 }

/**
 * What size the overlay should be for a given mode.
 *
 * The saved w/h only mean anything for a card — a pill is a pill, exactly as
 * `hubSize` in src/lib/voicehub.ts has it. Zero means "never resized", which is
 * why the default can be changed later without every existing install being
 * pinned to the old one.
 */
export function overlayBounds(
  mode: VoiceHubMode,
  saved: { x: number; y: number; w: number; h: number }
): OverlayBounds {
  const resizable = mode === 'expanded'
  const size = resizable
    ? { width: saved.w || OVERLAY_CARD.width, height: saved.h || OVERLAY_CARD.height }
    : OVERLAY_PILL
  return { x: saved.x, y: saved.y, ...size, resizable }
}

/**
 * Where the overlay goes the very first time it is undocked.
 *
 * Bottom-right of the primary work area, above where the taskbar clock is, so
 * it reads as having come out of the status bar it was docked in — and clear of
 * the corner, so it is not mistaken for a notification toast.
 *
 * Screen coordinates come from the caller (the host renderer knows the window's
 * position); this is the fallback for a first run with nothing saved.
 */
export function firstOverlayPos(mode: VoiceHubMode): { x: number; y: number } {
  const size = mode === 'expanded' ? OVERLAY_CARD : OVERLAY_PILL
  const w = typeof screen !== 'undefined' ? screen.availWidth : 1920
  const h = typeof screen !== 'undefined' ? screen.availHeight : 1080
  return { x: Math.round(w - size.width - 32), y: Math.round(h - size.height - 32) }
}
