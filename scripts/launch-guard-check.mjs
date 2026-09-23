/**
 * launch-guard:check — the main agent's hard guard (electron/voice-agent/launch-guard.ts).
 *
 * Nothing the hub brain runs may start an agent CLI or a new console window
 * outside Forge, or put a web page in a desktop browser. Every launch shape
 * seen in the wild is refused; every look-don't-launch command still passes.
 *
 *   node scripts/launch-guard-check.mjs
 */
import './ts-hooks.mjs'

const G = await import('../electron/voice-agent/launch-guard.ts')

let passed = 0
let failed = 0
function expect(label, got, want) {
  if (got === want) {
    passed++
    console.log(`  ok  ${label}`)
  } else {
    failed++
    console.error(`  FAIL ${label}\n       got:  ${got}\n       want: ${want}`)
  }
}

const AGENT = G.AGENT_REFUSAL
const WEB = G.WEB_REFUSAL

console.log('run_command — refused (agent CLI / new console)')
for (const cmd of [
  // Steve's actual case, 2026-09-23 21:12.
  "Start-Process wt -ArgumentList 'claude'",
  'Start-Process claude',
  "Start-Process -FilePath 'C:\\Users\\steve\\AppData\\Roaming\\npm\\codex.cmd'",
  'start claude',
  'cmd /c start "" claude',
  'cmd /c start gemini',
  'cmd /k codex',
  'wt new-tab -d . claude',
  'wt',
  'conhost.exe cmd',
  'powershell -NoExit -Command claude',
  "Start-Process powershell -ArgumentList '-NoExit','-Command','claude'",
  'Start-Process pwsh',
  'saps cmd',
  'claude',
  'claude -p "open a new session"',
  '& "C:\\Program Files\\nodejs\\claude.cmd" --dangerously-skip-permissions',
  'cd C:\\work; codex',
  'Set-Location C:\\x && agy',
  'npx @openai/codex',
  'npx -y @google/gemini-cli',
  'pnpm dlx opencode-ai',
  'qwen',
  'kimi --yolo',
  'pwsh -Command "Start-Process claude"',
  'Invoke-Item C:\\tools\\opencode.exe',
  'Start-Process -WindowStyle Normal grok',
  // The foreman's refutation probes (B7 judge).
  'Invoke-Expression "claude --dangerously-skip-permissions"',
  'iex "codex"',
  'Start-Job { claude }',
  'Invoke-Command -ScriptBlock { Set-Location C:\\x; gemini }',
  '& { opencode }',
  'node C:/Users/steve/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js',
  'node "C:\\Users\\steve\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"',
  'bun ./node_modules/@google/gemini-cli/dist/index.js'
]) {
  expect(cmd, G.refuseCommand(cmd), AGENT)
}

console.log('run_command — refused (web page in a desktop browser)')
for (const cmd of [
  'Start-Process https://www.tripadvisor.com/malaga',
  'start https://example.com',
  'start chrome https://example.com',
  'Start-Process msedge -ArgumentList "https://example.com"',
  'explorer "https://maps.google.com"',
  'rundll32 url.dll,FileProtocolHandler https://example.com',
  '& chrome.exe --new-window https://example.com'
]) {
  expect(cmd, G.refuseCommand(cmd), WEB)
}

console.log('run_command — allowed (looking, not launching)')
for (const cmd of [
  'claude --version',
  'codex --help',
  'gemini -v',
  'Get-Command claude',
  'where.exe codex',
  'Get-Process claude',
  'Get-ChildItem C:\\Users\\steve\\Desktop',
  'npm view @openai/codex version',
  'Select-String -Path notes.md -Pattern claude',
  'Invoke-WebRequest https://example.com -UseBasicParsing | Select-Object StatusCode',
  'curl.exe -s https://api.github.com',
  'git status',
  'Start-Process notepad',
  'Start-Process "C:\\Windows\\System32\\calc.exe"',
  'echo "start claude later"',
  'node --version; npm --version',
  'Get-Item "$env:APPDATA\\npm\\claude.cmd"',
  'Get-ChildItem C:\\Users\\steve\\.claude',
  'git log --oneline -5',
  "Get-ChildItem | Where-Object { $_.Name -like '*claude*' }",
  'Get-Process | ForEach-Object { $_.Name }',
  'iex "Get-Date"',
  'node --version',
  'node scripts/launch-guard-check.mjs'
]) {
  expect(cmd, G.refuseCommand(cmd), null)
}

console.log('open_desktop_app')
expect('Windows Terminal', G.refuseAppLaunch('Windows Terminal'), AGENT)
expect('PowerShell', G.refuseAppLaunch('PowerShell'), AGENT)
expect('Command Prompt', G.refuseAppLaunch('Command Prompt'), AGENT)
expect('Claude Code', G.refuseAppLaunch('Claude Code'), AGENT)
expect('codex.exe', G.refuseAppLaunch('codex.exe'), AGENT)
expect('a URL as an app', G.refuseAppLaunch('https://example.com'), WEB)
expect('Spotify passes', G.refuseAppLaunch('Spotify'), null)
expect('Google Chrome (the app, no URL) passes', G.refuseAppLaunch('Google Chrome'), null)
expect('Notepad passes', G.refuseAppLaunch('Notepad'), null)

console.log('open_file_or_link')
expect('https → Forge browser', JSON.stringify(G.routeOpenTarget('https://example.com/menu')), JSON.stringify({ web: 'https://example.com/menu' }))
expect('www. → Forge browser (https)', JSON.stringify(G.routeOpenTarget('www.example.com')), JSON.stringify({ web: 'https://www.example.com' }))
expect('claude.exe refused', JSON.stringify(G.routeOpenTarget('C:\\tools\\claude.exe')), JSON.stringify({ refuse: AGENT }))
expect('wt.exe refused', JSON.stringify(G.routeOpenTarget('C:\\Users\\steve\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe')), JSON.stringify({ refuse: AGENT }))
expect('a folder opens as before', G.routeOpenTarget('C:\\Users\\steve\\Desktop'), null)
expect('an image opens as before', G.routeOpenTarget('C:\\Users\\steve\\Pictures\\cat.png'), null)

console.log('pane agents: forge-bridge open_agent_pane matches the shared spec')
const specs = await import('../shared/brain-tools.ts')
const app = await import('../bridge/forge-app-tools.mjs')
const shared = specs.MAIN_AGENT_TOOL_SPECS.find((t) => t.name === 'open_agent_pane')
expect('description word for word', app.OPEN_AGENT_PANE_DESCRIPTION, shared.description)
expect('schema matches', JSON.stringify(app.APP_TOOLS[0].inputSchema), JSON.stringify(shared.parameters))
const reg = await import('../electron/bridge/cli-register.ts')
expect('the instructions line carries the open_agent_pane rule', reg.BROWSER_INSTRUCTION_LINE.includes(app.APP_INSTRUCTION_LINE), true)

console.log("pane agents: \"Agents use Forge's browser only\" launch flag")
const BO = await import('../electron/bridge/browser-only.ts')
const deny = `--disallowedTools "${BO.OTHER_BROWSER_SERVERS.join(',')}"`
expect('claude gets the deny list', BO.applyForgeBrowserOnly('claude', true), `claude ${deny}`)
expect('GLM (Claude Code) gets it too', BO.applyForgeBrowserOnly("claude --model 'glm-5.3[1m]'", true), `claude --model 'glm-5.3[1m]' ${deny}`)
expect('setting off leaves the command alone', BO.applyForgeBrowserOnly('claude', false), 'claude')
expect('codex has no such flag — untouched', BO.applyForgeBrowserOnly('codex', true), 'codex')
expect('a plain shell is untouched', BO.applyForgeBrowserOnly('', true), '')
expect('an explicit --disallowedTools is respected', BO.applyForgeBrowserOnly('claude --disallowedTools Bash', true), 'claude --disallowedTools Bash')
expect('claude-in-chrome and playwright are on the list', ['mcp__claude-in-chrome', 'mcp__plugin_playwright_playwright'].every((s) => BO.OTHER_BROWSER_SERVERS.includes(s)), true)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
