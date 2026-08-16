/**
 * "Is that CLI even installed?" — the whole answer, checked without Electron.
 *
 *   node scripts/agents-check.mjs
 *
 * Three things have to hold for a pane never to open onto `'codex' is not
 * recognized` again:
 *
 *  1. The PATH walk finds what is there and does not claim what is not.
 *  2. It refuses to guess about a command line no PATH walk can settle — a
 *     quoted path, a pipeline — because a wrong "not installed" on a profile
 *     that works is worse than saying nothing at all.
 *  3. Every built-in agent profile joins to a tool spec that knows how to
 *     install it. That join is what puts `npm i -g @openai/codex` in the pane's
 *     notice and behind the Install button; without it the notice is true and
 *     useless.
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

const { checkableExe, probeCommands, whichCommand } = await import('../electron/which.ts')
const { BUILTIN_AGENT_PROFILES, isGlmClaudeCommand, isShellProfile, migrateBuiltinCommand } =
  await import('../shared/agents.ts')
const { installCommandFor, toolSpecForCommand } = await import('../shared/tools.ts')

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

/* ------------------------------------------------------------- the walk */

console.log('\nfinding things on PATH')
// node is running this script, so it is on PATH by definition.
ok(whichCommand('node') !== null, 'node is found', String(whichCommand('node')))
ok(whichCommand('node --version') !== null, 'arguments do not confuse the lookup')
ok(whichCommand('forge-definitely-not-installed-xyz') === null, 'a made-up command is not found')

console.log('\nwhat can honestly be checked')
ok(checkableExe('codex') === 'codex', 'a bare command')
ok(checkableExe('opencode -m opencode/deepseek-v4-flash-free') === 'opencode', 'a command with flags')
ok(checkableExe('C:\\tools\\agent.exe') === 'C:\\tools\\agent.exe', 'an absolute path')
ok(checkableExe('') === null, 'nothing is not a command')
// The cases that must return null: answering "not installed" for any of these
// would be a confident lie about a profile that runs perfectly.
ok(checkableExe('"C:\\Program Files\\my agent.exe"') === null, 'a quoted path is not guessed at')
ok(checkableExe('conda activate x; claude') === null, 'a two-statement line is not guessed at')
ok(checkableExe('& $env:MYAGENT') === null, 'a call operator is not guessed at')
ok(checkableExe('cmd | claude') === null, 'a pipeline is not guessed at')

console.log('\nprobing a list')
const rows = probeCommands(['node', 'forge-definitely-not-installed-xyz', 'conda activate x; claude', ''])
ok(rows.length === 4, 'one answer per command asked about')
ok(rows[0].found === true && rows[0].unknown === false && Boolean(rows[0].path), 'node: found, with a path')
ok(rows[1].found === false && rows[1].unknown === false, 'the made-up one: looked for, not there')
ok(rows[2].unknown === true && rows[2].found === false, 'the clever one: no answer, and not called missing')
ok(rows[3].unknown === true, 'an empty command has nothing to answer')
ok(
  rows.every((r, i) => r.command === ['node', 'forge-definitely-not-installed-xyz', 'conda activate x; claude', ''][i]),
  'answers come back keyed by the exact string asked about'
)

/* ------------------------------------------- profiles ↔ install commands */

console.log('\nevery built-in agent can be installed from Forge')
for (const profile of BUILTIN_AGENT_PROFILES.filter((p) => !isShellProfile(p))) {
  const spec = toolSpecForCommand(profile.command)
  const install = spec ? installCommandFor(spec) : null
  // Kimi is the documented exception: a local .cmd shim wrapping Claude Code,
  // with nothing to install it from. It must still *join* to its row, so the
  // pane's notice can name it correctly.
  const expected = profile.id === 'kimi' ? spec !== null : Boolean(install)
  ok(expected, `${profile.name} → ${spec?.name ?? 'no tool row'}${install ? ` → ${install}` : ''}`)
}
ok(toolSpecForCommand('codex --full-auto')?.id === 'codex', 'flags do not break the join')
ok(
  toolSpecForCommand('opencode -m opencode/deepseek-v4-flash-free')?.id === 'opencode',
  'the DeepSeek profile installs OpenCode, which is what it actually runs'
)
ok(
  BUILTIN_AGENT_PROFILES.find((p) => p.id === 'glm')?.command === "claude --model 'glm-5.3[1m]'",
  'the GLM profile launches the 1M model, quoted for pwsh'
)
ok(
  toolSpecForCommand("claude --model 'glm-5.3[1m]'")?.id === 'claude',
  'the GLM 5.3 profile installs Claude Code, which is what it actually runs'
)
ok(isGlmClaudeCommand("claude --model 'glm-5.3[1m]'"), 'a GLM launch is recognised')
ok(
  isGlmClaudeCommand("claude --model 'glm-5.3[1m]' --permission-mode acceptEdits"),
  'flags do not hide a GLM launch'
)
ok(isGlmClaudeCommand('claude --model glm-5.3'), 'the old 200k launch is still recognised')
ok(!isGlmClaudeCommand('claude'), 'a regular Claude pane is not a GLM launch')
ok(!isGlmClaudeCommand('opencode -m zai-coding-plan/glm-5.3'), 'the old OpenCode wrapper is not a GLM Claude launch')
ok(
  migrateBuiltinCommand('glm', 'claude --model glm-5.3', "claude --model 'glm-5.3[1m]'") ===
    "claude --model 'glm-5.3[1m]'",
  'the shipped 200k default is migrated to the quoted 1M model'
)
ok(
  migrateBuiltinCommand('glm', "claude --model 'glm-4.7'", "claude --model 'glm-5.3[1m]'") ===
    "claude --model 'glm-4.7'",
  'a hand-edited GLM command is left alone'
)
ok(toolSpecForCommand('forge-definitely-not-installed-xyz') === null, 'an unknown command has no row, and says so')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
