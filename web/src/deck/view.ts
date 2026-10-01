import { useCallback, useState, useSyncExternalStore } from 'react'

/**
 * Focus or the Wall — the deck's Ctrl+G, as this browser's own choice.
 *
 *   focus  one agent fills the stage; the Agents menu in the top bar picks which
 *   wall   every agent in the project on one grid
 *
 * Local on purpose: the wire has no verb for the desktop's view mode (see
 * `WEB_LAYOUT_OPS`), and what one window shows is not something another screen
 * should be changed by. Remembered per browser, like the theme. A browser that
 * remembered the old 'tabs' view lands in focus, its successor.
 */
export type DeckView = 'focus' | 'wall'

const KEY = 'forge-web-view'

function stored(): DeckView {
  try {
    return window.localStorage.getItem(KEY) === 'wall' ? 'wall' : 'focus'
  } catch {
    return 'focus'
  }
}

export function useDeckView(): [DeckView, (view: DeckView) => void] {
  const [view, setView] = useState<DeckView>(stored)
  const set = useCallback((next: DeckView) => {
    try {
      window.localStorage.setItem(KEY, next)
    } catch {
      /* this page still switches */
    }
    setView(next)
  }, [])
  return [view, set]
}

/**
 * Where the voice bar lives — the project, D and the words. Per browser,
 * like the theme.
 *
 *   top     in the top bar; the words float over the foot of the stage, and
 *           only while they are wanted — the panes run to the bottom edge
 *   bottom  the dock: one bar along the bottom edge, always there
 */
export type BarPlace = 'top' | 'bottom'

const BAR_KEY = 'forge-web-bar'

function storedPlace(): BarPlace {
  try {
    return window.localStorage.getItem(BAR_KEY) === 'top' ? 'top' : 'bottom'
  } catch {
    return 'bottom'
  }
}

export function useBarPlace(): [BarPlace, (place: BarPlace) => void] {
  const [place, setPlace] = useState<BarPlace>(storedPlace)
  const set = useCallback((next: BarPlace) => {
    try {
      window.localStorage.setItem(BAR_KEY, next)
    } catch {
      /* this page still moves it */
    }
    setPlace(next)
  }, [])
  return [place, set]
}

/**
 * What the stage shows: the desktop's agents, its Browser tabs
 * (./DeckBrowser.tsx) or the project's Board (./DeckBoard.tsx). Per browser,
 * like the view. A store rather than state, because the top bar's switch and
 * the stage are drawn from different parents.
 *
 *   agents   the panes, in focus or on the Wall (DeckView above)
 *   browser  the desktop's Browser tabs, one live picture at a time
 *   board    what the agents put on the project's Board, read-only
 */
export type DeckSurface = 'agents' | 'browser' | 'board'

const SURFACE_KEY = 'forge-web-surface'

function storedSurface(): DeckSurface {
  try {
    const kept = window.localStorage.getItem(SURFACE_KEY)
    return kept === 'browser' || kept === 'board' ? kept : 'agents'
  } catch {
    return 'agents'
  }
}

let surface: DeckSurface = storedSurface()
const surfaceListeners = new Set<() => void>()

export function setDeckSurface(next: DeckSurface): void {
  if (next === surface) return
  try {
    window.localStorage.setItem(SURFACE_KEY, next)
  } catch {
    /* this page still switches */
  }
  surface = next
  for (const listener of [...surfaceListeners]) listener()
}

function subscribeSurface(listener: () => void): () => void {
  surfaceListeners.add(listener)
  return () => {
    surfaceListeners.delete(listener)
  }
}

export function useDeckSurface(): DeckSurface {
  return useSyncExternalStore(subscribeSurface, () => surface, () => surface)
}
