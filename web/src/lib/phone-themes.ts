import { useSyncExternalStore } from 'react'
import type { ThemeCore } from '@shared/types'
import { resolveTheme, type ResolvedTheme } from '@/theme/themes'

/**
 * Themes only Forge Web wears, on the phone and in the Forge browser's deck
 * picker (`DECK_THEMES = PHONE_THEMES`). Forge desktop never sees this file (it
 * lives in web/, and src/theme/themes.ts stays the desktop's six).
 *
 * WhatsApp: the colours people already read a chat in, taken whole — ground,
 * bars, both bubbles, ink, icons, the green and the blue ticks — so the phone's
 * Chat view reads like the app it borrows its grammar from. It follows the
 * phone's own dark / light setting live, the way WhatsApp does, so it is two
 * cores behind one row in the Theme list.
 *
 * A core is the dozen colours every other token derives from (themes.ts
 * `resolveTheme`); the few places WhatsApp's own value beats the derived one
 * (its secondary ink, its icon grey, the raised menu surface) are written over
 * the result, and the chat's bubble colours ride along as `theme-*` tokens
 * that ChatView.css reads with a fallback, so every other theme keeps its own.
 */

export const WHATSAPP_ID = 'whatsapp'

const WHATSAPP_DARK: ThemeCore = {
  id: WHATSAPP_ID,
  name: 'WhatsApp',
  appearance: 'dark',
  bg: '#0b141a',
  panel: '#202c33',
  text: '#e9edef',
  accent: '#00a884',
  danger: '#f15c6d',
  warn: '#ffd279',
  info: '#53bdeb',
  ok: '#25d366',
  // The terminal sits on the chat's own ground, so flipping Chat ↔ Terminal is one room.
  termBg: '#0b141a',
  termFg: '#e9edef',
  ansi: [
    '#111b21',
    '#f15c6d',
    '#25d366',
    '#ffd279',
    '#53bdeb',
    '#c89cf5',
    '#5fd6c9',
    '#d1d7db',
    '#8696a0',
    '#ff8a97',
    '#6fe7a0',
    '#ffe3a3',
    '#8ad4f4',
    '#dcbdfa',
    '#93e6dd',
    '#f7f8fa'
  ]
}

const WHATSAPP_LIGHT: ThemeCore = {
  id: WHATSAPP_ID,
  name: 'WhatsApp',
  appearance: 'light',
  bg: '#efeae2',
  panel: '#f0f2f5',
  text: '#111b21',
  accent: '#008069',
  danger: '#d42a3f',
  warn: '#9a5b00',
  info: '#027eb5',
  ok: '#008069',
  termBg: '#f7f5f1',
  termFg: '#111b21',
  ansi: [
    '#111b21',
    '#b8182d',
    '#00705c',
    '#7a5200',
    '#02649a',
    '#7b2fa8',
    '#00687a',
    '#54656f',
    '#5b6b74',
    '#961426',
    '#005c4b',
    '#5e3f00',
    '#014f7a',
    '#5f2483',
    '#005262',
    '#111b21'
  ]
}

/** WhatsApp's own values where the derived ones drift from it. */
const WHATSAPP_OVER: Record<'dark' | 'light', ResolvedTheme> = {
  dark: {
    'text-secondary': '#aebac1',
    'text-muted': '#8696a0',
    'text-dim': '#8696a0',
    'bg-panel-raised': '#233138',
    'bg-sunken': '#111b21',
    'theme-bubble-in': '#202c33',
    'theme-bubble-out': '#005c4b',
    'theme-bubble-ink': '#e9edef',
    'theme-bubble-meta': '#8696a0',
    'theme-bubble-meta-out': '#aecfc9',
    'theme-bubble-edge': 'transparent',
    'theme-tick': '#53bdeb'
  },
  light: {
    'text-secondary': '#54656f',
    'text-muted': '#54656f',
    'text-dim': '#667781',
    'bg-panel-raised': '#ffffff',
    'bg-sunken': '#f0f2f5',
    'theme-bubble-in': '#ffffff',
    'theme-bubble-out': '#d9fdd3',
    'theme-bubble-ink': '#111b21',
    'theme-bubble-meta': '#667781',
    'theme-bubble-meta-out': '#56666f',
    'theme-bubble-edge': 'rgba(11, 20, 26, 0.13)',
    'theme-tick': '#53bdeb'
  }
}

/** The one row the phone's Theme list adds; its swatch shows both halves. */
export const PHONE_ONLY_THEMES: ThemeCore[] = [WHATSAPP_DARK]

export function isPhoneOnlyTheme(id: string): boolean {
  return id === WHATSAPP_ID
}

/** Does this theme follow the phone's dark / light setting? */
export function followsSystem(id: string): boolean {
  return id === WHATSAPP_ID
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

function subscribeSystem(listener: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const query = window.matchMedia(DARK_QUERY)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

/** The phone's dark / light setting, live. */
export function useSystemDark(): boolean {
  return useSyncExternalStore(subscribeSystem, systemDark, () => true)
}

/** The core this phone-only theme wears right now. */
export function phoneOnlyCore(id: string, dark = systemDark()): ThemeCore | null {
  if (id === WHATSAPP_ID) return dark ? WHATSAPP_DARK : WHATSAPP_LIGHT
  return null
}

/** Both of a system-following theme's cores, for a swatch that shows it follows. */
export function phoneOnlyPair(id: string): { dark: ThemeCore; light: ThemeCore } | null {
  return id === WHATSAPP_ID ? { dark: WHATSAPP_DARK, light: WHATSAPP_LIGHT } : null
}

/** Every token the theme writes: the derived set plus its own overrides and bubble colours. */
export function resolvePhoneOnly(core: ThemeCore): ResolvedTheme {
  return { ...resolveTheme(core), ...WHATSAPP_OVER[core.appearance] }
}
