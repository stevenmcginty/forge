/**
 * Forge Web's phone-face test and visual-viewport pin, proved without a phone.
 *
 *   node scripts/viewport-check.mjs
 *
 * Safari on a large iPhone used to need a rotate-and-rotate-back before the
 * page filled the glass. Two numbers were wrong, and both live in
 * web/src/lib/viewport.ts so this file can hold them to it:
 *
 *  1. **Phone or desktop.** `(pointer: coarse) and (max-width: 900px)` called
 *     an iPhone 16 Pro Max in landscape (956 CSS px) a desktop, and a first
 *     paint that reported that width in portrait did the same. A phone's
 *     screen short edge is 320–440; iPad Mini is 744.
 *  2. **How tall the shell is.** `innerHeight` on iOS is the large viewport
 *     (URL bar hidden) or a leftover orientation. `visualViewport.height` is
 *     the glass, unless the user is pinch-zooming, in which case the document
 *     must zoom rather than reflow.
 *
 * The numbers are asserted in-process. A Chrome half then loads the real
 * preview at an iPhone 16 Pro Max landscape size — the viewport that used to
 * miss the phone face — and reads `--app-height` off the live document. No
 * Chrome is a skip, not a fail; the fast lane has to mean something on a bare
 * checkout. Safari's first-paint lie cannot be reproduced here.
 */
import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'

registerHooks({
  load(url, context, next) {
    // Only our file. A resolve hook that tacks `.ts` onto every extensionless
    // relative import would rewrite playwright-core's own `./lib/bootstrap`.
    if (url.replace(/\\/g, '/').endsWith('/web/src/lib/viewport.ts')) {
      return next(url, { ...context, format: 'module-typescript' })
    }
    return next(url, context)
  }
})

const { isPhoneFace, appViewport, PHONE_SHORT_EDGE_PX, PHONE_LANDSCAPE_MAX_HEIGHT_PX } =
  await import('../web/src/lib/viewport.ts')

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

const face = (partial) =>
  isPhoneFace({
    askedPhone: false,
    coarse: true,
    viewportWidth: 390,
    viewportHeight: 844,
    screenWidth: 390,
    screenHeight: 844,
    ...partial
  })

console.log('phone face')

ok(!face({ coarse: false, viewportWidth: 390 }), 'a mouse at 390px is still the desktop fold')
ok(face({ viewportWidth: 390, screenWidth: 390, screenHeight: 844 }), 'iPhone SE portrait is a phone')
ok(
  face({ viewportWidth: 440, viewportHeight: 956, screenWidth: 440, screenHeight: 956 }),
  'iPhone 16 Pro Max portrait is a phone'
)
ok(
  face({ viewportWidth: 956, viewportHeight: 440, screenWidth: 440, screenHeight: 956 }),
  'iPhone 16 Pro Max landscape is still a phone (956 > 900, screen short edge 440)'
)
ok(
  face({ viewportWidth: 980, viewportHeight: 956, screenWidth: 440, screenHeight: 956 }),
  'a stale 980px first paint on a Pro Max is still a phone'
)
ok(
  face({ viewportWidth: 1024, viewportHeight: 956, screenWidth: 430, screenHeight: 932 }),
  'Safari “Request Desktop Website” on a phone is still a phone'
)
ok(
  !face({
    viewportWidth: 1133,
    viewportHeight: 744,
    screenWidth: 744,
    screenHeight: 1133
  }),
  'iPad Mini landscape is a desktop (short edge 744)'
)
ok(
  face({
    viewportWidth: 744,
    viewportHeight: 1133,
    screenWidth: 744,
    screenHeight: 1133
  }),
  'iPad Mini portrait stays the phone face, as max-width 900 already did'
)
ok(
  face({ askedPhone: true, coarse: false, viewportWidth: 1440, screenWidth: 1920, screenHeight: 1080 }),
  '?phone on the dev server wins over a mouse'
)
ok(
  !face({
    coarse: true,
    viewportWidth: 1440,
    viewportHeight: 900,
    screenWidth: 1920,
    screenHeight: 1080
  }),
  'touch emulation on a 1440px Playwright window is not a phone until it narrows'
)
ok(
  face({
    coarse: true,
    viewportWidth: 390,
    viewportHeight: 844,
    screenWidth: 1920,
    screenHeight: 1080
  }),
  'and once it narrows, viewport width ≤ 900 is enough (Playwright screen is the host)'
)
ok(PHONE_SHORT_EDGE_PX === 500, 'the screen-short-edge ceiling sits between Pro Max (440) and iPad Mini (744)')
ok(PHONE_LANDSCAPE_MAX_HEIGHT_PX === 500, 'the landscape-height fold covers Pro Max at 440')

console.log('shell size')

const pin = (partial) =>
  appViewport({
    visualHeight: 800,
    visualOffsetTop: 0,
    visualScale: 1,
    innerHeight: 900,
    ...partial
  })

ok(pin({ visualHeight: 800, innerHeight: 932 }).height === 800, 'the glass, not the large viewport')
ok(pin({ visualHeight: 0, innerHeight: 932 }).height === 932, 'a 0 visual height (iOS first tick) falls back to innerHeight')
ok(pin({ visualHeight: null, innerHeight: 932 }).height === 932, 'and so does a missing visualViewport')
ok(pin({ visualHeight: 500, innerHeight: 932 }).height === 500, 'the keyboard shrinks the shell')
ok(pin({ visualHeight: 800, visualScale: 1.4, innerHeight: 932 }).height === 932, 'a pinch-zoom does not reflow')
ok(pin({ visualHeight: 800, visualOffsetTop: 47 }).top === 47, 'a shifted visual viewport is followed')
ok(pin({ visualHeight: 800, visualScale: 1.4, visualOffsetTop: 47, innerHeight: 932 }).top === 0, 'but not during a pinch')
ok(pin({ visualHeight: 800, visualOffsetTop: -12 }).top === 0, 'a negative offset is ignored')
ok(pin({ visualHeight: 800, innerHeight: 0 }).height === 800, 'visual height wins when innerHeight is 0')

const ROOT = resolve(import.meta.dirname, '..')
const VITE_PORT = 5177

async function inBrowser() {
  let chromium
  let createViteServer
  try {
    ;({ chromium } = await import('playwright-core'))
    ;({ createServer: createViteServer } = await import('vite'))
  } catch (err) {
    console.log(`  --  no browser driver (${String(err?.message ?? err).split('\n')[0]})`)
    return
  }

  let browser
  try {
    browser = await chromium.launch({ channel: 'chrome' })
  } catch (err) {
    console.log(`  --  no Chrome to drive (${String(err?.message ?? err).split('\n')[0]})`)
    console.log('  --  the in-page half is skipped')
    return
  }

  const vite = await createViteServer({
    configFile: join(ROOT, 'web', 'vite.config.ts'),
    server: { port: VITE_PORT, strictPort: true },
    logLevel: 'error'
  })
  await vite.listen()
  const origin = `http://localhost:${VITE_PORT}`

  const readShell = () => {
    const root = document.getElementById('root')
    const cs = getComputedStyle(root)
    return {
      mobile: document.querySelector('[data-mobile]') != null,
      appHeight: document.documentElement.style.getPropertyValue('--app-height').trim(),
      position: cs.position,
      height: Math.round(root.getBoundingClientRect().height),
      visual: window.visualViewport ? Math.round(window.visualViewport.height) : Math.round(window.innerHeight)
    }
  }

  try {
    console.log('in the page')

    const max = await browser.newContext({
      viewport: { width: 956, height: 440 },
      screen: { width: 440, height: 956 },
      hasTouch: true,
      isMobile: true
    })
    const maxPage = await max.newPage()
    maxPage.on('pageerror', (err) => ok(false, `Pro Max landscape threw — ${err.message}`))
    await maxPage.goto(`${origin}/?preview=feed`, { waitUntil: 'networkidle' })
    const maxShell = await maxPage.evaluate(readShell)
    ok(maxShell.mobile, 'iPhone 16 Pro Max landscape wears the phone face, without ?phone', JSON.stringify(maxShell))
    ok(
      maxShell.position === 'fixed',
      '#root is position:fixed so it cannot inherit a stale percentage height',
      maxShell.position
    )
    ok(
      maxShell.appHeight === `${maxShell.visual}px`,
      `--app-height is the visual viewport (${maxShell.appHeight} vs ${maxShell.visual}px)`,
      maxShell.appHeight
    )
    ok(
      Math.abs(maxShell.height - maxShell.visual) <= 1,
      `#root fills the visual viewport (${maxShell.height} vs ${maxShell.visual})`
    )
    await max.close()

    const stale = await browser.newContext({
      viewport: { width: 980, height: 956 },
      screen: { width: 440, height: 956 },
      hasTouch: true,
      isMobile: true
    })
    const stalePage = await stale.newPage()
    await stalePage.goto(`${origin}/?preview=feed`, { waitUntil: 'networkidle' })
    const staleShell = await stalePage.evaluate(readShell)
    ok(
      staleShell.mobile,
      'a 980px first-paint lie on a Pro Max screen is still the phone face',
      JSON.stringify(staleShell)
    )
    await stale.close()

    const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const deskPage = await desk.newPage()
    await deskPage.goto(`${origin}/?preview=feed`, { waitUntil: 'networkidle' })
    const deskShell = await deskPage.evaluate(readShell)
    ok(!deskShell.mobile, 'a mouse at 1280px stays the desktop face')
    ok(
      deskShell.appHeight === `${deskShell.visual}px`,
      `desktop --app-height still tracks the window (${deskShell.appHeight})`
    )
    await desk.close()
  } finally {
    await browser.close()
    await vite.close()
  }
}

await inBrowser()

if (fail > 0) {
  console.log(`\n${fail} failed, ${pass} passed`)
  process.exit(1)
}
console.log(`\n${pass} passed`)
