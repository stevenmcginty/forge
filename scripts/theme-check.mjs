/**
 * Contrast audit for every built-in theme.
 *
 *   node scripts/theme-check.mjs
 *
 * A theme is allowed to be moody. It is not allowed to be unreadable: every
 * ANSI slot a program writes text in has to clear 4.5:1 against that theme's
 * terminal background, in Paper exactly as much as in Volt. This is the check
 * that keeps the light theme honest, since a light terminal is where the usual
 * "just invert it" palette falls apart.
 *
 * Also prints the derived-token table for one theme so a change to the mixing
 * amounts is visible rather than merely believed.
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const { BUILTIN_THEMES, ANSI_SLOTS, auditTheme, contrast, resolveTheme, mix, alpha, parseHex, forkTheme } =
  await import('../src/theme/themes.ts')

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✕ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ------------------------------------------------------------ colour maths */

console.log('\ncolour maths')
ok(parseHex('#fff') && parseHex('#fff').r === 255, 'short hex expands')
ok(parseHex('nonsense') === null, 'junk hex rejected')
ok(mix('#000000', '#ffffff', 0.5) === '#808080', 'mix midpoint', mix('#000000', '#ffffff', 0.5))
ok(mix('#123456', '#abcdef', 0) === '#123456', 'mix at 0 keeps a')
ok(alpha('#c6ff4a', 0.5) === 'rgba(198, 255, 74, 0.5)', 'alpha formats rgba', alpha('#c6ff4a', 0.5))
ok(Math.round(contrast('#000000', '#ffffff')) === 21, 'black on white is 21:1')
ok(contrast('#777777', '#777777') === 1, 'identical colours are 1:1')

/* --------------------------------------------------------------- palettes */

for (const theme of BUILTIN_THEMES) {
  console.log(`\n${theme.name} (${theme.appearance})`)
  const findings = auditTheme(theme)
  if (findings.length === 0) {
    ok(true, 'every slot clears its contrast floor')
  } else {
    for (const f of findings) {
      ok(false, `${f.slot} ${f.color}`, `only ${f.ratio}:1`)
    }
  }

  // The terminal has to actually be the appearance it claims, or a TUI probing
  // OSC 11 will pick the wrong half of its own theme.
  const dark = contrast(theme.termBg, '#ffffff') > contrast(theme.termBg, '#000000')
  ok(
    dark === (theme.appearance === 'dark'),
    `terminal background matches the declared appearance`,
    `${theme.termBg} reads as ${dark ? 'dark' : 'light'}`
  )

  ok(theme.ansi.length === 16, 'sixteen ANSI slots')
  ok(
    theme.ansi.every((c) => parseHex(c) !== null),
    'every ANSI slot is a valid hex colour'
  )

  const tokens = resolveTheme(theme)
  ok(
    Object.values(tokens).every((v) => typeof v === 'string' && v.length > 0),
    'resolves to a complete token map'
  )
  ok(
    ANSI_SLOTS.every((s) => tokens[`term-${s}`]),
    'every ANSI slot reaches the token map'
  )
}

/* ------------------------------------------------------- worst-case report */

console.log('\nworst slot per theme')
for (const theme of BUILTIN_THEMES) {
  let worst = { slot: '', ratio: Infinity }
  ANSI_SLOTS.forEach((slot, i) => {
    if (slot === 'black') return
    const ratio = contrast(theme.ansi[i], theme.termBg)
    if (ratio < worst.ratio) worst = { slot, ratio }
  })
  console.log(`  ${theme.name.padEnd(7)} ${worst.slot.padEnd(14)} ${worst.ratio.toFixed(2)}:1`)
}

/* ------------------------------------------------------------ custom theme */

console.log('\ncustom themes')
{
  const base = BUILTIN_THEMES[0]
  const forked = forkTheme(base, 'custom-1', 'Mine')
  ok(forked.custom === true, 'a fork is marked custom')
  ok(forked.basedOn === base.id, 'a fork remembers its base')
  forked.accent = '#ff00aa'
  ok(base.accent !== '#ff00aa', 'editing a fork does not touch the built-in')
  forked.ansi[1] = '#ff0000'
  ok(base.ansi[1] !== '#ff0000', 'the ANSI array is copied, not shared')
  const tokens = resolveTheme(forked)
  ok(tokens['accent'] === '#ff00aa', 'a custom accent reaches the tokens')
  ok(tokens['term-red'] === '#ff0000', 'a custom ANSI slot reaches the tokens')
  ok(tokens['accent-soft'].startsWith('rgba(255, 0, 170'), 'accent washes follow the custom accent')
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
