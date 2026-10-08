/**
 * minibar:check — the mini bar end to end, on a throwaway Forge (docs/MINI-BAR.md, 7).
 *
 *   npm run build && node scripts/minibar-check.mjs
 *
 * Launches the built app (out/) with its own `--data-dir`, seeded with two
 * projects of plain PowerShell panes (no real agent), and drives it through
 * playwright-core: the main window from the main process, the #minibar and
 * #shotcard windows as pages.
 *
 *   1. minimise    the #minibar window shows, always on top, with the project
 *                  name and one chip per pane
 *   2. send        `echo minibar-ok` typed in the bar reaches the pane (read
 *                  back through the host's Peek, which is snapshotText)
 *   3. project     the project.next chord pressed in the bar switches project
 *   4. restore     the bar hides; words typed but not sent are in the big bar
 *   5. shot card   an image on the clipboard while minimised pops #shotcard at
 *                  the top right, and it is gone again after about 10.5 s
 *   6. news        a pane that prints for ~10 s and stops raises a Done toast
 *                  and an Activity row; Peek from the row shows its last lines
 *   7. quit        the bar's X with panes running shows the confirm row; Quit
 *                  ends the process, and no watchdog.pause is written
 *
 * Step 6 does not use `Start-Sleep 9; echo done`: a pane is busy only after
 * an unbroken 600 ms run of output, and a hole over 400 ms starts the run
 * again (BUSY_ONSET_MS, BUSY_GAP_MS in src/lib/terminals.ts), so a silent
 * sleep never counts as work, and neither does a line every half second. The
 * command prints a line every 200 ms for about ten seconds instead.
 *
 * Side effects outside the scratch folder, on purpose and small: step 5 writes
 * a 64x48 image to the real clipboard (any other running Forge will catch it
 * too), and the throwaway window shows on screen for about a minute. Global
 * keys, spoken updates and earcons are off in the seed.
 *
 * Screenshots go to shots/e2e-*.png (or `--shots <dir>`).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright-core'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const shotsArg = process.argv.indexOf('--shots')
const SHOTS = shotsArg > 0 && process.argv[shotsArg + 1] ? resolve(process.argv[shotsArg + 1]) : join(ROOT, 'shots')

/** The card's own timings (src/minibar/ShotCardApp.tsx): 10 s up, then a short fade. */
const CARD_GONE_MIN_MS = 9000
const CARD_GONE_MAX_MS = 13000
/** shot-card-window.ts: 14 px in from the top and right of the work area. */
const CARD_INSET = 14

const P1 = { id: 'proj_mb_one', name: 'Mini One' }
const P2 = { id: 'proj_mb_two', name: 'Mini Two' }
const TICKS = '1..50 | % { "tick $_"; Start-Sleep -Milliseconds 200 }; "done"'
const DRAFT = 'kept for the big bar 42'

let passes = 0
let failures = 0
const log = (ok, message) => {
  if (ok) passes++
  else failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}
const note = (message) => console.log(`  --  ${message}`)
const section = (title) => console.log(`\n${title}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll `fn` until it returns something truthy; the last value either way. */
async function until(fn, ms, every = 200) {
  const end = Date.now() + ms
  let value
  while (Date.now() < end) {
    value = await fn()
    if (value) return value
    await sleep(every)
  }
  return value
}

/* ------------------------------------------------------------------ seed */

function seed() {
  const scratch = mkdtempSync(join(tmpdir(), 'forge-minibar-check-'))
  const data = join(scratch, 'data')
  mkdirSync(join(data, 'layouts'), { recursive: true })
  const now = Date.now()
  const project = (p, color) => {
    const path = join(scratch, p.id)
    mkdirSync(path)
    return { id: p.id, name: p.name, path, color, defaultProfileId: 'pwsh', createdAt: now }
  }
  writeFileSync(
    join(data, 'settings.json'),
    JSON.stringify({
      onboarded: true,
      webAccountPromptDismissed: true,
      lastNotesVersion: '0.3.0',
      lastProjectId: P1.id,
      confirmOnQuit: true,
      miniBar: true,
      shotsOnDesktop: true,
      // Never hook Steve's keyboard, talk, or chime from a check.
      miniGlobalKeys: false,
      miniSpeakUpdates: false,
      voiceEarcons: false,
      terminalExitChime: false
    })
  )
  writeFileSync(join(data, 'projects.json'), JSON.stringify([project(P1, '#5B8DEF'), project(P2, '#E0A040')]))
  const leaf = (id) => ({ type: 'leaf', id, profileId: 'pwsh', title: '' })
  writeFileSync(
    join(data, 'layouts', `${P1.id}.json`),
    JSON.stringify({
      tabs: [
        {
          id: 'tab_mb_one',
          title: 'Shells',
          root: { type: 'split', id: 'split_mb_one', direction: 'row', ratio: 0.5, a: leaf('pane_mb_a1'), b: leaf('pane_mb_a2') },
          activePaneId: 'pane_mb_a1'
        }
      ],
      activeTabId: 'tab_mb_one',
      viewMode: 'tabs'
    })
  )
  writeFileSync(
    join(data, 'layouts', `${P2.id}.json`),
    JSON.stringify({
      tabs: [{ id: 'tab_mb_two', title: 'Shell', root: leaf('pane_mb_b1'), activePaneId: 'pane_mb_b1' }],
      activeTabId: 'tab_mb_two',
      viewMode: 'tabs'
    })
  )
  return { scratch, data }
}

/* ------------------------------------------------------- the app, from main */

/** Visibility and bounds of the main window, or of the window at `#hash`. */
function windowInfo(app, hash) {
  return app.evaluate(({ BrowserWindow, screen }, h) => {
    const win = BrowserWindow.getAllWindows().find((w) => {
      const url = w.webContents.getURL()
      return h ? url.endsWith(`#${h}`) : url.startsWith('file:') && !url.includes('#')
    })
    if (!win || win.isDestroyed()) return null
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    return { visible: win.isVisible(), minimised: win.isMinimized(), onTop: win.isAlwaysOnTop(), bounds: win.getBounds(), area }
  }, hash ?? null)
}

function mainWindow(app, op) {
  return app.evaluate(({ BrowserWindow }, o) => {
    const win = BrowserWindow.getAllWindows().find((w) => {
      const url = w.webContents.getURL()
      return url.startsWith('file:') && !url.includes('#')
    })
    if (!win) return false
    if (o === 'minimize') win.minimize()
    else win.restore()
    return true
  }, op)
}

/** The host's last MiniBarState, as main relayed it. */
const hostState = (app) => app.evaluate(() => globalThis.__minibarCheckState ?? null)

async function pageAt(app, hash, ms = 15000) {
  return until(() => app.windows().find((p) => p.url().endsWith(`#${hash}`)), ms)
}

async function snap(page, name) {
  // Let a panel that just opened finish fading in.
  await sleep(450)
  try {
    await page.screenshot({ path: join(SHOTS, `e2e-${name}.png`), timeout: 10000 })
  } catch (err) {
    note(`screenshot ${name} failed: ${err.message.split('\n')[0]}`)
  }
}

/** "Ctrl+Shift+PageDown" as Playwright spells it. */
const pwChord = (chord) =>
  chord
    .split('+')
    .map((k) => ({ Ctrl: 'Control', Cmd: 'Meta', Win: 'Meta' })[k] ?? k)
    .join('+')

/* ------------------------------------------------------------------- run */

if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) {
  console.error('out/ is missing: run `npm run build` first.')
  process.exit(1)
}
mkdirSync(SHOTS, { recursive: true })

const { scratch, data } = seed()
const env = { ...process.env }
for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_ENV', 'NODE_ENV_ELECTRON_VITE']) delete env[k]

const app = await _electron.launch({ executablePath: ELECTRON, args: ['.', '--data-dir', data], cwd: ROOT, env, timeout: 60000 })
let exited = false
app.process().on('exit', () => (exited = true))

try {
  // Every state the host publishes, kept where the script can read it.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.on('minibar:publish', (_e, s) => {
      globalThis.__minibarCheckState = s
    })
  })

  const main = await until(() => app.windows().find((p) => /index\.html$/.test(p.url())), 30000)
  if (!main) throw new Error('the main window never loaded')
  await main.waitForSelector('.terminal-surface', { timeout: 30000 })
  // Give both shells time to print their banner and prompt.
  await sleep(3000)

  /* ---- 1 ---- */
  section('1. Minimise: the bar shows')
  await mainWindow(app, 'minimize')
  const shown = await until(async () => {
    const w = await windowInfo(app, 'minibar')
    return w?.visible ? w : null
  }, 15000)
  log(!!shown, 'a #minibar window is visible')
  log(shown?.onTop === true, 'it is always on top')
  const bar = await pageAt(app, 'minibar')
  if (!bar) throw new Error('no #minibar page')
  const s1 = await until(async () => {
    const s = await hostState(app)
    const two = s?.agents.filter((a) => a.projectId === P1.id && a.status !== 'starting').length === 2
    return s?.project?.id === P1.id && two ? s : null
  }, 20000)
  log(!!s1, `the host publishes ${P1.name} with two live panes`)
  await bar.waitForSelector('.mb-chip', { timeout: 10000 }).catch(() => null)
  const projName = (await bar.locator('.mb-proj__name').textContent().catch(() => ''))?.trim()
  log(projName === P1.name, `the bar shows the project name (${JSON.stringify(projName)})`)
  // Not the ruler's copies, which are there only to be measured.
  const chips = await bar.locator('.mb-chips > .mb-chip').count()
  log(chips === 2, `the bar shows two agent chips (${chips})`)
  await snap(bar, '1-minimised')

  /* ---- 2 ---- */
  section('2. Type in the bar: the pane runs it')
  const target = s1?.target.kind === 'pane' ? s1.target.paneId : null
  log(!!target, `the bar targets a pane (${target})`)
  await bar.locator('.mb-box').fill('echo minibar-ok')
  await bar.locator('.mb-box').press('Enter')
  const boxAfter = await until(async () => ((await bar.locator('.mb-box').inputValue()) === '' ? true : null), 2000)
  log(boxAfter === true, 'the box empties on send')
  await sleep(1500)
  const ranIt = await until(async () => {
    await bar.evaluate((paneId) => window.forge.minibar.call({ t: 'peek', paneId }), target)
    await sleep(600)
    const s = await hostState(app)
    const text = s?.peek?.paneId === target ? s.peek.text : ''
    return text.split('\n').some((l) => l.trim() === 'minibar-ok') ? text : null
  }, 12000, 800)
  log(!!ranIt, 'the pane printed minibar-ok (read through the host)')
  await snap(bar, '2-sent-peek')
  await bar.evaluate(() => window.forge.minibar.call({ t: 'closePeek' }))
  await sleep(400)

  /* ---- 3 ---- */
  section('3. The next-project chord in the bar')
  const s3 = await hostState(app)
  const next = s3?.keymap.find((k) => k.command === 'project.next')
  log(!!next, `project.next is in the bar's keymap (${next?.chord}, ${next?.scope})`)
  if (next && next.chord !== 'Ctrl+Shift+PageDown') note(`the chord is ${next.chord}, not Ctrl+Shift+PageDown`)
  await bar.locator('.mb-box').focus()
  await bar.keyboard.press(pwChord(next?.chord ?? 'Ctrl+Shift+PageDown'))
  const switched = await until(async () => (await hostState(app))?.project?.id === P2.id, 8000)
  log(switched === true, `the host's project is now ${P2.name}`)
  const projName3 = await until(async () => {
    const t = (await bar.locator('.mb-proj__name').textContent())?.trim()
    return t === P2.name ? t : null
  }, 4000)
  log(projName3 === P2.name, 'the bar shows it')
  await snap(bar, '3-next-project')

  /* ---- 4 ---- */
  section('4. Restore: the bar hides, the draft comes home')
  await bar.locator('.mb-box').fill(DRAFT)
  await sleep(800)
  await mainWindow(app, 'restore')
  const hidden = await until(async () => ((await windowInfo(app, 'minibar'))?.visible === false ? true : null), 8000)
  log(hidden === true, 'the bar is hidden')
  const dock = await until(async () => {
    const v = await main.locator('.dock__field').first().inputValue().catch(() => null)
    return v === DRAFT ? v : null
  }, 6000)
  log(dock === DRAFT, `the big bar holds the unsent words (${JSON.stringify(dock)})`)
  await snap(main, '4-restored')
  // Empty it again, so the next minimise does not hand it straight back.
  await main.locator('.dock__field').first().fill('')
  await sleep(500)

  /* ---- 5 ---- */
  section('5. A shot while minimised: the desktop card')
  await mainWindow(app, 'minimize')
  await until(async () => ((await windowInfo(app, 'minibar'))?.visible ? true : null), 8000)
  const before = await app.evaluate(({ clipboard }) => ({
    text: clipboard.readText(),
    image: clipboard.availableFormats().some((f) => f.startsWith('image/'))
  }))
  // A fresh image every run, or the shelf calls it a duplicate and pops nothing.
  await app.evaluate(({ clipboard, nativeImage }) => {
    const width = 64
    const height = 48
    const px = Buffer.alloc(width * height * 4)
    const [b, g, r] = [Math.random() * 255, Math.random() * 255, Math.random() * 255].map(Math.floor)
    for (let i = 0; i < px.length; i += 4) {
      px[i] = (b + i) & 255
      px[i + 1] = g
      px[i + 2] = r
      px[i + 3] = 255
    }
    clipboard.writeImage(nativeImage.createFromBitmap(px, { width, height }))
  })
  const card = await until(async () => {
    const w = await windowInfo(app, 'shotcard')
    return w?.visible ? { ...w, at: Date.now() } : null
  }, 6000, 100)
  log(!!card, 'a #shotcard window is visible')
  if (card) {
    const right = card.area.x + card.area.width - CARD_INSET
    const top = card.area.y + CARD_INSET
    const near = Math.abs(card.bounds.x + card.bounds.width - right) <= 2 && Math.abs(card.bounds.y - top) <= 2
    log(near, `it sits at the top right (${JSON.stringify(card.bounds)} in ${JSON.stringify(card.area)})`)
    const cardPage = await pageAt(app, 'shotcard', 3000)
    // The window is up before React has drawn the card in it.
    const pic = cardPage ? await cardPage.waitForSelector('img', { timeout: 4000 }).catch(() => null) : null
    log(!!pic, 'the card shows the picture')
    // After the pop-in has settled.
    if (cardPage) await snap(cardPage, '5-shotcard')
    // A 4:3 picture is the tallest card ShotPop draws (it holds wider ones to 1.42:1).
    const fit = cardPage
      ? await cardPage.evaluate(() => {
          const card = document.querySelector('.shotpop__card')
          return card ? { bottom: Math.ceil(card.getBoundingClientRect().bottom), room: window.innerHeight } : null
        })
      : null
    log(!!fit && fit.bottom <= fit.room, `the whole card fits its window (${fit?.bottom} of ${fit?.room} px)`)
    const gone = await until(async () => ((await windowInfo(app, 'shotcard'))?.visible === false ? Date.now() : null), CARD_GONE_MAX_MS + 2000, 100)
    const upFor = gone ? gone - card.at : NaN
    log(upFor >= CARD_GONE_MIN_MS && upFor <= CARD_GONE_MAX_MS, `it hides itself after ${(upFor / 1000).toFixed(1)} s`)
  }
  if (before.text && !before.image) await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), before.text)

  /* ---- 6 ---- */
  section('6. Work, then quiet: Done toast, Activity, Peek')
  const s6 = await hostState(app)
  const pane6 = s6?.target.kind === 'pane' ? s6.target.paneId : null
  log(s6?.project?.id === P2.id && pane6 === 'pane_mb_b1', `the bar targets ${P2.name}'s pane (${pane6})`)
  await until(async () => (await hostState(app))?.agents.find((a) => a.paneId === pane6 && a.status !== 'starting'), 15000)
  await bar.locator('.mb-box').fill(TICKS)
  await bar.locator('.mb-box').press('Enter')
  const done = await until(async () => {
    const s = await hostState(app)
    const ev = s?.events.find((e) => e.kind === 'done' && e.paneId === pane6)
    return ev ? { ev, toast: s.toasts.includes(ev.id) } : null
  }, 35000, 250)
  log(!!done, `a Done event for the pane (${done ? `worked ${Math.round(done.ev.workedMs / 1000)} s` : 'none'})`)
  log(done?.toast === true, 'its toast is up')
  const toastEl = await bar.locator('.mb-toast[data-kind="done"]').count()
  log(toastEl > 0, 'the bar draws the Done toast')
  await snap(bar, '6-toast')
  await bar.locator('.mb-bell').click()
  const rows = await until(async () => (await bar.locator('.mb-evrow').count()) || null, 4000)
  log(rows >= 1, `Activity lists it (${rows} row${rows === 1 ? '' : 's'})`)
  await snap(bar, '6-activity')
  await bar.locator('.mb-evrow').first().click()
  const peekText = await until(async () => {
    const t = await bar.locator('.mb-peek .mb-screen, .mb-peek .mb-md').first().textContent().catch(() => '')
    // Lines of their own: the command line itself also says "tick" and "done".
    return (t ?? '').split('\n').some((l) => l.trim() === 'tick 50' || l.trim() === 'done') ? t : null
  }, 6000)
  log(!!peekText, "Peek shows the pane's last lines")
  const atBottom = await bar
    .locator('.mb-peek__body')
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 2)
    .catch(() => false)
  log(atBottom, 'it opens on the newest line, at the bottom')
  await snap(bar, '6-peek')
  await bar.evaluate(() => window.forge.minibar.call({ t: 'closePeek' }))
  await sleep(400)

  /* ---- 7 ---- */
  section('7. X with panes running: confirm, then quit')
  await bar.locator('.mb-quit').click()
  const row = await until(async () => {
    const t = await bar.locator('.mb-quitrow .mb-bar__notice-word').textContent().catch(() => null)
    return t?.includes('still running') ? t : null
  }, 4000)
  log(!!row, `the confirm row shows (${JSON.stringify(row)})`)
  await snap(bar, '7-confirm')
  await bar.locator('.mb-quitrow .mb-btn--danger').click()
  const quit = await until(() => exited, 15000)
  log(quit === true, 'the process exits')
  log(!existsSync(join(data, 'watchdog.pause')), 'no watchdog.pause in the data dir')
} catch (err) {
  log(false, `the run stopped: ${err.message.split('\n')[0]}`)
} finally {
  if (!exited) await app.close().catch(() => null)
  // The shells may hold their folders for a moment after the app is gone.
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(scratch, { recursive: true, force: true })
      break
    } catch {
      await sleep(500)
    }
  }
}

console.log(`\n${passes} passed, ${failures} failed`)
if (failures) process.exit(1)
