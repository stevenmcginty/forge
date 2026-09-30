import { useCallback, useState } from 'react'
import type { ThemeCore } from '@shared/types'
import { BUILTIN_THEMES, applyTheme, findTheme, resolveTheme } from '@/theme/themes'
import { rethemeTerminals } from '../lib/term'
import { defaultThemeId, isKnownTheme, storedThemeId } from '../lib/phone-themes'
import { isPhoneFace, phoneFaceFromWindow } from '../lib/viewport'

/**
 * The theme this browser wears. Read straight from src/theme/themes.ts — the
 * same cores (the six, then WhatsApp dark and WhatsApp light) and the same
 * resolver the desktop uses — so a theme added or retuned on the deck is here
 * on the next build without anyone copying a colour. lib/phone-themes.ts adds
 * only the browser's side: which ids it may wear, and the move off the old
 * one-row WhatsApp id.
 *
 * Remembered per browser (localStorage), never sent to the desktop: this is
 * how *this* window looks, not a setting of that machine.
 *
 * Painted before React's first render (`paintStoredTheme`, from main.tsx), so
 * the sign-in, PIN and Connecting screens wear it too, and kept on the root by
 * `useDeckTheme` from then on. The Android status bar follows through
 * `<meta name="theme-color">`.
 */

const KEY = 'forge-web-theme'

/** The phone's Theme list: the six, then WhatsApp dark, then WhatsApp light. */
export const PHONE_THEMES: ThemeCore[] = BUILTIN_THEMES

/** The deck's picker: the same list — the two WhatsApp themes last. */
export const DECK_THEMES: ThemeCore[] = PHONE_THEMES

/** A theme's core for a label or a swatch. Null for an id nobody knows. */
export function phoneThemeCore(id: string): ThemeCore | null {
  return BUILTIN_THEMES.find((t) => t.id === id) ?? null
}

/** Is this page wearing the phone face? Read the same way Workspace reads it. */
function onPhone(): boolean {
  try {
    return isPhoneFace(phoneFaceFromWindow(false))
  } catch {
    return false
  }
}

function stored(): string {
  const fallback = defaultThemeId(onPhone())
  try {
    const raw = window.localStorage.getItem(KEY)
    const id = storedThemeId(raw, undefined, fallback)
    // The old one-row WhatsApp is kept under the half it became, so the
    // phone's setting is read once, here, and never again.
    if (raw && id !== raw && id !== fallback) {
      try {
        window.localStorage.setItem(KEY, id)
      } catch {
        /* this page still wears it; the next one migrates again */
      }
    }
    return id
  } catch {
    /* storage refused (private window): the default is still a theme */
  }
  return fallback
}

/** What this module last wrote onto the root, so it can be changed or taken off again. */
let applied: { key: string; tokens: string[] } | null = null

/** The page's own chrome colours, as index.html writes them before any theme. */
const PAGE_THEME_COLOR = '#0b0c0e'

function setMeta(name: string, content: string): void {
  const meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
  if (meta && meta.content !== content) meta.content = content
}

function put(id: string): void {
  const core = findTheme(id, [])
  const key = `${core.id}:${core.appearance}`
  if (applied?.key === key) return
  // The themes.ts path, so the root reads exactly as the desktop's would. It
  // also takes off a token the last theme wrote that this one does not
  // (WhatsApp's bubble colours), so the next theme falls back to its own.
  const tokens = applyTheme(core)
  const names = Object.keys(tokens)
  setMeta('theme-color', tokens['bg-base'] ?? core.bg)
  setMeta('color-scheme', core.appearance)
  const had = applied !== null
  applied = { key, tokens: names }
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
  setMeta('theme-color', PAGE_THEME_COLOR)
  setMeta('color-scheme', 'dark')
  applied = null
  rethemeTerminals()
}

/**
 * The stored theme, on the root before React renders anything: main.tsx calls
 * this first, so no screen is ever drawn in Volt and then flipped.
 */
export function paintStoredTheme(): void {
  try {
    put(stored())
  } catch {
    /* a theme is decoration: the page still comes up in tokens.css's Volt */
  }
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
    if (!isKnownTheme(id)) return
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
