/**
 * Head-less proof of per-project agent memory (M7).
 *
 * Bundles the *real* electron/memory-store.ts and shared/memory.ts with esbuild
 * (the copy Vite already ships) and drives the store exactly as the main
 * process does: append across sections, refuse duplicates, prune the oldest
 * activity, hold the file under its byte cap, replace the summary, clear it,
 * and round-trip a hand-edited file without losing anything.
 *
 *   npm run memory:smoke
 *
 * No Electron, no network, no renderer — memory-store.ts takes a directory and
 * an ipcMain rather than importing them, which is what makes this possible.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE = join(ROOT, 'electron', 'memory-store.ts')

const scratch = join(ROOT, 'node_modules', '.forge-memory-smoke')
const bundle = join(scratch, 'memory-store.mjs')

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

/** A fixed clock, so the stamped lines in the expectations are stable. */
const T0 = new Date(2026, 6, 30, 15, 4, 0).getTime()
const MINUTE = 60_000

async function main() {
  await build({
    entryPoints: [SOURCE],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    absWorkingDir: ROOT,
    alias: { '@shared': join(ROOT, 'shared') }
  })

  const { ProjectMemoryStore, memoryFileName, registerMemoryHandlers, setMemoryDir } = await import(
    pathToFileURL(bundle).href
  )

  const dir = mkdtempSync(join(tmpdir(), 'forge-memory-'))
  const store = new ProjectMemoryStore(dir)
  const P = 'proj-alpha'

  /* --------------------------------------------------------- 1. filenames */

  log(memoryFileName('proj-alpha') === 'proj-alpha.md', 'a project id becomes <id>.md')
  log(
    memoryFileName('..\\..\\Windows\\System32') === '______Windows_System32.md',
    'a hostile id cannot escape the memory folder'
  )
  log(memoryFileName('') === 'unknown.md', 'an empty id still lands on a real filename')

  /* ------------------------------------------------------ 2. empty memory */

  log(store.read(P) === '', 'a project with no memory reads as an empty string')
  log(describeSections(store.load(P)) === 'about:0 decisions:0 preferences:0 activity:0', 'and parses as nothing')

  /* --------------------------------------------------------- 3. appending */

  store.append(P, 'preferences', 'remember I prefer TypeScript strict mode', T0)
  store.append(P, 'decisions', 'Working on: a top-down car game', T0 + MINUTE)
  store.append(P, 'activity', 'Opened 3 Kimi tabs', T0 + 2 * MINUTE)

  const md = store.read(P)
  log(md.startsWith('# Project memory\n'), 'the file is titled markdown')
  log(md.includes('## Preferences\n- remember I prefer TypeScript strict mode'), 'a preference is stored verbatim')
  log(md.includes('## Decisions\n- Working on: a top-down car game'), 'a decision is stored as a bullet')
  log(md.includes('## Recent activity\n- 2026-07-30 15:06 — Opened 3 Kimi tabs'), 'activity is stamped by the caller')
  log(!md.includes('## About this project'), 'an empty section is left out, not shipped as a bare heading')

  const order = ['## Decisions', '## Preferences', '## Recent activity'].map((h) => md.indexOf(h))
  log(
    order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])),
    'sections always come out in the same order'
  )

  /* ------------------------------------------------------- 4. round trip */

  const parsed = store.load(P)
  log(parsed.preferences[0] === 'remember I prefer TypeScript strict mode', 'preferences round-trip exactly')
  log(parsed.decisions[0] === 'Working on: a top-down car game', 'decisions round-trip exactly')
  log(parsed.activity[0] === '2026-07-30 15:06 — Opened 3 Kimi tabs', 'activity keeps its stamp')

  /* -------------------------------------------------------- 5. duplicates */

  store.append(P, 'preferences', 'remember I prefer TypeScript strict mode', T0 + 3 * MINUTE)
  log(store.load(P).preferences.length === 1, 'saying the same preference twice does not store it twice')

  store.append(P, 'activity', 'Opened 3 Kimi tabs', T0 + 4 * MINUTE)
  log(store.load(P).activity.length === 1, 'the same action twice in a breath is not logged twice')

  store.append(P, 'activity', 'Closed the focused pane', T0 + 5 * MINUTE)
  store.append(P, 'activity', 'Opened 3 Kimi tabs', T0 + 6 * MINUTE)
  log(store.load(P).activity.length === 3, 'but the same action again later is real history')

  store.append(P, 'preferences', '   ', T0)
  log(store.load(P).preferences.length === 1, 'an empty entry is ignored rather than stored blank')

  /* ------------------------------------------------------ 6. the summary */

  store.replaceSummary(P, 'A browser car game in TypeScript.\nSteve drives it from Forge.')
  const withAbout = store.load(P)
  log(withAbout.about.includes('A browser car game'), 'the summary is stored as prose, not bullets')
  log(store.read(P).indexOf('## About this project') < store.read(P).indexOf('## Decisions'), 'and comes first')

  store.replaceSummary(P, 'A browser car game in TypeScript, driven from Forge.')
  log(
    store.load(P).about === 'A browser car game in TypeScript, driven from Forge.' &&
      store.load(P).preferences.length === 1,
    'replacing the summary rewrites only the summary'
  )

  /* ----------------------------------------------------- 7. activity cap */

  const Q = 'proj-cap'
  for (let i = 0; i < 60; i++) store.append(Q, 'activity', `did thing number ${i}`, T0 + i * MINUTE)
  const capped = store.load(Q)
  log(capped.activity.length === 40, `activity is capped at 40 entries (got ${capped.activity.length})`)
  log(capped.activity[0].endsWith('— did thing number 20'), 'the oldest entries are the ones pruned')
  log(capped.activity.at(-1).endsWith('— did thing number 59'), 'the newest entry survives')

  /* --------------------------------------------------------- 8. byte cap */

  const R = 'proj-big'
  store.append(R, 'preferences', 'always use TypeScript strict mode', T0)
  store.append(R, 'decisions', 'Working on: the payments rewrite', T0)
  for (let i = 0; i < 60; i++) {
    store.append(R, 'activity', `${'x'.repeat(240)} #${i}`, T0 + i * MINUTE)
  }
  const bytes = Buffer.byteLength(store.read(R), 'utf8')
  log(bytes <= 8 * 1024, `the whole file stays under 8KB (${bytes} bytes)`)
  const big = store.load(R)
  log(big.preferences.includes('always use TypeScript strict mode'), 'the preference survives the pruning')
  log(big.decisions.includes('Working on: the payments rewrite'), 'so does the decision')
  log(big.activity.length > 0 && big.activity.length < 40, `activity was what got dropped (${big.activity.length} left)`)
  log(big.activity.at(-1).includes('#59'), 'and what is left is the newest of it')

  /* ------------------------------------------------- 9. long single entry */

  const S = 'proj-long'
  store.append(S, 'preferences', 'y'.repeat(5000), T0)
  const longEntry = store.load(S).preferences[0]
  log(longEntry.length <= 300, `a single huge entry is clipped to 300 chars (got ${longEntry.length})`)
  log(longEntry.endsWith('…'), 'and says it was clipped')

  const T = 'proj-multiline'
  store.append(T, 'decisions', 'first line\nsecond line\n\nthird', T0)
  log(store.load(T).decisions[0] === 'first line second line third', 'newlines are flattened so a bullet stays a bullet')

  /* ------------------------------------------------------- 10. atomicity */

  const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'))
  log(leftovers.length === 0, `no .tmp files are left behind (${leftovers.join(', ') || 'none'})`)
  const onDisk = readFileSync(store.fileFor(P), 'utf8')
  log(onDisk === store.read(P) && onDisk.endsWith('\n'), 'what append returned is exactly what is on disk')

  // A reader that opens the file at any moment sees a complete document: the
  // write goes to <file>.tmp and is renamed, so there is no torn state.
  const before = readFileSync(store.fileFor(P), 'utf8')
  store.append(P, 'activity', 'a further thing happened', T0 + 99 * MINUTE)
  const after = readFileSync(store.fileFor(P), 'utf8')
  log(before !== after && after.includes('a further thing happened'), 'the next write replaces the file wholesale')
  log(parseCount(after, '## ') === parseCount(before, '## ') , 'and does not disturb the other sections')

  /* -------------------------------------------- 11. hand-edited tolerance */

  const H = 'proj-hand'
  writeFileSync(
    store.fileFor(H),
    [
      '# Project memory',
      '',
      '## About this project',
      'Edited by hand in Notepad.',
      '',
      '## Preferences',
      '* written with a star',
      '-   extra spaces',
      '',
      '## Nonsense Heading',
      '- ignored',
      ''
    ].join('\n'),
    'utf8'
  )
  const hand = store.load(H)
  log(hand.about === 'Edited by hand in Notepad.', 'a hand-written summary is read back')
  log(hand.preferences.length === 2, 'bullets written with * or extra spaces still parse')
  log(
    !JSON.stringify(hand).includes('ignored'),
    'an unknown heading is skipped without swallowing the rest of the file'
  )
  store.append(H, 'preferences', 'and one from the app', T0)
  log(store.load(H).preferences.length === 3, 'and the app can still append to it')

  /* ------------------------------------------------------------ 12. clear */

  log(store.clear(P) === true, 'clear() deletes the file')
  log(!existsSync(store.fileFor(P)), 'and it is really gone')
  log(store.read(P) === '', 'a cleared project reads as empty again')
  log(store.clear('never-existed') === true, 'clearing a project that had nothing is not an error')

  store.append(P, 'preferences', 'a fresh start', T0)
  log(store.load(P).preferences.length === 1, 'and the project can start remembering again from nothing')

  /* --------------------------------------------------- 13. the ipc surface */

  const handlers = new Map()
  registerMemoryHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    read: 'memory:read',
    append: 'memory:append',
    replaceSummary: 'memory:replace-summary',
    clear: 'memory:clear'
  })
  log(handlers.size === 4, 'all four channels are registered')

  setMemoryDir(dir)
  const U = 'proj-ipc'
  const appended = await handlers.get('memory:append')(null, U, 'preferences', 'over ipc', T0)
  log(appended.includes('- over ipc'), 'append over IPC returns the whole file back')
  log((await handlers.get('memory:read')(null, U)) === appended, 'read agrees with what append returned')

  const rejected = await handlers.get('memory:append')(null, U, 'rm -rf', 'sneaky', T0)
  log(!rejected.includes('sneaky'), 'an unknown section is refused rather than written')
  log((await handlers.get('memory:clear')(null, U)) === true, 'clear works over IPC')

  /* ------------------------------------------------------------- tidy up */

  rmSync(dir, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })

  console.log(failures === 0 ? '\nmemory: all checks passed\n' : `\nmemory: ${failures} FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

function describeSections(m) {
  return `about:${m.about.length} decisions:${m.decisions.length} preferences:${m.preferences.length} activity:${m.activity.length}`
}

function parseCount(text, needle) {
  return text.split(needle).length - 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
