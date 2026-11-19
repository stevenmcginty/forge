/**
 * The Dates agent tools, held to docs/DATES.md ("Agent tools").
 *
 *   node scripts/dates-tools-check.mjs      (npm run dates-tools:check)
 *
 * 1. THE SCHEMAS. shared/brain-tools.ts `DATES_TOOL_SPECS` has the contract's
 *    three tools and field names; Forge's own agents get them in
 *    `forgeToolDefs` (a real VoiceAgentHost, over its brain link) and are
 *    allowed to call them; the forge-bridge copy (bridge/dates-tools.mjs) is
 *    the same word for word and is served and routed to main.
 * 2. THE ANSWERS. shared/dates-tools.ts `runDatesTool` — the one function both
 *    tool sets call — against electron/dates-store.ts on a fresh temp folder:
 *    list / add / update / done / snooze / delete, a repeating line moving
 *    on, and every bad input answered in a sentence instead of a throw.
 * 3. THE WAYS IN. The same calls through the host's handlers and through the
 *    bridge's relay (to a stand-in for main's pipe that answers with
 *    runDatesTool, as electron/browser-panes/ipc.ts does).
 * 4. show_view accepts dates in all three places.
 *
 * The live data dir is never touched: electron/store.ts is swapped, for
 * electron/dates-store.ts only, for a stub whose getDataDir is a temp folder.
 * All examples are made up.
 */
import './ts-hooks.mjs'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TEMP = mkdtempSync(join(tmpdir(), 'forge-dates-tools-'))
const HOST_DIR = join(TEMP, 'host-data')

// Registered after ts-hooks, so it runs first: getDates() (the host's handlers)
// lands in a temp folder, never in %APPDATA%\Forge.
const STORE_STUB = 'data:text/javascript,' + encodeURIComponent(`export function getDataDir(){return ${JSON.stringify(HOST_DIR)}}`)
registerHooks({
  resolve(spec, context, next) {
    if (spec === './store' && String(context.parentURL ?? '').endsWith('/electron/dates-store.ts')) {
      return { url: STORE_STUB, shortCircuit: true }
    }
    return next(spec, context)
  }
})

for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'FORGE_BROWSER_LINK_FILE']) delete process.env[k]

const specs = await import('../shared/brain-tools.ts')
const T = await import('../shared/dates-tools.ts')
const { createDatesService } = await import('../electron/dates-store.ts')
const B = await import('../bridge/dates-tools.mjs')
const APP = await import('../bridge/forge-app-tools.mjs')
const { planShowView } = await import('../src/lib/showView.ts')

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? `\n       ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const src = (p) => readFileSync(join(ROOT, p), 'utf8')

const NAMES = ['dates_list', 'dates_add', 'dates_update']
const LIST_FIELDS = ['include_done', 'kind', 'group']
const ADD_FIELDS = ['title', 'date', 'kind', 'group', 'amount', 'end_date', 'note', 'action', 'estimated', 'remind_days', 'repeat']
const UPDATE_FIELDS = ['id', ...ADD_FIELDS, 'done', 'snooze_until', 'delete']
const FIELDS = { dates_list: LIST_FIELDS, dates_add: ADD_FIELDS, dates_update: UPDATE_FIELDS }
const REQUIRED = { dates_list: [], dates_add: ['title', 'date'], dates_update: ['id'] }
const REPEATS = ['none', 'monthly', 'quarterly', 'yearly']
const sorted = (a) => [...a].sort()

try {
  /* ----------------------------------------------------------- 1. schemas */
  console.log('the schemas: shared, forgeToolDefs, forge-bridge')
  {
    ok(same(T.DATES_TOOL_NAMES, NAMES), 'DATES_TOOL_NAMES is the contract’s three', T.DATES_TOOL_NAMES)
    ok(same(specs.DATES_TOOL_SPECS.map((s) => s.name), NAMES), 'DATES_TOOL_SPECS has the three, in order')
    for (const spec of specs.DATES_TOOL_SPECS) {
      const props = spec.parameters.properties
      ok(same(sorted(Object.keys(props)), sorted(FIELDS[spec.name])), `${spec.name}: the contract’s field names`, Object.keys(props))
      ok(same(spec.parameters.required, REQUIRED[spec.name]), `${spec.name}: required ${JSON.stringify(REQUIRED[spec.name])}`)
      if (props.repeat) ok(same(props.repeat.enum, REPEATS), `${spec.name}: repeat is none, monthly, quarterly or yearly`, props.repeat.enum)
      if (props.remind_days) ok(props.remind_days.type === 'array' && props.remind_days.items?.type === 'integer', `${spec.name}: remind_days is a list of whole days`)
    }
    const words = specs.DATES_TOOL_SPECS.map((s) => s.description).join(' ')
    for (const needle of ['renewals', 'insurance', 'web domains', 'payment plans', 'coming up', 'when you find', 'only when Steve asks']) {
      ok(words.includes(needle), `the descriptions say when to use them: "${needle}"`)
    }

    const { VoiceAgentHost } = await import('../electron/voice-agent/host.ts')
    const host = new VoiceAgentHost({ sendEvent() {}, sendToolRequest() {}, getModel: () => 'opus', getBrain: () => 'codex-cli' })
    const link = host.listLinkTools()
    for (const name of NAMES) {
      const def = link.find((t) => t.name === name)
      ok(!!def, `forgeToolDefs has ${name}`)
      const props = def?.inputSchema?.properties ?? {}
      ok(same(sorted(Object.keys(props)), sorted(FIELDS[name])), `forgeToolDefs ${name}: the contract’s field names`, Object.keys(props))
      ok(same(sorted(def?.inputSchema?.required ?? []), sorted(REQUIRED[name])), `forgeToolDefs ${name}: required ${JSON.stringify(REQUIRED[name])}`, def?.inputSchema?.required)
      ok(def?.description === specs.DATES_TOOL_SPECS.find((s) => s.name === name)?.description, `forgeToolDefs ${name}: the shared description`)
      if (props.repeat) ok(same(props.repeat.enum, REPEATS), `forgeToolDefs ${name}: repeat takes quarterly too`, props.repeat)
      if (props.remind_days) ok(props.remind_days.type === 'array' && props.remind_days.items?.type === 'integer', `forgeToolDefs ${name}: remind_days is an integer list`, props.remind_days)
    }
    const hostSrc = src('electron/voice-agent/host.ts')
    ok(/\.\.\.DATES_TOOL_NAMES\.map\(\(name\) => `mcp__forge__\$\{name\}`\)/.test(hostSrc), 'host.ts allowedTools lets every dates tool through (mcp__forge__dates_*)')

    ok(same(B.DATES_TOOLS.map((t) => t.name), NAMES), 'bridge DATES_TOOLS: the same three names')
    for (const tool of B.DATES_TOOLS) {
      const spec = specs.DATES_TOOL_SPECS.find((s) => s.name === tool.name)
      ok(tool.description === spec?.description, `bridge ${tool.name}: description word for word`)
      ok(same(tool.inputSchema, spec?.parameters), `bridge ${tool.name}: schema identical to the shared one`, tool.inputSchema)
      ok(typeof B.DATES_HANDLERS[tool.name] === 'function', `bridge ${tool.name}: has a handler`)
    }
    const bridgeSrc = src('bridge/gemini-bridge.mjs')
    ok(/\.\.\.DATES_TOOLS\b/.test(bridgeSrc) && /\.\.\.DATES_HANDLERS\b/.test(bridgeSrc), 'forge-bridge serves DATES_TOOLS and DATES_HANDLERS')
    const ops = src('electron/browser-panes/service.ts').match(/export const APP_LINK_OPS[^\n]*/)?.[0] ?? ''
    ok(/\.\.\.DATES_TOOL_NAMES/.test(ops), 'main lets the dates tools through the pipe (APP_LINK_OPS)', ops)
    ok(/if \(isDatesTool\(op\)\) return runDatesTool\(getDates\(\), op, args\)/.test(src('electron/browser-panes/ipc.ts')), 'main answers them with runDatesTool on the live list (browser-panes/ipc.ts)')

    /* -------------------------------------------- 3a. through the host */
    console.log('through the host’s handlers (getDates on a temp folder)')
    const added = await host.callLinkTool('dates_add', { title: 'Van insurance renews', date: '2031-05-01', kind: 'insurance', repeat: 'quarterly' })
    ok(!added.isError && /^Added: \w+ \| 2031-05-01 \| in \d+ days \| insurance \| {2}\| Van insurance renews \(repeats quarterly\)/.test(added.content?.[0]?.text ?? ''), 'dates_add over the brain link answers the new line', added)
    const listed = await host.callLinkTool('dates_list', {})
    ok(/^1 open date\. Today is \d{4}-\d{2}-\d{2}\.\n/.test(listed.content?.[0]?.text ?? '') && listed.content[0].text.includes('Van insurance renews'), 'dates_list over the brain link sees it', listed)
    const onDisk = JSON.parse(readFileSync(join(HOST_DIR, 'dates.json'), 'utf8'))
    ok(onDisk.items.length === 1 && onDisk.items[0].source === 'agent', 'it landed in the stubbed data dir, source agent', onDisk)
    const badShape = await host.callLinkTool('dates_add', { title: 'X', date: '2031-01-01', remind_days: 'soon' })
    ok(badShape.isError === true && /wrong arguments/.test(badShape.content?.[0]?.text ?? ''), 'a remind_days that is not a list is refused by the shape, in words', badShape)
  }

  /* ----------------------------------------------------------- 2. answers */
  console.log('the answers: runDatesTool on a temp-folder store')
  const NOW = new Date(2026, 0, 10, 12, 0, 0)
  const TODAY = '2026-01-10'
  const dir = join(TEMP, 'store')
  const store = createDatesService({ dir, now: () => NOW })
  const run = (name, args) => T.runDatesTool(store, name, args, NOW)
  const idOf = (text) => text.replace(/^[^:]+: /, '').split(' | ')[0]
  const itemOf = (id) => store.list().find((i) => i.id === id)
  {
    const empty = run('dates_list', {})
    ok(empty.ok && empty.text === `No open dates. Today is ${TODAY}.`, 'empty list: says so, with today', empty.text)

    const lease = run('dates_add', { title: 'Shop lease ends', date: '2026-03-31', kind: 'contract', group: 'Shop', amount: '900 a month', note: 'Six months notice | in writing', action: 'Decide whether to renew' })
    ok(lease.ok && lease.text.startsWith('Added: '), 'dates_add answers "Added: <line>"', lease.text)
    const leaseId = idOf(lease.text)
    ok(lease.text === `Added: ${leaseId} | 2026-03-31 | in 80 days | contract | Shop | Shop lease ends | 900 a month | Six months notice / in writing | Decide whether to renew`, 'the line: id | date | when | kind | group | title | amount | note | action (no stray column marks)', lease.text)
    const leaseItem = itemOf(leaseId)
    ok(leaseItem?.source === 'agent' && same(leaseItem?.remindDays, [30, 7, 1, 0]) && leaseItem?.repeat === 'none', 'an added line: source agent, default reminders, no repeat', leaseItem)

    const domain = run('dates_add', { title: 'Web domain expires', date: '2026-01-25', kind: 'domain', estimated: true, remind_days: [14, 0, 14, 3] })
    const domainId = idOf(domain.text)
    ok(domain.ok && domain.text === `Added: ${domainId} | about 2026-01-25 | in 15 days | domain |  | Web domain expires |  |  | `, 'empty fields are left empty; estimated says about', domain.text)
    ok(same(itemOf(domainId)?.remindDays, [14, 3, 0]), 'remind_days goes to remindDays, cleaned by the store', itemOf(domainId)?.remindDays)

    const plan = run('dates_add', { title: 'Payment plan instalment', date: '2026-01-12', kind: 'payment', repeat: 'quarterly', group: 'Cafe' })
    const planId = idOf(plan.text)
    const trip = run('dates_add', { title: 'Holiday', date: '2026-02-01', end_date: '2026-02-08', kind: 'holiday' })
    const tripId = idOf(trip.text)
    ok(trip.ok && trip.text.includes('| 2026-02-01 to 2026-02-08 |') && itemOf(tripId)?.endDate === '2026-02-08', 'end_date goes to endDate and shows in the date', trip.text)

    const list = run('dates_list', {})
    const lines = list.text.split('\n')
    ok(lines[0] === `4 open dates. Today is ${TODAY}.`, 'first line: how many, and today', lines[0])
    ok(lines[1] === 'id | date | when | kind | group | title | amount | note | action', 'then the column names', lines[1])
    ok(same(lines.slice(2).map((l) => l.split(' | ')[0]), [planId, domainId, tripId, leaseId]), 'one line per item, soonest first', lines)
    ok(lines.slice(2).every((l) => l.split(' | ').length === 9), 'every line has the nine fields')
    ok(lines[2].includes('| in 2 days | payment | Cafe | Payment plan instalment (repeats quarterly) |'), 'a repeating line says how it repeats', lines[2])

    const byKind = run('dates_list', { kind: 'Web domain' })
    ok(byKind.text.startsWith('1 open date (kind Web domain).') && byKind.text.includes(domainId), 'kind narrows the list (id or label, any case)', byKind.text)
    const byGroup = run('dates_list', { group: 'caf' })
    ok(byGroup.text.startsWith('1 open date (group "caf").') && byGroup.text.includes(planId), 'group narrows the list (contains, any case)', byGroup.text)
    const none = run('dates_list', { kind: 'licence' })
    ok(none.text === `No open dates (kind licence). Today is ${TODAY}.`, 'nothing matching: says so', none.text)

    const upd = run('dates_update', { id: leaseId, title: 'Shop lease ends (unit 4)', amount: '950 a month', remind_days: [60, 30], end_date: '2026-04-30', estimated: true })
    ok(upd.ok && upd.text.startsWith(`Updated: ${leaseId} | about 2026-03-31 to 2026-04-30 | in 80 days | contract | Shop | Shop lease ends (unit 4) | 950 a month |`), 'dates_update answers the changed line', upd.text)
    const li = itemOf(leaseId)
    ok(li?.title === 'Shop lease ends (unit 4)' && li?.amount === '950 a month' && same(li?.remindDays, [60, 30]) && li?.endDate === '2026-04-30' && li?.estimated === true, 'snake_case went to the store camelCase (remindDays, endDate)', li)
    const cleared = run('dates_update', { id: leaseId, end_date: '' })
    ok(cleared.ok && itemOf(leaseId)?.endDate === undefined, 'end_date "" clears the end day', cleared.text)
    const moved = run('dates_update', { id: leaseId, date: '2026-04-01' })
    ok(moved.ok && itemOf(leaseId)?.date === '2026-04-01', 'date moves', moved.text)

    const snoozed = run('dates_update', { id: domainId, snooze_until: '2026-01-20' })
    ok(snoozed.ok && itemOf(domainId)?.snoozedUntil === '2026-01-20', 'snooze_until snoozes', snoozed.text)
    const unsnoozed = run('dates_update', { id: domainId, snooze_until: '' })
    ok(unsnoozed.ok && itemOf(domainId)?.snoozedUntil === undefined, 'snooze_until "" clears the snooze', unsnoozed.text)

    const done = run('dates_update', { id: domainId, done: true })
    ok(done.ok && done.text.startsWith(`Marked done: ${domainId} | about 2026-01-25 | done |`), 'done true marks it done', done.text)
    ok(itemOf(domainId)?.done === true && typeof itemOf(domainId)?.doneAt === 'string', 'the store has it done, with doneAt')
    ok(!run('dates_list', {}).text.includes(domainId), 'a done line leaves the open list')
    const withDone = run('dates_list', { include_done: true })
    ok(withDone.text.startsWith(`4 dates. Today is ${TODAY}.`) && withDone.text.includes(`${domainId} | about 2026-01-25 | done |`), 'include_done lists it, last, as done', withDone.text)
    const reopened = run('dates_update', { id: domainId, done: false })
    ok(reopened.ok && itemOf(domainId)?.done === false, 'done false opens it again', reopened.text)

    const repeat = run('dates_update', { id: planId, done: true })
    const pi = itemOf(planId)
    ok(repeat.ok && pi?.done === false && pi?.date === '2026-04-12', 'a quarterly line marked done stays open and moves on 3 months', pi)
    ok(repeat.text.startsWith('Done, and it repeats: the next one is 2026-04-12. '), 'and says the next date', repeat.text)

    const gone = run('dates_update', { id: tripId, delete: true })
    ok(gone.ok && gone.text.startsWith(`Deleted: ${tripId} |`) && !itemOf(tripId), 'delete true removes it, answering the line it was', gone.text)

    console.log('bad input: a sentence, never a throw')
    const expectNo = (reply, label, re) => ok(reply.ok === false && re.test(reply.text), label, reply.text)
    let threw = null
    try {
      expectNo(run('dates_update', { id: 'nosuchid', title: 'x' }), 'unknown id', /^No date was changed: No date has the id "nosuchid"\. dates_list shows the ids\.$/)
      expectNo(run('dates_update', { id: tripId, done: true }), 'a deleted id is unknown too', /No date has the id/)
      expectNo(run('dates_update', { title: 'x' }), 'no id', /^No date was changed: An id is needed\./)
      expectNo(run('dates_add', { title: 'Licence renewal', date: '2026-02-30' }), 'bad date on add', /^No date was added: "2026-02-30" is not a real day\. Write it as YYYY-MM-DD\.$/)
      expectNo(run('dates_add', { title: 'Licence renewal', date: '31/03/2026' }), 'a date in the wrong form', /is not a real day/)
      expectNo(run('dates_add', { date: '2026-05-01' }), 'no title', /^No date was added: A date needs a title\.$/)
      expectNo(run('dates_add', { title: 'Holiday', date: '2026-05-10', end_date: '2026-05-01' }), 'end_date before date', /The end day cannot be before the date/)
      expectNo(run('dates_add', { title: 'Plan', date: '2026-05-10', repeat: 'weekly' }), 'a repeat the contract has not got (raw bridge args)', /Repeat must be none, monthly, quarterly or yearly/)
      expectNo(run('dates_update', { id: leaseId, date: '2026-13-01' }), 'bad date on update', /^No date was changed: "2026-13-01" is not a real day/)
      const before = itemOf(leaseId)?.title
      expectNo(run('dates_update', { id: leaseId, title: 'Should not save', snooze_until: 'next week' }), 'bad snooze day', /is not a real day to snooze to/)
      ok(itemOf(leaseId)?.title === before, 'and nothing else in that call was saved', itemOf(leaseId)?.title)
      expectNo(run('dates_update', { id: leaseId }), 'nothing to change', /^No date was changed: Nothing to change/)
      expectNo(run('dates_fly', {}), 'an unknown tool', /There is no Dates tool called dates_fly/)
      const junk = run('dates_add', null)
      ok(junk.ok === false && typeof junk.text === 'string', 'args that are not an object', junk.text)
      const junkList = run('dates_list', 'everything')
      ok(junkList.ok === true && junkList.text.startsWith('3 open dates.'), 'dates_list with junk args lists everything open', junkList.text)
    } catch (err) {
      threw = err
    }
    ok(threw === null, 'none of those threw', threw?.stack)

    const reloaded = createDatesService({ dir, now: () => NOW })
    ok(same(reloaded.list(), store.list()), 'every change was saved: a fresh service on the folder reads the same list')
  }

  /* ------------------------------------------ 3b. through the bridge relay */
  console.log('through the bridge: relayed to main’s pipe, answered by runDatesTool')
  {
    const noLink = await B.DATES_HANDLERS.dates_list({})
    ok(noLink.isError === true && /Forge is not reachable from here/.test(noLink.content?.[0]?.text ?? ''), 'no link file: an error result in words, not a throw', noLink)

    const relayDir = join(TEMP, 'relay')
    const relayStore = createDatesService({ dir: relayDir })
    const token = 'check-token'
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\forge-dates-tools-check-${process.pid}` : join(TEMP, 'pipe.sock')
    const seen = []
    const server = createServer((socket) => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        buffer += chunk
        const nl = buffer.indexOf('\n')
        if (nl === -1) return
        const req = JSON.parse(buffer.slice(0, nl))
        seen.push(req)
        const reply = req.token === token ? T.runDatesTool(relayStore, req.op, req.args) : { ok: false, text: 'bad token' }
        socket.end(`${JSON.stringify(reply)}\n`)
      })
    })
    await new Promise((res) => server.listen(pipe, res))
    const linkFile = join(TEMP, 'link.json')
    writeFileSync(linkFile, JSON.stringify({ pipe, token }))
    process.env.FORGE_BROWSER_LINK_FILE = linkFile
    try {
      const add = await B.DATES_HANDLERS.dates_add({ title: 'Software subscription renews', date: '2030-06-01', kind: 'subscription', remind_days: [7], repeat: 'yearly' })
      ok(!add.isError && /^Added: \w+ \| 2030-06-01 \|/.test(add.content?.[0]?.text ?? ''), 'bridge dates_add: the new line', add)
      ok(seen[0]?.op === 'dates_add' && same(seen[0]?.args?.remind_days, [7]) && seen[0]?.args?.repeat === 'yearly', 'the args reach main as given (snake_case)', seen[0])
      const it = relayStore.list()[0]
      ok(it?.source === 'agent' && same(it?.remindDays, [7]) && it?.repeat === 'yearly', 'main saved it, source agent', it)
      const list = await B.DATES_HANDLERS.dates_list({})
      ok(!list.isError && list.content?.[0]?.text.split('\n')[0].startsWith('1 open date. Today is '), 'bridge dates_list', list)
      const bad = await B.DATES_HANDLERS.dates_update({ id: 'nosuchid', done: true })
      ok(bad.isError === true && /^No date was changed: No date has the id "nosuchid"/.test(bad.content?.[0]?.text ?? ''), 'bridge dates_update, unknown id: an error result with the sentence', bad)
      const done = await B.DATES_HANDLERS.dates_update({ id: it.id, done: true })
      ok(!done.isError && /^Done, and it repeats: the next one is 2031-06-01\./.test(done.content?.[0]?.text ?? ''), 'bridge dates_update done on a yearly line: moves on a year', done)
    } finally {
      delete process.env.FORGE_BROWSER_LINK_FILE
      await new Promise((res) => server.close(res))
    }
  }

  /* --------------------------------------------------------- 4. show_view */
  console.log('show_view accepts dates, in all three places')
  {
    const spec = specs.MAIN_AGENT_TOOL_SPECS.find((t) => t.name === 'show_view')
    ok(spec?.parameters.properties.view.enum.includes('dates'), 'shared/brain-tools.ts: view enum has dates', spec?.parameters.properties.view.enum)
    const bridge = APP.APP_TOOLS.find((t) => t.name === 'show_view')
    ok(bridge?.inputSchema.properties.view.enum.includes('dates'), 'bridge/forge-app-tools.mjs: view enum has dates', bridge?.inputSchema.properties.view.enum)
    ok(spec?.description.includes('Dates') && bridge?.description === spec?.description, 'both descriptions name Dates, word for word')
    const snap = { mode: 'agents', surfaces: [{ id: 'dates', title: 'Dates' }], project: null, projects: [], tabs: [], front: null }
    const plan = planShowView({ view: 'dates' }, snap)
    ok(plan.ok && plan.switchTo === 'dates', 'src/lib/showView.ts: view dates switches to the dates surface', plan)
    ok(/'dates'/.test(src('src/lib/showView.ts').match(/export type ShowViewName[^\n]*/)?.[0] ?? ''), 'and ShowViewName includes dates')
  }
} finally {
  rmSync(TEMP, { recursive: true, force: true })
}

ok(!existsSync(TEMP), 'the temp folder is gone')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
