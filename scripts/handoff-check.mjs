/**
 * Rules check for handoff packs.
 *
 *   node scripts/handoff-check.mjs
 *
 * A handoff is one agent writing down what it was doing so another agent, from
 * another company, can pick the work up. Forge creates the file and watches it
 * fill; the agent fills it with its own file tools. So the parts that decide
 * whether that works at all are pure, live in shared/handoff.ts and
 * electron/handoff-store.ts, and are held to their rules here.
 *
 * Three things this asserts that are easy to get wrong and impossible to notice:
 *
 *   • `isFilled` is the whole of `open → ready`. A rule that says yes too early
 *     hands the next agent an empty template; one that says no too late leaves a
 *     pane waiting forever. Both directions are pinned.
 *   • the id shape is the *only* thing standing between a renderer string and a
 *     `join()`, so everything that is not an id is refused rather than sanitised.
 *   • `markHandoff` re-heads a pack and must leave the body byte-identical — it
 *     is the agent's work, and Forge marking it taken must not so much as
 *     re-wrap it.
 */
import { registerHooks } from 'node:module'

/**
 * `electron`, stubbed — the same trick scripts/share-check.mjs uses.
 *
 * Nothing this file exercises needs it: shared/handoff.ts and
 * electron/handoff-store.ts are both deliberately free of any electron import,
 * which is what lets the real modules be driven against `mkdtempSync()` instead
 * of a copy. The stub is here only so a stray transitive import cannot take the
 * run down.
 */
const ELECTRON_STUB = 'forge-check:electron'

registerHooks({
  resolve(spec, context, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('@/')) {
      return next(new URL(`../src/${spec.slice('@/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url === ELECTRON_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const app = { getPath: () => "", getAppPath: () => "" }'
      }
    }
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const H = await import('../shared/handoff.ts')
const S = await import('../shared/share.ts')

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

/* ---------------------------------------------------------------- identity */

console.log('\nidentity')
{
  const id = H.newHandoffId(Date.parse('2026-09-02T14:12:33'))
  ok(H.isHandoffId(id), 'a fresh id is an id', id)
  ok(/^20260902-141233-[0-9a-f]{4}$/.test(id), 'stamped to the second, with four hex to break a tie', id)
  ok(H.handoffFileName(id) === `${id}.md`, 'a pack is named by its id', H.handoffFileName(id))
  ok(H.handoffRelPath(id) === `.forge/handoff/${id}.md`, 'and lives under .forge/handoff', H.handoffRelPath(id))
  ok(H.HANDOFF_DIR_REL === '.forge/handoff', 'which is the directory the constant names')
  ok(H.newHandoffId(Date.now()) !== H.newHandoffId(Date.now()), 'two ids made in the same moment differ')

  const refused = [
    '',
    'slot-1',
    '../../evil',
    '20260902-141233',
    '20260902-141233-9F0A',
    '20260902-141233-9f0az',
    '2026090-141233-9f0a',
    '20260902-141233-9f0a.md',
    '20260902/141233-9f0a',
    42,
    null,
    undefined,
    {}
  ]
  ok(refused.every((v) => !H.isHandoffId(v)), 'everything that is not an id is refused')
}

/* ------------------------------------------------------------- round trip */

console.log('\nformat round trip')
const record = {
  id: '20260902-141233-9f0a',
  title: 'Handoff: the sync endpoint',
  status: 'ready',
  from: 'pane-1',
  fromAgent: 'Claude',
  fromTitle: 'main',
  to: 'pane-2',
  toAgent: 'Antigravity',
  toTitle: 'worker',
  origin: '20260901-090000-0001',
  createdAt: Date.parse('2026-09-02T14:12:33Z'),
  updatedAt: Date.parse('2026-09-02T14:40:00Z'),
  transcript: 'C:\\Users\\steve\\.claude\\projects\\x\\abc.jsonl',
  bytes: 0,
  filled: false
}
const body = 'Line one.\n\n---\n\nA body whose third line is a rule.\n'
const rendered = H.formatHandoff(record, body)
const round = H.parseHandoff(record.id, rendered, 1)
{
  ok(round.body === body, 'the body comes back byte for byte, rule line and all', JSON.stringify(round.body))
  for (const key of ['id', 'title', 'status', 'from', 'fromAgent', 'fromTitle', 'to', 'toAgent', 'toTitle', 'origin', 'transcript']) {
    ok(round.record[key] === record[key], `${key} survives the round trip`, `${round.record[key]} vs ${record[key]}`)
  }
  ok(round.record.createdAt === record.createdAt, 'createdAt survives to the second')
  ok(round.record.updatedAt === record.updatedAt, 'updatedAt survives to the second')
  ok(rendered.startsWith('---\nid: 20260902-141233-9f0a\n'), 'front matter leads with the id')
  ok(
    H.HANDOFF_KEYS.every((key) => new RegExp(`^${key}: `, 'm').test(rendered)),
    'every declared front-matter key is actually written'
  )
  const order = H.HANDOFF_KEYS.map((k) => rendered.indexOf(`\n${k}: `))
  ok(
    order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])),
    'and in the declared order',
    JSON.stringify(order)
  )
  ok(H.HANDOFF_MAX_BYTES === S.SHARE_MAX_BYTES, 'a pack is capped exactly as a slot is')
  ok(H.HANDOFF_INLINE_MAX === 4000, 'and inlines under the same 4000 characters')
}

/* -------------------------------------------------------- tolerant reading */

console.log('\ntolerant reading')
{
  const plain = H.parseHandoff('20260902-141233-9f0a', '# Handoff: hand-written\n\nGoal: ship it.\n', 4242)
  ok(plain.record.id === '20260902-141233-9f0a', 'a file with no front matter takes its id from the caller')
  ok(plain.record.status === 'open', 'and reads as open')
  ok(plain.record.updatedAt === 4242, 'with its time taken from the file mtime')
  ok(plain.body === '# Handoff: hand-written\n\nGoal: ship it.\n', 'and the whole file as the body')

  const crlf = H.parseHandoff(
    '20260902-141233-9f0a',
    '---\r\nid: 20260902-141233-9f0a\r\ntitle: Windows wrote this\r\nstatus: taken\r\n---\r\n\r\nBody.\r\n',
    9
  )
  ok(crlf.record.title === 'Windows wrote this', 'CRLF front matter parses', crlf.record.title)
  ok(crlf.record.status === 'taken', 'CRLF status parses')
  ok(crlf.body === 'Body.\r\n', 'CRLF body keeps its own line endings', JSON.stringify(crlf.body))

  const bom = H.parseHandoff('20260902-141233-9f0a', '\ufeff---\nid: x\ntitle: With a BOM\n---\n\nBody.', 9)
  ok(bom.record.title === 'With a BOM', 'a leading BOM does not hide the front matter', bom.record.title)

  const unclosed = '---\nid: x\ntitle: never closed\n\nstill going'
  ok(H.parseHandoff('20260902-141233-9f0a', unclosed, 7).body === unclosed, 'an unterminated header leaves the file as the body')

  const badStatus = H.parseHandoff('20260902-141233-9f0a', '---\nid: x\nstatus: teleported\n---\n\nb', 1)
  ok(badStatus.record.status === 'open', 'an unknown status reads as open')

  const badDate = H.parseHandoff('20260902-141233-9f0a', '---\nid: x\nupdatedAt: not-a-date\n---\n\nb', 5150)
  ok(badDate.record.updatedAt === 5150, 'an unparseable date falls back to the mtime')

  ok(H.parseHandoff('20260902-141233-9f0a', '', 0).record.title === 'Untitled', 'nothing at all still reads as a record')
}

/* ------------------------------------------------------------- the filling */

console.log('\nfilled or not')
{
  ok(!H.isFilled(H.HANDOFF_TEMPLATE), 'the untouched template is not filled')
  ok(!H.isFilled(H.handoffTemplate('The sync endpoint')), 'and neither is it with a real title in the heading')
  ok(!H.isFilled(''), 'an empty body is not filled')
  ok(!H.isFilled('   \n\n\t\n'), 'and neither is whitespace')

  const reordered = H.HANDOFF_TEMPLATE.split('\n\n').reverse().join('\n\n')
  ok(!H.isFilled(reordered), 'a template whose headings were only reordered is not filled')

  const headingsOnly = '# Handoff: x\n\n## Goal\n\n## Done\n\n## Left to do\n'
  ok(!H.isFilled(headingsOnly), 'headings with the placeholders deleted are not filled either')

  const oneLine = H.handoffTemplate('The sync endpoint').replace(
    '(what we are building, in two or three sentences)',
    'We are adding a /sync endpoint that reconciles the local queue.'
  )
  ok(H.isFilled(oneLine), 'one real line under Goal is filled')

  ok(H.isPlaceholderLine('(anything that bit us)'), 'a whole line in parentheses is a placeholder')
  ok(H.isPlaceholderLine('  (indented)  '), 'indentation does not hide one')
  ok(!H.isPlaceholderLine('run (npm test) first'), 'a line that merely contains parentheses is not one')
  ok(!H.isPlaceholderLine('()'), 'and neither is an empty pair')
  ok(
    H.HANDOFF_TEMPLATE.split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .every((l) => H.isPlaceholderLine(l)),
    'every non-heading line of the template is a placeholder — which is why isFilled works'
  )
}

/* ----------------------------------------------------------------- prompts */

console.log('\nthe prompts')
{
  const ask = H.handoffAskPrompt(round.record)
  ok(ask.includes(H.handoffRelPath(record.id)), 'the ask names the path to open', ask.slice(0, 80))
  ok(ask.includes('Antigravity'), 'and who is taking over')
  ok(ask.includes('HANDOFF READY'), 'and what done sounds like')
  ok(ask.includes(record.transcript), 'and the transcript, when there is one')
  ok(ask.includes('## Left to do'), 'and carries the template')
  ok(ask.endsWith('\n'), 'and ends with the template, newline and all')

  const noTranscript = H.handoffAskPrompt({ ...round.record, transcript: '', toAgent: '' })
  ok(noTranscript.includes('another agent'), 'with no target agent it says "another agent"', noTranscript.slice(0, 60))
  ok(!noTranscript.includes('transcript'), 'and with no transcript it does not mention one')

  const take = H.handoffTakePrompt(round.record, 'The pack.\n')
  ok(take.includes('Claude') && take.includes('"main"'), 'the take names who and which pane', take.slice(0, 80))
  ok(take.includes('Do not edit the pack.'), 'and says not to edit the pack')
  ok(take.includes('Left to do'), 'and where to continue from')
  ok(take.includes('\n\nThe pack.\n'), 'a short pack is inlined', JSON.stringify(take.slice(-20)))

  const big = 'x'.repeat(H.HANDOFF_INLINE_MAX + 1)
  ok(!H.handoffTakePrompt(round.record, big).includes('xxx'), 'a pack over the inline cap is not inlined')
  const atCap = 'y'.repeat(H.HANDOFF_INLINE_MAX)
  ok(H.handoffTakePrompt(round.record, atCap).includes(atCap), 'and one exactly at the cap still is')
  ok(!H.handoffTakePrompt(round.record, null).includes('\n\n'), 'no body, no inline')
}

/* ---------------------------------------------------------------- the store */

const { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync } = await import('node:fs')
const { join } = await import('node:path')
const { tmpdir } = await import('node:os')
const ST = await import('../electron/handoff-store.ts')

console.log('\nthe store')
{
  const dir = mkdtempSync(join(tmpdir(), 'forge-handoff-'))
  ok(ST.handoffDir(dir) === join(dir, '.forge', 'handoff'), 'the folder is .forge\\handoff under the project', ST.handoffDir(dir))
  ok(ST.listHandoffs(dir).length === 0, 'a project with no packs lists none')

  const started = ST.startHandoff(
    dir,
    {
      title: 'The sync endpoint',
      from: 'pane-1',
      fromAgent: 'Claude',
      fromTitle: 'main',
      toAgent: 'Antigravity',
      transcript: 'C:\\x\\abc.jsonl'
    },
    Date.parse('2026-09-02T14:12:33')
  )
  ok(started !== null && H.isHandoffId(started.id), 'start() creates a pack and answers with it', JSON.stringify(started))
  const path = join(dir, '.forge', 'handoff', `${started.id}.md`)
  ok(existsSync(path), 'in the file named for its id')
  ok(!readdirSync(join(dir, '.forge', 'handoff')).some((n) => n.endsWith('.tmp')), 'and leaves no .tmp behind')
  ok(started.status === 'open', 'it starts open')
  ok(started.filled === false, 'and not filled')
  ok(started.fromAgent === 'Claude' && started.toAgent === 'Antigravity', 'with the agents it was told about')
  ok(started.transcript === 'C:\\x\\abc.jsonl', 'and the transcript path, backslashes and all', started.transcript)
  ok(ST.readHandoff(dir, started.id).body === H.handoffTemplate('The sync endpoint'), 'and the template as its body')

  const listed = ST.listHandoffs(dir)
  ok(listed.length === 1 && listed[0].id === started.id, 'list() shows it')
  ok(listed[0].status === 'open' && listed[0].filled === false, 'as open and not filled')

  // The agent writes the pack with its own tools — the whole point of the feature.
  const filledBody = H.handoffTemplate('The sync endpoint').replace(
    '(the next steps, in order)',
    '1. Wire the retry. 2. Add the test in scripts/sync-check.mjs.'
  )
  const head = readFileSync(path, 'utf8').split('\n---\n')[0]
  writeFileSync(path, `${head}\n---\n\n${filledBody}`, 'utf8')

  const afterWrite = ST.listHandoffs(dir)
  ok(afterWrite[0].filled === true, 'once the agent writes real content, the pack reads as filled')
  ok(afterWrite[0].status === 'open', 'and is still open — promoting is the watcher’s job, not the store’s')
  ok(afterWrite[0].bytes > 0, 'with the body size on the record', String(afterWrite[0].bytes))

  const beforeMark = readFileSync(path, 'utf8')
  const bodyBefore = ST.readHandoff(dir, started.id).body
  const ready = ST.markHandoff(dir, started.id, { status: 'ready' }, Date.parse('2026-09-02T15:00:00Z'))
  ok(ready?.status === 'ready', 'mark() moves it to ready', JSON.stringify(ready?.status))
  ok(ST.readHandoff(dir, started.id).body === bodyBefore, 'and the body is byte-identical afterwards')
  ok(readFileSync(path, 'utf8') !== beforeMark, 'while the header did change')
  ok(ready.updatedAt === Date.parse('2026-09-02T15:00:00Z'), 'with updatedAt bumped to the moment it was marked')
  ok(ready.createdAt === ST.listHandoffs(dir)[0].createdAt, 'and createdAt left where it was')

  const taken = ST.markHandoff(dir, started.id, { status: 'taken', to: 'pane-2', toTitle: 'worker' })
  ok(taken?.status === 'taken', 'mark() moves it to taken')
  ok(taken.to === 'pane-2' && taken.toTitle === 'worker', 'and records the target pane')
  ok(taken.toAgent === 'Antigravity', 'leaving the fields the patch did not name alone')
  ok(ST.readHandoff(dir, started.id).body === bodyBefore, 'and the body is still byte-identical')

  ok(ST.readHandoff(dir, '20260101-000000-0000') === null, 'reading a pack that is not there is null, not an error')
  ok(ST.markHandoff(dir, '20260101-000000-0000', { status: 'ready' }) === null, 'and so is marking one')
  for (const bad of ['../../evil', 'slot-1', '', null]) {
    ok(ST.handoffPath(dir, bad) === null, `there is no path for ${JSON.stringify(bad)}`)
    ok(ST.readHandoff(dir, bad) === null, `and nothing to read at ${JSON.stringify(bad)}`)
  }

  // A file in the folder whose name is not an id belongs to somebody else.
  writeFileSync(join(dir, '.forge', 'handoff', 'notes.md'), '# mine\n', 'utf8')
  ok(ST.listHandoffs(dir).length === 1, 'a file that is not named for an id is skipped rather than listed')

  const second = ST.startHandoff(dir, { title: 'A later one' }, Date.parse('2026-09-03T09:00:00'))
  ok(ST.listHandoffs(dir)[0].id === second.id, 'the newest pack is listed first')
  ok(ST.listHandoffs(dir).length === 2, 'and both are there')
}

/* ------------------------------------------------------------- the view */

/**
 * What the pane's Handoff control says — src/lib/handoffview.ts.
 *
 * Two things are asserted here that no type can hold and no eye would catch in
 * a menu that mostly looks right:
 *
 *   • the *order*. Hand back is first because bouncing work home is the answer
 *     nine times out of ten, and a menu whose top row is usually right is a menu
 *     people stop reading. A refactor that sorted the rows alphabetically would
 *     break nothing and ruin it.
 *   • who is *not* offered. A shell cannot write a pack and cannot read one, the
 *     pane itself is not a handover, and a hand-back to a pane that has been
 *     closed writes a record addressed to a pane id that names nothing.
 */
const V = await import('../src/lib/handoffview.ts')

console.log('\nthe menu')
{
  const profiles = [
    { id: 'pwsh', name: 'PowerShell', command: '', accent: '#888', badge: 'PS', kind: 'shell' },
    { id: 'claude', name: 'Claude', command: 'claude', accent: '#c96', badge: 'CL', kind: 'agent' },
    { id: 'codex', name: 'Codex', command: 'codex', accent: '#6c9', badge: 'CO', kind: 'agent' }
  ]
  const leaf = (id, profileId, title = '') => ({ type: 'leaf', id, profileId, title })
  const workspace = {
    tabs: [
      {
        id: 'tab-1',
        title: 'Work',
        root: leaf('pane-1', 'claude', 'main'),
        activePaneId: 'pane-1',
        settings: { handoffTargetId: 'codex' }
      },
      { id: 'tab-2', title: 'Other', root: leaf('pane-2', 'codex', 'worker'), activePaneId: 'pane-2' },
      { id: 'tab-3', title: 'Shell', root: leaf('pane-3', 'pwsh'), activePaneId: 'pane-3' },
      { id: 'tab-4', title: 'Asleep', root: leaf('pane-4', 'claude', 'dead'), activePaneId: 'pane-4' }
    ],
    activeTabId: 'tab-1'
  }
  const tab = workspace.tabs[0]
  const alive = new Set(['pane-1', 'pane-2', 'pane-3'])
  const isLive = (id) => alive.has(id)

  const took = {
    ...H.emptyHandoff('20260902-100000-0001', Date.parse('2026-09-02T10:00:00Z')),
    status: 'taken',
    title: 'The sync endpoint',
    from: 'pane-2',
    fromAgent: 'Codex',
    fromTitle: 'worker',
    to: 'pane-1',
    toAgent: 'Claude',
    toTitle: 'main'
  }

  const base = { paneId: 'pane-1', tab, workspace, profiles, isLive }

  const plain = V.handoffTargets({ ...base, records: [] })
  ok(plain[0]?.kind === 'default', 'with nothing to hand back, the tab default leads', JSON.stringify(plain[0]?.kind))
  ok(plain[0]?.profileId === 'codex' && plain[0]?.note === 'tab default', 'and names the profile the tab chose')
  ok(plain[1]?.kind === 'pane' && plain[1]?.paneId === 'pane-2', 'then the live agent panes', JSON.stringify(plain[1]))
  ok(
    plain.filter((t) => t.kind === 'pane').length === 1,
    'and only those: the shell, the dead pane and this pane itself are all left out',
    JSON.stringify(plain.filter((t) => t.kind === 'pane').map((t) => t.paneId))
  )
  ok(!plain.some((t) => t.paneId === 'pane-1'), 'handing work to yourself is not offered')
  ok(!plain.some((t) => t.paneId === 'pane-3'), 'and neither is a shell')
  ok(!plain.some((t) => t.paneId === 'pane-4'), 'and neither is a pane that is not running')

  const news = plain.filter((t) => t.kind === 'new')
  ok(news.length === 2, 'every non-shell profile can be opened fresh', String(news.length))
  ok(
    news.every((t) => t.label.startsWith('New ')),
    'each said as "New <agent>"',
    JSON.stringify(news.map((t) => t.label))
  )
  ok(!news.some((t) => t.profileId === 'pwsh'), 'and never a new shell — a prompt cannot write a pack')
  ok(
    plain.indexOf(news[0]) > plain.lastIndexOf(plain.filter((t) => t.kind === 'pane').pop()),
    'the new rows come after every pane that is already open'
  )
  ok(new Set(plain.map((t) => t.key)).size === plain.length, 'every row has its own key')

  const back = V.handoffTargets({ ...base, records: [took] })
  ok(back[0]?.kind === 'back', 'a pane that was handed work leads with handing it back', JSON.stringify(back[0]?.kind))
  ok(back[0]?.label === 'Hand back to Codex — worker', 'named for the agent and the pane it came from', back[0]?.label)
  ok(back[0]?.origin === took.id, 'and carries the pack it replies to, so the hand-back records its origin')
  ok(back[0]?.paneId === 'pane-2', 'addressed to the pane that wrote it')
  ok(back[1]?.kind === 'default', 'the tab default still comes second')
  ok(
    !back.some((t) => t.kind === 'pane' && t.paneId === 'pane-2'),
    'and the source pane is not offered twice — the hand-back row is its row'
  )
  ok(V.handbackRecord({ ...base, records: [took] })?.id === took.id, 'handbackRecord names the pack itself')

  const gone = V.handoffTargets({ ...base, records: [{ ...took, from: 'pane-9' }] })
  ok(gone[0]?.kind === 'default', 'a hand-back to a pane that has been closed is not offered', JSON.stringify(gone[0]))
  const asleep = V.handoffTargets({ ...base, records: [{ ...took, from: 'pane-4' }] })
  ok(asleep[0]?.kind === 'default', 'and neither is one to a pane that is no longer running')
  const notMine = V.handoffTargets({ ...base, records: [{ ...took, to: 'pane-2' }] })
  ok(notMine[0]?.kind === 'default', 'a pack taken by somebody else is not this pane’s to hand back')
  const stillOpen = V.handoffTargets({ ...base, records: [{ ...took, status: 'ready' }] })
  ok(stillOpen[0]?.kind === 'default', 'and neither is one that was never taken')

  const older = { ...took, id: '20260901-090000-0002', updatedAt: Date.parse('2026-09-01T09:00:00Z') }
  const newest = V.handoffTargets({ ...base, records: [older, took] })
  ok(newest[0]?.origin === took.id, 'the newest hand-back wins', newest[0]?.origin)

  const noDefault = V.handoffTargets({ ...base, tab: { ...tab, settings: {} }, records: [] })
  ok(noDefault[0]?.kind === 'pane', 'a tab with no default names none')
  const deadDefault = V.handoffTargets({ ...base, tab: { ...tab, settings: { handoffTargetId: 'gone' } }, records: [] })
  ok(deadDefault[0]?.kind === 'pane', 'a default naming a profile that has been deleted is no default at all')
  const shellDefault = V.handoffTargets({ ...base, tab: { ...tab, settings: { handoffTargetId: 'pwsh' } }, records: [] })
  ok(shellDefault[0]?.kind === 'pane', 'and neither is one naming a shell')
  ok(V.handoffTargets({ ...base, tab: null, records: [] })[0]?.kind === 'pane', 'a pane with no tab still gets a menu')

  ok(V.handoffPaneTitle('main') === 'Handoff — main', 'a handoff opens its pane named for where it came from')
  ok(V.handoffPaneTitle('') === 'Handoff', 'and just "Handoff" when it came from nowhere in particular')
}

console.log('\nthe chip')
{
  const at = (t) => Date.parse(t)
  const pack = (patch) => ({ ...H.emptyHandoff(patch.id, at('2026-09-02T10:00:00Z')), title: 'The sync endpoint', ...patch })

  ok(V.paneHandoffChip('pane-1', []) === null, 'a pane with no handoffs says nothing')
  ok(V.paneHandoffChip('', [pack({ id: '20260902-100000-0001', from: 'pane-1' })]) === null, 'and neither does no pane')

  const open = V.paneHandoffChip('pane-1', [pack({ id: '20260902-100000-0001', from: 'pane-1', toAgent: 'Codex' })])
  ok(open?.label === 'Handing off…', 'a pack nobody has written yet is still being handed off', open?.label)
  ok(open?.state === 'waiting' && open.id === '20260902-100000-0001', 'and the chip names the pack a click reveals')
  ok(open?.title.includes('The sync endpoint'), 'with the handoff’s title in the tooltip', open?.title)

  const ready = V.paneHandoffChip('pane-1', [
    pack({ id: '20260902-100000-0001', from: 'pane-1', status: 'ready', toAgent: 'Codex' })
  ])
  ok(ready?.state === 'waiting', 'a written pack that has not moved yet still reads as in flight')

  const sent = V.paneHandoffChip('pane-1', [
    pack({ id: '20260902-100000-0001', from: 'pane-1', status: 'taken', to: 'pane-2', toAgent: 'Codex', toTitle: 'worker' })
  ])
  ok(sent?.label === 'Handed off → Codex', 'once taken, the source pane says where it went', sent?.label)
  ok(sent?.state === 'sent', 'and reads as sent')

  const took = V.paneHandoffChip('pane-2', [
    pack({ id: '20260902-100000-0001', from: 'pane-1', status: 'taken', to: 'pane-2', fromAgent: 'Claude', fromTitle: 'main' })
  ])
  ok(took?.label === 'Took over ← Claude', 'and the target pane says where it came from', took?.label)
  ok(took?.state === 'took', 'and reads as taken over')

  const notYet = V.paneHandoffChip('pane-2', [
    pack({ id: '20260902-100000-0001', from: 'pane-1', status: 'ready', to: 'pane-2', fromAgent: 'Claude' })
  ])
  ok(notYet === null, 'a pane addressed but not yet handed to says nothing — it has not taken anything over')

  const newer = V.paneHandoffChip('pane-1', [
    pack({ id: '20260901-090000-0001', from: 'pane-1', status: 'taken', toAgent: 'Codex', updatedAt: at('2026-09-01T09:00:00Z') }),
    pack({ id: '20260902-140000-0002', from: 'pane-1', updatedAt: at('2026-09-02T14:00:00Z') })
  ])
  ok(newer?.id === '20260902-140000-0002', 'the newest handoff is the one the chip is about', newer?.id)

  const both = V.paneHandoffChip('pane-2', [
    pack({ id: '20260901-090000-0001', from: 'pane-1', status: 'taken', to: 'pane-2', fromAgent: 'Claude', updatedAt: at('2026-09-01T09:00:00Z') }),
    pack({ id: '20260902-140000-0002', from: 'pane-2', updatedAt: at('2026-09-02T14:00:00Z') })
  ])
  ok(both?.label === 'Handing off…', 'a pane that took work over and is now handing it on says the newer thing', both?.label)
}

/* -------------------------------------------------------------------- end */

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)

/**
 * `process.exitCode`, not `process.exit()` — the same reason share-check.mjs
 * gives: an immediate exit tears the TypeScript loader down while it still holds
 * handles, and Node aborts *after* printing PASS.
 */
process.exitCode = fail === 0 ? 0 : 1
