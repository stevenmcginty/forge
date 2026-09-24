import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { uiCommands } from './uiCommands'

/**
 * The shell's plug points — everything another feature mounts *into* the
 * desktop shell without editing it.
 *
 *   registerSurface   a canvas surface (the built-in browser, the image board,
 *                     the voice hub's Talk view). It becomes a mode in the top
 *                     bar's switcher, a `set-mode <id>` command, and a region of
 *                     the stage — beside the agents or in place of them.
 *   setDockVoice      what sits in the dock's voice socket. Default: the agent
 *                     switch and the dictation pill, exactly as the status bar
 *                     had them.
 *   setComposerRoute  a chance to take a composer message before it is typed
 *                     into the active pane (e.g. while the voice hub is live).
 *
 * Each one is a tiny external store, so registering from anywhere — a module's
 * top level, an effect — re-renders exactly the shell parts that read it.
 */

/* ------------------------------------------------------------ the stores */

function store<T>(initial: T): {
  get: () => T
  set: (next: T) => void
  subscribe: (cb: () => void) => () => void
} {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return
      value = next
      for (const cb of listeners) cb()
    },
    subscribe: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    }
  }
}

/* ------------------------------------------------------------- surfaces */

export interface SurfaceProps {
  /** True while this surface is the mode on screen. */
  active: boolean
}

export interface CanvasSurface {
  /** Stable id; also the `set-mode` argument. e.g. 'browser', 'board', 'talk'. */
  id: string
  /** One word for the mode switcher. */
  title: string
  /** A 16×16 glyph for the switcher, stroked in currentColor. */
  glyph?: ReactNode
  /**
   * `beside` shares the stage with the agent panes (surface left, agents in a
   * column on the right) — the browser's layout. `full` takes the whole stage.
   */
  placement: 'beside' | 'full'
  /** Sort order in the switcher, after Agents / Tasks / Devices. Lower first. */
  order?: number
  /** Suggested keymap binding for its `set-mode` command. */
  defaultKey?: string
  render: ComponentType<SurfaceProps>
}

const surfaces = store<CanvasSurface[]>([])

/**
 * Add a surface to the canvas. Returns the unregister function. Registering an
 * id that already exists replaces it (hot reload, a remount).
 */
export function registerSurface(surface: CanvasSurface): () => void {
  surfaces.set([...surfaces.get().filter((s) => s.id !== surface.id), surface])
  const undefine = uiCommands.define({
    id: `mode-${surface.id}`,
    title: surface.title,
    group: 'Modes',
    ...(surface.defaultKey ? { defaultKey: surface.defaultKey } : {})
  })
  const unhandle = uiCommands.handle(`mode-${surface.id}`, () => uiCommands.run('set-mode', surface.id))
  return () => {
    unhandle()
    undefine()
    surfaces.set(surfaces.get().filter((s) => s !== surface))
    if (shellMode.get() === surface.id) shellMode.set(null)
  }
}

export function useSurfaces(): CanvasSurface[] {
  return useSyncExternalStore(surfaces.subscribe, surfaces.get)
}

/**
 * The registered surface on screen, or null for the built-in modes (which live
 * in app state: agents, tasks, devices). Written only by the shell's
 * `set-mode` handler.
 */
export const shellMode = store<string | null>(null)

export function useShellMode(): string | null {
  return useSyncExternalStore(shellMode.subscribe, shellMode.get)
}

/* ------------------------------------------------------------ dock voice */

const dockVoice = store<ComponentType | null>(null)

/** Replace what sits in the dock's voice socket; null puts the default back. */
export function setDockVoice(component: ComponentType | null): void {
  dockVoice.set(component)
}

export function useDockVoice(): ComponentType | null {
  return useSyncExternalStore(dockVoice.subscribe, dockVoice.get)
}

/* -------------------------------------------------------- composer route */

export interface ComposerMessage {
  text: string
  /** The pane the composer would type into, if any. */
  paneId: string | null
}

/**
 * Return true to say "handled — do not type this into the pane". The newest
 * route is asked first; null clears it.
 */
export type ComposerRoute = (message: ComposerMessage) => boolean

const composerRoute = store<ComposerRoute | null>(null)

export function setComposerRoute(route: ComposerRoute | null): void {
  composerRoute.set(route)
}

export function composerRouteNow(): ComposerRoute | null {
  return composerRoute.get()
}

/* ----------------------------------------------------------------- sheets */

/**
 * Which of the shell's sheets is open. One at a time: opening one closes the
 * other, the way a menu bar works.
 */
export type ShellSheet = 'projects' | 'panes' | 'shelf' | 'tools' | null

export const shellSheet = store<ShellSheet>(null)

export function useShellSheet(): ShellSheet {
  return useSyncExternalStore(shellSheet.subscribe, shellSheet.get)
}

/* ------------------------------------------------------------ chrome hosts */

/**
 * Where the agents' own chrome is drawn. There is no tab strip any more (the
 * wall strip on the stage replaced it), so the one host left is for
 * TerminalGrid's reference tools — Skills, Commands, tab colours, text size,
 * reset — which it portals into the title bar's "…" menu (`toolsHost`). The
 * host is an element the shell registers with a ref.
 */
export const toolsHost = store<HTMLElement | null>(null)

export function useHost(host: typeof toolsHost): HTMLElement | null {
  return useSyncExternalStore(host.subscribe, host.get)
}
