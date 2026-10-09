/**
 * Check for forge_command — any Forge command Steve could run from a key or
 * the palette, by id, for every brain and pane agent (src/lib/forgeCommand.ts),
 * and the four window commands it brought (src/lib/windowCommands.ts).
 *
 *   node scripts/forge-command-check.mjs
 *
 * Pure: the planner is fed lists built here; the live runner goes through the
 * real uiCommands bus and keymap registry with stub handlers and a stub
 * window.forge — no window, no React tree, no IPC. Then the tool's name and
 * words across the three ways in, as scripts/show-view-check.mjs does.
 */
import './ts-hooks.mjs'
import { readFileSync } from 'node:fs'

const FC = await import('../src/lib/forgeCommand.ts')
const W = await import('../src/lib/windowCommands.ts')
const { uiCommands } = await import('../src/lib/uiCommands.ts')
const { getKeymapView, setCommandHandler } = await import('../src/lib/keymapRegistry.ts')
const { BUILTIN_COMMANDS } = await import('../src/lib/shortcutCommands.ts')
const specs = await import('../shared/brain-tools.ts')
const { MAIN_AGENT_RULES } = await import('../shared/brain-persona.ts')
const APP = await import('../bridge/forge-app-tools.mjs')

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

let pass = 0
let fail = 0
function ok(cond, label, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  }
}

/* ------------------------------------------------------------ the planner */
console.log('the planner, on a list built here')
{
  const e = (id, title, group, over = {}) => ({ id, title, group, key: null, runnable: true, source: 'ui', ...over })
  const list = [
    e('window-minimise', 'Minimise Forge', 'Window'),
    e('window-maximise', 'Maximise Forge', 'Window'),
    e('next-mode', 'Next mode', 'Modes', { key: 'Ctrl+Shift+]' }),
    e('set-mode', 'Switch mode', 'Modes', { arg: 'mode' }),
    e('open-settings', 'Open settings', 'Shell', { arg: 'section', argOptional: true }),
    e('open-shelf', 'Open the shelf', 'Shell', { runnable: false }),
    e('pane.close', 'Close pane', 'Panes', { key: 'Ctrl+W', source: 'keymap' }),
    e('tab.close', 'Close tab', 'Tabs', { key: 'Ctrl+Shift+W', source: 'keymap' })
  ]

  const all = FC.planForgeCommand({}, list)
  ok(all.kind === 'list', 'no id: the list', JSON.stringify(all))
  ok(all.text.includes('Window: window-minimise — Minimise Forge · window-maximise — Maximise Forge'), 'grouped, id — title', all.text)
  ok(all.text.includes('next-mode — Next mode (Ctrl+Shift+])'), 'with its key', all.text)
  ok(all.text.includes('set-mode <mode> — Switch mode') && all.text.includes('open-settings [section] — Open settings'), 'arguments shown, optional in brackets', all.text)
  ok(all.text.includes("pane.close — Close pane (Ctrl+W) [needs Steve's yes]"), 'destructive ones marked', all.text)
  ok(!all.text.includes('open-shelf'), 'a command nothing answers right now is not listed', all.text)
  ok(FC.planForgeCommand({ id: '   ' }, list).kind === 'list', 'a blank id: the list too')

  const unknown = FC.planForgeCommand({ id: 'quit-everything' }, list)
  ok(
    unknown.kind === 'refuse' && unknown.reason === 'unknown' && unknown.text === 'Unknown command "quit-everything". Call forge_command with no id for the list.',
    'unknown id: refused, pointed at the list',
    unknown.text
  )

  const noArg = FC.planForgeCommand({ id: 'set-mode' }, list)
  ok(noArg.kind === 'refuse' && noArg.reason === 'needs-arg' && noArg.text === 'Switch mode needs its mode: pass it as arg.', 'a missing argument: says which', noArg.text)
  const withArg = FC.planForgeCommand({ id: 'set-mode', arg: ' browser ' }, list)
  ok(withArg.kind === 'run' && withArg.arg === 'browser' && withArg.entry.id === 'set-mode', 'with its argument: runs, trimmed', JSON.stringify(withArg))
  const optional = FC.planForgeCommand({ id: 'open-settings' }, list)
  ok(optional.kind === 'run' && optional.arg === undefined, 'an optional argument may be left out', JSON.stringify(optional))
  const extra = FC.planForgeCommand({ id: 'next-mode', arg: 'x' }, list)
  ok(extra.kind === 'run' && extra.arg === undefined, 'an argument to a command that takes none is dropped', JSON.stringify(extra))

  for (const id of ['pane.close', 'tab.close']) {
    const no = FC.planForgeCommand({ id }, list)
    const title = id === 'pane.close' ? 'Close pane' : 'Close tab'
    ok(
      no.kind === 'refuse' && no.reason === 'needs-yes' && no.text === `${title} needs Steve's yes. Ask him, then call again with confirmed true.`,
      `${id}: refused without confirmed`,
      no.text
    )
    const loose = FC.planForgeCommand({ id, confirmed: 'true' }, list)
    ok(loose.kind === 'refuse' && loose.reason === 'needs-yes', `${id}: only confirmed true counts`, JSON.stringify(loose))
    const yes = FC.planForgeCommand({ id, confirmed: true }, list)
    ok(yes.kind === 'run' && yes.entry.id === id, `${id}: allowed with confirmed true`, JSON.stringify(yes))
  }

  const shelf = FC.planForgeCommand({ id: 'open-shelf' }, list)
  ok(shelf.kind === 'refuse' && shelf.reason === 'unavailable' && shelf.text === 'Open the shelf is not available right now: nothing on screen answers it.', 'known but not mounted: says so', shelf.text)
  const prefixed = FC.planForgeCommand({ id: 'ui.Window-Maximise' }, list)
  ok(prefixed.kind === 'run' && prefixed.entry.id === 'window-maximise', 'the keymap’s ui. prefix and any case resolve', JSON.stringify(prefixed))
}

/* ------------------------------------------------------- the destructive set */
console.log('the destructive set')
{
  const set = [...FC.DESTRUCTIVE_FORGE_COMMANDS].sort()
  ok(JSON.stringify(set) === '["pane.close","tab.close"]', 'closing a pane or a tab (both kill what runs in them)', JSON.stringify(set))
  const ids = new Set(BUILTIN_COMMANDS.map((c) => c.id))
  ok(set.every((id) => ids.has(id)), 'every one is a real built-in command id')
}

/* ------------------------------------------------- the live list, in Forge */
console.log('the live registries')
{
  W.registerWindowCommands()
  const entries = FC.collectForgeCommands()
  const ids = entries.map((e) => e.id)
  for (const id of ['window-minimise', 'window-maximise', 'window-unmaximise', 'window-restore']) {
    const entry = entries.find((x) => x.id === id)
    ok(!!entry && entry.group === 'Window' && entry.runnable && entry.key === null && entry.source === 'ui', `${id}: a runnable Window command, no default key`, JSON.stringify(entry))
  }
  const listed = FC.formatForgeCommandList(entries)
  ok(
    listed.includes('Window: window-minimise — Minimise Forge · window-maximise — Maximise Forge · window-unmaximise — Un-maximise Forge · window-restore — Bring Forge back (restore)'),
    'the list has the window commands',
    listed
  )
  const view = getKeymapView().commands
  const palette = view.find((c) => c.id === 'ui.window-minimise')
  ok(!!palette && palette.available && palette.keys.length === 0, 'and the palette / keymap see them (ui.window-minimise, available, unbound)', JSON.stringify(palette))

  ok(ids.includes('set-mode') && ids.includes('next-mode') && ids.includes('toggle-canvas-view'), 'the core uiCommands are there')
  ok(ids.includes('pane.close') && ids.includes('view.toggle') && ids.includes('project.next'), 'and the keymap built-ins')
  ok(ids.filter((id) => id === 'window-minimise').length === 1 && !ids.some((id) => id.startsWith('ui.')), 'ui.<id> rows are listed once, by the bare id')
  for (const left of ['voice.talk.dictate', 'voice.talk.agent', 'bar.palette', 'bar.saveDraft', 'app.devtools']) {
    ok(!ids.includes(left), `${left} is left out (cannot be run by id)`)
  }
  ok(!entries.find((e) => e.id === 'pane.close').runnable, 'a built-in with no handler mounted is not runnable')
}

/* ---------------------------------------------------- run, through the bus */
console.log('running, through the palette’s bus')
{
  const asked = []
  globalThis.window = { forge: { window: {} } }
  const stale = await FC.runForgeCommand({ id: 'window-maximise' })
  ok(!stale.ok && stale.text === 'FAILED: Window control needs a Forge restart.', 'an older preload: degrades in words, never throws', stale.text)

  let shape = 'normal'
  globalThis.window = {
    forge: {
      window: {
        control: async (action) => {
          asked.push(action)
          if (action === 'minimise') shape = 'minimised'
          if (action === 'maximise') shape = 'maximised'
          if (action === 'unmaximise') shape = 'normal'
          return shape
        },
        revealIfAway: async () => {
          asked.push('reveal')
          if (shape === 'minimised') shape = 'normal'
          return { back: true, maximised: false }
        }
      }
    }
  }
  const min = await FC.runForgeCommand({ id: 'window-minimise' })
  ok(min.ok && min.text === 'Done: Minimise Forge. Forge is now minimised.', 'window-minimise: done, says what the window is now', min.text)
  const back = await FC.runForgeCommand({ id: 'window-restore' })
  ok(back.ok && back.text === 'Done: Bring Forge back (restore). Forge is now on screen, not maximised.', 'window-restore: revealIfAway, then the state', back.text)
  const max = await FC.runForgeCommand({ id: 'window-maximise' })
  ok(max.ok && max.text === 'Done: Maximise Forge. Forge is now maximised.', 'window-maximise', max.text)
  const un = await FC.runForgeCommand({ id: 'window-unmaximise' })
  ok(un.ok && un.text === 'Done: Un-maximise Forge. Forge is now on screen, not maximised.', 'window-unmaximise', un.text)
  ok(JSON.stringify(asked) === '["minimise","reveal","state","maximise","unmaximise"]', 'each one asked main once, restore the guarded way', JSON.stringify(asked))

  const modes = []
  const offMode = uiCommands.handle('set-mode', (m) => modes.push(m))
  const offNext = uiCommands.handle('next-mode', () => modes.push('next'))
  const set = await FC.runForgeCommand({ id: 'set-mode', arg: 'board' })
  const next = await FC.runForgeCommand({ id: 'next-mode' })
  ok(set.ok && set.text === 'Done: Switch mode.' && next.ok && next.text === 'Done: Next mode.', 'uiCommands run by id, with the argument', `${set.text} | ${next.text}`)
  ok(JSON.stringify(modes) === '["board","next"]', 'through uiCommands.run', JSON.stringify(modes))
  offMode()
  offNext()
  const gone = await FC.runForgeCommand({ id: 'next-mode' })
  ok(!gone.ok && gone.text.startsWith('FAILED: Next mode is not available right now'), 'unmounted again: says so', gone.text)

  const closed = []
  const offClose = setCommandHandler('pane.close', () => closed.push('pane'))
  const refused = await FC.runForgeCommand({ id: 'pane.close' })
  ok(!refused.ok && refused.text === "FAILED: Close pane needs Steve's yes. Ask him, then call again with confirmed true." && closed.length === 0, 'pane.close without confirmed: refused, nothing closed', refused.text)
  const yes = await FC.runForgeCommand({ id: 'pane.close', confirmed: true })
  ok(yes.ok && yes.text === 'Done: Close pane.' && closed.length === 1, 'with confirmed true: closed through the keymap registry', yes.text)
  offClose()
  const offNone = setCommandHandler('tab.next', () => false)
  const none = await FC.runForgeCommand({ id: 'tab.next' })
  ok(!none.ok && none.text === 'FAILED: Next tab did nothing right now.', 'a handler that did nothing: says so', none.text)
  offNone()
  const unknown = await FC.runForgeCommand({ id: 'nope' })
  ok(!unknown.ok && unknown.text === 'FAILED: Unknown command "nope". Call forge_command with no id for the list.', 'unknown id, live', unknown.text)
  delete globalThis.window
}

/* ------------------------------------------------------------- the tool */
console.log('the tool, everywhere it is offered')
{
  ok(specs.MAIN_AGENT_TOOL_NAMES.includes('forge_command'), 'forge_command is in the shared tool names (every brain)')
  const spec = specs.MAIN_AGENT_TOOL_SPECS.find((t) => t.name === 'forge_command')
  ok(spec?.description === specs.FORGE_COMMAND_DESCRIPTION, 'its description is the exported constant')
  ok(spec?.description.length < 260 && !spec.description.includes('pane.close'), 'short, and does not list every command (it rides the voice manifest)', spec?.description)
  ok(spec?.description.includes('Call with no id to list them.'), 'it says how to get the list', spec?.description)
  const props = spec?.parameters.properties ?? {}
  ok(
    JSON.stringify(spec?.parameters.required) === '[]' && props.id?.type === 'string' && props.arg?.type === 'string' && props.confirmed?.type === 'boolean',
    'id, arg and confirmed, none required',
    JSON.stringify(spec?.parameters)
  )

  const bridge = APP.APP_TOOLS.find((t) => t.name === 'forge_command')
  ok(!!bridge, 'forge_command is a forge-bridge APP_TOOLS tool (pane agents)')
  ok(bridge?.description === spec?.description, 'its description is the shared one, word for word', bridge?.description)
  ok(JSON.stringify(bridge?.inputSchema) === JSON.stringify(spec?.parameters), 'its schema is the shared one', JSON.stringify(bridge?.inputSchema))
  ok(typeof APP.APP_HANDLERS.forge_command === 'function', 'and it has a handler')
  ok(APP.APP_TOOLS[0].name === 'open_agent_pane', 'open_agent_pane stays first')

  const ops = read('electron/browser-panes/service.ts').match(/export const APP_LINK_OPS[^\n]*/)?.[0] ?? ''
  ok(/'forge_command'/.test(ops) && /'show_view'/.test(ops), 'main lets forge_command through the pipe (APP_LINK_OPS)', ops)
  ok(/forge_command/.test(MAIN_AGENT_RULES) && /Ask him before anything that closes or deletes/.test(MAIN_AGENT_RULES), 'the shared persona routes minimise / maximise / keys to it, and asks before closing', '')

  ok(/registerWindowCommands\(\)/.test(read('src/main.tsx')), 'the window commands are registered at startup (src/main.tsx)')
  ok(/control: \(action\) => ipcRenderer\.invoke\(IPC\.windowControl, action\)/.test(read('electron/preload.ts')), 'the preload exposes window.control')
  ok(/ipcMain\.handle\(IPC\.windowControl,/.test(read('electron/main.ts')), 'and main answers it')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
