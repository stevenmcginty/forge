import { isTypedInput } from '@shared/typing'

/**
 * Who owns a pane's grid — **the width follows the typist**.
 *
 * A ConPTY has one grid and Forge gives it several viewers: this desktop's
 * renderer, a phone on Forge Mobile, one or more browsers on Forge Web. They
 * cannot all have their own size, so something has to decide. This module is
 * that something, and it is the third answer Forge has given, because the first
 * two were shipped and rejected in turn.
 *
 *  1. **Last mover wins.** Every viewer fitted the PTY to its own box, so
 *     whichever moved last won — and the desktop moves on every layout change.
 *     Switching tabs at the desk dragged the width back from a browser reading
 *     that pane from another town, and switching panes in the browser dragged it
 *     the other way. Rejected: "connecting a device changes the desktop".
 *  2. **The desk owns it while it has a window.** A remote's cols/rows were
 *     dropped outright whenever a Forge window existed, and remotes drew the
 *     desk's grid at a shrunken font. That fixed the fighting and broke the
 *     point: a 32-inch browser wasted two thirds of its screen letterboxing a
 *     laptop's pane, and a phone drew a 200-column grid at 7px. Rejected: "big
 *     client screens are wasted, the phone is unusable; I want native on the
 *     device I'm actually using".
 *  3. **This one.** The grid belongs to the device that last *typed* into the
 *     pane. Its size wishes are honoured on the real PTY; every other viewer —
 *     the desktop renderer included — draws that grid font-scaled to fit its own
 *     box. Sit down at the desk and type, and the desk is native again;
 *     pick the phone up and type, and the phone is. Merely connecting, merely
 *     attaching, merely looking changes nothing anywhere.
 *
 * ## What counts as typing
 *
 * Not every `write`. A terminal answers the questions a TUI asks it — `CSI 6 n`
 * most of all — down the same channel a keystroke takes, so a browser that has a
 * busy pane open is writing steadily without anybody touching it. Ownership
 * turns on `isTypedInput` (shared/typing.ts) for exactly that reason: if it did
 * not, "glancing at a screen changes nothing" would be false the moment the
 * pane printed anything.
 *
 * ## An unowned pane takes the first wish
 *
 * `owner === null` is the state a pane is in after its owner hangs up, and it is
 * also the state every pane is in on a head-less desktop that never registered a
 * creator. The first wish that arrives is granted *and claims the pane*, which
 * is what makes "the next wish wins" settle instead of restarting the fight of
 * policy 1. It is also what keeps `scripts/web-e2e.mjs` — whose fake host has no
 * registry at all — behaving exactly as it always did: no registry is the same
 * answer as an unowned pane, which is "yes".
 *
 * Deliberately free of any Electron import, like PtySessionManager beside it, so
 * the smoke tests can drive the real policy against a real PTY with no Electron
 * in the process (see scripts/fixtures/web-smoke-entry.ts).
 */

/** The viewer id of this desktop's own renderer. Remote ids are minted per socket. */
export const DESK_VIEWER = 'desk'

export interface Grid {
  cols: number
  rows: number
}

export interface GridOwnersOptions {
  /**
   * Put a grid on the real PTY. Handed the viewer as well as the size, because
   * the desk's own wishes arrive already jiggled by the renderer and a remote's
   * do not — see `resizeForViewer` in electron/pty-host.ts.
   */
  apply: (id: string, cols: number, rows: number, viewer: string) => boolean
  /**
   * A pane changed hands. Optional, and the one thing this module says out loud:
   * the desktop renderer has to know whether it is drawing its own grid or
   * following somebody else's, and an ownership change with no resize behind it
   * (the new owner already wanted the size the pane has) would otherwise be
   * silent.
   */
  onOwner?: (id: string) => void
}

interface Pane {
  /** The viewer whose wishes are granted, or null while nobody has claimed it. */
  owner: string | null
  /** The last size each viewer said it was reading at. */
  wishes: Map<string, Grid>
}

export class GridOwners {
  private readonly panes = new Map<string, Pane>()
  private readonly apply: GridOwnersOptions['apply']
  private readonly onOwner: GridOwnersOptions['onOwner']

  constructor(options: GridOwnersOptions) {
    this.apply = options.apply
    this.onOwner = options.onOwner
  }

  /** The viewer whose wishes this pane grants, or null when it is unclaimed. */
  ownerOf(id: string): string | null {
    return this.panes.get(id)?.owner ?? null
  }

  /**
   * True when nothing remote is holding this pane's grid — which is what the
   * desktop renderer needs to know, and the two answers it merges: a pane the
   * desk owns and a pane nobody owns are both panes the desk may size freely.
   */
  deskOwns(id: string): boolean {
    const owner = this.ownerOf(id)
    return owner === null || owner === DESK_VIEWER
  }

  /** A viewer opened this pane, so it starts out theirs. */
  created(id: string, viewer: string): void {
    const pane = this.paneFor(id)
    if (pane.owner === viewer) return
    pane.owner = viewer
    this.onOwner?.(id)
  }

  /**
   * "This is the size I am reading it at." Stored always, granted only by the
   * owner — or by anybody, when there is no owner. Returns whether it landed on
   * the real PTY.
   */
  noteWish(id: string, viewer: string, cols: number, rows: number): boolean {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return false
    const pane = this.paneFor(id)
    pane.wishes.set(viewer, { cols, rows })
    if (pane.owner !== null && pane.owner !== viewer) return false
    if (pane.owner === null) {
      pane.owner = viewer
      this.onOwner?.(id)
    }
    return this.apply(id, cols, rows, viewer)
  }

  /**
   * Somebody wrote into this pane. If it was typing, and it was not already
   * theirs, the pane changes hands *now* — no hysteresis, no grace period: the
   * whole promise is that the device you start typing on becomes the native one,
   * and a delay would make that a device you type on twice.
   *
   * The new owner's stored wish is applied immediately, so the grid arrives with
   * the first keystroke rather than waiting for the client to notice and re-send
   * one. A viewer that has never said what size it reads at simply keeps the
   * grid the pane already had.
   */
  noteWrite(id: string, viewer: string, data: string): boolean {
    if (!isTypedInput(data)) return false
    const pane = this.paneFor(id)
    if (pane.owner === viewer) return false
    pane.owner = viewer
    this.onOwner?.(id)
    const wish = pane.wishes.get(viewer)
    if (wish) this.apply(id, wish.cols, wish.rows, viewer)
    return true
  }

  /**
   * A viewer asked for the pane outright — the one way to take a grid without
   * typing into it, and it exists for a phone: a 150-column grid font-fitted to
   * a 390px screen is not readable, and the person holding the phone with that
   * pane on screen is the person using it. Same consequence as a keystroke, no
   * more and no less — the next keystroke at the desk takes it straight back.
   */
  claim(id: string, viewer: string): boolean {
    const pane = this.paneFor(id)
    if (pane.owner === viewer) return false
    pane.owner = viewer
    this.onOwner?.(id)
    const wish = pane.wishes.get(viewer)
    if (wish) this.apply(id, wish.cols, wish.rows, viewer)
    return true
  }

  /**
   * A viewer stopped reading — one pane when `id` is given (a detach), all of
   * them when it is not (a hang-up, or this desktop's window being destroyed).
   *
   * Ownership goes back to null rather than to anybody in particular: there is
   * no honest way to pick which of the remaining viewers should inherit a grid,
   * and "the next wish wins" is both simpler and what somebody sitting down at
   * one of those screens will observe.
   */
  release(viewer: string, id?: string): void {
    for (const [paneId, pane] of this.panes) {
      if (id !== undefined && paneId !== id) continue
      pane.wishes.delete(viewer)
      if (pane.owner !== viewer) continue
      pane.owner = null
      this.onOwner?.(paneId)
    }
  }

  /** The pane is gone. Nothing here outlives the session it describes. */
  forget(id: string): void {
    this.panes.delete(id)
  }

  clear(): void {
    this.panes.clear()
  }

  private paneFor(id: string): Pane {
    let pane = this.panes.get(id)
    if (!pane) {
      pane = { owner: null, wishes: new Map() }
      this.panes.set(id, pane)
    }
    return pane
  }
}
