import type { Settings, VoiceHubMode, VoiceHubPlacement } from '@shared/types'

/**
 * The voice hub, as arithmetic.
 *
 * Everything about *where* the hub is and *what it turns into next* lives here,
 * with no DOM and no React in it, for the same reason the mosaic's geometry
 * does: dragging a thing about is exactly the sort of behaviour that looks
 * right while your hand is on the mouse and turns out to be wrong the one time
 * the window is 700px wide. `npm run hub:check` holds this file to its rules.
 *
 * Three states, and they are now the *only* chrome the voice agent has — the
 * right-hand panel is gone:
 *
 *   docked     the status-bar pill (src/components/DictationPill.tsx)
 *   floating   a bigger pill over the app — dictation on its body, the agent
 *              on the round button beside it
 *   expanded   the hub card: the conversation, the composer, the lot
 *
 * The dock is magnetic: a floating pill released within `HUB_DOCK_RADIUS` of
 * its home corner snaps back and shrinks. Anywhere else, it stays where it was
 * dropped — clamped so it can never be dragged off the edge and lost.
 *
 * None of this touches the *pipeline*. The agent itself is headless and lives
 * in src/state/VoiceAgent.tsx, mounted at the app root: phrases from the phone
 * are answered and memory is written with the hub docked and nothing on screen
 * at all. This file only decides what you can see.
 */

export interface Size {
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

/** The rectangle the hub is allowed to live in, in viewport pixels. */
export interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

/** The floating pill. Big enough for the meter and the agent button together. */
export const HUB_PILL_SIZE: Size = { w: 180, h: 56 }

/**
 * The expanded card, out of the box.
 *
 * Wider and taller than it was when the right-hand panel still existed: with
 * the panel deleted this is where the conversation lives, so it has to be
 * comfortable to read a drafted prompt in rather than merely adequate.
 */
export const HUB_CARD_SIZE: Size = { w: 420, h: 560 }

/** What a corner-drag may do to the card. */
export const HUB_CARD_MIN: Size = { w: 340, h: 400 }
export const HUB_CARD_MAX: Size = { w: 760, h: 1000 }

/** Breathing room kept between the hub and every edge of the window. */
export const HUB_EDGE = 10

/** Release a floating pill this close to its dock and it goes home. */
export const HUB_DOCK_RADIUS = 80

/** A press is not a drag until the pointer has moved this far. */
export const HUB_DRAG_THRESHOLD = 6

/** How long the snap-home takes. Must match --hub-snap in VoiceHub.css. */
export const HUB_SNAP_MS = 200

/** A fresh install: docked, nowhere yet to float back to, default card. */
export const DEFAULT_HUB: VoiceHubPlacement = { mode: 'docked', x: 0, y: 0, w: 0, h: 0 }

/**
 * How big the hub is right now.
 *
 * A pill is a pill; a card is whatever he last dragged its corner to. Zero is
 * "never resized", which is why the default can be changed later without
 * every existing install being stuck at the old one.
 */
export function hubSize(hub: Pick<VoiceHubPlacement, 'mode' | 'w' | 'h'>): Size {
  if (hub.mode !== 'expanded') return HUB_PILL_SIZE
  return { w: hub.w || HUB_CARD_SIZE.w, h: hub.h || HUB_CARD_SIZE.h }
}

/**
 * A card size a corner-drag is allowed to produce.
 *
 * Bounded by the window as well as by the constants: a card taller than the
 * viewport has a composer you cannot reach, which is the one part of it that
 * must always be reachable.
 */
export function clampCardSize(size: Size, bounds: Bounds): Size {
  const roomW = bounds.right - bounds.left - 2 * HUB_EDGE
  const roomH = bounds.bottom - bounds.top - 2 * HUB_EDGE
  return {
    w: Math.round(Math.max(HUB_CARD_MIN.w, Math.min(Math.min(HUB_CARD_MAX.w, roomW), size.w))),
    h: Math.round(Math.max(HUB_CARD_MIN.h, Math.min(Math.min(HUB_CARD_MAX.h, roomH), size.h)))
  }
}

/**
 * What the hub does next.
 *
 *   dragOut   lifted out of the status bar
 *   expand    double-click, or the chevron
 *   minimise  the card's minimise button
 *   escape    Esc — collapses the card, never dismisses the hub entirely
 *   dock      dropped on the dock ghost, or the "send home" button
 *   toggle    one gesture that means "the other size"
 *
 * Written as a table rather than a chain of ifs so the illegal moves are
 * visible: nothing here can put the hub into a state it cannot get out of, and
 * every event is defined for every mode.
 */
export type HubEvent = 'dragOut' | 'expand' | 'minimise' | 'escape' | 'dock' | 'toggle'

const TRANSITIONS: Record<VoiceHubMode, Partial<Record<HubEvent, VoiceHubMode>>> = {
  docked: {
    dragOut: 'floating',
    expand: 'expanded',
    toggle: 'floating'
  },
  floating: {
    expand: 'expanded',
    toggle: 'expanded',
    dock: 'docked'
  },
  expanded: {
    minimise: 'floating',
    escape: 'floating',
    toggle: 'floating',
    dock: 'docked'
  }
}

export function nextHubMode(mode: VoiceHubMode, event: HubEvent): VoiceHubMode {
  return TRANSITIONS[mode][event] ?? mode
}

/** True while the hub is off its perch — i.e. something is floating over the app. */
export function isFloatingHub(mode: VoiceHubMode): boolean {
  return mode !== 'docked'
}

/**
 * Where a hub of this size is allowed to sit.
 *
 * Clamped rather than rejected: a window narrower than the card still has to
 * put it somewhere, so the floor wins over the ceiling and it ends up flush
 * with the left/top edge instead of at a negative coordinate.
 */
export function clampHubPos(pos: Point, size: Size, bounds: Bounds): Point {
  const maxX = bounds.right - HUB_EDGE - size.w
  const maxY = bounds.bottom - HUB_EDGE - size.h
  const minX = bounds.left + HUB_EDGE
  const minY = bounds.top + HUB_EDGE
  return {
    x: Math.round(Math.max(minX, Math.min(maxX, pos.x))),
    y: Math.round(Math.max(minY, Math.min(maxY, pos.y)))
  }
}

/** The bounds of a window, given its size and the chrome the hub must miss. */
export function hubBounds(viewport: Size, chrome: { top: number; bottom: number }): Bounds {
  return { left: 0, top: chrome.top, right: viewport.w, bottom: viewport.h - chrome.bottom }
}

/**
 * The dock, as a point: the centre of where the status-bar pill sits.
 *
 * The live app measures the real socket instead — this is the answer for a
 * window whose status bar has not been laid out yet, and the one the check
 * script can reason about.
 */
export function dockPoint(bounds: Bounds, statusBarH = 26): Point {
  return { x: bounds.right - 96, y: bounds.bottom + statusBarH / 2 }
}

/** The centre of a hub sitting at `pos`. */
export function hubCentre(pos: Point, size: Size): Point {
  return { x: pos.x + size.w / 2, y: pos.y + size.h / 2 }
}

/** Close enough to home that letting go should send it there. */
export function isNearDock(pos: Point, size: Size, dock: Point, radius = HUB_DOCK_RADIUS): boolean {
  const c = hubCentre(pos, size)
  return Math.hypot(c.x - dock.x, c.y - dock.y) <= radius
}

/**
 * Where a hub goes when it is floating but has never been placed — a restored
 * settings.json with a mode and no position, say.
 *
 * Above its dock, so it reads as having come out of there, but a clear dock
 * radius above it: land inside the magnet and the very first thing he does
 * with it — pick it up and let go — would fire it straight back home.
 */
export function defaultHubPos(size: Size, bounds: Bounds): Point {
  const dock = dockPoint(bounds)
  return clampHubPos({ x: dock.x - size.w / 2, y: dock.y - size.h - HUB_DOCK_RADIUS }, size, bounds)
}

/**
 * The saved placement, made safe.
 *
 * Anything off disk is suspect, and a hub restored to `x: NaN` would be an
 * invisible thing eating clicks in the top-left corner. The position is not
 * clamped here — the window it was saved on may have been a different size, so
 * the clamping is done against the *current* viewport when it mounts.
 */
export function sanitiseHubPlacement(raw: unknown): VoiceHubPlacement {
  const v = (raw ?? {}) as Partial<VoiceHubPlacement>
  const mode: VoiceHubMode =
    v.mode === 'floating' || v.mode === 'expanded' || v.mode === 'docked' ? v.mode : DEFAULT_HUB.mode
  const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0)
  // A size *is* clamped here, unlike a position: 0 means "the default card" and
  // is the only value below the minimum that means anything.
  const dim = (n: unknown, lo: number, hi: number): number => {
    const v = num(n)
    return v === 0 ? 0 : Math.max(lo, Math.min(hi, v))
  }
  return {
    mode,
    x: num(v.x),
    y: num(v.y),
    w: dim(v.w, HUB_CARD_MIN.w, HUB_CARD_MAX.w),
    h: dim(v.h, HUB_CARD_MIN.h, HUB_CARD_MAX.h)
  }
}

/**
 * Is there anywhere for the agent's words to *go*?
 *
 * The routing rule dictation follows used to be "the voice panel is open and
 * armed". There is no panel any more, so the question is simply whether the hub
 * is out: the floating pill carries the round button and the card carries the
 * conversation, and the docked pill is dictation only. Without this, an armed
 * agent with nothing on screen would send every phrase into a terminal.
 *
 * Note what this does *not* gate: the pipeline. Phrases from the phone are
 * answered and memory is written with the hub docked — see VoiceAgent.tsx.
 */
export function agentSurfaceOpen(settings: Pick<Settings, 'voiceHub'>): boolean {
  return isFloatingHub(settings.voiceHub?.mode ?? 'docked')
}
