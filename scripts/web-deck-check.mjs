/**
 * Forge Web's deck face against the deck it mirrors.
 *
 *   node scripts/web-deck-check.mjs
 *
 * The desktop-browser face (web/src/deck) imports what it safely can from the
 * redesigned desktop — the tokens, the pane chrome, the themes — and redraws
 * the rest from the deck's own numbers. The desktop redesign is still moving,
 * so this fails the moment the two part:
 *
 *   1. every `var(--x)` the web deck CSS reads is still defined somewhere it
 *      can come from (the deck tokens, the design tokens, or the web deck CSS);
 *   2. every class and state the web deck draws on an imported deck stylesheet
 *      still has a rule there (the pane chrome);
 *   3. every value restated from a deck file still equals the deck's own;
 *   4. the Calm backdrop and the StateChip shapes still match their sources.
 *
 * Read-only; touches nothing. Exit code 1 on any drift, with what moved.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

/* ------------------------------------------------------------ a small CSS reader */

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const norm = (s) => s.replace(/\s+/g, ' ').replace(/\s*([>,])\s*/g, '$1 ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()

/** Every rule, at any depth, as { selector, decls }. At-rule wrappers are walked into. */
function rules(css) {
  const text = stripComments(css)
  const out = []
  const walk = (start, end) => {
    let i = start
    while (i < end) {
      const open = text.indexOf('{', i)
      if (open < 0 || open >= end) return
      let depth = 1
      let j = open + 1
      while (j < end && depth > 0) {
        if (text[j] === '{') depth++
        else if (text[j] === '}') depth--
        j++
      }
      const head = text.slice(i, open).trim()
      const body = text.slice(open + 1, j - 1)
      if (head.startsWith('@')) {
        if (!/^@keyframes/.test(head)) walk(open + 1, j - 1)
      } else {
        const decls = {}
        for (const part of body.split(';')) {
          const at = part.indexOf(':')
          if (at < 0) continue
          decls[part.slice(0, at).trim()] = norm(part.slice(at + 1))
        }
        out.push({ selector: norm(head), decls })
      }
      i = j
    }
  }
  walk(0, text.length)
  return out
}

function rule(css, selector) {
  const want = norm(selector)
  return rules(css).find((r) => r.selector === want) ?? null
}

/* ------------------------------------------------------------------ the files */

const DECK_DIR = 'web/src/deck'
const webCss = readdirSync(join(ROOT, DECK_DIR))
  .filter((f) => f.endsWith('.css'))
  .map((f) => ({ name: `${DECK_DIR}/${f}`, css: read(`${DECK_DIR}/${f}`) }))
const web = webCss.map((f) => f.css).join('\n')

const SRC = {
  tokens: read('src/theme/tokens.css'),
  deckTokens: read('src/components/shell/deck-tokens.css'),
  deckCss: read('src/components/shell/deck.css'),
  dock: read('src/components/shell/Dock.css'),
  shell: read('src/components/shell/Shell.css'),
  comp: read('src/components/hub/Composer.css'),
  backdrop: read('src/components/shell/Backdrop.tsx'),
  stateChip: read('src/components/shell/StateChip.tsx'),
  mosaic: read('src/lib/mosaicLayout.ts')
}

/* ------------------------------------------------------- 1. every token resolves */

const defined = new Set()
for (const css of [SRC.tokens, SRC.deckTokens, web]) {
  for (const m of stripComments(css).matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1])
}
// Custom properties the web deck's components set inline (`style={{ '--project': … }}`).
for (const dir of [DECK_DIR, 'web/src/components']) {
  for (const f of readdirSync(join(ROOT, dir)).filter((n) => n.endsWith('.tsx'))) {
    for (const m of read(`${dir}/${f}`).matchAll(/'(--[a-z0-9-]+)'\s*:/gi)) defined.add(m[1])
  }
}
const used = new Set([...stripComments(web).matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]))
const missing = [...used].filter((name) => !defined.has(name))
log(missing.length === 0, `every token the web deck reads is defined (${used.size} read)${missing.length ? `: missing ${missing.join(', ')}` : ''}`)

/* -------------------------------------------- 2. imported sheets still style us */

const deckSelectors = [
  '.deck .pane',
  ".deck .pane[data-focused='true']",
  '.deck .pane__header',
  '.deck .pane__title',
  ".deck .empty[data-size='md'] .empty__title"
]
const lostDeck = deckSelectors.filter((s) => !rule(SRC.deckCss, s))
log(lostDeck.length === 0, `deck.css still dresses the panes under .deck${lostDeck.length ? `: lost ${lostDeck.join(', ')}` : ''}`)

log(/export function columnsFor\(/.test(SRC.mosaic), 'mosaicLayout.ts still exports columnsFor, which the Wall lays out by')

/* ----------------------------------------------------- 3. restated values agree */

const W = ".app[data-face='deck']"
const pairs = [
  // [deck source, deck selector, web selector, properties]
  ['dock', '.sheet', `${W} .dk-sheet`, ['border-radius', 'background', 'border', 'box-shadow', 'animation']],
  ['dock', '.sheet--projects', `${W} .dk-sheet--projects`, ['left', 'width', 'transform-origin']],
  ['dock', '.sheet__head', `${W} .dk-sheet__head`, ['height', 'padding', 'gap', 'border-bottom']],
  ['dock', '.sheet__eyebrow', `${W} .dk-sheet__eyebrow`, ['font-family', 'font-size', 'font-weight', 'letter-spacing', 'color']],
  ['dock', '.sheet__seg', `${W} .dk-seg`, ['padding', 'border', 'border-radius', 'background']],
  ['dock', ".sheet__seg > button[data-active='true']", `${W} .dk-seg > button[data-active='true']`, ['color', 'background', 'box-shadow']],
  ['dock', '.sheet__foot', `${W} .dk-sheet__foot`, ['height', 'padding', 'border-top']],
  ['dock', '.prow', `${W} .dk-prow`, ['grid-template-columns', 'height', 'padding', 'border-radius']],
  ['dock', ".prow[data-current='true']", `${W} .dk-prow[data-current='true']`, ['box-shadow']],
  ['dock', '.prow__name', `${W} .dk-prow__name`, ['font-family', 'font-size', 'font-weight', 'letter-spacing']],
  ['dock', '.prow__here', `${W} .dk-prow__here`, ['font-size', 'letter-spacing', 'color']],
  ['dock', '.dock', `${W} .dk-dock`, ['position', 'bottom', 'left', 'z-index', 'transform']],
  ['dock', '.dock__composer::before', `${W} .dk-dock .composer__card::before`, ['left', 'right', 'height', 'background', 'opacity']],
  ['dock', '.dock__project-dot', `${W} .dk-project__dot`, ['border-radius', 'background', 'box-shadow']],
  ['dock', '.dock__chev', `${W} .dk-project__chev`, ['transform', 'transition']],
  ['comp', '.dock__composer.comp', `${W} .dk-dock .composer__card`, ['padding', 'border-radius']],
  ['comp', '.comp__project', `${W} .dk-project`, ['height', 'padding', 'max-width', 'border-radius', 'background', 'box-shadow']],
  ['comp', '.comp__project .dock__project-name', `${W} .dk-project__name`, ['font-size']],
  ['shell', '.deck__stage', `${W} .dk-stage`, ['padding']],
  ['shell', '.dtoast', `${W} .notice`, ['right', 'padding', 'border-radius', 'background', 'border', 'max-width']],
  ['shell', '.dtoast__mark', `${W} .notice::before`, ['width', 'height', 'transform', 'border-radius', 'background', 'box-shadow']]
]
for (const [src, deckSel, webSel, props] of pairs) {
  const theirs = rule(SRC[src], deckSel)
  const ours = rules(web).find((r) => r.selector === norm(webSel))
  if (!theirs || !ours) {
    log(false, `${deckSel} → ${webSel}: ${!theirs ? 'gone from the deck' : 'gone from the web deck'}`)
    continue
  }
  // The web deck's own keyframes are the deck's under a `dk-` name.
  const same = (p) => theirs.decls[p] === ours.decls[p]?.replace(/\bdk-/g, '')
  const moved = props.filter((p) => !same(p))
  log(
    moved.length === 0,
    `${deckSel} matches ${webSel.replace(W, '').trim()}${moved.length ? ` — moved: ${moved.map((p) => `${p} deck "${theirs.decls[p]}" web "${ours.decls[p]}"`).join('; ')}` : ''}`
  )
}

// The bar's width: hub/Composer.css says it on `.dock__composer.comp`; the web deck keeps it as a token.
{
  const theirs = rule(SRC.comp, '.dock__composer.comp')?.decls.width
  const ours = rule(web, W)?.decls['--dk-bar-w']
  log(theirs !== undefined && theirs === ours, `the bar is as wide as the deck's (${theirs} / ${ours})`)
}

/* ------------------------------------------- 4. backdrop and state shapes agree */

const deckTsx = read('web/src/deck/Deck.tsx')
const calm = SRC.backdrop.match(/function Calm[\s\S]*?\n}\n/)?.[0] ?? ''
const calmParts = [
  'radial-gradient(80% 60% at 50% -10%',
  'pal.light ? 0.08 : 0.1',
  'radial-gradient(120% 90% at 50% 120%',
  'pal.light ? 0.04 : 0.35',
  'pal.light ? 0.06 : 0.06'
]
const calmMoved = calmParts.filter((p) => !calm.includes(p))
log(calm !== '' && calmMoved.length === 0, `Backdrop.tsx's Calm scene is still the one the web deck paints${calmMoved.length ? `: moved ${calmMoved.join(' | ')}` : ''}`)
log(
  deckTsx.includes('light ? 0.08 : 0.1') && deckTsx.includes('light ? 0.04 : 0.35') && deckTsx.includes('0.06)'),
  'and the web deck paints it with the same amounts'
)

const panes = read('web/src/deck/PanesSheet.tsx')
const shapes = ['M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z', 'cx="5" cy="5" r="3.2" fill="none"', 'x="1.5" y="4.2" width="7" height="1.6" rx="0.8"']
const shapesMoved = shapes.filter((s) => !SRC.stateChip.includes(s) || !panes.includes(s))
log(shapesMoved.length === 0, `the pane rows draw StateChip's own shapes${shapesMoved.length ? `: moved ${shapesMoved.join(' | ')}` : ''}`)

console.log(failures === 0 ? '\nweb-deck-check — the web deck matches the deck' : `\nweb-deck-check — ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
