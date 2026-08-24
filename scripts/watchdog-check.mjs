/**
 * The renderer watchdog, driven on a clock this script owns.
 *
 *   npm run watchdog:check
 *
 * electron/renderer-watchdog.ts decides whether Forge's window is still Forge,
 * and every decision it makes is a duration: eight seconds of silence, five
 * seconds of hanging, a thirty-second cooldown, three reloads in five minutes.
 * A check that sat through those would take the best part of six minutes and
 * would be the first thing anybody skipped, so the whole module takes its time
 * by injection (`WatchdogClock`) and this drives it with virtual time. Nothing
 * here sleeps.
 *
 * The window and its webContents are doubles too — a handful of methods and two
 * event emitters. That is the entire Electron surface the watchdog touches, and
 * keeping it that small is deliberate: a watchdog that needed a real
 * BrowserWindow to be provable would be a watchdog nobody proved.
 *
 * What is worth asserting here is not "does it reload" but the four judgement
 * calls, because each is a decision that costs something real when it is wrong:
 *
 *   - **Silence from a window you can see is death.** The failure that started
 *     this: a mounted-but-empty React tree in a live, responsive process.
 *   - **Silence from a window you cannot see is not.** Forge spends real time
 *     minimised and hidden to the tray, where the OS may stop the beat itself.
 *     Reloading there would mean the desktop restarted every time it was put
 *     away.
 *   - **An unhealthy beat is louder than silence.** The root boundary caught
 *     something and said so; there is nothing left to wait for.
 *   - **It has to be able to give up.** A renderer broken on the ground comes
 *     back broken, and a watchdog with no ceiling turns that into a reload loop
 *     nobody can interrupt.
 *
 * And one that is not a duration at all: a crashed *process* escalates
 * differently from a hung or silent one — it destroys the window on a second
 * death so the quit path runs, rather than leaving a windowless Forge holding
 * port 5173. That policy predates this module and moved into it unchanged; it
 * is asserted here so it cannot quietly be softened into the rule beside it.
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

const {
  armRendererWatchdog,
  HEARTBEAT_SILENCE_MS,
  UNRESPONSIVE_GRACE_MS,
  RELOAD_COOLDOWN_MS,
  RELOAD_WINDOW_MS,
  RELOAD_LIMIT,
  CRASH_RELOAD_DELAY_MS
} = await import('../electron/renderer-watchdog.ts')

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

/* --------------------------------------------------------------- the clock
 *
 * Virtual time with a proper ordered queue rather than "run every callback
 * once": the watchdog's sweep is an interval that must fire repeatedly inside a
 * single `advance`, and a cooldown that expires mid-advance has to be seen by
 * the sweeps that follow it, not by the one that came before.
 */
function makeClock() {
  let now = 0
  let seq = 0
  const timers = new Map()

  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq
      timers.set(id, { at: now + ms, fn, every: 0 })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    setInterval(fn, ms) {
      const id = ++seq
      timers.set(id, { at: now + ms, fn, every: ms })
      return id
    },
    clearInterval(id) {
      timers.delete(id)
    },
    /** Run every timer due inside the next `ms`, in the order they come due. */
    advance(ms) {
      const target = now + ms
      for (;;) {
        let dueId = null
        let due = null
        for (const [id, timer] of timers) {
          if (timer.at > target) continue
          if (due === null || timer.at < due.at) {
            dueId = id
            due = timer
          }
        }
        if (due === null) break
        now = due.at
        if (due.every > 0) due.at = now + due.every
        else timers.delete(dueId)
        due.fn()
      }
      now = target
    }
  }
}

/* -------------------------------------------------------------- the window */

function makeWindow({ visible = true, minimized = false } = {}) {
  const winListeners = new Map()
  const wcListeners = new Map()
  const add = (map, event, fn) => {
    const list = map.get(event) ?? []
    list.push(fn)
    map.set(event, list)
  }
  const fire = (map, event, args) => {
    for (const fn of map.get(event) ?? []) fn(...args)
  }

  const win = {
    visible,
    minimized,
    destroyed: false,
    reloads: 0,
    destroyed_calls: 0,
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isMinimized: () => win.minimized,
    destroy() {
      win.destroyed_calls++
      win.destroyed = true
    },
    on(event, fn) {
      add(winListeners, event, fn)
    },
    emit(event, ...args) {
      fire(winListeners, event, args)
    },
    webContents: {
      isDestroyed: () => win.destroyed,
      reload() {
        win.reloads++
      },
      on(event, fn) {
        add(wcListeners, event, fn)
      },
      emit(event, ...args) {
        fire(wcListeners, event, args)
      }
    }
  }
  return win
}

/**
 * One armed watchdog over one fake window, with everything the assertions need.
 *
 * `loaded()` is called by default because the watchdog deliberately judges
 * nothing before the first `did-finish-load` — an empty window that has not
 * loaded yet is not a dead one — and every scenario below except the explicit
 * test of that rule wants to start from a Forge that came up.
 */
function arm({ visible = true, minimized = false, load = true } = {}) {
  const clock = makeClock()
  const win = makeWindow({ visible, minimized })
  const states = []
  const logs = []
  const dog = armRendererWatchdog(win, {
    clock,
    onState: (state, reason) => states.push({ state, reason: reason ?? '' }),
    log: (line) => logs.push(line)
  })
  if (load) win.webContents.emit('did-finish-load')
  return { clock, win, dog, states, logs, beat: (b) => dog.heartbeat(b ?? { healthy: true }) }
}

/** Beat healthily every 2s across `ms`, exactly as the React root does. */
function beatThrough(rig, ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 2000) {
    rig.clock.advance(2000)
    rig.beat()
  }
}

/* ------------------------------------------------------ a healthy renderer */

console.log('\na renderer that keeps beating')
{
  const rig = arm()
  beatThrough(rig, 5 * 60_000)
  ok(rig.win.reloads === 0, 'five minutes of steady heartbeats causes no reload', `reloads=${rig.win.reloads}`)
  ok(rig.states.length === 0, 'and the clients are told nothing at all', JSON.stringify(rig.states))
  rig.dog.dispose()
}

{
  const rig = arm()
  // Just inside the limit, repeatedly: the sweep must not accumulate impatience.
  for (let i = 0; i < 20; i++) {
    rig.clock.advance(HEARTBEAT_SILENCE_MS - 500)
    rig.beat()
  }
  ok(rig.win.reloads === 0, 'a beat arriving just inside the silence window is always in time')
  rig.dog.dispose()
}

/* -------------------------------------------------- a renderer gone quiet */

console.log('\nsilence from a window you can see')
{
  const rig = arm()
  rig.clock.advance(HEARTBEAT_SILENCE_MS - 1000)
  ok(rig.win.reloads === 0, 'not reloaded a second before the silence limit')
  rig.clock.advance(2000)
  ok(rig.win.reloads === 1, 'reloaded once past it', `reloads=${rig.win.reloads}`)
  ok(rig.states[0]?.state === 'recovering', 'the clients are told the desktop is recovering')
  ok(
    /heartbeat/i.test(rig.states[0]?.reason ?? ''),
    'and the reason says what happened',
    rig.states[0]?.reason ?? '(none)'
  )
  ok(
    rig.logs.some((line) => line.startsWith('[watchdog] ') && /reloading/.test(line)),
    'the decision is logged under [watchdog]',
    rig.logs.join(' | ')
  )

  // The document comes back and React mounts: 'ready' waits for a real beat,
  // not for the load — a load that mounts nothing is this whole bug.
  rig.win.webContents.emit('did-finish-load')
  ok(rig.states.length === 1, 'a finished load alone does not say the desktop is ready')
  rig.beat()
  ok(rig.states[1]?.state === 'ready', 'the first healthy heartbeat does', JSON.stringify(rig.states))
  rig.dog.dispose()
}

console.log('\nsilence from a window you cannot see')
{
  const rig = arm({ visible: false })
  rig.clock.advance(10 * 60_000)
  ok(rig.win.reloads === 0, 'a hidden window that says nothing for ten minutes is left alone')
  ok(rig.states.length === 0, 'and nothing is broadcast about it')
  rig.dog.dispose()
}

{
  const rig = arm({ minimized: true })
  rig.clock.advance(10 * 60_000)
  ok(rig.win.reloads === 0, 'nor is a minimised one')
  rig.dog.dispose()
}

{
  // Coming back into view must not be an accusation: `lastBeat` is hours stale
  // through no fault of the renderer's.
  const rig = arm({ visible: false })
  rig.clock.advance(60 * 60_000)
  rig.win.visible = true
  rig.win.emit('show')
  rig.clock.advance(HEARTBEAT_SILENCE_MS - 1000)
  ok(rig.win.reloads === 0, 'a window restored after an hour gets the full silence budget, not an instant verdict')
  rig.clock.advance(2000)
  ok(rig.win.reloads === 1, 'and is judged normally after that', `reloads=${rig.win.reloads}`)
  rig.dog.dispose()
}

{
  const rig = arm({ load: false })
  rig.clock.advance(10 * 60_000)
  ok(rig.win.reloads === 0, 'a window that has never finished loading is not judged at all')
  rig.dog.dispose()
}

/* ------------------------------------------------- a renderer that admits it */

console.log('\nan unhealthy heartbeat')
{
  const rig = arm()
  rig.beat({ healthy: false, error: 'Foreman is not a function' })
  ok(rig.win.reloads === 1, 'reloads at once — there is nothing left to wait for', `reloads=${rig.win.reloads}`)
  ok(
    (rig.states[0]?.reason ?? '').includes('Foreman is not a function'),
    'and carries the error to the clients',
    rig.states[0]?.reason ?? '(none)'
  )
  rig.dog.dispose()
}

{
  // An error boundary beats every 2s like any other component, so an unhealthy
  // beat must be counted as silence rather than mistaken for life.
  const rig = arm()
  rig.beat({ healthy: false, error: 'boom' })
  for (let i = 0; i < 10; i++) {
    rig.clock.advance(2000)
    rig.beat({ healthy: false, error: 'boom' })
  }
  ok(rig.win.reloads === 1, 'a stream of unhealthy beats does not buy a reload each', `reloads=${rig.win.reloads}`)
  rig.dog.dispose()
}

/* ------------------------------------------------------------- rate limits */

console.log('\nthe rate limit')
{
  const rig = arm()
  rig.clock.advance(HEARTBEAT_SILENCE_MS + 1000)
  ok(rig.win.reloads === 1, 'first reload')
  rig.win.webContents.emit('did-finish-load')
  // Dead again immediately. The cooldown, not the silence window, is what holds
  // the second one back.
  rig.clock.advance(RELOAD_COOLDOWN_MS - 5000)
  ok(rig.win.reloads === 1, 'a second failure inside the 30s cooldown does not reload again')
  rig.clock.advance(6000)
  ok(rig.win.reloads === 2, 'it reloads once the cooldown is up', `reloads=${rig.win.reloads}`)
  rig.dog.dispose()
}

console.log('\nthe cutoff')
{
  const rig = arm()
  // A renderer broken on the ground: every reload loads a document that never
  // beats. Walk it well past the point where a loop would run away.
  for (let i = 0; i < 12; i++) {
    rig.clock.advance(RELOAD_COOLDOWN_MS + HEARTBEAT_SILENCE_MS)
    rig.win.webContents.emit('did-finish-load')
  }
  ok(
    rig.win.reloads === RELOAD_LIMIT,
    `it stops after ${RELOAD_LIMIT} reloads rather than looping forever`,
    `reloads=${rig.win.reloads}`
  )
  ok(
    rig.logs.some((line) => /giving up/.test(line)),
    'and says out loud that it has given up',
    rig.logs.filter((l) => /giving up/.test(l)).join(' | ') || '(never said)'
  )
  ok(
    rig.states.at(-1)?.state === 'recovering',
    'the clients are left told the desktop is not coming back on its own',
    JSON.stringify(rig.states.at(-1))
  )

  // Giving up is a latch, not a life sentence: a renderer that heals is watched
  // again. By this point the loop above has run well past RELOAD_WINDOW_MS, so
  // the old attempts have decayed too — both are needed, and the mutation that
  // stops a healthy beat lifting the latch fails this line.
  rig.beat()
  ok(rig.states.at(-1)?.state === 'ready', 'a healthy beat clears the recovery')
  const before = rig.win.reloads
  rig.clock.advance(HEARTBEAT_SILENCE_MS + 1000)
  ok(
    rig.win.reloads === before + 1,
    'and a later failure, past the window, is defended again',
    `reloads=${rig.win.reloads}`
  )
  rig.dog.dispose()
}

{
  /*
   * The other half of that, and the deliberately harsh one: a healthy beat
   * lifts the latch but does *not* refund the budget.
   *
   * A stale preload produces exactly this shape — mount, beat once, throw,
   * reload, mount, beat once, throw — and a ceiling that reset on every good
   * beat would be no ceiling at all. So a fresh failure inside the same five
   * minutes still finds the budget spent.
   */
  const rig = arm()
  for (let i = 0; i < RELOAD_LIMIT + 1; i++) {
    rig.clock.advance(RELOAD_COOLDOWN_MS + 1000)
    rig.win.webContents.emit('did-finish-load')
    rig.clock.advance(HEARTBEAT_SILENCE_MS + 1000)
  }
  ok(rig.win.reloads === RELOAD_LIMIT, 'the budget is spent', `reloads=${rig.win.reloads}`)
  rig.win.webContents.emit('did-finish-load')
  rig.beat()
  const before = rig.win.reloads
  rig.clock.advance(HEARTBEAT_SILENCE_MS + 1000)
  ok(
    rig.win.reloads === before,
    'and one healthy beat inside the same window does not buy another reload',
    `reloads=${rig.win.reloads}`
  )
  rig.dog.dispose()
}

{
  const rig = arm()
  // Three deaths spread wide enough that the five-minute window has forgotten
  // the first by the time the fourth comes round.
  for (let i = 0; i < 4; i++) {
    rig.clock.advance(RELOAD_WINDOW_MS / 2)
    rig.win.webContents.emit('did-finish-load')
    rig.clock.advance(HEARTBEAT_SILENCE_MS + 1000)
  }
  ok(rig.win.reloads > RELOAD_LIMIT, 'failures spread beyond the window are not held against it', `reloads=${rig.win.reloads}`)
  rig.dog.dispose()
}

/* ------------------------------------------------------------ a hung window */

console.log('\nan unresponsive renderer')
{
  const rig = arm()
  rig.win.webContents.emit('unresponsive')
  rig.clock.advance(UNRESPONSIVE_GRACE_MS - 1000)
  ok(rig.win.reloads === 0, 'a stall is given five seconds to be a big paste rather than a hang')
  rig.clock.advance(2000)
  ok(rig.win.reloads === 1, 'and reloads when it is still hung after them', `reloads=${rig.win.reloads}`)
  rig.dog.dispose()
}

{
  const rig = arm()
  // A four-second stall: the main thread is blocked, so nothing beats during
  // it, and then it finishes and the renderer picks up where it left off. Kept
  // under the silence limit deliberately — this asserts that `responsive`
  // cancels the pending hang timer, and a stall long enough to trip the
  // heartbeat rule as well would prove nothing about that.
  rig.win.webContents.emit('unresponsive')
  rig.clock.advance(UNRESPONSIVE_GRACE_MS - 1000)
  rig.win.webContents.emit('responsive')
  rig.beat()
  beatThrough(rig, 60_000)
  ok(rig.win.reloads === 0, 'a renderer that comes back on its own is never reloaded', `reloads=${rig.win.reloads}`)
  rig.dog.dispose()
}

/* ---------------------------------------------------------- a dead process */

console.log('\na crashed renderer process')
{
  const rig = arm()
  rig.win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  ok(rig.win.reloads === 0, 'the reload waits out the crash delay')
  ok(rig.states[0]?.state === 'recovering', 'the clients are told immediately, not after the wait')
  rig.clock.advance(CRASH_RELOAD_DELAY_MS + 100)
  ok(rig.win.reloads === 1, 'then it reloads', `reloads=${rig.win.reloads}`)
  ok(rig.win.destroyed_calls === 0, 'and does not destroy the window on a first death')
  rig.dog.dispose()
}

{
  const rig = arm()
  rig.win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' })
  // Only past the crash delay, not past the silence limit: the claim is that
  // the crash handler scheduled nothing, and running on far enough for the
  // heartbeat rule to fire would be measuring a different rule entirely.
  rig.clock.advance(CRASH_RELOAD_DELAY_MS + 100)
  ok(rig.win.reloads === 0, 'a clean exit is not a crash and schedules no reload')
  ok(rig.states.length === 0, 'and tells the clients nothing')
  rig.dog.dispose()
}

{
  /*
   * The policy this module inherited from electron/main.ts, asserted so it
   * cannot drift into the rate-limited path beside it. A second dead process
   * with no healthy beat in between destroys the window, so 'window-all-closed'
   * fires and Forge quits honestly instead of surviving as a windowless process
   * holding port 5173 against every later launch.
   */
  const rig = arm()
  rig.win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  rig.clock.advance(CRASH_RELOAD_DELAY_MS + 100)
  rig.win.webContents.emit('did-finish-load')
  rig.win.webContents.emit('render-process-gone', {}, { reason: 'oom' })
  ok(rig.win.destroyed_calls === 1, 'a second death with no healthy beat destroys the window', `destroys=${rig.win.destroyed_calls}`)
  ok(rig.win.reloads === 1, 'rather than reloading again', `reloads=${rig.win.reloads}`)
  rig.dog.dispose()
}

{
  const rig = arm()
  rig.win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  rig.clock.advance(CRASH_RELOAD_DELAY_MS + 100)
  rig.win.webContents.emit('did-finish-load')
  rig.beat()
  rig.win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  ok(rig.win.destroyed_calls === 0, 'a crash after the renderer proved itself healthy gets its reload back')
  rig.clock.advance(CRASH_RELOAD_DELAY_MS + 100)
  ok(rig.win.reloads === 2, 'and takes it', `reloads=${rig.win.reloads}`)
  rig.dog.dispose()
}

/* ------------------------------------------------------------- after death */

console.log('\nafter the window has gone')
{
  const rig = arm()
  rig.dog.dispose()
  rig.clock.advance(10 * 60_000)
  ok(rig.win.reloads === 0, 'a disposed watchdog stops watching')

  const other = arm()
  other.win.destroyed = true
  other.clock.advance(10 * 60_000)
  ok(other.win.reloads === 0, 'and a destroyed window is never reloaded')
  other.dog.dispose()
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
