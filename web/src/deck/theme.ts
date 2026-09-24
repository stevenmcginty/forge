import { useCallback, useState } from 'react'
import type { ThemeCore } from '@shared/types'
import { BUILTIN_THEMES, DEFAULT_THEME_ID, applyTheme, findTheme, resolveTheme } from '@/theme/themes'
import { rethemeTerminals } from '../lib/term'

/**
 * The one setting the desktop-browser face has: which of the deck's themes it
 * wears. Read straight from src/theme/themes.ts — the same six cores and the
 * same resolver the desktop uses — so a theme added or retuned on the deck is
 * here on the next build without anyone copying a colour.
 *
 * Remembered per browser (localStorage), never sent to the desktop: this is
 * how *this* window looks, not a setting of that machine.
 *
 * Only ever applied while the deck face is up. The phone face paints from
 * tokens.css exactly as it always has, so when a window crosses into the phone
 * face (a touch laptop folded small) every inline token this wrote is taken
 * back off the root.
 */

const KEY = 'forge-web-theme'

export const DECK_THEMES: ThemeCore[] = BUILTIN_THEMES

function stored(): string {
  try {
    const id = window.localStorage.getItem(KEY)
    if (id && BUILTIN_THEMES.some((t) => t.id === id)) return id
  } catch {
    /* storage refused (private window): the default is still a theme */
  }
  return DEFAULT_THEME_ID
}

/** What this module last wrote onto the root, so it can be taken off again. */
let applied: { id: string; tokens: string[] } | null = null

function put(id: string): void {
  if (applied?.id === id) return
  const core = findTheme(id, [])
  const tokens = applyTheme(core)
  const had = applied !== null
  applied = { id: core.id, tokens: Object.keys(tokens) }
  // Terminals cache their palette off the tokens; a change after they exist
  // has to be handed to them. The first apply happens before any mounts.
  if (had) rethemeTerminals()
}

function takeOff(): void {
  if (!applied) return
  const root = document.documentElement
  for (const name of applied.tokens) root.style.removeProperty(`--${name}`)
  delete root.dataset['theme']
  delete root.dataset['appearance']
  applied = null
  rethemeTerminals()
}

/**
 * The deck theme, applied while `on`. Called from the shell's render rather
 * than an effect on purpose: children's effects run before a parent's, and a
 * terminal mounted in one of them would read its palette off the tokens
 * before this had written them.
 */
export function useDeckTheme(on: boolean): { themeId: string; setTheme: (id: string) => void } {
  const [themeId, setThemeId] = useState(stored)
  if (on) put(themeId)
  else takeOff()

  const setTheme = useCallback((id: string) => {
    if (!BUILTIN_THEMES.some((t) => t.id === id)) return
    try {
      window.localStorage.setItem(KEY, id)
    } catch {
      /* this page still changes; the next one starts from the default */
    }
    setThemeId(id)
  }, [])

  return { themeId, setTheme }
}

/** The three colours a swatch needs, resolved the way the theme itself resolves them. */
export function swatchOf(core: ThemeCore): { bg: string; panel: string; accent: string } {
  const t = resolveTheme(core)
  return { bg: t['bg-base'] ?? core.bg, panel: t['bg-panel'] ?? core.panel, accent: core.accent }
}
