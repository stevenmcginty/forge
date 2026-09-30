import { BUILTIN_THEMES, DEFAULT_THEME_ID, WHATSAPP_DARK_ID, WHATSAPP_LIGHT_ID } from '@/theme/themes'

/**
 * Forge Web's side of the themes. The cores themselves — the six, then
 * WhatsApp dark and WhatsApp light — live in src/theme/themes.ts, the one list
 * Forge desktop and Forge Web both wear; this file keeps only what a browser
 * needs on top: which ids it may wear, and the move off the old one-row
 * WhatsApp id that followed the phone's dark / light setting.
 */

export { WHATSAPP_DARK_ID, WHATSAPP_LIGHT_ID }

/**
 * The id the one system-following WhatsApp row was stored under. A browser that
 * still holds it is moved to the half it was wearing (`storedThemeId`).
 */
export const LEGACY_WHATSAPP_ID = 'whatsapp'

/** A theme this browser can wear: one of the built-ins. */
export function isKnownTheme(id: string): boolean {
  return BUILTIN_THEMES.some((t) => t.id === id)
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** The phone's own setting; dark when the browser cannot say. */
export function systemDark(): boolean {
  try {
    if (typeof window === 'undefined' || !window.matchMedia) return true
    const dark = window.matchMedia(DARK_QUERY)
    // `not all` means the query is unknown: no answer, so dark.
    if (dark.media === 'not all') return true
    return dark.matches || !window.matchMedia('(prefers-color-scheme: light)').matches
  } catch {
    return true
  }
}

/**
 * What a phone wears until somebody picks: WhatsApp dark (Steve, 2026-09-30).
 * The desk face keeps the desktop's own default, Volt.
 */
export const PHONE_DEFAULT_THEME_ID = WHATSAPP_DARK_ID

/** The theme a browser wears with nothing stored, by face. */
export function defaultThemeId(phone: boolean): string {
  return phone ? PHONE_DEFAULT_THEME_ID : DEFAULT_THEME_ID
}

/**
 * The theme a stored id stands for. The old system-following WhatsApp becomes
 * the half it wears right now, so nothing changes on screen; an id nobody knows
 * (or none) is `fallback` — the face's default, from `defaultThemeId`.
 */
export function storedThemeId(raw: string | null, dark = systemDark(), fallback = DEFAULT_THEME_ID): string {
  const id = raw === LEGACY_WHATSAPP_ID ? (dark ? WHATSAPP_DARK_ID : WHATSAPP_LIGHT_ID) : raw
  return id && isKnownTheme(id) ? id : fallback
}
