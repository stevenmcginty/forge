/**
 * Pane alerts for the browser's voice agent (web/src/deck/voice-alerts.ts).
 *
 *   node scripts/voice-alerts-check.mjs      (npm run voice-alerts:check)
 *
 * The tracker is fed the desktop's voice-context text, one poll at a time, the
 * way voiceAgent.ts feeds it — so these cases are the conversation's own:
 * nothing on the first look, one "done" per working stretch (and only after it
 * has stayed settled), a question at once, and several at once as one note.
 */
import './ts-hooks.mjs'

const { parsePaneStates, PaneAlertTracker, alertNote } = await import('../web/src/deck/voice-alerts.ts')

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`)
  }
}

/** buildAppContext's text (src/lib/realtime/context.ts) for these panes. */
function context(panes) {
  const lines = ['# FORGE RIGHT NOW (live app state; it replaces any earlier one)', 'project: forge · branch master']
  if (!panes.length) lines.push('terminals: none — open one with open_agent_pane')
  else {
    lines.push('terminals (name · agent · state) — call each by its name, never by a number:')
    for (const [name, state, agent = 'Claude Code', focused = false] of panes) {
      lines.push(`- ${name} · ${agent} · ${state}${focused ? ' · focused' : ''}`)
    }
  }
  return lines.join('\n')
}

/** Feeds each poll's panes to a fresh tracker; returns the alerts each poll gave. */
function run(polls) {
  const t = new PaneAlertTracker()
  return polls.map((p) => t.feed(typeof p === 'string' ? parsePaneStates(p) : parsePaneStates(context(p))))
}

const flat = (runs) => runs.flat()
const show = (v) => JSON.stringify(v)

console.log('parsePaneStates')
{
  const snap = parsePaneStates(
    context([
      ['Zeb', 'working', 'Claude Code', true],
      ['Zeb 2', 'ready', 'PowerShell (plain shell)']
    ])
  )
  ok(snap instanceof Map && snap.size === 2, 'reads every pane line', show(snap && [...snap]))
  ok(snap?.get('Zeb')?.state === 'working' && snap?.get('Zeb')?.agent === 'Claude Code', 'a focused pane keeps its state and agent')
  ok(snap?.get('Zeb 2')?.agent === 'PowerShell (plain shell)', 'a plain shell keeps its agent words')
  const none = parsePaneStates(context([]))
  ok(none instanceof Map && none.size === 0, '"terminals: none" is no panes, not unreadable')
  for (const bad of ['', '   ', 'garbage', 'terminals (name · agent · state):\n- Zeb · Claude Code · dancing', null, undefined, 42, {}]) {
    let out
    let threw = null
    try {
      out = parsePaneStates(bad)
    } catch (err) {
      threw = err
    }
    const empty = out === null || (out instanceof Map && out.size === 0)
    ok(!threw && empty, `unreadable ${show(bad)} → nothing, no throw`, threw ? String(threw) : show(out))
  }
}

console.log('alerts')
{
  const r = run([[['Zeb', 'ready'], ['Zeb 2', 'asking'], ['Zeb 3', 'working']]])
  ok(flat(r).length === 0, 'the first snapshot only primes', show(r))
}
{
  const r = run([[['Zeb', 'working']], [['Zeb', 'ready']]])
  ok(flat(r).length === 0, 'working → ready once: nothing yet (a flicker)', show(r))
}
{
  const r = run([[['Zeb', 'working']], [['Zeb', 'ready']], [['Zeb', 'ready']], [['Zeb', 'ready']]])
  const all = flat(r)
  ok(all.length === 1 && all[0].kind === 'done' && all[0].pane === 'Zeb', 'working → ready → ready: one DONE, and only one', show(r))
  ok(r[2].length === 1, 'DONE comes on the second settled poll', show(r))
}
{
  const r = run([[['Zeb', 'working']], [['Zeb', 'ready']], [['Zeb', 'working']], [['Zeb', 'ready']]])
  ok(flat(r).length === 0, 'ready flickering back to working starts the count again', show(r))
}
{
  const r = run([[['Zeb', 'working']], [['Zeb', 'idle']], [['Zeb', 'idle']]])
  ok(flat(r).length === 1 && flat(r)[0].kind === 'done', 'idle counts as settled too', show(r))
}
{
  const r = run([[['Zeb', 'ready']], [['Zeb', 'asking']], [['Zeb', 'asking']]])
  const all = flat(r)
  ok(all.length === 1 && all[0].kind === 'asking' && r[1].length === 1, '→ asking: one ASKING, at once', show(r))
}
{
  const r = run([[['Zeb', 'working']], [['Zeb', 'asking']], [['Zeb', 'ready']], [['Zeb', 'ready']]])
  const all = flat(r)
  ok(all.length === 1 && all[0].kind === 'asking', 'working → asking: ASKING only, no DONE after', show(r))
}
{
  const r = run([
    [['Zeb', 'working'], ['Zeb 2', 'working']],
    [['Zeb', 'ready'], ['Zeb 2', 'ready']],
    [['Zeb', 'ready'], ['Zeb 2', 'ready']]
  ])
  ok(r[2].length === 2 && flat(r).length === 2, 'two panes finishing together arrive in one poll', show(r))
  const note = alertNote(r[2])
  ok(
    typeof note === 'string' && note.includes('Zeb (Claude Code)') && note.includes('Zeb 2 (Claude Code)') && note.split('[Forge alert').length === 2,
    'and coalesce into one note naming both',
    note
  )
}
{
  const r = run([[['Zeb', 'working'], ['Zeb 2', 'ready']], [['Zeb 2', 'ready']], [['Zeb 2', 'ready']], []])
  ok(flat(r).length === 0, 'a pane removed says nothing (nor does the last one closing)', show(r))
}
{
  const r = run([[['Zeb', 'working']], [['Zeb', 'exited']], [['Zeb', 'exited']], [['Zeb', 'starting']], [['Zeb', 'starting']]])
  ok(flat(r).length === 0, 'exited and starting say nothing', show(r))
}
{
  const r = run([[['Zeb', 'working']], '', 'garbage', [['Zeb', 'ready']], 'garbage', [['Zeb', 'ready']]])
  ok(flat(r).length === 1 && r[5].length === 1, 'unreadable polls in between change nothing and throw nothing', show(r))
}
{
  const r = run(['', [['Zeb', 'asking']]])
  ok(flat(r).length === 0, 'an unreadable first poll does not count as priming', show(r))
}
{
  const r = run([
    [['Zeb', 'working']],
    [['Zeb', 'ready']],
    [['Zeb', 'ready']],
    [['Zeb', 'working']],
    [['Zeb', 'ready']],
    [['Zeb', 'ready']]
  ])
  ok(flat(r).length === 2 && r[2].length === 1 && r[5].length === 1, 'a second working stretch gives a second DONE', show(r))
}
{
  const t = new PaneAlertTracker()
  t.feed(parsePaneStates(context([['Zeb', 'working']])))
  const busy = t.anyWorking()
  t.feed(parsePaneStates(context([['Zeb', 'ready']])))
  ok(busy && !t.anyWorking(), 'anyWorking follows the latest snapshot')
  t.reset()
  const r = t.feed(parsePaneStates(context([['Zeb', 'asking']])))
  ok(r.length === 0 && !t.anyWorking(), 'reset primes again')
}

console.log('notes')
{
  ok(alertNote([]) === null, 'no alerts → no note')
  const done = alertNote([{ kind: 'done', pane: 'Zeb', agent: 'Claude Code' }])
  ok(
    done ===
      '[Forge alert — not the user speaking] Zeb (Claude Code) just finished its turn. Tell the user in one short spoken sentence. If it helps, read_pane Zeb first and say what it did or what it needs next.',
    'DONE note',
    done
  )
  const asking = alertNote([{ kind: 'asking', pane: 'Zeb', agent: 'Claude Code' }])
  ok(
    asking?.startsWith('[Forge alert — not the user speaking] Zeb (Claude Code) is asking the user a question.') &&
      asking.includes('read_pane') &&
      asking.includes('wait for the answer'),
    'ASKING note',
    asking
  )
  const shell = alertNote([{ kind: 'done', pane: 'Zeb 2', agent: 'PowerShell (plain shell)' }])
  ok(shell?.includes('Zeb 2 (PowerShell shell)'), 'a plain shell is named plainly', shell)
  const mixed = alertNote([
    { kind: 'done', pane: 'Zeb', agent: 'Claude Code' },
    { kind: 'asking', pane: 'Zeb 2', agent: 'Codex' }
  ])
  ok(!!mixed && mixed.indexOf('Zeb 2 (Codex) is asking') < mixed.indexOf('Zeb (Claude Code) just finished'), 'a question comes first in a coalesced note', mixed)
  const all = [done, asking, shell, mixed].join('\n')
  ok(!/```|\$\{|\{\{|undefined|null/.test(all), 'plain words: no code fences, no template markers', all)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
