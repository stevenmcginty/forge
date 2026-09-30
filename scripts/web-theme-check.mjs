/**
 * WhatsApp dark and WhatsApp light, as Forge Web wears them.
 *
 *   node scripts/web-theme-check.mjs
 *
 * Two fixed built-ins (src/theme/themes.ts, shared with Forge desktop), not one
 * that follows the phone: each id wears its own half, the old one-row id moves
 * to the half the phone was showing, and the chat's text and bubbles stay
 * readable in both.
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('@/')) {
      return next(new URL(`../src/${spec.slice('@/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const { contrast, DEFAULT_THEME_ID, BUILTIN_THEMES, resolveTheme, forkTheme } = await import(
  '../src/theme/themes.ts'
)
const { WHATSAPP_DARK_ID, WHATSAPP_LIGHT_ID, LEGACY_WHATSAPP_ID, storedThemeId, isKnownTheme, defaultThemeId } = await import(
  '../web/src/lib/phone-themes.ts'
)

const builtin = (id) => BUILTIN_THEMES.find((t) => t.id === id) ?? null
const BUBBLE_TOKENS = [
  'theme-bubble-in',
  'theme-bubble-out',
  'theme-bubble-ink',
  'theme-bubble-meta',
  'theme-bubble-meta-out',
  'theme-bubble-edge',
  'theme-tick'
]

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ✕ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ------------------------------------------------------------------ ids */

console.log('\nids')
ok(WHATSAPP_DARK_ID === 'whatsapp-dark' && WHATSAPP_LIGHT_ID === 'whatsapp-light', 'the two ids')
const ids = BUILTIN_THEMES.map((t) => t.id).join()
ok(
  ids === 'volt,orbit,carbon,ember,ice,paper,whatsapp-dark,whatsapp-light',
  'the built-ins are the six, then dark, then light',
  ids
)
ok(DEFAULT_THEME_ID === 'volt', 'the default is still Volt')
const dark = builtin('whatsapp-dark')
const light = builtin('whatsapp-light')
ok(dark?.appearance === 'dark', 'whatsapp-dark is dark', dark?.appearance)
ok(light?.appearance === 'light', 'whatsapp-light is light', light?.appearance)
ok(dark?.name === 'WhatsApp dark' && light?.name === 'WhatsApp light', 'each name says dark or light')
ok(dark && light && dark.bg !== light.bg && dark.text !== light.text, 'the two differ')
ok(builtin(LEGACY_WHATSAPP_ID) === null, 'the legacy id is no theme of its own')
ok(!isKnownTheme(LEGACY_WHATSAPP_ID), 'the legacy id is not offered')

/* ------------------------------------------------------------ migration */

console.log('\nstored ids')
ok(storedThemeId('whatsapp', true) === 'whatsapp-dark', 'legacy + dark phone → whatsapp-dark')
ok(storedThemeId('whatsapp', false) === 'whatsapp-light', 'legacy + light phone → whatsapp-light')
ok(storedThemeId('whatsapp-dark', false) === 'whatsapp-dark', 'whatsapp-dark stays dark on a light phone')
ok(storedThemeId('whatsapp-light', true) === 'whatsapp-light', 'whatsapp-light stays light on a dark phone')
ok(storedThemeId('paper', true) === 'paper', 'a built-in passes through')
ok(storedThemeId('nonsense', true) === DEFAULT_THEME_ID, 'an unknown id falls back to the default')
ok(storedThemeId(null, true) === DEFAULT_THEME_ID, 'nothing stored is the default')
ok(defaultThemeId(true) === 'whatsapp-dark', 'a phone with nothing stored wears WhatsApp dark')
ok(defaultThemeId(false) === DEFAULT_THEME_ID, 'the desk face keeps Volt')
ok(storedThemeId(null, true, defaultThemeId(true)) === 'whatsapp-dark', 'nothing stored on a phone is WhatsApp dark')
ok(storedThemeId('paper', true, defaultThemeId(true)) === 'paper', 'a phone that picked a theme keeps it')

// The default argument reads the phone's own setting: stub the matcher.
const stub = (isDark) => {
  globalThis.window = {
    matchMedia: (q) => ({
      media: q,
      matches: q.includes('dark') ? isDark : !isDark
    })
  }
}
stub(true)
ok(storedThemeId('whatsapp') === 'whatsapp-dark', 'legacy on a phone set to dark (matcher) → whatsapp-dark')
stub(false)
ok(storedThemeId('whatsapp') === 'whatsapp-light', 'legacy on a phone set to light (matcher) → whatsapp-light')
delete globalThis.window

/* --------------------------------------------------------------- tokens */

console.log('\nresolved tokens')
for (const core of [dark, light]) {
  const t = resolveTheme(core)
  const missing = BUBBLE_TOKENS.filter((k) => !t[k])
  ok(missing.length === 0, `${core.name} resolves every bubble token`, missing.join() || 'all seven')
}
ok(
  resolveTheme(dark)['text-secondary'] === '#aebac1' && resolveTheme(light)['text-secondary'] === '#54656f',
  'each WhatsApp half wears its own secondary ink over the derived one'
)
const others = BUILTIN_THEMES.filter((t) => t !== dark && t !== light)
ok(
  others.every((t) => BUBBLE_TOKENS.every((k) => !(k in resolveTheme(t)))),
  'no other built-in writes a bubble token'
)
const fork = forkTheme(dark, 'theme-test', 'WhatsApp dark (mine)')
ok(!('theme-bubble-in' in resolveTheme(fork)), 'a fork of WhatsApp dark wears the derived set alone')

/* ------------------------------------------------------------- contrast */

for (const core of [dark, light]) {
  console.log(`\n${core.name}`)
  const t = resolveTheme(core)
  const pairs = [
    ['text on bg', t['text-primary'] ?? core.text, t['bg-base'] ?? core.bg, 4.5],
    ['bubble-ink on bubble-in', t['theme-bubble-ink'], t['theme-bubble-in'], 4.5],
    ['bubble-ink on bubble-out', t['theme-bubble-ink'], t['theme-bubble-out'], 4.5],
    ['bubble-meta on bubble-in', t['theme-bubble-meta'], t['theme-bubble-in'], 3],
    ['bubble-meta-out on bubble-out', t['theme-bubble-meta-out'], t['theme-bubble-out'], 3]
  ]
  for (const [label, fg, bg, floor] of pairs) {
    const ratio = fg && bg ? contrast(fg, bg) : 0
    ok(ratio >= floor, `${label} ≥ ${floor}:1`, `${fg} on ${bg} = ${ratio.toFixed(2)}:1`)
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
