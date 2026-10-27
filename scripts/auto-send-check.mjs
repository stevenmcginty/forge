/**
 * The TV box's Auto-send timer (mobile/src/lib/auto-send.ts), on a fake clock:
 * a 3+ character burst arms 1.2 s, a key or small change disarms, a new burst
 * restarts the wait, and the send happens once.
 *
 *   npm run auto-send:check
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-smoke')
mkdirSync(scratch, { recursive: true })
const outfile = join(scratch, 'auto-send.mjs')
await build({
  entryPoints: [join(ROOT, 'mobile/src/lib/auto-send.ts')],
  outfile,
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  logLevel: 'silent'
})
const { createAutoSend, isBurst, isImeKey, AUTO_SEND_MS } = await import(pathToFileURL(outfile).href)

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

/** A clock that only moves when told to. */
function fakeClock() {
  let now = 0
  let next = 1
  const timers = new Map()
  return {
    setTimer: (fn, ms) => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      now += ms
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id)
          t.fn()
        }
      }
    }
  }
}

function rig() {
  const clock = fakeClock()
  let sent = 0
  const auto = createAutoSend({ send: () => sent++, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  return { auto, clock, sent: () => sent }
}

log(AUTO_SEND_MS === 1200, 'the quiet wait is 1.2 s')
log(isBurst('', 'hey') && isBurst('ab', 'ab cd') && !isBurst('ab', 'abc') && !isBurst('abcdef', 'abc'), 'a burst is 3+ characters added at once; typing and deleting are not')
log(isImeKey({ keyCode: 229 }) && isImeKey({ key: 'Unidentified' }) && !isImeKey({ key: 'ArrowDown', keyCode: 40 }), 'IME key events are told apart from D-pad presses')

{
  const { auto, clock, sent } = rig()
  auto.change('', 'show phone numbers on the customer sheet')
  clock.advance(1199)
  log(sent() === 0, 'a dictation burst does not send before 1.2 s of quiet')
  clock.advance(1)
  log(sent() === 1, '...and sends once at 1.2 s')
  clock.advance(5000)
  log(sent() === 1, '...and only once')
}
{
  const { auto, clock, sent } = rig()
  auto.change('', 'show phone')
  clock.advance(800)
  auto.change('show phone', 'show phone numbers on the sheet')
  clock.advance(800)
  log(sent() === 0, 'a second burst inside the wait restarts it')
  clock.advance(400)
  log(sent() === 1, '...and it sends 1.2 s after the last burst')
}
{
  const { auto, clock, sent } = rig()
  auto.change('', 'show phone numbers')
  clock.advance(500)
  auto.cancel() // a D-pad press
  clock.advance(5000)
  log(sent() === 0, 'a key press cancels it')
}
{
  const { auto, clock, sent } = rig()
  auto.change('', 'show phone numbers')
  clock.advance(500)
  auto.change('show phone numbers', 'show phone numbers!')
  clock.advance(5000)
  log(sent() === 0, 'a small change (typing a character) cancels it')
}
{
  const { auto, clock, sent } = rig()
  let typed = '' // one key at a time
  for (const ch of 'hello there') {
    auto.change(typed, typed + ch)
    typed += ch
  }
  clock.advance(5000)
  log(sent() === 0, 'ordinary typing never arms it')
}
{
  const { auto, clock, sent } = rig()
  auto.burst('  hi ')
  clock.advance(5000)
  log(sent() === 0, 'a voice segment under 3 characters does not arm it')
  auto.burst('show phone numbers')
  log(auto.armed(), 'a voice segment of 3+ characters arms it')
  clock.advance(1200)
  log(sent() === 1, '...and sends at 1.2 s')
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
