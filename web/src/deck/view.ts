import { useCallback, useState } from 'react'

/**
 * Tabs or the Wall — the deck's Ctrl+G, as this browser's own choice.
 *
 * Local on purpose: the wire has no verb for the desktop's view mode (see
 * `WEB_LAYOUT_OPS`), and what one window shows is not something another screen
 * should be changed by. Remembered per browser, like the theme.
 */
export type DeckView = 'tabs' | 'wall'

const KEY = 'forge-web-view'

function stored(): DeckView {
  try {
    return window.localStorage.getItem(KEY) === 'wall' ? 'wall' : 'tabs'
  } catch {
    return 'tabs'
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
