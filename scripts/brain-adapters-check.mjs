/**
 * brain-adapters:check — the Codex and Gemini CLI main-agent brains (B8).
 *
 *   node scripts/brain-adapters-check.mjs
 *
 * Offline and key-free. It spawns no real CLI and writes nothing outside a temp
 * folder. What it holds:
 *
 *  - electron/cli-launch.ts: on Windows the extensionless npm sh shim is never
 *    what gets spawned (the "spawn …\npm\codex ENOENT" bug); a .cmd shim runs
 *    its script with node, and anything else is cmd.exe with safe args only.
 *  - electron/voice-agent/cli-brains.ts: the spawn args (no shell tools, a
 *    read-only sandbox, Forge's MCP server, the persona, resume), the Gemini
 *    temp settings and environment (never the real ~/.gemini for the key road),
 *    and the stream parsers against lines recorded from real runs
 *    (codex-cli 0.156.1, gemini 0.56.0, 2026-09-23).
 *  - The same tools: the host's link tools are its own tool definitions,
 *    run_command is still refused by the launch guard, and bridge/brain-mcp.mjs
 *    relays tools/list and tools/call over a real brain link to a fake renderer.
 *  - The one-time settings move off "Claude on gpt-5.6-luna".
 */
import './ts-hooks.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
// Never hand a check the environment's AI keys (this shell's may be someone else's, refused).
for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY']) delete process.env[k]

const ROOT = resolve(import.meta.dirname, '..')
const L = await import('../electron/cli-launch.ts')
const C = await import('../electron/voice-agent/cli-brains.ts')
const B = await import('../shared/agent-brain.ts')
const E = await import('../src/lib/realtime/errors.ts')
const { VoiceAgentHost } = await import('../electron/voice-agent/host.ts')
const { createBrainLink } = await import('../electron/voice-agent/brain-link.ts')

let passed = 0
let failed = 0
async function check(label, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${label}\n       ${err?.message ?? err}`)
  }
}

const TMP = mkdtempSync(join(tmpdir(), 'forge-brain-check-'))

/* ------------------------------------------------------------ cli-launch */

console.log('cli-launch — the Windows npm shim')
{
  const npm = join(TMP, 'npm')
  const script = join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  mkdirSync(join(npm, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true })
  writeFileSync(script, '// fake')
  // What npm writes: an sh script with no extension, and the .cmd beside it.
  writeFileSync(join(npm, 'codex'), '#!/bin/sh\nexec node "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"\n')
  writeFileSync(
    join(npm, 'codex.cmd'),
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'
  )
  // A fake node.exe beside the shim, as an npm-bundled node would be.
  writeFileSync(join(npm, 'node.exe'), '')
  const onlySh = join(TMP, 'only-sh')
  mkdirSync(onlySh)
  writeFileSync(join(onlySh, 'gemini'), '#!/bin/sh\n')
  const plainCmd = join(TMP, 'plain')
  mkdirSync(plainCmd)
  writeFileSync(join(plainCmd, 'tool.cmd'), '@echo off\r\necho hi\r\n')

  await check('an extensionless file next to a .cmd resolves to the .cmd, never the sh shim', () => {
    const got = L.resolveCliLaunch('codex', npm, 'win32')
    assert.ok(got, 'resolved')
    assert.equal(got.found.toLowerCase(), join(npm, 'codex.cmd').toLowerCase())
    assert.notEqual(got.file.toLowerCase(), join(npm, 'codex').toLowerCase())
  })
  await check('the npm shim runs its script with node directly — no cmd.exe', () => {
    const got = L.resolveCliLaunch('codex', npm, 'win32')
    assert.equal(got.via, 'node')
    assert.equal(got.file.toLowerCase(), join(npm, 'node.exe').toLowerCase())
    assert.deepEqual(got.prefix.map((p) => p.toLowerCase()), [script.toLowerCase()])
  })
  await check('only the sh shim on PATH = not installed (null), not a doomed spawn', () => {
    assert.equal(L.resolveCliLaunch('gemini', onlySh, 'win32'), null)
  })
  await check('a .cmd that is not an npm shim goes through cmd.exe', () => {
    const got = L.resolveCliLaunch('tool', plainCmd, 'win32')
    assert.equal(got.via, 'cmd')
    assert.deepEqual(got.prefix.slice(0, 3), ['/d', '/s', '/c'])
  })
  await check('cmdSafe refuses what cmd.exe would re-parse', () => {
    assert.equal(L.cmdSafe(['exec', '--json', '-']), true)
    for (const bad of ['a&b', 'a|b', '%PATH%', 'say "hi"', 'x^y', 'a<b', 'line\nbreak']) assert.equal(L.cmdSafe([bad]), false, bad)
  })
  await check('parseNpmShim reads both shim generations', () => {
    assert.equal(L.parseNpmShim('"%_prog%"  "%dp0%\\node_modules\\x\\cli.js" %*'), 'node_modules\\x\\cli.js')
    assert.equal(L.parseNpmShim('"%~dp0\\node.exe"  "%~dp0\\node_modules\\y\\bin.js" %*'), 'node_modules\\y\\bin.js')
    assert.equal(L.parseNpmShim('@echo off'), null)
  })
}

/* ------------------------------------------------------------ codex args */

const SETUP = { node: 'C:\\Program Files\\nodejs\\node.exe', mcpScript: 'C:\\Forge\\bridge\\brain-mcp.mjs', linkFile: 'C:\\Data\\brain\\link.json', workDir: join(TMP, 'brains'), geminiKey: '' }
const PERSONA = 'You are Jarvis.\nSay "yes" when asked.\\ done'

console.log('\ncodex-cli — spawn args')
{
  const args = C.codexBrainArgs({ setup: SETUP, persona: PERSONA })
  const cfg = (key) => {
    const i = args.findIndex((a, n) => args[n - 1] === '-c' && a.startsWith(`${key}=`))
    return i < 0 ? null : args[i].slice(key.length + 1)
  }
  await check('exec, JSON events, prompt on stdin', () => {
    assert.equal(args[0], 'exec')
    assert.ok(args.includes('--json'))
    assert.equal(args[args.length - 1], '-')
  })
  await check('no shell and no desktop: shell_tool, unified_exec, computer_use, browser_use off; read-only sandbox', () => {
    for (const f of ['shell_tool', 'unified_exec', 'computer_use', 'browser_use', 'in_app_browser']) {
      assert.ok(args.some((a, n) => args[n - 1] === '--disable' && a === f), f)
    }
    assert.equal(cfg('sandbox_mode'), '"read-only"')
    assert.equal(cfg('approval_policy'), '"never"')
  })
  await check("Steve's config.toml is not loaded (its MCP servers, plugins); auth still is", () => {
    assert.ok(args.includes('--ignore-user-config'))
  })
  await check('Forge MCP server via -c (temp flags, no config file): command, args, link env, auto-approve', () => {
    assert.equal(JSON.parse(cfg('mcp_servers.forge.command')), SETUP.node)
    assert.equal(cfg('mcp_servers.forge.args'), `[${JSON.stringify(SETUP.mcpScript)}]`)
    assert.equal(cfg('mcp_servers.forge.env'), `{FORGE_BRAIN_LINK_FILE=${JSON.stringify(SETUP.linkFile)}}`)
    assert.equal(cfg('mcp_servers.forge.default_tools_approval_mode'), '"approve"')
  })
  await check('the persona is one TOML string that round-trips exactly', () => {
    assert.equal(JSON.parse(cfg('developer_instructions')), PERSONA)
  })
  await check('resume: `exec resume <flags> <id> -`, and a bad id is dropped', () => {
    const r = C.codexBrainArgs({ setup: SETUP, persona: PERSONA, resumeId: '01a0d02d-7fd8-7c53-8b15-c9cdf50555e5' })
    assert.deepEqual(r.slice(0, 2), ['exec', 'resume'])
    assert.deepEqual(r.slice(-2), ['01a0d02d-7fd8-7c53-8b15-c9cdf50555e5', '-'])
    assert.ok(!r.includes('--sandbox'), 'resume has no --sandbox flag; sandbox_mode rides in -c')
    const bad = C.codexBrainArgs({ setup: SETUP, persona: PERSONA, resumeId: 'x; rm -rf' })
    assert.equal(bad[1], '--json')
  })
  await check('a model id is passed only when it is an id', () => {
    assert.ok(C.codexBrainArgs({ setup: SETUP, persona: '', model: 'gpt-6-luna' }).join(' ').includes('--model gpt-6-luna'))
    assert.ok(!C.codexBrainArgs({ setup: SETUP, persona: '', model: 'x"y' }).includes('--model'))
  })
  await check("codexUserModel reads config.toml's top-level model only", () => {
    const home = join(TMP, 'codex-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "medium"\n[profiles.x]\nmodel = "other"\n')
    assert.deepEqual(C.codexUserModel(home), { model: 'gpt-6-luna', effort: 'medium' })
    assert.deepEqual(C.codexUserModel(join(TMP, 'nope')), { model: null, effort: null })
  })
}

/* ----------------------------------------------------------- gemini args */

console.log('\ngemini-cli — spawn args, temp settings, environment')
{
  await check('headless stream-json, only the forge MCP server, no extensions, prompt on stdin', () => {
    const a = C.geminiBrainArgs()
    assert.deepEqual(a.slice(0, 2), ['-o', 'stream-json'])
    assert.ok(a.join(' ').includes('--allowed-mcp-server-names forge'))
    assert.ok(a.join(' ').includes('-e none'))
    assert.deepEqual(a.slice(-2), ['-p', ' '])
  })
  await check('resume by the session id from the stream', () => {
    const a = C.geminiBrainArgs({ resumeId: '1fc604ef-bad4-4f00-b48e-b805dae313eb' })
    assert.equal(a[a.indexOf('--resume') + 1], '1fc604ef-bad4-4f00-b48e-b805dae313eb')
    assert.ok(!C.geminiBrainArgs({ resumeId: '$(evil)' }).includes('--resume'))
  })
  await check('system settings: Forge MCP server trusted, shell/write tools excluded, auth type per road', () => {
    const g = C.geminiSystemSettings(SETUP, 'google')
    assert.deepEqual(g.mcpServers.forge.args, [SETUP.mcpScript])
    assert.equal(g.mcpServers.forge.env.FORGE_BRAIN_LINK_FILE, SETUP.linkFile)
    assert.equal(g.mcpServers.forge.trust, true)
    for (const t of ['run_shell_command', 'write_file', 'replace']) assert.ok(g.tools.exclude.includes(t), t)
    assert.equal(g.tools.core, undefined, 'tools.core would hide the MCP tools (seen on 0.56.0)')
    assert.equal(g.security.auth.selectedType, 'oauth-personal')
    assert.equal(C.geminiSystemSettings(SETUP, 'key').security.auth.selectedType, 'gemini-api-key')
  })
  await check('Google road: the real home, and no key in the environment at all', () => {
    const env = C.geminiBrainEnv({ GEMINI_API_KEY: 'k', GOOGLE_API_KEY: 'g', PATH: 'p' }, { auth: 'google', key: 'k', settingsPath: 's', personaPath: 'm', workDir: SETUP.workDir })
    assert.equal(env.GEMINI_API_KEY, undefined)
    assert.equal(env.GOOGLE_API_KEY, undefined)
    assert.equal(env.GEMINI_CLI_HOME, undefined)
    assert.equal(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 's')
    assert.equal(env.GEMINI_SYSTEM_MD, 'm')
  })
  await check("key road: Forge's key, in a home under Forge's data dir (never ~/.gemini)", () => {
    const env = C.geminiBrainEnv({ PATH: 'p' }, { auth: 'key', key: ' abc ', settingsPath: 's', personaPath: 'm', workDir: SETUP.workDir })
    assert.equal(env.GEMINI_API_KEY, 'abc')
    assert.equal(env.GEMINI_CLI_HOME, join(SETUP.workDir, 'gemini-home'))
  })
  await check('auth choice: Google login first, then a usable key, else none', () => {
    assert.equal(C.geminiAuthFor(true, ''), 'google')
    assert.equal(C.geminiAuthFor(false, 'k'), 'key')
    assert.equal(C.geminiAuthFor(false, 'enc:xyz'), 'none')
    assert.equal(C.geminiAuthFor(false, ''), 'none')
  })
  await check('Google login is read from ~/.gemini without writing', () => {
    const home = join(TMP, 'ghome')
    mkdirSync(join(home, '.gemini'), { recursive: true })
    writeFileSync(join(home, '.gemini', 'google_accounts.json'), '{"active":null,"old":["x"]}')
    assert.equal(C.geminiGoogleLogin(home), false)
    writeFileSync(join(home, '.gemini', 'oauth_creds.json'), '{}')
    assert.equal(C.geminiGoogleLogin(home), true)
  })
  await check('the persona names the engine it runs on', () => {
    assert.match(C.personaFor('You are one persistent Claude session living inside Forge', 'codex-cli'), /one persistent Codex session/)
    assert.match(C.personaFor('You are one persistent Claude session living inside Forge', 'gemini-cli'), /one persistent Gemini CLI session/)
  })
}

/* --------------------------------------------------------------- parsers */

// Recorded from real runs on this machine (codex-cli 0.156.1 with a stub MCP
// server; gemini 0.56.0), trimmed to the fields the parsers read.
const CODEX_SAMPLE = [
  '{"type":"thread.started","thread_id":"01a0d02d-7fd8-7c53-8b15-c9cdf50555e5"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_0","type":"mcp_tool_call","server":"forge","tool":"secret_word","arguments":{},"result":null,"error":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"forge","tool":"secret_word","arguments":{},"result":{"content":[{"type":"text","text":"zebra-42"}],"structured_content":null},"error":null,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"The secret word is zebra-42."}}',
  '{"type":"turn.completed","usage":{"input_tokens":36960,"cached_input_tokens":29952,"output_tokens":84}}'
]
const CODEX_DENIED = '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"forge","tool":"secret_word","arguments":{},"result":null,"error":{"message":"MCP tool call requires approval, but approval policy is never"},"status":"failed"}}'
const GEMINI_SAMPLE = [
  '{"type":"init","timestamp":"2026-09-23T21:38:18.830Z","session_id":"7ccbc976-7f09-4a2f-8e11-58e71465315a","model":"auto"}',
  '{"type":"message","timestamp":"2026-09-23T21:38:18.831Z","role":"user","content":"Call the secret_word tool"}',
  '{"type":"tool_use","timestamp":"2026-09-23T21:38:24.771Z","tool_name":"mcp_forge_secret_word","tool_id":"mcp_forge_secret_word__call_83369","parameters":{"who":"Jarvis"}}',
  '{"type":"tool_result","timestamp":"2026-09-23T21:38:24.798Z","tool_id":"mcp_forge_secret_word__call_83369","status":"success","output":"zebra-42"}',
  '{"type":"message","timestamp":"2026-09-23T21:38:27.369Z","role":"assistant","content":"The secret word","delta":true}',
  '{"type":"message","timestamp":"2026-09-23T21:38:27.430Z","role":"assistant","content":" is zebra-42.","delta":true}',
  '{"type":"result","timestamp":"2026-09-23T21:38:27.570Z","status":"success","stats":{"total_tokens":6665,"tool_calls":1}}'
]

console.log('\nstream parsers — recorded samples')
{
  await check('codex: thread id, tool start/end with the short name, the reply spoken and recorded', () => {
    const st = C.newStreamState()
    const events = CODEX_SAMPLE.flatMap((l) => C.parseCodexLine(l, st))
    assert.equal(st.sessionId, '01a0d02d-7fd8-7c53-8b15-c9cdf50555e5')
    assert.deepEqual(events[0], { type: 'tool', name: 'secret_word', phase: 'start' })
    assert.deepEqual(events[1], { type: 'tool', name: 'secret_word', phase: 'end', ok: true })
    assert.equal(events[2].type, 'delta')
    assert.deepEqual(events[3], { type: 'assistant', text: 'The secret word is zebra-42.' })
    assert.equal(st.finished, true)
    assert.equal(st.error, null)
  })
  await check('codex: a refused tool call ends as failed', () => {
    const [e] = C.parseCodexLine(CODEX_DENIED, C.newStreamState())
    assert.deepEqual(e, { type: 'tool', name: 'secret_word', phase: 'end', ok: false })
  })
  await check('codex: turn.failed and error lines are kept in words; junk lines are ignored', () => {
    const st = C.newStreamState()
    C.parseCodexLine('not json at all', st)
    C.parseCodexLine('{"type":"turn.failed","error":{"message":"You have hit your usage limit"}}', st)
    assert.equal(st.error, 'You have hit your usage limit')
  })
  await check('gemini: session id, mcp_forge_ prefix stripped, deltas streamed, whole reply kept', () => {
    const st = C.newStreamState()
    const events = GEMINI_SAMPLE.flatMap((l) => C.parseGeminiLine(l, st))
    assert.equal(st.sessionId, '7ccbc976-7f09-4a2f-8e11-58e71465315a')
    assert.deepEqual(events[0], { type: 'tool', name: 'secret_word', phase: 'start' })
    assert.deepEqual(events[1], { type: 'tool', name: 'secret_word', phase: 'end', ok: true })
    assert.deepEqual(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'The secret word is zebra-42.')
    assert.deepEqual(st.said, ['The secret word is zebra-42.'])
    assert.equal(st.finished, true)
  })
  await check('gemini: the user echo is not spoken', () => {
    assert.deepEqual(C.parseGeminiLine(GEMINI_SAMPLE[1], C.newStreamState()), [])
  })
  await check('gemini: an error line and a failed result say why', () => {
    const st = C.newStreamState()
    C.parseGeminiLine('{"type":"error","severity":"error","message":"API key not valid"}', st)
    C.parseGeminiLine('{"type":"result","status":"error"}', st)
    assert.equal(st.error, 'API key not valid')
    assert.equal(st.finished, false)
  })
  await check('failures are worded for the pill', () => {
    assert.equal(C.cliFailureText('codex-cli', 'Error: Not logged in', 1), 'Codex brain: not logged in — run codex login')
    assert.equal(C.cliFailureText('gemini-cli', 'API key not valid. Please pass a valid API key.', 1), 'Gemini CLI: key refused')
    assert.match(C.notInstalledText('codex-cli'), /^Codex brain: codex not found/)
    assert.equal(E.errorReasonOf('codex', C.notInstalledText('codex-cli')), 'Codex: not installed')
    assert.equal(E.errorReasonOf('gemini-cli', C.notInstalledText('gemini-cli')), 'Gemini CLI: not installed')
    assert.equal(E.errorReasonOf('codex', 'Codex brain: not logged in — run codex login'), 'Codex: not logged in')
    assert.equal(E.errorReasonOf('gemini-cli', 'Gemini CLI: not logged in — run gemini and sign in with Google'), 'Gemini CLI: not logged in')
    assert.equal(E.errorReasonOf('claude', 'spawn C:\\npm\\codex ENOENT'), 'Claude: not installed')
  })
}

/* ------------------------------------------------ runner, with a fake CLI */

console.log('\nrunner — one turn, then a resumed turn, against a fake codex')
{
  const fake = join(TMP, 'fake-codex.mjs')
  const argLog = join(TMP, 'fake-args.jsonl')
  writeFileSync(
    fake,
    [
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(argLog)}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
      "let input = ''",
      "process.stdin.on('data', (d) => { input += d })",
      "process.stdin.on('end', () => {",
      `  const lines = ${JSON.stringify(CODEX_SAMPLE)}`,
      "  lines[4] = JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'heard: ' + input.trim() } })",
      "  for (const l of lines) process.stdout.write(l + '\\n')",
      '})'
    ].join('\n')
  )
  const events = []
  const runner = new C.CliBrainRunner({
    sendEvent: (e) => events.push(e),
    setup: async () => SETUP,
    persona: PERSONA,
    resolve: () => ({ file: process.execPath, prefix: [fake], via: 'node', found: fake })
  })
  await runner.run({ brain: 'codex-cli', text: 'open a new Claude pane', cwd: TMP })
  await runner.run({ brain: 'codex-cli', text: 'and another', cwd: TMP })
  const argv = readFileSync(argLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))

  await check('the prompt went on stdin, never on the command line', () => {
    assert.ok(argv.every((a) => !a.some((x) => x.includes('open a new Claude pane'))))
    assert.ok(events.some((e) => e.type === 'assistant' && e.text === 'heard: open a new Claude pane'))
  })
  await check('each turn ends in one ok result with the reply', () => {
    const results = events.filter((e) => e.type === 'result')
    assert.equal(results.length, 2)
    assert.ok(results.every((r) => r.ok))
    assert.equal(results[1].text, 'heard: and another')
  })
  await check('the second turn resumes the first conversation (kept warm)', () => {
    assert.equal(argv[0][1], '--json')
    assert.deepEqual(argv[1].slice(0, 2), ['exec', 'resume'])
    assert.equal(argv[1][argv[1].length - 2], '01a0d02d-7fd8-7c53-8b15-c9cdf50555e5')
    assert.ok(runner.hasSession('codex-cli', TMP))
  })
  await check('not installed = an error event in words, and no spawn', async () => {
    const out = []
    const r = new C.CliBrainRunner({ sendEvent: (e) => out.push(e), setup: async () => SETUP, persona: '', resolve: () => null })
    await r.run({ brain: 'gemini-cli', text: 'hi', cwd: TMP })
    assert.deepEqual(out, [{ type: 'error', message: C.notInstalledText('gemini-cli') }])
  })
  await check('no tool link = refuse to run a brain with no tools', async () => {
    const out = []
    const r = new C.CliBrainRunner({ sendEvent: (e) => out.push(e), setup: async () => null, persona: '', resolve: () => ({ file: process.execPath, prefix: [fake], via: 'node', found: fake }) })
    await r.run({ brain: 'codex-cli', text: 'hi', cwd: TMP })
    assert.equal(out.length, 1)
    assert.match(out[0].message, /tool link did not start/)
  })
}

/* ------------------------------------------- the same tools, over the link */

console.log('\nthe same tools — host link tools and bridge/brain-mcp.mjs')
{
  const asked = []
  let host
  host = new VoiceAgentHost({
    sendEvent() {},
    // The fake renderer: answers every tool request at once.
    sendToolRequest(req) {
      asked.push(req)
      setTimeout(() => host.resolveTool({ id: req.id, ok: true, result: `renderer ran ${req.name} ${JSON.stringify(req.args)}` }), 0)
    },
    getModel: () => 'opus',
    getBrain: () => 'codex-cli'
  })
  const tools = host.listLinkTools()
  const names = tools.map((t) => t.name)

  await check('the link serves the host’s own tools: pane, app, desktop, file and browser tools', () => {
    for (const n of ['open_agent_pane', 'type_into_pane', 'help_prompt', 'read_pane', 'get_app_state', 'run_app_action', 'run_command', 'open_file_or_link', 'browser_open', 'focus_pane_by_name', 'describe_self']) {
      assert.ok(names.includes(n), n)
    }
  })
  await check('schemas are plain JSON Schema objects (no $schema, no propertyNames)', () => {
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object', t.name)
      const s = JSON.stringify(t.inputSchema)
      assert.ok(!s.includes('$schema') && !s.includes('propertyNames'), t.name)
    }
    const open = tools.find((t) => t.name === 'open_agent_pane')
    assert.deepEqual(open.inputSchema.required, ['agent'])
  })
  await check('a call reaches the renderer with its arguments', async () => {
    const r = await host.callLinkTool('open_agent_pane', { agent: 'claude' })
    assert.equal(r.isError, undefined)
    assert.match(r.content[0].text, /renderer ran open_agent_pane \{"agent":"claude"\}/)
  })
  await check('run_command still goes through the launch guard: Start-Process wt claude is refused', async () => {
    const before = asked.length
    const r = await host.callLinkTool('run_command', { command: "Start-Process wt -ArgumentList 'claude'" })
    assert.match(r.content[0].text, /open_agent_pane|inside Forge|refus/i)
    assert.equal(asked.length, before)
  })
  await check('wrong arguments and unknown tools answer in words, marked as errors', async () => {
    const bad = await host.callLinkTool('open_agent_pane', { agent: 42 })
    assert.equal(bad.isError, true)
    const none = await host.callLinkTool('nope', {})
    assert.equal(none.isError, true)
  })
  await check('describe_self names the engine it runs on', async () => {
    const r = await host.callLinkTool('describe_self', {})
    assert.match(r.content[0].text, /Codex session/)
  })

  // bridge/brain-mcp.mjs, end to end: a real brain link, the real script, MCP over stdio.
  const link = createBrainLink(join(TMP, 'brain'), () => host)
  await link.listen()
  const mcp = spawn(process.execPath, [join(ROOT, 'bridge', 'brain-mcp.mjs')], {
    cwd: ROOT,
    env: { ...process.env, FORGE_BRAIN_LINK_FILE: link.linkFile },
    windowsHide: true
  })
  const replies = new Map()
  let buf = ''
  mcp.stdout.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined) replies.set(msg.id, msg)
      } catch {
        /* not ours */
      }
    }
  })
  const rpc = (id, method, params) => {
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((res, rej) => {
      const t0 = Date.now()
      const tick = () => (replies.has(id) ? res(replies.get(id)) : Date.now() - t0 > 15000 ? rej(new Error(`no reply to ${method}`)) : setTimeout(tick, 20))
      tick()
    })
  }
  try {
    await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '0' } })
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const list = await rpc(2, 'tools/list', {})
    await check('brain-mcp.mjs lists exactly the host’s tools', () => {
      assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [...names].sort())
    })
    const call = await rpc(3, 'tools/call', { name: 'open_agent_pane', arguments: { agent: 'claude', name: 'Check' } })
    await check('brain-mcp.mjs relays tools/call to the renderer and back', () => {
      assert.match(call.result.content[0].text, /renderer ran open_agent_pane/)
    })
  } catch (err) {
    failed++
    console.error(`  FAIL brain-mcp.mjs round trip: ${err.message}`)
  } finally {
    mcp.kill()
    link.close()
    host.dispose()
  }
}

/* ------------------------------------------------------------- migration */

console.log('\nsettings — the one-time move off "Claude on gpt-5.6-luna"')
{
  await check('Claude + gpt-5.6-luna becomes the codex-cli brain, and the Claude model goes back to opus', () => {
    assert.deepEqual(B.migrateCodexClaudeModel('claude', 'gpt-5.6-luna', 'opus'), { agentBrain: 'codex-cli', voiceClaudeModel: 'opus' })
  })
  await check('another brain is left as picked; only the stale Claude model is reset', () => {
    assert.deepEqual(B.migrateCodexClaudeModel('gemini-live', 'gpt-5.6-luna', 'opus'), { agentBrain: 'gemini-live', voiceClaudeModel: 'opus' })
  })
  await check('a real Claude model is untouched (so it runs once)', () => {
    assert.equal(B.migrateCodexClaudeModel('claude', 'opus', 'opus'), null)
    assert.equal(B.migrateCodexClaudeModel('codex-cli', 'sonnet', 'opus'), null)
  })
  await check('both CLI brains are listed as subscription session brains', () => {
    for (const id of ['codex-cli', 'gemini-cli']) {
      const spec = B.agentBrainSpec(id)
      assert.equal(spec.id, id)
      assert.equal(spec.kind, 'session')
      assert.equal(spec.key, null)
    }
  })
}

rmSync(TMP, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
