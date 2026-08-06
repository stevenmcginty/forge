/**
 * The activity tracker's rules, driven head-less.
 *
 *   node scripts/activity-check.mjs
 *
 * Everything this file exercises is invisible in the running app. Attribution
 * happens inside a 1.5 second window while an agent is working; the burst brake
 * only fires during a checkout; the ignore list only shows itself by the rows it
 * does *not* produce; and exact-beats-inferred is a rule about two mechanisms
 * agreeing, which by definition you never see fail — you see a tree that quietly
 * says the wrong thing.
 *
 * So the rules live in shared/activity.ts and src/lib/activitytree.ts with no
 * Node, no Electron and no DOM in either, and this holds them to it: the four
 * transcript tools, the ignore list over real paths out of this repository, the
 * three attribution outcomes, the brake, the merge, and the tree's two shaping
 * rules.
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

const A = await import('../shared/activity.ts')
const T = await import('../src/lib/activitytree.ts')

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

/* ------------------------------------------------------------- transcripts */

const CWD = 'C:\\Users\\steve\\Desktop\\Forge Dev'

/** One assistant record carrying one tool call, as Claude Code writes them. */
const assistant = (uuid, name, input, timestamp = '2026-08-06T10:00:00.000Z') =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name, input }] }
  })

console.log('\ntranscript tool_use')
{
  const abs = `${CWD}\\src\\App.tsx`
  const one = (name, input) => A.toolUseEntries(JSON.parse(assistant('u1', name, input)))

  ok(one('Edit', { file_path: abs })[0]?.kind === 'edit', 'Edit is an edit')
  ok(one('MultiEdit', { file_path: abs })[0]?.kind === 'edit', 'MultiEdit is an edit')
  ok(one('Write', { file_path: abs })[0]?.kind === 'write', 'Write is a write')
  ok(one('Read', { file_path: abs })[0]?.kind === 'read', 'Read is a read')
  ok(one('Edit', { file_path: abs })[0]?.path === abs, 'and the path comes through untouched', String(one('Edit', { file_path: abs })[0]?.path))

  const nb = one('NotebookEdit', { notebook_path: `${CWD}\\notes.ipynb` })
  ok(nb.length === 1 && nb[0].kind === 'edit', 'NotebookEdit is an edit')
  ok(nb[0]?.path.endsWith('notes.ipynb'), 'and reads notebook_path', String(nb[0]?.path))
  ok(
    one('NotebookEdit', { file_path: `${CWD}\\old.ipynb` })[0]?.path.endsWith('old.ipynb'),
    'falling back to file_path when that is all there is'
  )

  ok(one('Bash', { command: 'sed -i s/a/b/ src/App.tsx' }).length === 0, 'Bash names no file and is ignored')
  ok(one('Glob', { pattern: '**/*.ts' }).length === 0, 'nor does Glob')
  ok(one('Grep', { pattern: 'todo' }).length === 0, 'nor Grep')
  ok(one('Task', { prompt: 'go' }).length === 0, 'nor Task')
  ok(one('WebFetch', { url: 'https://example.com' }).length === 0, 'nor WebFetch')
  ok(one('Edit', {}).length === 0, 'a tool call with no path at all is dropped')

  ok(
    A.toolUseEntries(JSON.parse(assistant('u1', 'Edit', { file_path: abs })))[0]?.at ===
      Date.parse('2026-08-06T10:00:00.000Z'),
    'the record timestamp is used when there is one'
  )
  const noStamp = JSON.parse(assistant('u1', 'Edit', { file_path: abs }))
  delete noStamp.timestamp
  ok(Math.abs(A.toolUseEntries(noStamp)[0].at - Date.now()) < 5000, 'and now when there is not')

  ok(A.toolUseEntries({ type: 'user', message: { content: [] } }).length === 0, 'a user turn is not activity')
  ok(A.toolUseEntries(null).length === 0, 'and neither is nothing at all')
}

console.log('\ntranscript lines')
{
  const seen = new Set()
  const line = assistant('uuid-a', 'Edit', { file_path: `${CWD}\\src\\App.tsx` })

  ok(A.transcriptTouches(line, seen).length === 1, 'a good line yields its touch')
  ok(A.transcriptTouches(line, seen).length === 0, 'the same uuid a second time yields nothing')
  ok(
    A.transcriptTouches(assistant('uuid-b', 'Edit', { file_path: `${CWD}\\src\\App.tsx` }), seen).length === 1,
    'a different message about the same file does count'
  )

  ok(A.transcriptTouches('{"type":"assistant"', seen).length === 0, 'a half-written line is not an error')
  ok(A.transcriptTouches('', seen).length === 0, 'nor is a blank one')
  ok(A.transcriptTouches('null', seen).length === 0, 'nor is a literal null')
  ok(A.transcriptTouches('{"type":"summary","summary":"x"}', seen).length === 0, 'nor a record type we know nothing about')
}

/* ------------------------------------------------------------------ paths */

console.log('\nproject-relative paths')
{
  ok(A.relativeTo(CWD, `${CWD}\\src\\App.tsx`) === 'src/App.tsx', 'backslashes come back as forward ones', String(A.relativeTo(CWD, `${CWD}\\src\\App.tsx`)))
  ok(A.relativeTo(CWD, `${CWD.toLowerCase()}\\src\\App.tsx`) === 'src/App.tsx', 'and a different drive casing still matches')
  ok(A.relativeTo(`${CWD}\\`, `${CWD}/src/App.tsx`) === 'src/App.tsx', 'a trailing separator on the root is ignored')
  ok(A.relativeTo(CWD, 'C:\\Users\\steve\\.claude\\settings.json') === null, 'a file outside the project belongs to nobody')
  ok(A.relativeTo(CWD, CWD) === null, 'the project folder itself is not a file in it')
  ok(A.relativeTo(CWD, `${CWD} Two\\src\\App.tsx`) === null, 'a sibling folder with the same prefix is not inside it')
  ok(A.relativeTo('', 'anything') === null, 'no root, no answer')
}

console.log('\nthe ignore list')
{
  const ignored = [
    'node_modules/react/index.js',
    'node_modules/.bin/tsc',
    'out/main/index.js',
    '.git/index',
    '.git/refs/heads/master',
    'bridge-dist/bridge.js',
    'stt-dist/stt.exe',
    'dist/assets/index.css',
    'build/icon.ico',
    'release/forge-setup.exe',
    '.next/server/page.js',
    '.turbo/cache/x',
    '.cache/x',
    'coverage/lcov.info',
    'target/debug/app',
    'venv/lib/site-packages/x.py',
    '.venv/pyvenv.cfg',
    'src/lib/__pycache__/paths.pyc',
    'database-debug.log',
    'yarn.lock',
    'src/App.tsx.swp',
    'src/theme/tokens.css.map',
    '.eslintrc',
    'src/.cache/thing.json',
    '.vscode/settings.json',
    `deep/${'a'.repeat(300)}.ts`
  ]
  const kept = [
    'src/App.tsx',
    'src/components/rail/ActivitySection.tsx',
    'src/lib/activitytree.ts',
    'electron/activity-watcher.ts',
    'shared/activity.ts',
    'scripts/activity-check.mjs',
    'package.json',
    'package-lock.json',
    'README.md',
    'assets/icon.png',
    'mobile/src/main.tsx',
    'electron-builder.yml'
  ]

  let bad = ignored.filter((p) => !A.shouldIgnorePath(p))
  ok(bad.length === 0, `all ${ignored.length} noisy paths are ignored`, bad.join(', '))
  bad = kept.filter((p) => A.shouldIgnorePath(p))
  ok(bad.length === 0, `all ${kept.length} real source paths are kept`, bad.join(', '))

  ok(A.shouldIgnorePath('') === true, 'an empty path is not a file')
  ok(A.shouldIgnorePath('a'.repeat(A.ACTIVITY_MAX_PATH + 1)) === true, 'and neither is one Windows cannot report honestly')
  ok(A.shouldIgnorePath('a'.repeat(A.ACTIVITY_MAX_PATH)) === false, 'exactly at the limit is still a file')
}

/* ----------------------------------------------------------- attribution */

console.log('\nattribution')
{
  const t = 1_000_000
  const busy = (rows) => new Map(rows)

  ok(A.attribute(busy([['p1', { since: t - 500, until: null }]]), t) === 'p1', 'one busy pane takes the credit')
  ok(
    A.attribute(busy([['p1', { since: t - 500, until: null }], ['p2', { since: t - 100, until: null }]]), t) === '',
    'two busy panes credit nobody rather than guess'
  )
  ok(A.attribute(busy([]), t) === null, 'no busy pane at all drops the event')
  ok(
    A.attribute(busy([['p1', { since: t - 5000, until: t - 9000 }]]), t) === null,
    'a pane that stopped long ago is not busy'
  )

  ok(
    A.attribute(busy([['p1', { since: t - 5000, until: t - 1000 }]]), t) === 'p1',
    'a write landing just after the spinner stops still counts'
  )
  ok(
    A.attribute(busy([['p1', { since: t - 5000, until: t - A.ATTRIB_GRACE_MS }]]), t) === 'p1',
    'exactly at the grace window it counts'
  )
  ok(
    A.attribute(busy([['p1', { since: t - 5000, until: t - A.ATTRIB_GRACE_MS - 1 }]]), t) === null,
    'one millisecond past it, it does not'
  )
  ok(
    A.attribute(busy([['p1', { since: t + 10, until: null }]]), t) === null,
    'a pane that only started working afterwards cannot have caused it'
  )
  ok(
    A.attribute(busy([['p1', { since: t - 500, until: null }], ['p2', { since: t - 9000, until: t - 8000 }]]), t) === 'p1',
    'a stale span does not make a certain answer ambiguous'
  )
}

/* ---------------------------------------------------------- the burst brake */

console.log('\nthe burst brake')
{
  const brake = A.newBurstBrake()
  const now = 5_000_000

  let dropped = 0
  for (let i = 0; i < 400; i++) if (A.brakeDrops(brake, now)) dropped++
  ok(dropped === 400 - A.ACTIVITY_BURST_MAX, `a 400-event bucket loses the ${400 - A.ACTIVITY_BURST_MAX} past the ceiling`, String(dropped))

  ok(A.brakeDrops(brake, now + 1000) === true, 'and the next second is dropped too, not merely rationed')
  ok(A.brakeDrops(brake, now + A.ACTIVITY_BURST_COOLDOWN_MS - 1) === true, 'still deaf just before the cooldown ends')
  ok(A.brakeDrops(brake, now + A.ACTIVITY_BURST_COOLDOWN_MS) === false, 'and listening again once it does')
}

{
  // A normal minute of work: a save is a handful of events, not three hundred.
  const brake = A.newBurstBrake()
  let dropped = 0
  for (let second = 0; second < 60; second++) {
    for (let i = 0; i < 8; i++) if (A.brakeDrops(brake, 1_000 + second * 1000 + i)) dropped++
  }
  ok(dropped === 0, 'ordinary editing never trips it', String(dropped))
}

/* ------------------------------------------------------------------ merge */

const entry = (over = {}) => ({
  path: 'src/App.tsx',
  absPath: `${CWD}\\src\\App.tsx`,
  paneId: 'p1',
  profileId: 'claude',
  exactness: 'inferred',
  kind: 'edit',
  at: 1_000_000,
  hits: 1,
  ...over
})

console.log('\nthe merge')
{
  const store = A.newActivityStore()
  A.recordActivity(store, entry())
  A.recordActivity(store, entry({ at: 1_000_500 }))
  const rows = A.activityEntries(store)
  ok(rows.length === 1, 'the same pane on the same file is one row', String(rows.length))
  ok(rows[0].hits === 2, 'with the hits counted', String(rows[0].hits))
  ok(rows[0].at === 1_000_500, 'and the time refreshed', String(rows[0].at))

  A.recordActivity(store, entry({ paneId: 'p2', profileId: 'codex' }))
  ok(A.activityEntries(store).length === 2, 'two panes on one file are two rows — that is the truth, not a duplicate')
}

{
  const store = A.newActivityStore()
  A.recordActivity(store, entry({ paneId: 'p1' }))
  A.recordActivity(store, entry({ paneId: 'p2' }))
  A.recordActivity(store, entry({ paneId: 'p3', exactness: 'exact', kind: 'write' }))

  const rows = A.activityEntries(store)
  ok(rows.length === 1, 'an exact entry evicts every guess about that file', JSON.stringify(rows.map((r) => r.paneId)))
  ok(rows[0].paneId === 'p3' && rows[0].exactness === 'exact', 'and it is the exact one that survives')

  A.recordActivity(store, entry({ paneId: 'p4' }))
  ok(A.activityEntries(store).length === 1, 'and a later guess about the same file is refused outright')

  A.recordActivity(store, entry({ path: 'src/main.tsx', paneId: 'p4' }))
  ok(A.activityEntries(store).length === 2, 'a guess about a different file is still welcome')
}

{
  const store = A.newActivityStore()
  const now = 2_000_000_000
  for (let i = 0; i < A.ACTIVITY_MAX_ENTRIES + 50; i++) {
    A.recordActivity(store, entry({ path: `src/f${i}.ts`, at: now - (A.ACTIVITY_MAX_ENTRIES + 50 - i) * 1000 }))
  }
  ok(store.entries.size === A.ACTIVITY_MAX_ENTRIES + 50, 'everything is recorded before a sweep')
  A.sweepActivity(store, now)
  ok(store.entries.size === A.ACTIVITY_MAX_ENTRIES, `the cap holds at ${A.ACTIVITY_MAX_ENTRIES}`, String(store.entries.size))
  ok(store.truncated === true, 'and says so, so the panel can admit it')

  const rows = A.activityEntries(store)
  ok(rows[0].path === `src/f${A.ACTIVITY_MAX_ENTRIES + 49}.ts`, 'the newest is kept', rows[0].path)
  ok(!rows.some((r) => r.path === 'src/f0.ts'), 'the oldest is what went')
}

{
  const store = A.newActivityStore()
  const now = 3_000_000_000
  A.recordActivity(store, entry({ path: 'src/old.ts', at: now - A.ACTIVITY_TTL_MS - 1 }))
  A.recordActivity(store, entry({ path: 'src/new.ts', at: now - 1000 }))
  A.sweepActivity(store, now)
  const rows = A.activityEntries(store)
  ok(rows.length === 1 && rows[0].path === 'src/new.ts', 'half an hour on, an entry is swept', JSON.stringify(rows.map((r) => r.path)))
  ok(store.truncated === false, 'and expiring is not the same as being truncated')
}

/* ------------------------------------------------------------------- tree */

console.log('\nthe tree')
{
  const nodes = T.buildActivityTree([
    entry({ path: 'src/components/rail/ActivitySection.tsx', at: 3000 }),
    entry({ path: 'src/components/rail/ActivityTree.tsx', at: 2000 })
  ])
  ok(nodes.length === 1 && nodes[0].kind === 'dir', 'one folder at the root')
  ok(nodes[0].name === 'src/components/rail', 'a single-child chain collapses into one row', nodes[0].name)
  ok(nodes[0].children.length === 2, 'with both files under it')
  ok(nodes[0].children[0].name === 'ActivitySection.tsx', 'newest first', nodes[0].children[0].name)
}

{
  const nodes = T.buildActivityTree([entry({ path: 'src/App.tsx' })])
  ok(nodes.length === 1 && nodes[0].kind === 'dir' && nodes[0].name === 'src', 'a folder holding one file does not collapse into it')
  ok(nodes[0].children[0].kind === 'file' && nodes[0].children[0].name === 'App.tsx', 'the file keeps its own row')
}

{
  const nodes = T.buildActivityTree([
    entry({ path: 'README.md', at: 5000 }),
    entry({ path: 'src/App.tsx', at: 1000 }),
    entry({ path: 'electron/main.ts', at: 4000 })
  ])
  ok(nodes.map((n) => n.kind).join(',') === 'dir,dir,file', 'directories come before files', nodes.map((n) => n.kind).join(','))
  ok(nodes[0].name === 'electron', 'and the folders are in recency order', nodes[0].name)
  ok(nodes[2].name === 'README.md', 'a root-level file is a row of its own', nodes[2].name)
}

{
  // The same file from two panes: one row, two entries, the newest first, and
  // exact wins the glyph even when the guess arrived later.
  const nodes = T.buildActivityTree([
    entry({ path: 'src/App.tsx', paneId: 'p1', exactness: 'exact', at: 2000 }),
    entry({ path: 'src/App.tsx', paneId: 'p2', at: 9000 })
  ])
  const file = nodes[0].children[0]
  ok(file.entries.length === 2, 'two panes on one file share a row', String(file.entries.length))
  ok(file.entries[0].paneId === 'p2', 'the most recent touch leads', file.entries[0].paneId)
  ok(file.exact === true, 'and one exact entry makes the row exact')
  ok(file.at === 9000, 'the row is as fresh as its freshest entry', String(file.at))
}

{
  const nodes = T.buildActivityTree([
    entry({ path: 'src/App.tsx', at: 1000 }),
    entry({ path: 'SRC/app.tsx', at: 2000 })
  ])
  ok(T.collectFiles(nodes).length === 1, 'NTFS casing does not make two rows of one file', String(T.collectFiles(nodes).length))
}

ok(T.buildActivityTree([]).length === 0, 'nothing touched is an empty tree')

console.log('\ngrouped by agent')
{
  const groups = T.groupByAgent([
    entry({ path: 'a.ts', paneId: '', profileId: '', at: 9000 }),
    entry({ path: 'b.ts', paneId: 'p1', at: 1000 }),
    entry({ path: 'c.ts', paneId: 'p2', at: 5000 })
  ])
  ok(groups.length === 3, 'one group per pane', String(groups.length))
  ok(groups[0].paneId === 'p2' && groups[1].paneId === 'p1', 'busiest-most-recently first', groups.map((g) => g.paneId).join(','))
  ok(groups[2].paneId === '', 'and Unattributed is always last however recent it is', groups[2].paneId)
}

console.log('\nrelative time')
ok(T.activityAge(1000, 1000) === 'now', 'this instant reads as now')
ok(T.activityAge(0, 120_000) === '2m', 'two minutes is 2m', T.activityAge(0, 120_000))
ok(T.activityAge(0, 3 * 3600_000) === '3h', 'three hours is 3h', T.activityAge(0, 3 * 3600_000))
ok(T.activityAge(0, 48 * 3600_000) === '2d', 'two days is 2d', T.activityAge(0, 48 * 3600_000))

/* ---------------------------------------------------------------- verdict */

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
