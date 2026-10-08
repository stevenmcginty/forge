/**
 * Check for the mini bar's spoken updates (docs/MINI-BAR.md, 4.11 and 7).
 *
 *   node scripts/announcer-check.mjs
 *
 * src/state/announcer.ts turns an agent's news into what Forge says while it
 * is minimised. The words are templates and the timing is a few rules — never
 * over Steve, merged, nothing late, nothing the Brain already says — so the
 * module has no React and no DOM, and this file holds it to them on a fake
 * clock.
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

const { createAnnouncer, lineFor, replyGist, speechFor, burstLine, STALE_MS, GATHER_MS } = await import(
  '../src/state/announcer.ts'
)

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
const is = (got, want, label) => ok(got === want, label, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

console.log('templates')
is(lineFor({ kind: 'done', paneId: 'p1', name: 'Jonah', at: 0 }), 'Jonah is done.', 'done, no reply')
is(
  lineFor({ kind: 'done', paneId: 'p1', name: 'Jonah', at: 0, reply: 'Fixed the login redirect, and tests pass.' }),
  'Jonah is done. Jonah says: Fixed the login redirect, and tests pass.',
  "done on a Claude pane quotes the reply in the pane's name"
)
is(
  lineFor({ kind: 'done', paneId: 'p1', name: 'Jonah', at: 0, reply: 'One. Two. Three.\n\n- a list' }),
  'Jonah is done. Jonah says: One. Two.',
  'the reply is cut to two sentences, before any list'
)
is(
  replyGist('Changed `src/app.ts` and ran the tests. All green.\n\n```ts\ncode\n```'),
  'Changed and ran the tests. All green.',
  'code and paths are not read aloud'
)
is(replyGist('Done'), 'Done', 'a reply with no full stop is kept')
is(lineFor({ kind: 'done', paneId: 'p1', name: 'Jonah', at: 0, reply: 'Done' }), 'Jonah is done. Jonah says: Done.', '…and given one')
is(
  lineFor({ kind: 'asking', paneId: 'p2', name: 'Ruth', at: 0, prompt: 'Allow an edit to login.ts?' }),
  'Ruth is asking: Allow an edit to login.ts?',
  'asking quotes the one-line question'
)
is(lineFor({ kind: 'asking', paneId: 'p2', name: 'Ruth', at: 0 }), 'Ruth is asking.', 'asking with no question')
is(lineFor({ kind: 'stopped', paneId: 'p3', name: 'Ivy', at: 0 }), 'Ivy stopped.', 'stopped')
ok(
  !/\b(he|she|his|her)\b/i.test(
    [
      lineFor({ kind: 'done', paneId: 'p1', name: 'Jonah', at: 0, reply: 'Done.' }),
      lineFor({ kind: 'asking', paneId: 'p2', name: 'Ruth', at: 0, prompt: 'Go?' }),
      lineFor({ kind: 'stopped', paneId: 'p3', name: 'Ivy', at: 0 }),
      burstLine('done', ['A', 'B', 'C'])
    ].join(' ')
  ),
  'never he or she'
)

console.log('burst merge')
is(burstLine('done', ['Jonah', 'Ruth', 'Ivy']), 'Three agents are done: Jonah, Ruth and Ivy.', 'three done')
is(burstLine('asking', ['A', 'B', 'C', 'D']), 'Four agents are asking: A, B, C and D.', 'four asking')
is(burstLine('stopped', Array.from({ length: 12 }, (_, i) => `P${i}`)).slice(0, 17), '12 agents stopped', 'past ten, digits')
is(
  speechFor([
    { kind: 'done', paneId: 'a', name: 'Jonah', at: 1 },
    { kind: 'done', paneId: 'b', name: 'Ruth', at: 2 },
    { kind: 'done', paneId: 'c', name: 'Ivy', at: 3 }
  ]),
  'Three agents are done: Jonah, Ruth and Ivy.',
  'three of one kind are one line'
)
is(
  speechFor([
    { kind: 'done', paneId: 'a', name: 'Jonah', at: 1 },
    { kind: 'stopped', paneId: 'c', name: 'Ivy', at: 3 },
    { kind: 'asking', paneId: 'b', name: 'Ruth', at: 2, prompt: 'Go on?' }
  ]),
  'Jonah is done. Ruth is asking: Go on? Ivy stopped.',
  'fewer than three: one line each, oldest first'
)
is(
  speechFor([
    { kind: 'done', paneId: 'a', name: 'Jonah', at: 1 },
    { kind: 'asking', paneId: 'a', name: 'Jonah', at: 2, prompt: 'Commit it?' }
  ]),
  'Jonah is asking: Commit it?',
  "one line per pane: its newest news"
)

console.log('the queue')
const rig = (opts = {}) => {
  const clock = { t: 100_000 }
  const said = []
  const flags = { on: true, quiet: true, brain: new Set(), ...opts }
  const a = createAnnouncer({
    now: () => clock.t,
    on: () => flags.on,
    quiet: () => flags.quiet,
    brainOwns: (id) => flags.brain.has(id),
    say: (text) => said.push(text)
  })
  return { a, clock, said, flags }
}
{
  const { a, clock, said } = rig()
  a.push({ kind: 'done', paneId: 'a', name: 'Jonah', at: clock.t })
  a.tick()
  is(said.length, 0, 'waits GATHER_MS for the news to settle')
  clock.t += GATHER_MS
  a.tick()
  is(said.join('|'), 'Jonah is done.', 'then says it')
  is(a.pending(), 0, 'and empties the queue')
}
{
  const { a, clock, said } = rig()
  for (const [id, name] of [['a', 'Jonah'], ['b', 'Ruth'], ['c', 'Ivy']]) {
    a.push({ kind: 'done', paneId: id, name, at: clock.t })
    clock.t += 1000
    a.tick()
  }
  clock.t += GATHER_MS
  a.tick()
  is(said.join('|'), 'Three agents are done: Jonah, Ruth and Ivy.', 'a burst inside the gather is said once')
}
{
  const { a, clock, said, flags } = rig({ quiet: false })
  a.push({ kind: 'done', paneId: 'a', name: 'Jonah', at: clock.t })
  clock.t += 10_000
  a.tick()
  is(said.length, 0, 'quiet queue: nothing while Steve or Forge is talking')
  a.push({ kind: 'stopped', paneId: 'b', name: 'Ivy', at: clock.t })
  flags.quiet = true
  clock.t += GATHER_MS
  a.tick()
  is(said.join('|'), 'Jonah is done. Ivy stopped.', 'then the waiting lines go as one')
}
{
  const { a, clock, said, flags } = rig({ quiet: false })
  a.push({ kind: 'done', paneId: 'a', name: 'Jonah', at: clock.t })
  clock.t += 30_000
  a.push({ kind: 'asking', paneId: 'b', name: 'Ruth', at: clock.t, prompt: 'Go?' })
  clock.t += STALE_MS - 30_000 + 1
  flags.quiet = true
  a.tick()
  is(said.join('|'), 'Ruth is asking: Go?', 'the 60 s drop: older news is never said late')
  clock.t += STALE_MS + 1
  a.push({ kind: 'done', paneId: 'c', name: 'Ivy', at: clock.t - STALE_MS - 1 })
  a.tick()
  is(said.length, 1, 'news already past 60 s is dropped')
  is(a.pending(), 0, 'and does not linger')
}
{
  const { a, clock, said, flags } = rig()
  flags.brain.add('a')
  a.push({ kind: 'done', paneId: 'a', name: 'Jonah', at: clock.t })
  a.push({ kind: 'done', paneId: 'b', name: 'Ruth', at: clock.t })
  clock.t += GATHER_MS
  a.tick()
  is(said.join('|'), 'Ruth is done.', 'Brain overlap: a pane the Brain opened is left to the Brain')
}
{
  const { a, clock, said, flags } = rig({ on: false })
  a.push({ kind: 'done', paneId: 'a', name: 'Jonah', at: clock.t })
  clock.t += GATHER_MS
  a.tick()
  is(said.length, 0, 'Speak updates off (or not minimised): nothing is queued or said')
  flags.on = true
  a.push({ kind: 'done', paneId: 'a', name: 'Jonah', at: clock.t })
  flags.on = false
  clock.t += GATHER_MS
  a.tick()
  is(said.length + a.pending(), 0, 'turning it off drops what was waiting')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
