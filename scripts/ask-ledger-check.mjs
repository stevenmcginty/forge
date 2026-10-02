/**
 * The phone's "is this pane asking" set, across a dropped socket.
 *
 *   npm run ask-ledger:check
 *
 * The bug this exists for (2026-10-02, pane "Xander"): the phone showed
 * "Claude Code is asking — Do you want to proceed?" long after the question
 * was answered and the agent had finished, and "1 waiting" with it. The
 * desktop had cleared the pane — its `idle` attention frame went out while the
 * phone's socket was dead (dev.log: the `done` push for the same pane says
 * "on screen 0") — and a frame sent to a dead socket is gone. On reconnect the
 * desktop re-states only the panes *still* asking (electron/web/server.ts,
 * after `hello-ok`), so a pane that stopped asking in the gap is never
 * mentioned again, and the page kept it forever.
 *
 * The desktop side is modelled here exactly as server.ts behaves: an
 * `askingNow` map that an attention transition writes and a hello re-states.
 * The page side is the real web/src/lib/ask-ledger.ts that state.tsx uses.
 */
import { build } from 'esbuild'
import { resolve } from 'node:path'

// Bundled rather than imported: web/ is not an ES-module package to Node, so
// the .ts is handed over the way scripts/web-phone-six-check.mjs does it.
const ROOT = resolve(import.meta.dirname, '..')
const bundled = await build({
  entryPoints: [resolve(ROOT, 'web/src/lib/ask-ledger.ts')],
  write: false,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'silent',
  absWorkingDir: ROOT
})
const { AskLedger } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

let failed = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** The desktop's half: server.ts `askingNow` plus the hello re-statement. */
function desktop() {
  const askingNow = new Map()
  return {
    attention(id, asking, prompt = '') {
      if (asking) askingNow.set(id, prompt)
      else askingNow.delete(id)
    },
    restate() {
      return [...askingNow.keys()]
    }
  }
}

/** A reconnect as the page sees it: hello-ok, the re-statements, then the beat-late settle. */
function reconnect(ledger, desk) {
  ledger.hello()
  const buzzed = []
  for (const id of desk.restate()) if (!ledger.attention(id, true)) buzzed.push(id)
  const dropped = ledger.settle()
  // As state.tsx does: each one goes through the idle-frame path.
  for (const id of dropped) ledger.attention(id, false)
  return { buzzed, dropped }
}

console.log('ask-ledger: a question answered while the phone was away')
{
  const desk = desktop()
  const page = new AskLedger()
  desk.attention('xander', true, 'Do you want to proceed?')
  page.attention('xander', true)
  // The socket dies. The question is answered on the desktop; the idle frame
  // is broadcast to nobody.
  desk.attention('xander', false)
  const { dropped } = reconnect(page, desk)
  check('the pane is no longer asking after the reconnect', !page.now.has('xander'), `page still holds ${[...page.now].join(', ')}`)
  check('it is reported as dropped, so the card and pill clear', dropped.includes('xander'), `dropped=${JSON.stringify(dropped)}`)
}

console.log('ask-ledger: a question still open across a reconnect')
{
  const desk = desktop()
  const page = new AskLedger()
  desk.attention('xander', true, 'Do you want to proceed?')
  page.attention('xander', true)
  const { buzzed, dropped } = reconnect(page, desk)
  check('still asking', page.now.has('xander'))
  check('not dropped', !dropped.includes('xander'))
  check('the re-statement does not buzz again', buzzed.length === 0, `buzzed=${JSON.stringify(buzzed)}`)
}

console.log('ask-ledger: a new question that lands before the settle')
{
  const page = new AskLedger()
  page.hello()
  const was = page.attention('viggo', true)
  check('a first ask after hello is new (buzzes)', was === false)
  check('kept by the settle', !page.settle().includes('viggo') && page.now.has('viggo'))
}

console.log('ask-ledger: two hellos before one settle')
{
  const page = new AskLedger()
  page.attention('a', true)
  page.attention('b', true)
  page.hello()
  page.hello()
  page.attention('a', true)
  const dropped = page.settle()
  for (const id of dropped) page.attention(id, false)
  check('the re-stated pane stays', page.now.has('a'))
  check('the unmentioned pane goes', !page.now.has('b') && dropped.includes('b'), `dropped=${JSON.stringify(dropped)}`)
}

console.log('ask-ledger: ordinary frames on a live link')
{
  const page = new AskLedger()
  check('asking edge reports not-was', page.attention('x', true) === false)
  check('repeat reports was', page.attention('x', true) === true)
  page.attention('x', false)
  check('idle clears', !page.now.has('x'))
  check('a settle with no hello drops nothing', page.settle().length === 0)
  page.attention('y', true)
  check('a second settle after one already ran drops nothing', page.settle().length === 0 && page.now.has('y'))
}

if (failed) {
  console.log(`\nask-ledger: ${failed} failed`)
  process.exit(1)
}
console.log('\nask-ledger: all passed')
