/**
 * The composer's terminal keys, in a real browser.
 *
 *   npm run web:keys
 *
 * The ←↑↓→ / Tab / Esc row under the textarea was built for a thumb. On a
 * keyboard the same keys work as themselves, but only while the box is empty —
 * the rule `Composer.tsx`'s RAW_KEYS explains, and the same one that already
 * makes Enter the Enter key rather than a Send when there is nothing to send.
 *
 * That rule is the whole feature and it has exactly two halves, so both are
 * checked here rather than one:
 *
 *   • **empty box → the pane.** Every key in the map puts its escape sequence
 *     down the PTY and the browser's own meaning is suppressed — Tab must not
 *     move focus out of the field, or answering a menu would cost the person
 *     their cursor.
 *   • **a draft → the textarea.** The arrows walk the caret and Tab leaves, as
 *     in any other box on the web. A composer you cannot edit with the arrow
 *     keys would be a bad trade for a menu shortcut, and this half is the one
 *     a careless fix breaks.
 *
 * Ctrl, Alt and Meta are checked too: those chords belong to the browser and
 * the OS, and a terminal client that swallowed Ctrl+ArrowUp would be a bad
 * neighbour on a machine it does not own.
 *
 * ## Why the preview page
 *
 * `web/src/components/Preview.tsx` mounts the *real* Composer with real state,
 * and it is dev-server-only, so no product code is bent for the test. Its
 * `onRaw` records what it is handed into a hidden `[data-testid="preview-raw"]`
 * node; the assertions below read that node. What is under test is therefore
 * the actual key handler, not a copy of its logic — the failure this catches is
 * "the sequence changed" or "the empty-box guard stopped guarding", which a
 * unit test of a re-implemented switch could not see.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer as createViteServer } from 'vite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VITE_PORT = 5199

let failures = 0
const log = (ok, what) => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
}

/** The wire form of one raw write, as Preview records it. */
const wrote = (data) => JSON.stringify(data)

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const ESC = '\x1b'
const BACK_TAB = '\x1b[Z'

async function main() {
  const vite = await createViteServer({
    configFile: join(ROOT, 'web', 'vite.config.ts'),
    server: { port: VITE_PORT, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error',
    plugins: [
      {
        name: 'forge-web-keys-config',
        configureServer(dev) {
          dev.middlewares.use('/config.json', (_req, res) => {
            res.setHeader('content-type', 'application/json')
            res.setHeader('cache-control', 'no-store')
            // The preview never signs in, so the values only have to parse.
            res.end(JSON.stringify({ apiKey: 'keys-check', databaseUrl: 'http://127.0.0.1:1/rtdb' }))
          })
        }
      }
    ]
  })
  await vite.listen()

  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await page.goto(`http://127.0.0.1:${VITE_PORT}/?preview=feed`, { waitUntil: 'domcontentloaded', timeout: 120000 })

  const box = page.locator('form.composer textarea.composer__input').first()
  const readout = page.locator('[data-testid="preview-raw"]').first()
  await box.waitFor({ state: 'visible', timeout: 15000 })

  /** Everything written since the page loaded, oldest first. */
  const rawSoFar = async () => ((await readout.textContent()) ?? '').trim()
  /** What the last `count` writes were, as one comparable string. */
  const lastWrites = async (count) => {
    const all = (await rawSoFar()).split(' ').filter(Boolean)
    return all.slice(all.length - count).join(' ')
  }
  const writeCount = async () => (await rawSoFar()).split(' ').filter(Boolean).length

  /* ------------------------------------------- 1. empty box → down the PTY */

  await box.click()
  log(await box.evaluate((el) => el === document.activeElement), 'the textarea takes focus')

  const EMPTY_KEYS = [
    ['ArrowUp', UP],
    ['ArrowDown', DOWN],
    ['ArrowLeft', LEFT],
    ['ArrowRight', RIGHT],
    ['Tab', '\t'],
    ['Shift+Tab', BACK_TAB],
    ['Escape', ESC]
  ]

  for (const [key, expected] of EMPTY_KEYS) {
    const before = await writeCount()
    await page.keyboard.press(key)
    const after = await writeCount()
    log(after === before + 1, `${key} with the box empty writes once`)
    log((await lastWrites(1)) === wrote(expected), `${key} writes ${wrote(expected)}`)
  }

  log(
    await box.evaluate((el) => el === document.activeElement),
    'Tab did not move focus out of the composer'
  )
  log((await box.inputValue()) === '', 'none of the terminal keys typed a character')

  /* ------------------------------ 2. Enter, the rule these keys are built on */

  {
    const before = await writeCount()
    await page.keyboard.press('Enter')
    log((await writeCount()) === before + 1, 'Enter with the box empty writes once')
    log((await lastWrites(1)) === wrote('\r'), 'Enter writes a carriage return')
  }

  /* -------------------------------- 3. a modifier belongs to the browser */

  for (const chord of ['Control+ArrowUp', 'Alt+ArrowDown']) {
    const before = await writeCount()
    await page.keyboard.press(chord)
    log((await writeCount()) === before, `${chord} is left to the browser`)
  }

  /* ------------------------------------------ 4. a draft → back to the box */

  await box.fill('hello')
  log((await box.inputValue()) === 'hello', 'the box holds a draft')

  const beforeDraft = await writeCount()
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape']) {
    await page.keyboard.press(key)
  }
  log((await writeCount()) === beforeDraft, 'with a draft the arrows and Escape write nothing')
  log((await box.inputValue()) === 'hello', 'and the draft is untouched')

  // The caret is the point of handing the arrows back: Home then ArrowRight
  // must sit it after the first character, which is only possible if the
  // textarea saw the key.
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  const caret = await box.evaluate((el) => el.selectionStart)
  log(caret === 1, `the arrows still move the caret in a draft (at ${caret})`)

  // Tab with a draft is the browser's: focus leaves the field.
  await page.keyboard.press('Tab')
  log(
    !(await box.evaluate((el) => el === document.activeElement)),
    'Tab with a draft moves focus on, as in any other box'
  )

  /* ------------------------------------------------------------- 5. console */

  log(consoleErrors.length === 0, `the browser console stayed clean${consoleErrors.length ? `: ${consoleErrors[0]}` : ''}`)

  await context.close()
  await browser.close()
  await vite.close()
}

main()
  .catch((err) => {
    failures++
    console.error(`\nFAIL  ${err?.stack ?? err}`)
  })
  .finally(() => {
    console.log(failures === 0 ? '\nweb:keys — all checks passed' : `\nweb:keys — ${failures} FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })
