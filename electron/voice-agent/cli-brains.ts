import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { VoiceAgentEvent } from '@shared/types'
import { cmdSafe, resolveCliLaunch, type CliLaunch } from '../cli-launch'

/**
 * The main agent on a CLI brain: a hidden, headless Codex or Gemini CLI session
 * that speaks through the bottom bar and never shows a terminal.
 *
 * Same contract as the Claude session in ./host.ts, which owns this and routes
 * a turn here by the brain id:
 *
 *  - **The same tools.** The CLI spawns bridge/brain-mcp.mjs as its MCP server,
 *    and that relays every call over the authenticated brain link to the host's
 *    own tool definitions — the ones the Claude session gets in-process. So a
 *    CLI brain opens panes with open_agent_pane, types into panes, reads them,
 *    browses in Forge's browser, and runs its commands through launch-guard.ts.
 *  - **None of its own hands.** Codex runs with its shell tools switched off
 *    (`--disable shell_tool --disable unified_exec`, a read-only sandbox, no
 *    computer-use or browser features); Gemini CLI with run_shell_command,
 *    write_file and replace excluded. Neither can Start-Process a window: the
 *    only way out is a Forge tool, and those are guarded.
 *  - **The same persona**, ./persona.ts, with the engine's name in it.
 *  - **Warm between turns.** Each turn is one headless run that *resumes* the
 *    conversation (`codex exec resume <id>`, `gemini --resume <id>`), so the
 *    brain keeps the thread; the id comes from the first run's own stream.
 *
 * Auth is the CLI's own login, read and never written: `codex login`
 * (ChatGPT) and the Gemini CLI's Google login. When the Gemini CLI has no
 * Google login on this PC, Forge's Gemini key is handed to it instead, in a home
 * folder of Forge's own, and the Settings test says so in words.
 *
 * What still lands in the real CLI homes is the CLI's own session history,
 * which is what makes resume work: ~/.codex/sessions for Codex, and for Gemini
 * with a Google login ~/.gemini/tmp. Nothing in either config is touched — the
 * MCP server, the persona and the tool limits all arrive as flags, environment
 * or files under Forge's data dir.
 *
 * No Electron import: scripts/brain-adapters-check.mjs drives the argument
 * builders and the stream parsers with recorded samples.
 */

export type CliBrainId = 'codex-cli' | 'gemini-cli'

export const CLI_BRAIN_IDS: readonly CliBrainId[] = ['codex-cli', 'gemini-cli']

export function isCliBrain(id: unknown): id is CliBrainId {
  return id === 'codex-cli' || id === 'gemini-cli'
}

/** The engine's name, in words, for the persona and the errors. */
export const CLI_BRAIN_NAME: Record<CliBrainId, string> = { 'codex-cli': 'Codex', 'gemini-cli': 'Gemini CLI' }

/** How a CLI brain reaches Forge's tools. Built by ./ipc.ts. */
export interface CliBrainSetup {
  /** The node that runs bridge/brain-mcp.mjs. */
  node: string
  /** Absolute path of bridge/brain-mcp.mjs. */
  mcpScript: string
  /** FORGE_BRAIN_LINK_FILE: the pipe and token of the brain link. */
  linkFile: string
  /** `<data dir>\brains` — Forge's own config for the CLIs lives here. */
  workDir: string
  /** Forge's Gemini key, for a Gemini CLI with no Google login. Empty = none. */
  geminiKey: string
}

/** Features Codex must not have as the main agent: no shell, no desktop, no browser of its own. */
export const CODEX_FEATURES_OFF = [
  'shell_tool',
  'unified_exec',
  'computer_use',
  'browser_use',
  'browser_use_external',
  'in_app_browser',
  'image_generation',
  'plugins',
  'apps',
  'multi_agent'
] as const

/** Gemini CLI built-ins the main agent must not have: no shell, no writing, no sub-agents. */
export const GEMINI_TOOLS_EXCLUDED = [
  'run_shell_command',
  'write_file',
  'replace',
  'invoke_agent',
  'ask_user',
  'activate_skill',
  'save_memory',
  'enter_plan_mode',
  'exit_plan_mode'
] as const

/** Longest a Forge tool may take before the CLI gives up on it (browser loads, media). */
const TOOL_TIMEOUT_SEC = 120

/** A TOML basic string. A JSON string literal is one: same escapes, same quotes. */
export function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** The persona with the right engine named where it says what it is. */
export function personaFor(persona: string, brain: CliBrainId): string {
  const name = CLI_BRAIN_NAME[brain]
  return persona.replace(/one persistent Claude session/g, `one persistent ${name} session`)
}

/* ------------------------------------------------------------------- codex */

export interface CodexArgsInput {
  setup: Pick<CliBrainSetup, 'node' | 'mcpScript' | 'linkFile'>
  persona: string
  model?: string | null
  effort?: string | null
  resumeId?: string | null
}

/**
 * `codex exec` for one turn. The prompt goes on stdin (`-`), never on the
 * command line. `--ignore-user-config` keeps Steve's config.toml (its MCP
 * servers, plugins, profiles) out; auth still comes from CODEX_HOME.
 */
export function codexBrainArgs(o: CodexArgsInput): string[] {
  const flags: string[] = ['--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']
  for (const f of CODEX_FEATURES_OFF) flags.push('--disable', f)
  flags.push(
    '-c', 'sandbox_mode="read-only"',
    '-c', 'approval_policy="never"',
    '-c', `mcp_servers.forge.command=${tomlString(o.setup.node)}`,
    '-c', `mcp_servers.forge.args=[${tomlString(o.setup.mcpScript)}]`,
    '-c', `mcp_servers.forge.env={FORGE_BRAIN_LINK_FILE=${tomlString(o.setup.linkFile)}}`,
    '-c', 'mcp_servers.forge.default_tools_approval_mode="approve"',
    '-c', `mcp_servers.forge.tool_timeout_sec=${TOOL_TIMEOUT_SEC}`,
    '-c', `developer_instructions=${tomlString(o.persona)}`
  )
  if (o.model && /^[A-Za-z0-9._-]+$/.test(o.model)) flags.push('--model', o.model)
  if (o.effort && /^[a-z]+$/.test(o.effort)) flags.push('-c', `model_reasoning_effort=${tomlString(o.effort)}`)
  const id = o.resumeId && /^[A-Za-z0-9-]+$/.test(o.resumeId) ? o.resumeId : null
  return id ? ['exec', 'resume', ...flags, id, '-'] : ['exec', ...flags, '-']
}

/**
 * The model Steve picked for Codex in his own config.toml — read, never
 * written. `--ignore-user-config` would otherwise hide it. Top-level keys only.
 */
export function codexUserModel(home = process.env['CODEX_HOME'] || join(homedir(), '.codex')): { model: string | null; effort: string | null } {
  let text = ''
  try {
    text = readFileSync(join(home, 'config.toml'), 'utf8')
  } catch {
    return { model: null, effort: null }
  }
  const top = text.split(/^\s*\[/m)[0] ?? ''
  const pick = (key: string): string | null => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"'\\r\\n]+)["']`, 'm').exec(top)
    return m ? m[1]!.trim() : null
  }
  return { model: pick('model'), effort: pick('model_reasoning_effort') }
}

/** Codex's login, read from its home without running anything. */
export function codexAuthState(home = process.env['CODEX_HOME'] || join(homedir(), '.codex')): 'chatgpt' | 'apikey' | 'none' {
  try {
    const auth = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')) as { auth_mode?: string; tokens?: unknown; OPENAI_API_KEY?: unknown }
    if (auth.tokens || auth.auth_mode === 'chatgpt') return 'chatgpt'
    if (auth.OPENAI_API_KEY) return 'apikey'
    return 'none'
  } catch {
    return 'none'
  }
}

/* ------------------------------------------------------------------ gemini */

export type GeminiAuth = 'google' | 'key' | 'none'

/** Is the Gemini CLI signed in with Google on this PC? Read-only. */
export function geminiGoogleLogin(home = homedir()): boolean {
  const dir = join(home, '.gemini')
  if (existsSync(join(dir, 'oauth_creds.json'))) return true
  try {
    const accounts = JSON.parse(readFileSync(join(dir, 'google_accounts.json'), 'utf8')) as { active?: unknown }
    return typeof accounts.active === 'string' && accounts.active.length > 0
  } catch {
    return false
  }
}

/** Which auth a Gemini CLI brain turn uses: Google login first, then Forge's key. */
export function geminiAuthFor(googleLogin: boolean, key: string): GeminiAuth {
  if (googleLogin) return 'google'
  return key.trim() && !key.trim().startsWith('enc:') ? 'key' : 'none'
}

/** The system settings file: Forge's MCP server, the tool limits and the auth type. */
export function geminiSystemSettings(setup: Pick<CliBrainSetup, 'node' | 'mcpScript' | 'linkFile'>, auth: GeminiAuth): Record<string, unknown> {
  return {
    mcpServers: {
      forge: {
        command: setup.node,
        args: [setup.mcpScript],
        env: { FORGE_BRAIN_LINK_FILE: setup.linkFile },
        // Forge's own tools, answered by Forge — no confirmation to wait for
        // in a headless run.
        trust: true,
        timeout: TOOL_TIMEOUT_SEC * 1000
      }
    },
    // Built-ins only. `tools.core` would be tidier but it also hides MCP tools
    // (checked against 0.56.0), so the dangerous ones are excluded by name.
    tools: { exclude: [...GEMINI_TOOLS_EXCLUDED] },
    security: { auth: { selectedType: auth === 'google' ? 'oauth-personal' : 'gemini-api-key' } }
  }
}

export interface GeminiArgsInput {
  resumeId?: string | null
  model?: string | null
}

/** `gemini -p` for one turn. The prompt goes on stdin; `-p " "` only switches headless on. */
export function geminiBrainArgs(o: GeminiArgsInput = {}): string[] {
  const args = ['-o', 'stream-json', '--allowed-mcp-server-names', 'forge', '-e', 'none']
  const id = o.resumeId && /^[A-Za-z0-9-]+$/.test(o.resumeId) ? o.resumeId : null
  if (id) args.push('--resume', id)
  if (o.model && /^[A-Za-z0-9._-]+$/.test(o.model)) args.push('-m', o.model)
  args.push('-p', ' ')
  return args
}

/** Where a Gemini CLI brain on Forge's key keeps its home, so ~/.gemini is never touched. */
export function geminiBrainHome(workDir: string): string {
  return join(workDir, 'gemini-home')
}

/**
 * The environment for one Gemini turn. A Google login uses the real home and no
 * key at all; the key road uses Forge's own home folder and Forge's key.
 */
export function geminiBrainEnv(
  base: NodeJS.ProcessEnv,
  o: { auth: GeminiAuth; key: string; settingsPath: string; personaPath: string; workDir: string }
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env['GEMINI_API_KEY']
  delete env['GOOGLE_API_KEY']
  delete env['GEMINI_CLI_HOME']
  env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'] = o.settingsPath
  env['GEMINI_SYSTEM_MD'] = o.personaPath
  env['GEMINI_CLI_TRUST_WORKSPACE'] = 'true'
  if (o.auth === 'key') {
    env['GEMINI_API_KEY'] = o.key.trim()
    env['GEMINI_CLI_HOME'] = geminiBrainHome(o.workDir)
  }
  return env
}

/* ---------------------------------------------------------------- parsers */

/** One parsed stream: events for the bar, plus what the runner needs at the end. */
export interface CliStreamState {
  sessionId: string | null
  /** Every finished reply message, in order. */
  said: string[]
  /** Gemini: the message still streaming in. */
  partial: string
  /** The CLI's own failure, in its words. */
  error: string | null
  /** Did the run report a finished turn? */
  finished: boolean
  toolCalls: number
  /** Gemini: tool_id → short name, so a tool_result can say which tool ended. */
  toolNames: Map<string, string>
}

export function newStreamState(): CliStreamState {
  return { sessionId: null, said: [], partial: '', error: null, finished: false, toolCalls: 0, toolNames: new Map() }
}

/** `mcp_forge_open_agent_pane` / `forge.open_agent_pane` → `open_agent_pane`. */
export function shortCliTool(name: string): string {
  return String(name ?? '').replace(/^mcp_forge_/, '').replace(/^forge[.:_]{1,2}/, '')
}

/** One line of `codex exec --json`. */
export function parseCodexLine(line: string, st: CliStreamState): VoiceAgentEvent[] {
  let e: {
    type?: string
    thread_id?: string
    message?: string
    error?: { message?: string }
    item?: { type?: string; text?: string; tool?: string; status?: string; error?: { message?: string } | null; message?: string }
  }
  try {
    e = JSON.parse(line)
  } catch {
    return []
  }
  switch (e.type) {
    case 'thread.started':
      if (typeof e.thread_id === 'string') st.sessionId = e.thread_id
      return []
    case 'item.started':
      if (e.item?.type === 'mcp_tool_call') {
        st.toolCalls++
        return [{ type: 'tool', name: shortCliTool(e.item.tool ?? ''), phase: 'start' }]
      }
      return []
    case 'item.completed': {
      const item = e.item
      if (!item) return []
      if (item.type === 'agent_message' && item.text?.trim()) {
        st.said.push(item.text.trim())
        // Codex sends each message whole; it is spoken as one delta.
        return [
          { type: 'delta', text: `${item.text.trim()}\n\n` },
          { type: 'assistant', text: item.text.trim() }
        ]
      }
      if (item.type === 'mcp_tool_call') {
        return [{ type: 'tool', name: shortCliTool(item.tool ?? ''), phase: 'end', ok: item.status === 'completed' && !item.error }]
      }
      if (item.type === 'error' && item.message) console.error(`[voice-agent:codex] ${item.message}`)
      return []
    }
    case 'turn.completed':
      st.finished = true
      return []
    case 'turn.failed':
      st.error = e.error?.message ?? 'the turn failed'
      return []
    case 'error':
      st.error = e.message ?? 'Codex reported an error'
      return []
    default:
      return []
  }
}

/** One line of `gemini -o stream-json`. */
export function parseGeminiLine(line: string, st: CliStreamState): VoiceAgentEvent[] {
  let e: {
    type?: string
    session_id?: string
    role?: string
    content?: string
    tool_name?: string
    tool_id?: string
    status?: string
    severity?: string
    message?: string
  }
  try {
    e = JSON.parse(line)
  } catch {
    return []
  }
  switch (e.type) {
    case 'init':
      if (typeof e.session_id === 'string') st.sessionId = e.session_id
      return []
    case 'message':
      if (e.role !== 'assistant' || !e.content) return []
      st.partial += e.content
      return [{ type: 'delta', text: e.content }]
    case 'tool_use': {
      st.toolCalls++
      // What was said before a tool call is a finished sentence.
      const before = st.partial.trim()
      st.partial = ''
      if (before) st.said.push(before)
      const name = shortCliTool(e.tool_name ?? '')
      if (e.tool_id) st.toolNames.set(e.tool_id, name)
      const tool: VoiceAgentEvent = { type: 'tool', name, phase: 'start' }
      return before ? [{ type: 'delta', text: '\n\n' }, tool] : [tool]
    }
    case 'tool_result':
      return [{ type: 'tool', name: st.toolNames.get(e.tool_id ?? '') ?? '', phase: 'end', ok: e.status === 'success' }]
    case 'error':
      if (e.severity === 'error' || !e.severity) st.error = e.message ?? 'Gemini CLI reported an error'
      return []
    case 'result':
      if (st.partial.trim()) st.said.push(st.partial.trim())
      st.partial = ''
      st.finished = e.status === 'success'
      if (e.status !== 'success' && !st.error) st.error = 'the turn failed'
      return []
    default:
      return []
  }
}

/* ------------------------------------------------------------------ errors */

/** A CLI failure, in the words the bar's pill shows ("Codex brain: not logged in — run codex login"). */
export function cliFailureText(brain: CliBrainId, raw: string, code: number | null): string {
  const t = raw.trim()
  const l = t.toLowerCase()
  if (brain === 'codex-cli') {
    if (/not logged in|login required|401|unauthori[sz]ed|please log ?in|refresh token/.test(l)) return 'Codex brain: not logged in — run codex login'
    if (/429|rate.?limit|usage limit|quota/.test(l)) return `Codex brain: usage limit reached${t ? ` — ${t.slice(0, 120)}` : ''}`
    return `Codex brain: no reply${code === null ? '' : ` (exit ${code})`}${t ? ` — ${t.slice(0, 160)}` : ''}`
  }
  if (/api key not valid|invalid api key|api_key_invalid/.test(l)) return 'Gemini CLI: key refused'
  if (/429|resource.?exhausted|quota/.test(l)) return 'Gemini CLI: free-tier limit (429)'
  if (/unsupported_client|login|sign ?in|auth|credentials/.test(l)) return `Gemini CLI: not logged in${t ? ` — ${t.slice(0, 120)}` : ''}`
  return `Gemini CLI: no reply${code === null ? '' : ` (exit ${code})`}${t ? ` — ${t.slice(0, 160)}` : ''}`
}

export function notInstalledText(brain: CliBrainId): string {
  return brain === 'codex-cli'
    ? 'Codex brain: codex not found — install it with npm i -g @openai/codex'
    : 'Gemini CLI: gemini not found — install it with npm i -g @google/gemini-cli'
}

/* ------------------------------------------------------------------ runner */

export interface CliBrainDeps {
  sendEvent(event: VoiceAgentEvent): void
  /** How to reach Forge's tools; null when the brain link could not start. */
  setup(): Promise<CliBrainSetup | null>
  /** The static persona (./persona.ts). */
  persona: string
  /** For the check: override the CLI lookup. */
  resolve?(name: string): CliLaunch | null
}

export interface CliTurn {
  brain: CliBrainId
  text: string
  cwd: string
  /** Codex only: a model to force (the old "Claude on gpt-5.6-luna" setting). */
  model?: string | null
}

/** Kill a CLI and everything it started — codex.js runs a native codex.exe under it. */
function killTree(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid
  if (process.platform === 'win32' && pid) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
  } else {
    child.kill()
  }
}

export class CliBrainRunner {
  private readonly deps: CliBrainDeps
  private child: ChildProcessWithoutNullStreams | null = null
  /** `${brain}|${cwd}` → the CLI's own conversation id, for resume. */
  private readonly sessions = new Map<string, string>()
  /** Set when a turn is cut short on purpose, so its exit is not reported as a failure. */
  private cancelled = new WeakSet<ChildProcessWithoutNullStreams>()

  constructor(deps: CliBrainDeps) {
    this.deps = deps
  }

  get running(): boolean {
    return this.child !== null
  }

  /** Stop the turn in flight. The conversation id is kept: the next turn resumes it. */
  interrupt(): boolean {
    const child = this.child
    if (!child) return false
    this.cancelled.add(child)
    this.child = null
    killTree(child)
    return true
  }

  /** Forget every conversation (the session was closed). */
  reset(): void {
    this.interrupt()
    this.sessions.clear()
  }

  /** Has a conversation been started for this brain and folder? For the context manifest. */
  hasSession(brain: CliBrainId, cwd: string): boolean {
    return this.sessions.has(`${brain}|${cwd}`)
  }

  /** Run one turn. Emits the same VoiceAgentEvents the Claude session does; never throws. */
  async run(turn: CliTurn): Promise<void> {
    this.interrupt()
    const fail = (message: string): void => {
      console.error(`[voice-agent] ${message}`)
      this.deps.sendEvent({ type: 'error', message })
    }
    const name = turn.brain === 'codex-cli' ? 'codex' : 'gemini'
    const launch = (this.deps.resolve ?? resolveCliLaunch)(name)
    if (!launch) return fail(notInstalledText(turn.brain))

    const setup = await this.deps.setup().catch(() => null)
    if (!setup) return fail(`${CLI_BRAIN_NAME[turn.brain]}: Forge's tool link did not start, so the brain would have no tools`)

    const key = `${turn.brain}|${turn.cwd}`
    const first = await this.once(turn, launch, setup, this.sessions.get(key) ?? null)
    if (first === 'stale-session') {
      // The CLI no longer has that conversation (deleted, or another folder):
      // start a new one rather than failing the turn.
      this.sessions.delete(key)
      await this.once(turn, launch, setup, null)
    }
  }

  private async once(turn: CliTurn, launch: CliLaunch, setup: CliBrainSetup, resumeId: string | null): Promise<'ok' | 'failed' | 'stale-session'> {
    const persona = personaFor(this.deps.persona, turn.brain)
    let args: string[]
    let env: NodeJS.ProcessEnv = process.env
    if (turn.brain === 'codex-cli') {
      const user = codexUserModel()
      args = codexBrainArgs({ setup, persona, model: turn.model ?? user.model, effort: user.effort, resumeId })
    } else {
      const auth = geminiAuthFor(geminiGoogleLogin(), setup.geminiKey)
      if (auth === 'none') {
        this.deps.sendEvent({ type: 'error', message: 'Gemini CLI: not logged in — run gemini and sign in with Google, or add a Gemini key in Settings' })
        return 'failed'
      }
      mkdirSync(setup.workDir, { recursive: true })
      if (auth === 'key') mkdirSync(geminiBrainHome(setup.workDir), { recursive: true })
      const settingsPath = join(setup.workDir, 'gemini-system-settings.json')
      const personaPath = join(setup.workDir, 'gemini-system.md')
      writeFileSync(settingsPath, JSON.stringify(geminiSystemSettings(setup, auth), null, 2), 'utf8')
      writeFileSync(personaPath, persona, 'utf8')
      env = geminiBrainEnv(process.env, { auth, key: setup.geminiKey, settingsPath, personaPath, workDir: setup.workDir })
      args = geminiBrainArgs({ resumeId })
    }
    if (launch.via === 'cmd' && !cmdSafe(args)) {
      this.deps.sendEvent({ type: 'error', message: `${CLI_BRAIN_NAME[turn.brain]}: cannot start ${launch.found} without a shell parsing its arguments` })
      return 'failed'
    }

    const started = Date.now()
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(launch.file, [...launch.prefix, ...args], { cwd: turn.cwd, env, windowsHide: true })
    } catch (err) {
      this.deps.sendEvent({ type: 'error', message: cliFailureText(turn.brain, err instanceof Error ? err.message : String(err), null) })
      return 'failed'
    }
    this.child = child
    child.stdin.on('error', () => undefined)
    child.stdin.end(turn.text)

    const st = newStreamState()
    const parse = turn.brain === 'codex-cli' ? parseCodexLine : parseGeminiLine
    let buffer = ''
    let errTail = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        for (const event of parse(line, st)) {
          if (this.child === child) this.deps.sendEvent(event)
        }
      }
    })
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString('utf8').trim()
      if (!text) return
      console.error(`[voice-agent:${turn.brain}] ${text}`)
      const last = text.split(/\r?\n/).filter((l) => l.trim() && !/^Ripgrep is not available|DeprecationWarning|trace-deprecation|Reading additional input|tools\.exclude in settings\.json is deprecated/.test(l)).pop()
      if (last) errTail = last.trim()
    })

    return new Promise((resolve) => {
      child.once('error', (err) => {
        if (this.child === child) this.child = null
        this.deps.sendEvent({ type: 'error', message: cliFailureText(turn.brain, err.message, null) })
        resolve('failed')
      })
      child.once('close', (code) => {
        if (this.child === child) this.child = null
        if (st.sessionId) this.sessions.set(`${turn.brain}|${turn.cwd}`, st.sessionId)
        if (this.cancelled.has(child)) return resolve('ok')
        const reply = [...st.said, st.partial].map((s) => s.trim()).filter(Boolean).join('\n')
        if (code === 0 && !st.error && (st.finished || reply)) {
          if (turn.brain === 'gemini-cli' && reply) this.deps.sendEvent({ type: 'assistant', text: reply })
          this.deps.sendEvent({ type: 'result', ok: true, text: reply, turns: 1 + st.toolCalls, costUsd: 0, durationMs: Date.now() - started })
          return resolve('ok')
        }
        const why = st.error ?? errTail
        if (resumeId && !reply && /session|thread|conversation|rollout/i.test(why) && /not found|no .*found|invalid|missing|does not exist/i.test(why)) {
          return resolve('stale-session')
        }
        this.deps.sendEvent({ type: 'error', message: cliFailureText(turn.brain, why, code) })
        resolve('failed')
      })
    })
  }
}
