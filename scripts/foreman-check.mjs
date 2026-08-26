/**
 * Foreman's loop, driven head-less with a stub brain.
 *
 *   node scripts/foreman-check.mjs
 *
 * Every rule this file exercises is invisible in the running app, because the
 * app's version of it takes an hour, a real `claude` login and a real terminal:
 * the seed turn, the answer to a question, the debounce that stops Foreman
 * answering its own echo, the coalescing of triggers that arrive mid-turn, the
 * log cap, and the fact that everything it pushes at a renderer is plain JSON.
 *
 * So electron/foreman/host.ts is Electron-free and takes its whole world
 * through `ForemanDeps`, and it has two seams that make this possible:
 * `openQuery`, which is the brain, and `callTool`, which every MCP handler
 * delegates to. The stub below is a brain — it pulls turns out of the real
 * input generator, calls the real tools, and yields the real `result` message
 * that ends a turn — so what is tested here is the code that runs in anger, not
 * a parallel implementation of it.
 *
 * Nothing here touches the network, spawns a process, or reads a `claude`
 * login. The one real SDK call is `createSdkMcpServer`, which builds an object.
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

const { ForemanHost, OWN_SEND_QUIET_MS, DEFAULT_FOREMAN_MODEL } = await import('../electron/foreman/host.ts')
const { FOREMAN_LOG_MAX, DEFAULT_FOREMAN_BRIEF, FOREMAN_IPC } = await import('../shared/foreman.ts')

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

const PANE = 'pane-1'
const HIRED = 'pane-2'

/**
 * Let the host's own promises, generators and timers run to a standstill.
 *
 * Both kinds of tick, because both are load-bearing: the turn loop is promises
 * and generators, and `finish` schedules its teardown on a zero timer so the
 * model's own tool result reaches it before the session closes.
 */
const settle = async (ticks = 12) => {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 0))
  }
}

/**
 * A brain that does what it is told, and nothing else.
 *
 * `script(text, turn)` is handed each turn's text and answers with a list of
 * tool calls to make. It is the only intelligence in this file, which is the
 * point: the *loop* is the thing under test, so the model's contribution is a
 * lookup table.
 */
function stubBrain(script) {
  const seen = []
  let host = null
  const open = (options, prompt) => {
    const iterator = (async function* () {
      for await (const message of prompt) {
        const text = message.message.content
        seen.push(text)
        for (const call of script(text, seen.length) ?? []) {
          // Through the same seam the real MCP handlers use.
          call.answer = await host.callTool(call.pane ?? PANE, call.tool, call.args ?? {})
        }
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'ok',
          num_turns: 1,
          total_cost_usd: 0,
          duration_ms: 1
        }
      }
    })()
    iterator.interrupt = async () => {
      opened.interrupted = true
    }
    const nativeReturn = iterator.return.bind(iterator)
    iterator.return = (value) => {
      opened.returned = true
      return nativeReturn(value)
    }
    opened.options = options
    opened.count++
    return iterator
  }
  const opened = { count: 0, options: null, interrupted: false, returned: false, turns: seen }
  return {
    open,
    opened,
    bind: (h) => {
      host = h
    }
  }
}

/**
 * The doubles, and a recorder for everything that crossed each boundary.
 * `writes` is the one that matters most: it is the only way Foreman changes
 * anything at all.
 */
function harness(script, overrides = {}) {
  const writes = []
  const states = []
  const actions = []
  const brain = stubBrain(script)
  const host = new ForemanHost({
    sendState: (state) => states.push(JSON.parse(JSON.stringify(state))),
    writePane: (paneId, data) => {
      writes.push({ paneId, data })
      return true
    },
    readScreen: () => 'Do you want to proceed?\n  1. Yes\n  2. No',
    readTranscript: () => 'I have written the plan and I am waiting.',
    paneInfo: (paneId) =>
      paneId === PANE || paneId === HIRED
        ? { id: paneId, cwd: 'C:\\work\\sweets', projectName: 'sweets', title: 'Claude', sessionId: '', agent: true }
        : null,
    listPanes: () => [
      { id: PANE, cwd: 'C:\\work\\sweets', projectName: 'sweets', title: 'Claude', sessionId: '', agent: true },
      { id: HIRED, cwd: 'C:\\work\\sweets', projectName: 'sweets', title: 'Grok', sessionId: '', agent: true }
    ],
    getModel: () => '',
    getStandingBrief: () => DEFAULT_FOREMAN_BRIEF,
    runAppAction: async (action) => {
      actions.push(action)
      return 'Split 1 Grok pane'
    },
    openQuery: brain.open,
    ...overrides
  })
  brain.bind(host)
  return { host, writes, states, actions, brain }
}

/** The one script most cases want: answer every turn with one send. */
const answerWith = (text) => () => [{ tool: 'send_to_pane', args: { text } }]

try {
  /* ------------------------------------------------------------- the seed */

  console.log('\nstarting a job')
  {
    const { host, writes, states, brain } = harness(answerWith('/gaffer Build a sweet shop site.'))
    const state = host.start({ paneId: PANE, seed: 'website for a sweet shop' })
    ok(state.paneId === PANE, 'the state comes back for the pane it was started on', state.paneId)
    ok(state.seed === 'website for a sweet shop', 'the seed is kept verbatim', state.seed)
    ok(
      state.log.length === 1 && state.log[0].kind === 'seed' && state.log[0].text === 'website for a sweet shop',
      'the seed is the first line of the log',
      JSON.stringify(state.log)
    )
    ok(brain.opened.count === 1, 'one session opened', String(brain.opened.count))
    ok(
      brain.opened.options.model === DEFAULT_FOREMAN_MODEL,
      'an empty foremanModel falls back to the default alias',
      String(brain.opened.options.model)
    )
    ok(brain.opened.options.cwd === 'C:\\work\\sweets', 'the session runs in the pane’s folder', brain.opened.options.cwd)

    await settle()
    const turn = brain.opened.turns[0] ?? ''
    ok(turn.startsWith('Seed: website for a sweet shop'), 'the first turn is the seed', turn.slice(0, 40))
    ok(/gaffer/.test(turn) && /plan mode/.test(turn), 'and it asks for /gaffer and plan mode')

    ok(writes.length === 1, 'exactly one thing was typed into the pane', String(writes.length))
    ok(writes[0].paneId === PANE, 'into the driven pane', writes[0].paneId)
    ok(
      writes[0].data === '/gaffer Build a sweet shop site.\r',
      'the brief, with a trailing carriage return — Enter, not a line feed',
      JSON.stringify(writes[0].data)
    )
    ok(
      host.stateOf(PANE).log.some((e) => e.kind === 'brief'),
      'and the send is logged as the brief',
      JSON.stringify(host.stateOf(PANE).log.map((e) => e.kind))
    )
    ok(host.stateOf(PANE).status === 'waiting', 'the turn ends with the job waiting on the pane', host.stateOf(PANE).status)

    /* ------------------------------------------------------ JSON on the wire */
    const pushed = states.at(-1)
    ok(states.length > 0, 'state was pushed', String(states.length))
    ok(
      JSON.stringify(pushed) === JSON.stringify(JSON.parse(JSON.stringify(host.stateOf(PANE)))),
      'every push survives a round trip through JSON unchanged'
    )
    ok(typeof pushed.log[0].at === 'number', 'timestamps are numbers, not Dates', typeof pushed.log[0].at)

    host.dispose()
  }

  /* ------------------------------------------------------ answering a question */

  console.log('\nanswering the pane')
  {
    const { host, writes, states, brain } = harness((text) =>
      text.startsWith('Seed:') ? [] : [{ tool: 'send_to_pane', args: { text: '1' } }]
    )
    host.start({ paneId: PANE, seed: 'a sweet shop' })
    await settle()
    ok(writes.length === 0, 'nothing typed yet', String(writes.length))

    host.noteAttention({ paneId: PANE, state: 'asking', prompt: 'Do you want to proceed?' })
    await settle()
    const turn = brain.opened.turns[1] ?? ''
    ok(turn.startsWith('The pane is asking: Do you want to proceed?'), 'the question is handed over verbatim', turn.slice(0, 50))
    ok(/1\. Yes/.test(turn), 'with the screen underneath it')
    ok(/All decisions are yours/.test(turn), 'and no invitation to ask a human')
    ok(writes.length === 1 && writes[0].data === '1\r', 'the menu got a number and an Enter', JSON.stringify(writes.at(-1)))
    ok(
      host.stateOf(PANE).log.at(-1).kind === 'answer',
      'logged as an answer, not as a brief',
      host.stateOf(PANE).log.at(-1).kind
    )
    ok(
      states.some((s) => s.line === 'Answering: Do you want to proceed?'),
      'the footer says what is being answered while the turn runs',
      JSON.stringify(states.map((s) => s.line))
    )
    ok(host.stateOf(PANE).line === 'Waiting for the pane', 'and goes back to waiting when it is done', host.stateOf(PANE).line)

    /* ------------------------------------------- an unsubmitted key, for Escape */
    host.noteAttention({ paneId: PANE, state: 'asking', prompt: 'Trust this folder?' })
    await settle()
    await host.callTool(PANE, 'send_to_pane', { text: '\x1b', submit: false })
    ok(writes.at(-1).data === '\x1b', 'submit:false types the bare key with no Enter', JSON.stringify(writes.at(-1).data))

    host.dispose()
  }

  /* ------------------------------------------------------------ the debounce */

  console.log('\nForeman’s own echo')
  {
    const { host, writes, brain } = harness((text) =>
      text.startsWith('Seed:') ? [{ tool: 'send_to_pane', args: { text: 'the brief' } }] : []
    )
    host.start({ paneId: PANE, seed: 'a sweet shop' })
    await settle()
    ok(writes.length === 1, 'the brief went in', String(writes.length))
    const turnsAfterBrief = brain.opened.turns.length

    // The pane echoes what was just typed and then stops printing, which the
    // renderer reports as the pane going quiet. It is not.
    host.noteAttention({ paneId: PANE, state: 'idle', prompt: '' }, Date.now())
    await settle()
    ok(brain.opened.turns.length === turnsAfterBrief, 'an idle inside the window is dropped', String(brain.opened.turns.length))

    host.noteAttention({ paneId: PANE, state: 'done', prompt: '' }, Date.now())
    await settle()
    ok(brain.opened.turns.length === turnsAfterBrief, 'and so is a done inside it', String(brain.opened.turns.length))

    // A question is never dropped: an echo cannot produce one.
    host.noteAttention({ paneId: PANE, state: 'asking', prompt: 'Overwrite index.html?' }, Date.now())
    await settle()
    ok(brain.opened.turns.length === turnsAfterBrief + 1, 'a question inside the window still gets through', String(brain.opened.turns.length))

    // Past the window, quiet means quiet.
    host.noteAttention({ paneId: PANE, state: 'idle', prompt: '' }, Date.now() + OWN_SEND_QUIET_MS + 1)
    await settle()
    ok(brain.opened.turns.length === turnsAfterBrief + 2, 'past the window the same idle is a real one', String(brain.opened.turns.length))
    ok(
      (brain.opened.turns.at(-1) ?? '').startsWith('The pane went quiet.'),
      'and it arrives as the quiet turn',
      (brain.opened.turns.at(-1) ?? '').slice(0, 30)
    )
    ok(/call finish/.test(brain.opened.turns.at(-1) ?? ''), 'which is the only turn that offers finish')

    host.dispose()
  }

  /* ------------------------------------------------------------ coalescing */

  console.log('\ntriggers that arrive mid-turn')
  {
    let release = null
    const held = new Promise((r) => {
      release = r
    })
    // The first turn parks inside its tool call, so everything that arrives
    // next arrives while a turn is in flight.
    const { host, brain } = harness((text) => (text.startsWith('Seed:') ? [{ tool: 'note', args: { text: 'thinking' } }] : []))
    const original = host.callTool.bind(host)
    host.callTool = async (paneId, name, args) => {
      if (name === 'note') await held
      return original(paneId, name, args)
    }
    host.start({ paneId: PANE, seed: 'a sweet shop' })
    await settle()

    host.noteAttention({ paneId: PANE, state: 'asking', prompt: 'first question' }, Date.now())
    host.noteAttention({ paneId: PANE, state: 'asking', prompt: 'second question' }, Date.now())
    host.noteAttention({ paneId: PANE, state: 'asking', prompt: 'third question' }, Date.now())
    await settle()
    ok(brain.opened.turns.length === 1, 'nothing is pushed while a turn is in flight', String(brain.opened.turns.length))

    release()
    await settle()
    ok(brain.opened.turns.length === 2, 'exactly one queued turn follows, not three', String(brain.opened.turns.length))
    ok(
      /third question/.test(brain.opened.turns[1] ?? ''),
      'and it is the latest one — the older screens have scrolled away',
      (brain.opened.turns[1] ?? '').slice(0, 40)
    )

    host.dispose()
  }

  /* ------------------------------------------------------------------ tools */

  console.log('\nthe tools')
  {
    const { host, actions, writes } = harness(() => [])
    host.start({ paneId: PANE, seed: 'a sweet shop' })
    await settle()

    ok(
      (await host.callTool(PANE, 'get_standing_brief', {})).includes('Supabase'),
      'get_standing_brief hands over the setting, not a paragraph baked into the prompt'
    )
    ok(
      (await host.callTool(PANE, 'read_pane', {})).includes('1. Yes'),
      'read_pane defaults to the driven pane'
    )
    ok(
      (await host.callTool(PANE, 'read_transcript', {})).includes('waiting'),
      'read_transcript reads the session’s own words'
    )

    const hire = await host.callTool(PANE, 'open_agent_pane', { profileId: 'grok' })
    ok(
      actions.length === 1 && actions[0].kind === 'open_panes' && actions[0].profileId === 'grok',
      'open_agent_pane goes out as an open_panes app action',
      JSON.stringify(actions[0])
    )
    ok(hire.includes(HIRED), 'and answers with the pane ids Foreman can now aim at', hire.replace(/\n/g, ' '))
    ok(host.stateOf(PANE).log.at(-1).kind === 'hire', 'the hire is logged', host.stateOf(PANE).log.at(-1).kind)

    await host.callTool(PANE, 'send_to_pane', { pane: HIRED, text: 'make me three logos' })
    ok(writes.at(-1).paneId === HIRED, 'send_to_pane can address a hired pane', writes.at(-1).paneId)

    const nowhere = await host.callTool(PANE, 'send_to_pane', { pane: 'pane-99', text: 'hello' })
    ok(/no running pane/.test(nowhere), 'and refuses a pane that is not there', nowhere.split('\n')[0])
    ok(writes.at(-1).paneId === HIRED, 'without typing anything anywhere', writes.at(-1).paneId)

    ok((await host.callTool(PANE, 'not_a_tool', {})).includes('not a Foreman tool'), 'an unknown tool answers rather than throws')
    ok(
      (await host.callTool('pane-99', 'read_pane', {})).includes('not driving that pane'),
      'and so does a tool call for a pane nobody is driving'
    )

    host.dispose()
  }

  /* ------------------------------------------------------------- finishing */

  console.log('\nfinishing')
  {
    const { host, brain } = harness((text) =>
      text.startsWith('Seed:') ? [{ tool: 'finish', args: { summary: 'Site is up, all 42 tests green.' } }] : []
    )
    host.start({ paneId: PANE, seed: 'a sweet shop' })
    await settle()
    const state = host.stateOf(PANE)
    ok(state.status === 'done', 'finish marks the job done', state.status)
    ok(state.line === 'Site is up, all 42 tests green.', 'and puts the summary in the footer', state.line)
    ok(state.log.at(-1).kind === 'done', 'and in the log', state.log.at(-1).kind)
    ok(brain.opened.returned, 'the session is ended rather than left open')

    host.noteAttention({ paneId: PANE, state: 'asking', prompt: 'anything else?' }, Date.now() + 10_000)
    await settle()
    ok(brain.opened.turns.length === 1, 'a finished job ignores the pane from then on', String(brain.opened.turns.length))

    host.dispose()
  }

  /* ---------------------------------------------------------------- stopping */

  console.log('\nswitching it off')
  {
    const { host, brain, writes } = harness(answerWith('the brief'))
    host.start({ paneId: PANE, seed: 'a sweet shop' })
    await settle()
    const state = host.stop(PANE)
    ok(state.status === 'off', 'stop puts the pane back to off', state.status)
    ok(brain.opened.interrupted, 'the turn in flight is aborted')
    ok(brain.opened.returned, 'and the session is ended')
    ok(/keyboard/.test(state.line), 'the footer says the human has it back', state.line)

    const before = writes.length
    host.noteAttention({ paneId: PANE, state: 'asking', prompt: 'still there?' }, Date.now() + 10_000)
    await settle()
    ok(writes.length === before, 'and nothing is typed into the pane after that', String(writes.length - before))

    ok(host.stop('pane-never-driven').status === 'off', 'stopping a pane nobody drove is a no-op that answers')
    host.dispose()
  }

  /* --------------------------------------------------------------- the log */

  console.log('\nthe log')
  {
    const { host } = harness(() => [])
    host.start({ paneId: PANE, seed: 'a sweet shop' })
    await settle()
    for (let i = 0; i < FOREMAN_LOG_MAX + 50; i++) await host.callTool(PANE, 'note', { text: `note ${i}` })
    const log = host.stateOf(PANE).log
    ok(log.length === FOREMAN_LOG_MAX, `the log stops at ${FOREMAN_LOG_MAX}`, String(log.length))
    ok(log.at(-1).text === `note ${FOREMAN_LOG_MAX + 49}`, 'the newest line survives', log.at(-1).text)
    ok(log[0].text !== 'a sweet shop', 'and the oldest is the one that fell off', log[0].text)

    const long = 'x'.repeat(9000)
    await host.callTool(PANE, 'note', { text: long })
    ok(host.stateOf(PANE).log.at(-1).text.length < 9000, 'one very long line is capped too', String(host.stateOf(PANE).log.at(-1).text.length))
    host.dispose()
  }

  /* ------------------------------------------------------------ steve says */

  console.log('\na word from Steve')
  {
    const { host, brain, writes } = harness((text) =>
      text.startsWith('Steve says:') ? [{ tool: 'send_to_pane', args: { text: 'Change of plan: dark theme.' } }] : []
    )
    host.start({ paneId: PANE, seed: 'a sweet shop' })
    await settle()
    const before = brain.opened.turns.length
    ok(host.say({ paneId: PANE, text: '' }).log.every((e) => e.kind !== 'you'), 'an empty say is nothing')
    const state = host.say({ paneId: PANE, text: 'make it dark' })
    await settle()
    ok(brain.opened.turns.length === before + 1, 'idle, it is the next turn straight away', String(brain.opened.turns.length))
    ok((brain.opened.turns.at(-1) ?? '').startsWith('Steve says: make it dark'), 'and it opens with his words', (brain.opened.turns.at(-1) ?? '').slice(0, 30))
    ok(state.log.some((e) => e.kind === 'you' && e.text === 'make it dark'), 'the log records it as his, verbatim')
    ok(writes.some((w) => w.data.startsWith('Change of plan')), 'a send during it reaches the pane')
    ok(
      host.stateOf(PANE).log.filter((e) => e.kind === 'instruction').length === 1,
      'and is logged as an instruction — his words, relayed'
    )
    ok(host.say({ paneId: 'nobody', text: 'hello' }).status === 'off', 'a pane nobody drives comes back off')
    host.dispose()
  }

  console.log('\na word from Steve, mid-turn')
  {
    let release = null
    const held = new Promise((r) => {
      release = r
    })
    const { host, brain } = harness((text) => (text.startsWith('Seed:') ? [{ tool: 'note', args: { text: 'thinking' } }] : []))
    const original = host.callTool.bind(host)
    host.callTool = async (paneId, name, args) => {
      if (name === 'note') await held
      return original(paneId, name, args)
    }
    host.start({ paneId: PANE, seed: 'a sweet shop' })
    await settle()
    host.noteAttention({ paneId: PANE, state: 'asking', prompt: 'Trust this folder?' }, Date.now())
    const held1 = host.say({ paneId: PANE, text: 'use pnpm' })
    host.say({ paneId: PANE, text: 'and no tailwind' })
    await settle()
    ok(brain.opened.turns.length === 1, 'held while the turn is in flight', String(brain.opened.turns.length))
    ok(/Got it/.test(held1.line), 'and the footer says so', held1.line)
    release()
    await settle()
    ok(brain.opened.turns.length === 3, 'then both his words and the pane’s question go in', String(brain.opened.turns.length))
    ok((brain.opened.turns[1] ?? '').startsWith('Steve says:'), 'his first', (brain.opened.turns[1] ?? '').slice(0, 20))
    ok(/use pnpm/.test(brain.opened.turns[1]) && /no tailwind/.test(brain.opened.turns[1]), 'both messages, none dropped')
    ok(/Trust this folder/.test(brain.opened.turns[2] ?? ''), 'the pane’s question second, not lost')
    host.dispose()
  }

  /* ---------------------------------------------------------------- the plan */

  console.log('\nthe plan')
  {
    const { host, states } = harness(() => [])
    host.start({ paneId: PANE, seed: 'a sweet shop' })
    await settle()
    const plan = (extra = {}) =>
      host.callTool(PANE, 'set_plan', {
        steps: [
          { id: 'plan', title: 'Plan the pages' },
          { id: 'build', title: 'Build the shop front' },
          { id: 'tests', title: 'Run the suite' }
        ],
        ...extra
      })
    ok(/Nothing changed/.test(await host.callTool(PANE, 'set_plan', { steps: [{ id: 'a', title: 'one' }] })), 'fewer than three steps is refused')
    ok(
      /Nothing changed/.test(await host.callTool(PANE, 'set_plan', { steps: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, title: `step ${i}` })) })),
      'more than eight is refused'
    )
    ok(host.stateOf(PANE).plan === undefined, 'and neither left a plan behind')

    const first = await plan({ active: 'plan' })
    ok(/Plan recorded \(0\/3, active: Plan the pages\)/.test(first), 'the first call records it', first)
    const st = host.stateOf(PANE)
    ok(st.plan?.length === 3 && st.plan[0].status === 'active' && st.plan[1].status === 'pending', 'active names one step, the rest are pending')
    ok(st.log.filter((e) => e.kind === 'plan').length === 1, 'one plan line in the log', String(st.log.filter((e) => e.kind === 'plan').length))
    ok(st.line === '0/3 — Plan the pages', 'the footer line is the progress and the active step', st.line)

    ok((await plan({ active: 'plan' })) === 'Plan unchanged.', 'restating it is a no-op')
    ok(host.stateOf(PANE).log.filter((e) => e.kind === 'plan').length === 1, 'that logs nothing')

    await host.callTool(PANE, 'set_plan', {
      steps: [
        { id: 'plan', title: 'Plan the pages', status: 'done' },
        { id: 'build', title: 'Build the shop front' },
        { id: 'tests', title: 'Run the suite' }
      ],
      active: 'build'
    })
    const after = host.stateOf(PANE)
    ok(after.plan[0].status === 'done' && after.plan[1].status === 'active', 'a step finishes and the next goes active')
    ok(after.log.filter((e) => e.kind === 'plan').length === 2, 'one line for the step that finished', String(after.log.filter((e) => e.kind === 'plan').length))
    ok(/Done \(1\/3\): Plan the pages/.test(after.log.at(-1).text), 'and it says which', after.log.at(-1).text)
    ok(after.line === '1/3 — Build the shop front', 'the footer moved', after.line)
    ok(/no step has id/.test(await plan({ active: 'nope' })), 'an unknown active id is refused')

    await host.callTool(PANE, 'set_plan', {
      steps: [
        { id: 'plan', title: 'Plan the pages', status: 'done' },
        { id: 'build', title: 'Build the shop front', status: 'done' },
        { id: 'tests', title: 'Run the suite' },
        { id: 'commit', title: 'Commit' }
      ],
      active: 'tests'
    })
    ok(host.stateOf(PANE).plan.length === 4, 'a late step can be added')
    await host.callTool(PANE, 'finish', { summary: 'done' })
    await settle()
    ok(host.stateOf(PANE).plan.every((s) => s.status !== 'active'), 'finish closes the active step')
    ok(states.every((s) => typeof JSON.stringify(s) === 'string'), 'every pushed state is still plain JSON')
    host.dispose()
  }

  /* ------------------------------------------------------------- the shape */

  console.log('\nthe wire vocabulary')
  {
    ok(FOREMAN_IPC.start === 'foreman:start', 'foreman:start', FOREMAN_IPC.start)
    ok(FOREMAN_IPC.stop === 'foreman:stop', 'foreman:stop', FOREMAN_IPC.stop)
    ok(FOREMAN_IPC.list === 'foreman:list', 'foreman:list', FOREMAN_IPC.list)
    ok(FOREMAN_IPC.state === 'foreman:state', 'foreman:state', FOREMAN_IPC.state)

    const { host } = harness(() => [])
    host.start({ paneId: PANE, seed: 'one' })
    host.start({ paneId: HIRED, seed: 'two' })
    await settle()
    ok(host.list().length === 2, 'list carries every pane being driven', String(host.list().length))
    ok(host.start({ paneId: '', seed: 'nowhere' }).status === 'off', 'a start with no pane is refused')
    host.dispose()
    ok(host.list().length === 0, 'dispose takes every session with it', String(host.list().length))
  }
} catch (err) {
  fail++
  console.log(`\n  ✕ the check itself threw — ${err && err.stack ? err.stack : err}`)
}

/* ---------------------------------------------------------------- verdict */

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
