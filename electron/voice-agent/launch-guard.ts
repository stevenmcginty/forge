import { USE_OPEN_AGENT_PANE } from '@shared/brain-tools'

/**
 * The hard guard behind the main agent's desktop tools: nothing it runs may
 * start an agent CLI, open a new console window, or put a web page in a desktop
 * browser. Those all happen INSIDE Forge — open_agent_pane for agents, the
 * built-in browser for the web — and the persona says so, but a persona is a
 * request. This is the refusal.
 *
 * Why it exists: Steve typed "spawn up a new Claude Code session" and got a
 * Start-Process'd Windows Terminal running `claude` outside Forge; he asked
 * the agent to "use our browser" and an external browser opened.
 *
 * Pure and Electron-free, so scripts/launch-guard-check.mjs drives it directly.
 * It errs towards refusing a launch it recognises and passing everything else:
 * `Get-Command claude`, `claude --version`, `Invoke-WebRequest https://…` are
 * all looking, not launching, and must keep working.
 */

/** Agent CLIs, by executable basename. */
const AGENT_EXES = new Set([
  'claude',
  'codex',
  'gemini',
  'agy',
  'antigravity',
  'opencode',
  'qwen',
  'kimi',
  'grok',
  'aider',
  'cursor-agent',
  'crush',
  'amp',
  'droid'
])

/** npm packages that are agent CLIs (npx / bunx / pnpm dlx). */
const AGENT_PACKAGES = /(^|\/)(claude-code|codex|gemini-cli|opencode(-ai)?|qwen-code|kimi-cli|grok-cli|aider-chat)(@|$)/i

/** An agent CLI's own entry point, run by path through node / bun / deno. */
const AGENT_PACKAGE_PATH = /@anthropic-ai[\\/]claude-code|@openai[\\/]codex|@google[\\/]gemini-cli|opencode-ai|@qwen-code|kimi-cli|grok-cli|aider-chat/i

/** Programs whose launch is a new console or terminal window. */
const CONSOLE_EXES = new Set(['powershell', 'pwsh', 'cmd', 'wt', 'windowsterminal', 'conhost', 'openconsole', 'mintty', 'git-bash', 'bash', 'wsl'])

/** Desktop browsers. */
const BROWSER_EXES = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'iexplore', 'vivaldi', 'arc'])

/** PowerShell / cmd verbs that start something in a window of its own. */
const LAUNCH_VERBS = new Set(['start-process', 'start', 'saps', 'invoke-item', 'ii', 'explorer', 'explorer.exe'])

/** Arguments that only ask a CLI about itself — never a session. */
const INFO_ARGS = new Set(['--version', '-v', '-V', 'version', '--help', '-h', 'help'])

export const AGENT_REFUSAL = `Refused: that would start an agent CLI or a new console window outside Forge. ${USE_OPEN_AGENT_PANE}`
export const WEB_REFUSAL =
  "Refused: web pages open in Forge's built-in browser, never a desktop browser. Use browser_open (then browser_read)."

const WEB_URL = /^(?:https?:\/\/|www\.)\S+/i

export function isWebUrl(value: string): boolean {
  return WEB_URL.test(unquote(value.trim()))
}

function unquote(token: string): string {
  return token.replace(/^[`'"]+|[`'",]+$/g, '')
}

/** `C:\x\claude.exe` → `claude`; `'codex.cmd'` → `codex`. */
function exeName(token: string): string {
  const bare = unquote(token)
  const base = bare.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase()
}

/** Split one command line into tokens, keeping quoted runs whole. */
function tokens(segment: string): string[] {
  const out: string[] = []
  const re = /"[^"]*"|'[^']*'|\S+/g
  for (const m of segment.matchAll(re)) out.push(m[0])
  return out
}

/** Statement boundaries: ; newline | && || — and cmd's lone &. */
function segments(command: string): string[] {
  return command
    .split(/\r?\n|;|\|\||&&|\||(?<=\s)&(?=\s)/)
    .map((s) => s.trim())
    .filter(Boolean)
}

type Verdict = 'agent' | 'web' | null

/** Everything in a quoted string argument is itself a command line worth checking. */
function innerCommands(toks: string[]): string[] {
  return toks.filter((t) => /^["'].*\s.*["']$/.test(t)).map(unquote)
}

function checkLaunched(target: string, rest: string[]): Verdict {
  const name = exeName(target)
  if (isWebUrl(target)) return 'web'
  if (AGENT_EXES.has(name)) return 'agent'
  if (CONSOLE_EXES.has(name)) return 'agent'
  if (BROWSER_EXES.has(name) && rest.some((a) => isWebUrl(a) || /https?:/i.test(a))) return 'web'
  if (rest.some((a) => AGENT_EXES.has(exeName(a)))) return 'agent'
  return null
}

function checkSegment(segment: string, depth: number): Verdict {
  let toks = tokens(segment)
  // The call operator and dot-sourcing put the next token in command position.
  while (toks[0] === '&' || toks[0] === '.') toks = toks.slice(1)
  if (!toks.length) return null
  const head = toks[0]!
  const name = exeName(head)
  const rest = toks.slice(1)

  // A launcher verb: whatever it starts is the question.
  if (LAUNCH_VERBS.has(name)) {
    let filePath: string | null = null
    const positional: string[] = []
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i]!
      if (/^-filepath$/i.test(t)) {
        filePath = rest[++i] ?? ''
        continue
      }
      // Parameters that take a value which is not the program or its arguments.
      if (/^-(windowstyle|verb|workingdirectory|credential|redirectstandard\w+)$/i.test(t)) {
        i++
        continue
      }
      // -ArgumentList's value is kept (it is the program's arguments); other
      // switches (-Wait, -PassThru, -NoNewWindow) carry nothing.
      if (/^-[a-z]+$/i.test(t)) continue
      // cmd's `start "" prog` — an empty window title.
      if (t === '""' || t === "''") continue
      positional.push(t)
    }
    const target = filePath ?? positional.shift() ?? ''
    if (!target) return null
    const verdict = checkLaunched(target, positional.flatMap((a) => tokens(unquote(a))))
    if (verdict) return verdict
    if (depth < 3) {
      for (const inner of innerCommands(positional)) {
        const v = check(inner, depth + 1)
        if (v) return v
      }
    }
    return null
  }

  // Windows Terminal and conhost only ever mean a new window.
  if (name === 'wt' || name === 'windowsterminal' || name === 'conhost' || name === 'openconsole' || name === 'mintty') return 'agent'

  // cmd /c … and powershell -Command … carry a command line of their own.
  if (name === 'cmd') {
    if (rest.some((t) => /^\/k$/i.test(t))) return 'agent'
    const at = rest.findIndex((t) => /^\/[cr]$/i.test(t))
    if (at >= 0 && depth < 3) return check(rest.slice(at + 1).map(unquote).join(' '), depth + 1)
    return null
  }
  if (name === 'powershell' || name === 'pwsh') {
    if (rest.some((t) => /^-noexit$/i.test(t))) return 'agent'
    const at = rest.findIndex((t) => /^-(c|command|encodedcommand|ec)$/i.test(t))
    if (at >= 0 && depth < 3) return check(rest.slice(at + 1).map(unquote).join(' '), depth + 1)
    return null
  }

  // Invoke-Expression "claude …" / iex "codex": the string is the command.
  if ((name === 'invoke-expression' || name === 'iex') && depth < 3) {
    const inner = rest.filter((t) => !/^-command$/i.test(t)).map(unquote).join(' ')
    return inner ? check(inner, depth + 1) : null
  }

  // node …/@anthropic-ai/claude-code/cli.js — the CLI by its package path.
  if ((name === 'node' || name === 'bun' || name === 'deno' || name === 'tsx') && rest.some((a) => AGENT_PACKAGE_PATH.test(unquote(a)))) {
    return 'agent'
  }

  // npx @openai/codex, bunx @google/gemini-cli, pnpm dlx opencode-ai …
  if (name === 'npx' || name === 'bunx' || name === 'pnpx' || ((name === 'pnpm' || name === 'yarn') && rest[0] === 'dlx')) {
    const args = name === 'pnpm' || name === 'yarn' ? rest.slice(1) : rest
    const pkg = args.find((t) => !t.startsWith('-'))
    if (pkg && (AGENT_PACKAGES.test(unquote(pkg)) || AGENT_EXES.has(exeName(pkg)))) return 'agent'
    return null
  }

  // A browser handed a web address.
  if (BROWSER_EXES.has(name) && rest.some((a) => /https?:/i.test(a))) return 'web'
  if (name === 'rundll32' && rest.some((a) => /url\.dll/i.test(a)) && rest.some((a) => /https?:/i.test(a))) return 'web'

  // The agent CLI itself, in command position. Asking it its version or help
  // is fine (`claude --version` passes on purpose): that starts no session.
  if (AGENT_EXES.has(name)) {
    if (rest.length && rest.every((a) => INFO_ARGS.has(unquote(a)))) return null
    return 'agent'
  }
  return null
}

function check(command: string, depth: number): Verdict {
  // Scriptblocks — Start-Job { … }, Invoke-Command { … }, & { … } — are
  // commands of their own. Innermost first; `{ $_.Name -like '*claude*' }`
  // stays a filter, not a launch, because nothing in it is in command position.
  if (depth < 3) {
    for (const m of command.matchAll(/\{([^{}]*)\}/g)) {
      const v = check(m[1] ?? '', depth + 1)
      if (v) return v
    }
  }
  for (const segment of segments(command)) {
    const v = checkSegment(segment, depth)
    if (v) return v
  }
  return null
}

/**
 * run_command's guard. Null = run it; a string = the refusal to answer with.
 */
export function refuseCommand(command: string): string | null {
  const verdict = check(String(command ?? ''), 0)
  return verdict === 'agent' ? AGENT_REFUSAL : verdict === 'web' ? WEB_REFUSAL : null
}

/** Spoken app names that are an agent or a console, normalised. */
const AGENT_APP_NAMES = /^(claude( code)?|codex|gemini( cli)?|antigravity|agy|opencode|open code|qwen( code)?|kimi|grok|aider|cursor agent)$/i
const CONSOLE_APP_NAMES = /^(windows )?(terminal|powershell|power shell|pwsh|command prompt|cmd|console|conhost|git bash|wsl|ubuntu)$/i

/**
 * open_desktop_app's guard, on the name as the model passed it.
 */
export function refuseAppLaunch(name: string): string | null {
  const said = String(name ?? '').trim()
  if (isWebUrl(said)) return WEB_REFUSAL
  const n = said.toLowerCase().replace(/\.(exe|lnk|cmd)$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
  if (AGENT_APP_NAMES.test(n) || CONSOLE_APP_NAMES.test(n)) return AGENT_REFUSAL
  if (AGENT_EXES.has(exeName(said)) || CONSOLE_EXES.has(exeName(said))) return AGENT_REFUSAL
  return null
}

/**
 * open_file_or_link: a web address goes to Forge's browser instead
 * (`{ web: url }`), an agent or console executable is refused, anything else
 * opens as before (`null`).
 */
export function routeOpenTarget(target: string): { web: string } | { refuse: string } | null {
  const t = unquote(String(target ?? '').trim())
  if (isWebUrl(t)) return { web: /^www\./i.test(t) ? `https://${t}` : t }
  const name = exeName(t)
  if (/\.(exe|cmd|bat|ps1|lnk)$/i.test(t) && (AGENT_EXES.has(name) || CONSOLE_EXES.has(name))) return { refuse: AGENT_REFUSAL }
  return null
}
