/**
 * The view toggle must not resize the terminal.
 *
 *   node scripts/viewtoggle-check.mjs
 *
 * ## The bug this file exists to keep buried
 *
 * On a phone, flicking a pane between the terminal face (`data-view='term'`)
 * and the cards face (`data-view='feed'`) duplicated the conversation. Nothing
 * in the feed parser was wrong; the duplication was manufactured three layers
 * down, and the chain is worth writing out because every link in it is
 * individually reasonable:
 *
 *   1. the toggle flips `data-view` on the pane and on the composer;
 *   2. a CSS rule keyed on `data-view` changed the terminal container's box —
 *      `padding-top: 52px` applied in term view only, and a key row hidden in
 *      feed view only, which shrank the composer and grew the stage above it;
 *   3. FitAddon divides that box by the cell size, so it proposed a different
 *      `rows`;
 *   4. a different `rows` is a real `resize` frame to the desktop;
 *   5. the desktop resized the real PTY;
 *   6. the agent repainted its whole screen — and on the normal buffer a
 *      repaint lands in scrollback, so the screen you already had came back a
 *      second time underneath itself.
 *
 * Step 6 is not a bug anybody can fix. A redraw is not new content, but the
 * scrollback cannot know that, so the only defensible place to stand is step 2:
 * **toggling a pane between `term` and `feed` must not change the terminal
 * container's content box, and must therefore send zero `resize` frames.**
 *
 * That is what this file asserts, and it asserts it the only way that survives
 * the next rule somebody writes: by measuring, in a real browser, with the real
 * stylesheets and the real cascade. A check that named the two known rules
 * would pass the day a third one was added.
 *
 * ## How it measures
 *
 * `?preview=feed` (web/src/components/Preview.tsx) mounts a pane — header,
 * stage, status strip, composer — with no desktop and no PTY on the other end,
 * and `?phone` makes it wear the phone face *and* answer `useMobile`, so the
 * `[data-mobile]` half of the cascade is live. That is the whole fixture: no
 * WebSocket, no auth, no ConPTY.
 *
 * The preview renders the terminal `<pre>` only in term view, so the script
 * appends its own bare `.pane__terminal` to the stage. That element is not a
 * stand-in for the real one — it *is* the real one, as far as the cascade is
 * concerned: the same class, in the same stage, under the same ancestors, so
 * every selector that reaches the shipped container reaches this one. It is
 * `position: absolute; inset: 0` like the shipped one, so it adds nothing to
 * the flow and disturbs no measurement but its own.
 *
 * What is read back is the container's whole box: `getComputedStyle().width` and
 * `.height`, because that is literally what FitAddon divides
 * (`proposeDimensions` does `parseInt(getComputedStyle(term.element
 * .parentElement).height)`), *and* the padding and border, because under this
 * project's global `box-sizing: border-box` that resolved height is the border
 * box and the padding is inside it. The assertion is on the box, not on the row
 * count it becomes: rows are the box divided and floored, so a small drift
 * crosses a row boundary at some window heights and not at others. The key row
 * this file was written for moved the stage by 4px — enough to be a resize on a
 * phone and not enough to be one at 844px tall in a headless Chrome. Asserting
 * the pixels catches it either way; asserting the rows would have passed here
 * and shipped.
 *
 * The `.app` class is added alongside `.preview` on the root. Both are the same
 * two lines of CSS (flex column, height 100%), so it changes no layout — but it
 * means a rule written `.app[data-mobile] …` is caught here as surely as one
 * written `[data-mobile] …`. Today's padding rule is spelled both ways; a
 * future one need only be spelled once.
 *
 * ## The canary, and why it is not optional
 *
 * A measurement harness that has stopped reaching the element passes forever
 * and says nothing. So after asserting the boxes match, the script *injects*
 * both shapes of the original bug, one at a time, and asserts the harness now
 * reports a difference. That is the part that stays meaningful after the fix
 * has landed: it proves this file would still catch the bug it was written for,
 * on a tree where the bug no longer exists.
 *
 * ## What it cannot catch
 *
 * The fixture is one agent pane in the preview harness. A geometry rule that
 * only bites on a shell pane (`data-kind='shell'`), inside a split, or under a
 * media query no viewport here visits is outside its reach. The source sweep at
 * the end is the cheap backstop for the most direct version of that: a
 * `data-view`-conditional rule that declares a box property straight onto
 * `.pane__terminal` or `.pane__stage`, wherever in the sheet it lives.
 *
 * A missing Chrome is reported and skipped rather than failed — this runs in
 * the fast lane, which has to mean something on a bare CI checkout, and the
 * source sweep runs either way.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer as createViteServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Not 5174 (web/vite.config.ts's dev port), not 5179 (web-e2e's), not 5273+
 * (the desktop renderer's, see scripts/dev.mjs). A check that stole the port
 * off a dev loop somebody was using would fail for a reason that has nothing to
 * do with what it tests.
 */
const VITE_PORT = 5176

/**
 * The shipped default terminal size, so a pixel delta can be reported as the
 * grid it becomes. `fontSize × 1.2` is `rowHeight`'s own fallback in
 * web/src/lib/term.ts, and 0.6em is a monospace advance; `RULER_PX` is the
 * overview ruler's default width, which `proposeDimensions` takes off the
 * available width before dividing.
 */
const FONT_PX = 14
const CELL_H = FONT_PX * 1.2
const CELL_W = FONT_PX * 0.6
const RULER_PX = 14

let passes = 0
let failures = 0
const log = (ok, message) => {
  if (ok) passes++
  else failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}
const note = (message) => console.log(`  --  ${message}`)

/* ------------------------------------------------------------- in the browser
 *
 * Everything below runs inside the page. It is written as source strings passed
 * to `page.evaluate` so the harness has no build step of its own.
 */

/**
 * The pane's geometry, in the two shapes the invariant is about.
 *
 * `width`/`height` are `getComputedStyle`'s, which is exactly what
 * `proposeDimensions` parses off the container — and under this project's
 * global `box-sizing: border-box` (src/theme/global.css) that resolved value is
 * the *border* box, padding included. That is worth knowing rather than
 * assuming, because it means a padding rule on the container does not by itself
 * move the row count; only the outside of the box does. So the padding and
 * border are carried alongside and compared in their own right, which asserts
 * the stricter and more durable half of the invariant: the grid is drawn in the
 * same place, whatever `box-sizing` happens to be next year.
 */
function measureInPage() {
  const px = (v) => Math.round(parseFloat(v) * 1000) / 1000
  const boxOf = (el) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    const padding = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(px)
    const border = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(px)
    return {
      // What FitAddon divides.
      width: px(cs.width),
      height: px(cs.height),
      padding,
      border,
      // Where the grid actually lands, which is the same box less its frame
      // under border-box and the same number again under content-box.
      contentWidth: px(el.clientWidth - padding[1] - padding[3]),
      contentHeight: px(el.clientHeight - padding[0] - padding[2]),
      top: px(rect.top),
      left: px(rect.left)
    }
  }
  const pane = document.querySelector('.pane[data-view]')
  return {
    view: pane?.getAttribute('data-view') ?? null,
    terminal: boxOf(document.querySelector('[data-viewtoggle-probe]')),
    stage: boxOf(document.querySelector('.pane__stage')),
    composerHeight: px(getComputedStyle(document.querySelector('.session-composer')).height)
  }
}

/**
 * Put a real `.pane__terminal` in the stage.
 *
 * The preview mounts its `<pre>` in term view only, and the question being
 * asked is about both views, so the container has to exist in both. It carries
 * no class the shipped one does not — `preview__term`, which the harness's own
 * `<pre>` also wears, is deliberately left off, because that one is a fixture
 * style and this one is standing in for production.
 */
function seedProbeInPage() {
  const stage = document.querySelector('.pane__stage')
  if (!stage) return false
  if (!document.querySelector('[data-viewtoggle-probe]')) {
    const probe = document.createElement('div')
    probe.className = 'pane__terminal'
    probe.setAttribute('data-viewtoggle-probe', 'true')
    stage.appendChild(probe)
  }
  // `.app` is `.preview`'s twin (flex column, height 100%), so this is free —
  // and it makes the `.app[data-mobile] …` spelling of a rule reachable too.
  const root = document.querySelector('.preview')
  if (root) {
    root.classList.add('app')
    root.setAttribute('data-ready', 'true')
    root.setAttribute('data-shell', 'app')
  }
  return true
}

/* --------------------------------------------------------------- the harness */

/**
 * The grid FitAddon would propose for a box.
 *
 * `proposeDimensions` (node_modules/@xterm/addon-fit) divides the container's
 * computed width and height by the rendered cell, less the overview ruler's
 * 14px. The cell here is the shipped default rather than a measured one — the
 * question being asked is whether the *answer changes between two views of the
 * same pane*, and any fixed cell size answers that. It is only the arithmetic
 * that turns a pixel difference into the number that goes on the wire.
 */
const gridFor = (box) =>
  box === null
    ? null
    : {
        cols: Math.max(2, Math.floor((box.width - RULER_PX) / CELL_W)),
        rows: Math.max(1, Math.floor(box.height / CELL_H))
      }

/** Would the toggle put a different `resize` on the wire? */
function gridsMatch(a, b) {
  const ga = gridFor(a)
  const gb = gridFor(b)
  return ga !== null && gb !== null && ga.cols === gb.cols && ga.rows === gb.rows
}

/**
 * Does the box itself survive a round trip through the other view?
 *
 * Stricter than `gridsMatch` on purpose. A padding rule that shifts the grid
 * down without changing the container's outer size sends no resize *today*,
 * because `box-sizing: border-box` keeps it out of the number FitAddon reads —
 * but it is the same class of mistake, it moves the picture under a thumb, and
 * one `box-sizing` change away from being the whole bug again.
 */
function boxesMatch(a, b) {
  return (
    a !== null &&
    b !== null &&
    a.width === b.width &&
    a.height === b.height &&
    a.contentWidth === b.contentWidth &&
    a.contentHeight === b.contentHeight &&
    a.top === b.top &&
    a.left === b.left &&
    a.padding.join() === b.padding.join() &&
    a.border.join() === b.border.join()
  )
}

/** A failure has to read as the thing that happens next: rows, then a resize. */
function describeDrift(a, b) {
  if (a === null || b === null) return 'one of the two boxes was not there to measure'
  const parts = []
  const ga = gridFor(a)
  const gb = gridFor(b)
  if (ga.rows !== gb.rows || ga.cols !== gb.cols) {
    parts.push(`grid ${ga.cols}×${ga.rows} → ${gb.cols}×${gb.rows} at ${FONT_PX}px — that is a resize frame`)
  }
  if (a.height !== b.height) parts.push(`height ${a.height} → ${b.height} (${(b.height - a.height).toFixed(3)}px)`)
  if (a.width !== b.width) parts.push(`width ${a.width} → ${b.width} (${(b.width - a.width).toFixed(3)}px)`)
  if (a.contentHeight !== b.contentHeight) parts.push(`content height ${a.contentHeight} → ${b.contentHeight}`)
  if (a.contentWidth !== b.contentWidth) parts.push(`content width ${a.contentWidth} → ${b.contentWidth}`)
  if (a.padding.join() !== b.padding.join()) parts.push(`padding [${a.padding}] → [${b.padding}]`)
  if (a.border.join() !== b.border.join()) parts.push(`border [${a.border}] → [${b.border}]`)
  if (a.top !== b.top || a.left !== b.left) parts.push(`origin ${a.top},${a.left} → ${b.top},${b.left}`)
  return parts.join('; ') || 'identical'
}

/**
 * Flip the pane through the header's own toggle rather than by writing the
 * attribute. The button is what a thumb hits, and it is what moves the composer
 * as well as the pane — writing `data-view` on the pane alone would silently
 * exempt the composer rule, which is half of the bug.
 */
async function toggleView(page) {
  const before = await page.getAttribute('.pane[data-view]', 'data-view')
  await page.click('.pane__actions .pane__action[aria-pressed]')
  await page.waitForFunction(
    (was) => document.querySelector('.pane[data-view]')?.getAttribute('data-view') !== was,
    before,
    { timeout: 4000 }
  )
  // One frame, so the flip has been laid out before anything is measured.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  return page.getAttribute('.pane[data-view]', 'data-view')
}

/** Measure the pane in both views and hand back the pair, in a known order. */
async function bothViews(page) {
  const first = await page.evaluate(measureInPage)
  await toggleView(page)
  const second = await page.evaluate(measureInPage)
  // Leave the pane on the face it was found on, so a caller can sweep panes and
  // inject rules in any order without each step depending on the last.
  await toggleView(page)
  return first.view === 'feed' ? { feed: first, term: second } : { feed: second, term: first }
}

/** Add a rule to the page, run something against it, take it away again. */
async function withRule(page, css, fn) {
  await page.evaluate((text) => {
    const style = document.createElement('style')
    style.id = 'viewtoggle-canary'
    style.textContent = text
    document.head.appendChild(style)
  }, css)
  try {
    return await fn()
  } finally {
    await page.evaluate(() => document.getElementById('viewtoggle-canary')?.remove())
  }
}

/* ----------------------------------------------------------------- the sweep */

async function sweep(page, label, { mobile }) {
  await page.waitForSelector('.pane[data-view]', { timeout: 15_000 })
  const seeded = await page.evaluate(seedProbeInPage)
  log(seeded, `${label}: the preview harness mounts a pane with a stage to measure`)
  if (!seeded) return

  // Whether the phone half of the cascade is actually live. Without this a
  // broken `?phone` would turn the phone sweep into a second desktop sweep,
  // which would pass and mean nothing — every mobile-only rule, the two this
  // file was written for included, would be unreachable.
  const reach = await page.evaluate(() => ({
    bare: document.querySelector('[data-mobile] .pane[data-view]') !== null,
    app: document.querySelector('.app[data-mobile] .pane[data-view]') !== null
  }))
  if (mobile) {
    log(
      reach.bare && reach.app,
      `${label}: the pane sits under both spellings of the phone face — a rule written [data-mobile] … or .app[data-mobile] … reaches it`
    )
  }

  // A collapsed fixture would agree with itself about everything and prove
  // nothing, so the box is checked for being a box before it is checked for
  // holding still.
  const opening = await page.evaluate(measureInPage)
  log(
    (opening.terminal?.height ?? 0) > 100 && (opening.terminal?.width ?? 0) > 100,
    `${label}: the terminal container is a real box before anything is toggled`
  )
  if ((opening.terminal?.height ?? 0) <= 100) {
    note(`the stage measured ${opening.terminal?.width}×${opening.terminal?.height} — nothing below this means anything`)
    return
  }

  // Every pane the preview offers. They carry different composers (different
  // model, effort and permission chrome), and a composer that changes height
  // between views is how the stage above it changes height.
  const switches = await page.$$('.preview__switch button')
  const panes = switches.length > 0 ? switches.length : 1
  for (let i = 0; i < panes; i++) {
    if (switches[i]) {
      await switches[i].click()
      await page.waitForSelector('.pane[data-view]')
      await page.evaluate(seedProbeInPage)
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    }
    const name = switches[i] ? await switches[i].textContent() : 'pane'
    const { feed, term } = await bothViews(page)

    // The headline, and it is the *box* rather than the row count on purpose.
    // Rows are the box divided and floored, so a few pixels of drift crosses a
    // row boundary at some window heights and not at others — the shipped key
    // row moved the stage by 4px, which at this viewport happens to round to
    // the same 35 rows and at a slightly taller one does not. A check that
    // asserted only the rows would therefore pass on the machine it was written
    // on and fail on a phone, which is the whole history of this bug.
    const boxHeld = boxesMatch(feed.terminal, term.terminal)
    log(
      boxHeld,
      `${label} · ${name}: the terminal's box is the same in cards view and terminal view — a redraw is not new content`
    )
    if (!boxHeld) {
      note(`terminal: ${describeDrift(feed.terminal, term.terminal)}`)
      note(`composer height: ${feed.composerHeight} (feed) vs ${term.composerHeight} (term)`)
    }

    // And the consequence, named as itself, so a failure says what goes on the
    // wire and not only what moved in the layout.
    const gridHeld = gridsMatch(feed.terminal, term.terminal)
    log(
      gridHeld,
      `${label} · ${name}: so the grid FitAddon proposes is unchanged and no resize frame reaches the desktop`
    )
    if (gridHeld && !boxHeld) {
      note('the drift above happened not to cross a row boundary at this viewport — luck, not correctness')
    }

    // One level up, because the two answers name different culprits: a stage
    // that moved was pushed by the chrome around it, a stage that held still
    // while the terminal moved was a padding rule on the container itself.
    log(
      boxesMatch(feed.stage, term.stage),
      `${label} · ${name}: and so is the stage the terminal fills — the chrome around it does not move when the view does`
    )
    if (!boxesMatch(feed.stage, term.stage)) note(`stage: ${describeDrift(feed.stage, term.stage)}`)
  }

  /* ------------------------------------------------------------- the canary
   *
   * Both shapes of the original bug, put back one at a time, to prove the
   * assertions above are still *reaching* the element. This is the part that
   * keeps meaning something after the fix has landed: a measurement harness
   * that has quietly stopped finding the container passes forever and says
   * nothing.
   *
   * `!important`, and the values are numbers that appear nowhere in the sheet.
   * A canary is asking "does a change here show up there", not "would this rule
   * win a specificity argument" — and the corrected sheet declares the real
   * padding at a specificity an injected rule cannot beat without turning into
   * a puzzle. If the selector reaches nothing, `!important` does not save it,
   * which is exactly the failure the canary is for.
   */

  // Shape one, the pill offset: a box property on the container itself, keyed
  // on one view.
  const caught1 = await withRule(
    page,
    `.pane[data-kind='agent'][data-view='term'] .pane__terminal { padding-top: 137px !important; }`,
    async () => {
      const { feed, term } = await bothViews(page)
      return !boxesMatch(feed.terminal, term.terminal)
    }
  )
  log(caught1, `${label}: the harness still catches a box property keyed on data-view (the pill-offset shape)`)

  // Shape two, the hidden key row: nothing touches the terminal at all. The
  // composer changes height in one view, the stage above it takes up the slack,
  // and the row count moves — stated as the composer's own padding rather than
  // as `.composer__keys { display: none }`, so it does not depend on which
  // control inside the composer happens to be the tallest today.
  const caught2 = await withRule(
    page,
    `.session-composer[data-view='feed'] { padding-bottom: 23px !important; }`,
    async () => {
      const { feed, term } = await bothViews(page)
      return !gridsMatch(feed.terminal, term.terminal) && !boxesMatch(feed.stage, term.stage)
    }
  )
  log(caught2, `${label}: and one that only changes the chrome below it (the hidden-key-row shape)`)
}

/* -------------------------------------------------------------------- driver */

async function inBrowser() {
  let browser
  try {
    browser = await chromium.launch({ channel: 'chrome' })
  } catch (err) {
    note(`no Chrome to drive (${String(err?.message ?? err).split('\n')[0]})`)
    note('the measurement half is skipped; the source sweep below still runs')
    return
  }

  const vite = await createViteServer({
    configFile: join(ROOT, 'web', 'vite.config.ts'),
    server: { port: VITE_PORT, strictPort: true },
    logLevel: 'error'
  })
  await vite.listen()
  const origin = `http://localhost:${VITE_PORT}`

  try {
    // The phone face. `?phone` answers `useMobile` as well as dressing the CSS
    // (commit 4fee9ae), and `hasTouch` makes `(pointer: coarse)` true as well,
    // so both halves of the media query are honest.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
    const phonePage = await phone.newPage()
    phonePage.on('pageerror', (err) => log(false, `phone: the preview threw — ${err.message}`))
    await phonePage.goto(`${origin}/?preview=feed&phone`, { waitUntil: 'domcontentloaded' })
    await sweep(phonePage, 'phone', { mobile: true })
    await phone.close()

    // The same question at a desk. The bug was mobile-only, but nothing in the
    // chain that turns a resize into duplicated scrollback is.
    const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const deskPage = await desk.newPage()
    deskPage.on('pageerror', (err) => log(false, `desktop: the preview threw — ${err.message}`))
    await deskPage.goto(`${origin}/?preview=feed`, { waitUntil: 'domcontentloaded' })
    await sweep(deskPage, 'desktop', { mobile: false })
    await desk.close()
  } finally {
    await browser.close()
    await vite.close()
  }
}

/* ------------------------------------------------------------- source sweep
 *
 * The backstop for what the fixture cannot visit. It asks one narrow question,
 * so that it can be trusted rather than argued with: does any rule that is
 * conditional on *one particular* `data-view` value declare a box-affecting
 * property directly onto the terminal container or the stage it fills?
 *
 * Narrow on purpose, three ways. A rule keyed on bare `[data-view]` applies in
 * both views and so cannot make them disagree — `.pane[data-view]
 * .pane__terminal { position: absolute; inset: 0 }` is the rule that makes the
 * container fill the stage at all, and it must stay legal. So must
 * `.pane[data-view='feed'] .pane__terminal { opacity: 0 }`, which changes what
 * you see and not how big it is. And so must a `data-view` rule about the
 * feed's own scroller — the feed is not what FitAddon measures. Only the two
 * elements whose geometry becomes a `rows` figure are policed here.
 */

/** Properties that move a box. `display` included: `none` is a zero-sized box. */
const BOX =
  /(^|[;{\s])(padding|margin|border(?!-radius)|width|height|inset|top|right|bottom|left|display|box-sizing|transform|zoom|font-size|gap)(-[a-z-]+)?\s*:/

/** The two elements FitAddon's answer is computed from. */
const MEASURED = /\.(pane__terminal|pane__stage)\s*(,|$)/

/** Every rule in a sheet that would make the two faces of a pane different sizes. */
function countOffenders(css) {
  // Rule bodies, flat. The sheet has @media blocks but no nesting, so a
  // selector is everything between the previous brace and the next one.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  const offenders = []
  for (const [, rawSelector, body] of rules) {
    const selector = rawSelector.replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (selector.startsWith('@') || selector === '') continue
    // `data-view=`, with a value: a bare `[data-view]` is true in both views.
    if (!/data-view\s*=/.test(selector)) continue
    // Each comma-separated selector answers for itself: only the ones whose
    // *subject* is a measured element are this rule's business.
    const subjects = selector.split(',').map((s) => s.trim())
    if (!subjects.some((s) => MEASURED.test(`${s},`) && /data-view\s*=/.test(s))) continue
    const decls = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d !== '' && BOX.test(`;${d.replace(/:.*/s, ':')}`))
    if (decls.length > 0) offenders.push(`${subjects.join(', ')} { ${decls.join('; ')} }`)
  }
  return offenders
}

function sourceSweep() {
  const css = readFileSync(join(ROOT, 'web', 'src', 'styles.css'), 'utf8')
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  const offenders = countOffenders(css)

  log(
    offenders.length === 0,
    'no data-view rule changes the box of .pane__terminal or .pane__stage — the geometry is the same on both faces of a pane'
  )
  for (const o of offenders) note(o)

  // And the guard on the guard: if the sheet stops being parseable this way,
  // the sweep above would find nothing and say so cheerfully.
  log(
    rules.length > 200 && css.includes('.pane__terminal'),
    'the stylesheet still parses into rules and still styles .pane__terminal — the sweep above has something to read'
  )

  // And the guard on the *filter*: the one rule everybody writes when they mean
  // "steal three rows off the terminal in one view only" must still be seen as
  // an offender, whatever the sheet happens to contain today.
  const CANARY = `[data-mobile] .pane[data-kind='agent'][data-view='term'] .pane__terminal { padding-top: 52px; }`
  log(
    countOffenders(CANARY).length === 1,
    'and the sweep still recognises a one-view padding rule when it is shown one'
  )
}

/* --------------------------------------------------------------------- main */

console.log('\nthe view toggle must not resize the terminal\n')

await inBrowser().catch((err) => {
  failures++
  console.error(`FAIL  the browser half threw — ${err?.stack ?? err}`)
})

console.log('\nsource sweep\n')
sourceSweep()

const passed = failures === 0
console.log(`\n${passed ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed\n`)
process.exit(passed ? 0 : 1)
