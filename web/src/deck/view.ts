import { useCallback, useState } from 'react'

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
 * Where the voice bar lives — the project, Listen, D and the words. Per browser,
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
    return window.localStorage.getItem(BAR_KEY) === 'bottom' ? 'bottom' : 'top'
  } catch {
    return 'top'
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
