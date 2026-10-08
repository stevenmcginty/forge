/**
 * The mini bar's talk keys take the same road as the main window's.
 *
 *   node scripts/minibar-keys-check.mjs
 *
 * While Forge is minimised the main window hears no keys. The mini bar's
 * window (src/minibar/useMiniKeys.ts, through createKeyForwarder) and the
 * global hook send raw presses instead, and the host replays them into a
 * private target (createRemoteKeyFeed) where useDictation attaches the same
 * `attachTalkKey` it attaches to `window`.
 *
 * Each case below plays one physical key sequence, in real time, into both
 * roads at once: as window events straight into attachTalkKey, and through
 * the forwarder and the feed. Both must give the same intents, and the
 * intents a person would expect. Then the feed alone, as the global hook
 * drives it: stray and doubled releases, repeats, `otherKey` with nothing
 * down, and the release on reset.
 */
import { registerHooks } from 'node:module'

const SHARED = new URL('../shared', import.meta.url).href

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) return next(`${SHARED}/${spec.slice('@shared/'.length)}.ts`, context)
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const G = await import('../src/lib/stt-gesture.ts')
const K = await import('../src/lib/miniBarKeys.ts')

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
const same = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * One road: a target with both talk keys attached the way useDictation
 * attaches them (Dictate with no cancel, Listen with one), and a log of what
 * they fired. Each key keeps its own "listening" flag, moved by its intents.
 */
function road(target, keys) {
  const log = []
  const offs = []
  const attach = (code, withCancel) => {
    let listening = false
    const apply = (intent) => {
      log.push(`${code}:${intent}`)
      if (intent === 'toggle') listening = !listening
      else listening = intent === 'ptt-start'
    }
    const cancel = withCancel
      ? () => {
          log.push(`${code}:cancel`)
          listening = false
        }
      : undefined
    offs.push(G.attachTalkKey(target, code, () => listening, apply, cancel))
  }
  attach(keys.dictate, false)
  attach(keys.listen, true)
  return { log, off: () => offs.forEach((off) => off?.()) }
}

/** A window-shaped key event: what Chromium hands attachTalkKey. */
function rawEvent(e) {
  if (e.type === 'pointer') return new Event('pointerdown')
  return Object.assign(new Event(e.type), {
    code: e.code,
    repeat: e.repeat === true,
    ctrlKey: e.ctrlKey === true,
    altKey: e.altKey === true,
    shiftKey: e.shiftKey === true,
    metaKey: e.metaKey === true
  })
}

/**
 * Play `steps` ({ at: ms, ...event }) into the window road and, through the
 * forwarder and the feed, into the remote road. Returns both logs.
 */
async function play(steps, keys = { dictate: 'AltRight', listen: 'ShiftRight' }) {
  const win = new EventTarget()
  const remote = new EventTarget()
  const winRoad = road(win, keys)
  const remoteRoad = road(remote, keys)
  const forward = K.createKeyForwarder(() => keys)
  const feed = K.createRemoteKeyFeed(remote)
  const t0 = Date.now()
  for (const step of steps) {
    const wait = t0 + step.at - Date.now()
    if (wait > 0) await sleep(wait)
    win.dispatchEvent(rawEvent(step))
    const out =
      step.type === 'pointer' ? forward.pointer() : step.type === 'keydown' ? forward.keydown(rawEvent(step)) : forward.keyup(rawEvent(step))
    for (const k of out) feed.feed(k)
  }
  await sleep(60)
  winRoad.off()
  remoteRoad.off()
  return { win: winRoad.log, remote: remoteRoad.log }
}

const down = (at, code, mods = {}) => ({ at, type: 'keydown', code, ...mods })
const rep = (at, code, mods = {}) => ({ at, type: 'keydown', code, repeat: true, ...mods })
const up = (at, code, mods = {}) => ({ at, type: 'keyup', code, ...mods })
const HOLD = 650

const cases = [
  ['Dictate key tapped', [down(0, 'AltRight', { altKey: true }), up(100, 'AltRight')], ['AltRight:toggle']],
  ['Dictate key held', [down(0, 'AltRight', { altKey: true }), up(HOLD, 'AltRight')], ['AltRight:ptt-start', 'AltRight:ptt-end']],
  [
    'another key before the hold: a combo, nothing fires',
    [down(0, 'AltRight', { altKey: true }), down(100, 'KeyA', { altKey: true }), up(150, 'KeyA', { altKey: true }), up(200, 'AltRight')],
    []
  ],
  [
    'another key during a Dictate hold: the hold ends (ptt-end)',
    [down(0, 'AltRight', { altKey: true }), down(600, 'KeyA', { altKey: true }), up(620, 'KeyA', { altKey: true }), up(700, 'AltRight')],
    ['AltRight:ptt-start', 'AltRight:ptt-end']
  ],
  [
    'another key during a Listen hold: the start is cancelled',
    [down(0, 'ShiftRight', { shiftKey: true }), down(600, 'KeyA', { shiftKey: true }), up(620, 'KeyA', { shiftKey: true }), up(700, 'ShiftRight')],
    ['ShiftRight:ptt-start', 'ShiftRight:cancel']
  ],
  ['Listen key tapped', [down(0, 'ShiftRight', { shiftKey: true }), up(100, 'ShiftRight')], ['ShiftRight:toggle']],
  [
    "AltGr held: the fake Left Ctrl and its repeats do not end the hold",
    [
      down(0, 'ControlLeft', { ctrlKey: true }),
      down(1, 'AltRight', { altKey: true }),
      rep(200, 'ControlLeft', { ctrlKey: true, altKey: true }),
      rep(300, 'ControlLeft', { ctrlKey: true, altKey: true }),
      rep(400, 'ControlLeft', { ctrlKey: true, altKey: true }),
      rep(500, 'ControlLeft', { ctrlKey: true, altKey: true }),
      rep(600, 'ControlLeft', { ctrlKey: true, altKey: true }),
      up(HOLD, 'ControlLeft', { altKey: true }),
      up(HOLD + 1, 'AltRight')
    ],
    ['AltRight:ptt-start', 'AltRight:ptt-end']
  ],
  [
    'AltGr tapped',
    [down(0, 'ControlLeft', { ctrlKey: true }), down(1, 'AltRight', { altKey: true }), up(100, 'ControlLeft', { altKey: true }), up(101, 'AltRight')],
    ['AltRight:toggle']
  ],
  [
    'AltGr reported with Ctrl held on the Right Alt press: both roads read it the same',
    [down(0, 'ControlLeft', { ctrlKey: true }), down(1, 'AltRight', { ctrlKey: true, altKey: true }), up(100, 'ControlLeft', { altKey: true }), up(101, 'AltRight')],
    []
  ],
  [
    'Ctrl held, then Right Shift: a combo',
    [down(0, 'ControlLeft', { ctrlKey: true }), down(50, 'ShiftRight', { ctrlKey: true, shiftKey: true }), up(100, 'ShiftRight', { ctrlKey: true }), up(150, 'ControlLeft')],
    []
  ],
  [
    'Right Alt held, then Right Shift: neither fires',
    [down(0, 'AltRight', { altKey: true }), down(100, 'ShiftRight', { altKey: true, shiftKey: true }), up(200, 'ShiftRight', { altKey: true }), up(300, 'AltRight')],
    []
  ],
  ['a mouse press during a hold ends it', [down(0, 'AltRight', { altKey: true }), { at: 600, type: 'pointer' }, up(700, 'AltRight')], ['AltRight:ptt-start', 'AltRight:ptt-end']],
  [
    "the talk key's own auto-repeat is not a new press",
    [down(0, 'AltRight', { altKey: true }), rep(500, 'AltRight', { altKey: true }), rep(550, 'AltRight', { altKey: true }), up(HOLD, 'AltRight')],
    ['AltRight:ptt-start', 'AltRight:ptt-end']
  ]
]

console.log('\nthe bar window road matches the main window road')
for (const [label, steps, want] of cases) {
  const got = await play(steps)
  same(got.remote, got.win, `${label}: same intents`)
  same(got.win, want, `${label}: ${want.length ? want.join(', ') : 'nothing'}`)
}

console.log('\na direct talk key (F8)')
{
  const keys = { dictate: 'F8', listen: 'ShiftRight' }
  let got = await play([down(0, 'F8'), up(100, 'F8')], keys)
  same(got.remote, got.win, 'tap: same intents')
  same(got.win, ['F8:toggle'], 'tap: toggle')
  got = await play([down(0, 'F8'), up(800, 'F8')], keys)
  same(got.remote, got.win, 'long press: same intents')
  same(got.win, ['F8:toggle', 'F8:ptt-end'], 'long press: toggle, then ptt-end on release')
}

console.log('\nthe feed alone, as the global hook drives it')
{
  const keys = { dictate: 'AltRight', listen: 'ShiftRight' }
  const run = async (script) => {
    const target = new EventTarget()
    const r = road(target, keys)
    const feed = K.createRemoteKeyFeed(target)
    const t0 = Date.now()
    for (const [at, k] of script) {
      const wait = t0 + at - Date.now()
      if (wait > 0) await sleep(wait)
      if (k === 'reset') feed.reset()
      else feed.feed(k)
    }
    await sleep(60)
    r.off()
    return r.log
  }
  const kd = (code) => ({ t: 'talkKey', code, phase: 'down' })
  const ku = (code) => ({ t: 'talkKey', code, phase: 'up' })

  same(await run([[0, ku('AltRight')]]), [], 'a release with no press is ignored')
  same(await run([[0, kd('AltRight')], [100, ku('AltRight')], [110, ku('AltRight')]]), ['AltRight:toggle'], 'a doubled release fires once')
  same(await run([[0, kd('AltRight')], [200, kd('AltRight')], [400, kd('AltRight')], [HOLD, ku('AltRight')]]), ['AltRight:ptt-start', 'AltRight:ptt-end'], 'a repeated press does not restart the hold')
  same(await run([[0, { t: 'otherKey' }], [10, kd('AltRight')], [100, ku('AltRight')]]), ['AltRight:toggle'], 'otherKey with nothing held means nothing')
  same(await run([[0, kd('AltRight')], [100, { t: 'otherKey' }], [200, ku('AltRight')]]), [], 'otherKey before the hold makes a combo')
  same(await run([[0, kd('ShiftRight')], [600, { t: 'otherKey' }], [700, ku('ShiftRight')]]), ['ShiftRight:ptt-start', 'ShiftRight:cancel'], 'otherKey during a Listen hold cancels it')
  same(await run([[0, kd('AltRight')], [HOLD, 'reset'], [HOLD + 50, ku('AltRight')]]), ['AltRight:ptt-start', 'AltRight:ptt-end'], 'reset lets go of a held key, once')
  same(await run([[0, { t: 'summon' }]]), [], 'summon is not a talk key')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
