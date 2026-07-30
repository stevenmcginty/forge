import type { ThemeCore } from '@shared/types'

/**
 * Forge's themes.
 *
 * A theme is not a stylesheet. It is a *core* of a dozen colours — background,
 * panel, ink, accent, the four signal colours and the sixteen ANSI slots — from
 * which every other token in tokens.css is derived by mixing (see `resolveTheme`
 * below). tokens.css still holds the Volt values literally, so the app has a
 * sane painted state before any JavaScript runs; from then on the resolved map
 * is written onto the root element as inline custom properties, which is what
 * makes a custom theme exactly as capable as a built-in one.
 *
 * Two rules govern the palettes:
 *
 *  1. **Terminal contrast is not negotiable.** The `--term-*` tokens are part of
 *     the theme, and a theme where an error line is unreadable is a broken
 *     theme, not a moody one. `auditTheme` measures every slot against the
 *     terminal background and is run over all built-ins by
 *     `npm run theme:check`.
 *
 *  2. **The accent means one thing.** Live / focused / go. Each theme picks its
 *     own, but none of them spends it on decoration.
 */

/* --------------------------------------------------------------- colour maths */

interface Rgb {
  r: number
  g: number
  b: number
}

/** #rgb / #rrggbb → channels. Returns null for anything else. */
export function parseHex(hex: string): Rgb | null {
  const s = hex.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(s)) {
    return {
      r: parseInt(s[0]! + s[0]!, 16),
      g: parseInt(s[1]! + s[1]!, 16),
      b: parseInt(s[2]! + s[2]!, 16)
    }
  }
  if (/^[0-9a-f]{6}$/i.test(s)) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16)
    }
  }
  return null
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

export function toHex({ r, g, b }: Rgb): string {
  const two = (n: number): string => clamp255(n).toString(16).padStart(2, '0')
  return `#${two(r)}${two(g)}${two(b)}`
}

/** `t` of 0 keeps `a`, 1 gives `b`. Invalid input falls back to `a`. */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a)
  const y = parseHex(b)
  if (!x || !y) return a
  const k = Math.max(0, Math.min(1, t))
  return toHex({
    r: x.r + (y.r - x.r) * k,
    g: x.g + (y.g - x.g) * k,
    b: x.b + (y.b - x.b) * k
  })
}

export function alpha(color: string, a: number): string {
  const c = parseHex(color)
  if (!c) return color
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000})`
}

/** WCAG relative luminance. */
export function luminance(color: string): number {
  const c = parseHex(color)
  if (!c) return 0
  const chan = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b)
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** Whichever of two inks reads better on `bg` — used for text-on-accent. */
export function bestInk(bg: string, dark: string, light: string): string {
  return contrast(bg, dark) >= contrast(bg, light) ? dark : light
}

/* ---------------------------------------------------------------- built-ins */

const VOLT: ThemeCore = {
  id: 'volt',
  name: 'Volt',
  appearance: 'dark',
  bg: '#0b0c0e',
  panel: '#121317',
  text: '#e8eaed',
  accent: '#c6ff4a',
  danger: '#ff5c48',
  warn: '#ffb347',
  info: '#7fd1ff',
  ok: '#5ee6a8',
  termBg: '#0e0f12',
  termFg: '#e8eaed',
  ansi: [
    '#15171b',
    '#ff6e6e',
    '#b8f04a',
    '#f2e56b',
    '#7fb6ff',
    '#c08bff',
    '#6fe3d2',
    '#d6d9de',
    // Dim ink still has to be ink: the classic near-black bright-black would sit
    // at 3:1 here, which is a comment nobody can read.
    '#828992',
    '#ff8f8f',
    '#ceff6e',
    '#ffef8f',
    '#a3ccff',
    '#d5aeff',
    '#9bf0e4',
    '#f4f6f8'
  ]
}

/** Graphite. Hues survive, saturation does not — a workshop, not a nightclub. */
const CARBON: ThemeCore = {
  id: 'carbon',
  name: 'Carbon',
  appearance: 'dark',
  bg: '#0d0e10',
  panel: '#16171a',
  text: '#e6e7ea',
  accent: '#cfd5de',
  danger: '#e08c86',
  warn: '#d9c08a',
  info: '#a8bcd6',
  ok: '#a8c9a6',
  termBg: '#101113',
  termFg: '#e6e7ea',
  ansi: [
    '#1a1b1e',
    '#d98a86',
    '#aec596',
    '#d4cb9e',
    '#a4b9d4',
    '#bfadcd',
    '#98c6c3',
    '#c8ccd2',
    '#7b8189',
    '#eaa9a5',
    '#cde0b4',
    '#ede4bb',
    '#c2d3ea',
    '#d6c6e4',
    '#b5e0dd',
    '#f2f3f5'
  ]
}

/** Forge-warm: firelight on iron. */
const EMBER: ThemeCore = {
  id: 'ember',
  name: 'Ember',
  appearance: 'dark',
  bg: '#100c0a',
  panel: '#1b1512',
  text: '#f2e7de',
  accent: '#ff9d4a',
  danger: '#ff6a55',
  warn: '#ffc861',
  info: '#9fb8e8',
  ok: '#9fd6a0',
  termBg: '#130e0b',
  termFg: '#f2e7de',
  ansi: [
    '#1f1714',
    '#ff7a63',
    '#c9d67a',
    '#ffc861',
    '#9fb8e8',
    '#e79ad4',
    '#7fd8c4',
    '#e0d3c6',
    '#8a786b',
    '#ff9a86',
    '#dced96',
    '#ffdc94',
    '#bfd0f2',
    '#f3b8e4',
    '#a4ebda',
    '#fdf6ee'
  ]
}

/** Cold light through a window at 3am. */
const ICE: ThemeCore = {
  id: 'ice',
  name: 'Ice',
  appearance: 'dark',
  bg: '#080d14',
  panel: '#101823',
  text: '#e3edf8',
  accent: '#5cc8ff',
  danger: '#ff7f8f',
  warn: '#ecd98a',
  info: '#7fbcff',
  ok: '#74e0b0',
  termBg: '#0a1017',
  termFg: '#e3edf8',
  ansi: [
    '#141d28',
    '#ff7f8f',
    '#74e0b0',
    '#ecd98a',
    '#7fbcff',
    '#b3a8ff',
    '#62dcea',
    '#cdd8e4',
    '#6d7d8f',
    '#ffa2ad',
    '#9ceecb',
    '#f6ecb2',
    '#a8d4ff',
    '#cfc7ff',
    '#93ecf5',
    '#f2f7fc'
  ]
}

/**
 * Daylight. The hard part of a light theme is the terminal: the usual ANSI
 * palette is designed to glow on black, and pasted onto white it turns into
 * pastel mush that nobody can read.
 *
 * So Paper's palette is inverted in intent — the "bright" half is *darker* than
 * the normal half rather than lighter, because xterm draws bold text in bright
 * colours and bold text has to be the more legible of the two, not the less.
 * Every slot clears 4.5:1 against the terminal background; `npm run theme:check`
 * fails the build if that ever stops being true.
 */
const PAPER: ThemeCore = {
  id: 'paper',
  name: 'Paper',
  appearance: 'light',
  bg: '#f6f6f4',
  panel: '#ececea',
  text: '#1b1d20',
  accent: '#4a7500',
  danger: '#b3261e',
  warn: '#8a5300',
  info: '#0a4fbf',
  ok: '#1c6b3c',
  termBg: '#fbfbf9',
  termFg: '#1f2124',
  ansi: [
    '#1b1f23',
    '#b3261e',
    '#216b2b',
    '#79550a',
    '#0a4fbf',
    '#7b2fa8',
    '#0a6470',
    '#5a6066',
    '#63696f',
    '#8f1c15',
    '#17561f',
    '#5c4207',
    '#063a94',
    '#5f2483',
    '#084e58',
    '#24282c'
  ]
}

export const BUILTIN_THEMES: ThemeCore[] = [VOLT, CARBON, EMBER, ICE, PAPER]

export const DEFAULT_THEME_ID = 'volt'

/** The canonical ANSI slot names, in xterm's order. */
export const ANSI_SLOTS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'bright-black',
  'bright-red',
  'bright-green',
  'bright-yellow',
  'bright-blue',
  'bright-magenta',
  'bright-cyan',
  'bright-white'
] as const

/* ------------------------------------------------------------- resolution */

/**
 * How far each derived surface travels, per appearance. Dark themes build *up*
 * from the background by adding ink; light themes have to come *down*, and much
 * less far — 12% of black over white is already a heavy line, where 12% of bone
 * over near-black is barely a hairline.
 */
const AMOUNTS = {
  dark: {
    sunken: 0.28, // toward black
    raised: 0.038, // panel toward text
    headerLive: 0.02,
    hover: 0.05,
    active: 0.088,
    hairline: 0.083,
    lineSoft: 0.035,
    lineStrong: 0.128,
    secondary: 0.42, // text toward panel
    muted: 0.6,
    dim: 0.79,
    accentBright: 0.28, // accent toward white
    scrollbar: 0.14,
    scrollbarHover: 0.23,
    shadowKey: 0.32,
    shadowAmbient: 0.42,
    insetTop: 0.035
  },
  light: {
    sunken: 0.06,
    raised: 0.055, // panel toward text (i.e. slightly darker)
    headerLive: 0.03,
    hover: 0.05,
    active: 0.1,
    hairline: 0.14,
    lineSoft: 0.07,
    lineStrong: 0.26,
    secondary: 0.33,
    muted: 0.5,
    dim: 0.68,
    accentBright: 0.22, // accent toward black
    scrollbar: 0.24,
    scrollbarHover: 0.36,
    shadowKey: 0.1,
    shadowAmbient: 0.14,
    insetTop: 0.5
  }
} as const

/**
 * A resolved theme: every custom property the stylesheets read, with values.
 * Keys are the bare token names — `bg-base`, not `--bg-base`.
 */
export type ResolvedTheme = Record<string, string>

export function resolveTheme(core: ThemeCore): ResolvedTheme {
  const light = core.appearance === 'light'
  const a = light ? AMOUNTS.light : AMOUNTS.dark
  const { bg, panel, text, accent } = core

  // A light theme's "raised" surface is a *lighter* card on a grey field, so it
  // travels toward white; a dark one travels toward its ink.
  const raised = light ? mix(panel, '#ffffff', 0.55) : mix(panel, text, a.raised)
  const sunken = light ? mix(bg, '#000000', a.sunken) : mix(bg, '#000000', a.sunken)
  const ansi = core.ansi

  const tokens: ResolvedTheme = {
    /* surfaces */
    'bg-base': bg,
    'bg-sunken': sunken,
    'bg-panel': panel,
    'bg-panel-raised': raised,
    'bg-terminal': core.termBg,
    'bg-header-live': mix(panel, text, a.headerLive),
    'bg-hover': mix(panel, text, a.hover),
    'bg-active': mix(panel, text, a.active),
    'bg-scrim': alpha(mix(bg, '#000000', light ? 0.15 : 0.4), light ? 0.5 : 0.62),

    /* lines */
    'line-hairline': mix(panel, text, a.hairline),
    'line-soft': mix(panel, text, a.lineSoft),
    'line-strong': mix(panel, text, a.lineStrong),

    /* ink */
    'text-primary': text,
    'text-secondary': mix(text, panel, a.secondary),
    'text-muted': mix(text, panel, a.muted),
    'text-dim': mix(text, panel, a.dim),
    'text-on-accent': bestInk(accent, bg, light ? '#ffffff' : text),

    /* accent */
    accent,
    'accent-bright': mix(accent, light ? '#000000' : '#ffffff', a.accentBright),
    'accent-soft': alpha(accent, light ? 0.16 : 0.14),
    'accent-softer': alpha(accent, light ? 0.09 : 0.07),
    'accent-line': alpha(accent, light ? 0.5 : 0.42),
    'accent-glow': alpha(accent, 0.22),
    'accent-wash': alpha(accent, light ? 0.24 : 0.2),
    'accent-wash-strong': alpha(accent, light ? 0.3 : 0.26),

    /* signals */
    danger: core.danger,
    'danger-soft': alpha(core.danger, 0.14),
    'danger-line': alpha(core.danger, 0.34),
    info: core.info,
    warn: core.warn,
    'warn-soft': alpha(core.warn, light ? 0.12 : 0.09),
    'warn-line': alpha(core.warn, 0.34),
    'warn-line-strong': alpha(core.warn, 0.45),
    ok: core.ok,

    /* furniture that used to be written as literals */
    'scrollbar-thumb': mix(panel, text, a.scrollbar),
    'scrollbar-thumb-hover': mix(panel, text, a.scrollbarHover),
    'panel-grad-a': mix(panel, text, 0.015),
    'panel-grad-b': mix(panel, bg, 0.55),
    'empty-grad-a': mix(panel, accent, 0.05),
    'empty-grad-b': mix(bg, accent, 0.03),
    'swatch-border': alpha(text, light ? 0.24 : 0.14),
    'raised-ring': alpha(text, light ? 0.05 : 0.03),
    'scrim-grad-from': alpha(sunken, 0),
    'scrim-grad-to': alpha(sunken, light ? 0.78 : 0.86),
    'shadow-key': `0 2px 3px ${alpha('#000000', a.shadowKey)}`,
    'shadow-ambient': `0 8px 22px ${alpha('#000000', a.shadowAmbient)}`,
    'shadow-inset-top': `inset 0 1px 0 ${alpha(light ? '#ffffff' : '#ffffff', a.insetTop)}`,

    /* terminal */
    'term-bg': core.termBg,
    'term-fg': core.termFg,
    'term-cursor-accent': core.termBg,
    'term-selection': alpha(accent, light ? 0.28 : 0.22)
  }

  ANSI_SLOTS.forEach((slot, i) => {
    tokens[`term-${slot}`] = ansi[i] ?? core.termFg
  })

  return tokens
}

/* -------------------------------------------------------------- application */

let applied: string | null = null

/**
 * Paint a theme onto the document. Inline custom properties on the root beat
 * tokens.css's `:root` block, so the stylesheet keeps working as the pre-JS
 * default and every theme — built-in or made ten seconds ago in the editor —
 * takes exactly the same path to the screen.
 *
 * Returns the resolved map, which is also what the terminal host needs.
 */
export function applyTheme(core: ThemeCore): ResolvedTheme {
  const tokens = resolveTheme(core)
  const root = document.documentElement
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(`--${name}`, value)
  }
  root.dataset['theme'] = core.id
  root.dataset['appearance'] = core.appearance
  applied = core.id
  return tokens
}

export function appliedThemeId(): string | null {
  return applied
}

/** Motion off is a whole-app switch, so it is an attribute, not a token. */
export function applyReducedMotion(on: boolean): void {
  const root = document.documentElement
  if (on) root.dataset['reducedMotion'] = 'true'
  else delete root.dataset['reducedMotion']
}

/* ------------------------------------------------------------------ lookup */

export function findTheme(id: string, custom: ThemeCore[]): ThemeCore {
  return (
    custom.find((t) => t.id === id) ??
    BUILTIN_THEMES.find((t) => t.id === id) ??
    BUILTIN_THEMES[0]!
  )
}

export function allThemes(custom: ThemeCore[]): ThemeCore[] {
  return [...BUILTIN_THEMES, ...custom]
}

/** A blank custom theme cloned off a base, ready for the editor. */
export function forkTheme(base: ThemeCore, id: string, name: string): ThemeCore {
  return { ...base, ansi: [...base.ansi], id, name, custom: true, basedOn: base.id }
}

/* ------------------------------------------------------------------- audit */

export interface ContrastFinding {
  slot: string
  color: string
  ratio: number
}

/**
 * Every terminal slot measured against the terminal background, plus the app's
 * own ink against its surfaces. `min` is the AA threshold for body text; the
 * `black` slot is exempt because programs use it as a *background* colour, and
 * the two selection/cursor tokens are washes rather than text.
 */
export function auditTheme(core: ThemeCore, min = 4.5): ContrastFinding[] {
  const out: ContrastFinding[] = []
  const check = (slot: string, color: string, bg: string, floor = min): void => {
    const ratio = Math.round(contrast(color, bg) * 100) / 100
    if (ratio < floor) out.push({ slot, color, ratio })
  }

  ANSI_SLOTS.forEach((slot, i) => {
    // `black` is the palette's background slot, not an ink.
    if (slot === 'black') return
    check(`term-${slot}`, core.ansi[i] ?? core.termFg, core.termBg)
  })
  check('term-fg', core.termFg, core.termBg)

  const tokens = resolveTheme(core)
  check('text-primary', tokens['text-primary']!, core.bg)
  check('text-secondary', tokens['text-secondary']!, core.panel, Math.min(min, 4.5))
  // Muted ink is eyebrows and hints — deliberately quiet, so it answers to the
  // large-text threshold rather than the body one.
  check('text-muted', tokens['text-muted']!, core.panel, 3)
  check('accent', core.accent, core.panel, 3)
  check('danger', core.danger, core.panel, 3)
  check('warn', core.warn, core.panel, 3)
  check('ok', core.ok, core.panel, 3)

  return out.sort((x, y) => x.ratio - y.ratio)
}
