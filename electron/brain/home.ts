import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_RULES } from '@shared/brain-persona'
import type { PaneWords } from '../pane-reply'

/**
 * Forge Brain's home: the folder its CLI runs in, and everything that folder
 * has to hold for each engine to start as the brain.
 *
 *   BRAIN.md                 the persona. Written once; Steve may edit it.
 *   CLAUDE.md, AGENTS.md,    the persona again, as each CLI's own instruction
 *   GEMINI.md                file (Claude, Codex, Gemini), with what it knows
 *                            about Forge (`forgeKnowledge`) after it. Rewritten
 *                            on every start, so an edit to BRAIN.md, and a
 *                            newer Forge's knowledge, reach all three.
 *   HANDOFF.md               the note a fresh start leaves the next conversation
 *                            (./host.ts `freshStartBrain`); never written here.
 *   .claude/settings.json    Claude: the brain's Forge tools allowed without a
 *                            prompt; editing and shell tools denied; Remote
 *                            Control at startup off; and the status line
 *                            command, because the brain no longer loads
 *                            Steve's user settings (./launch.ts).
 *   .gemini/settings.json    Gemini: the Forge MCP server, trusted; the shell
 *                            and file-writing tools excluded.
 *
 * Codex takes its MCP server and limits as launch flags (./host.ts), and the
 * Claude MCP config is a file beside the home, not in it (`brain\mcp.json`).
 *
 * Also here, because they are words Forge puts to the brain and nothing more:
 * the wording of its "[Forge]" notes and the small tests around them (the end
 * of this file). ./host.ts decides when one is sent.
 *
 * No Electron import, and nothing here decides anything about the app: the
 * caller passes the paths and the facts it chose.
 */

export const BRAIN_PERSONA = `# Forge Brain

You are Forge Brain. You run Forge for Steve: the desktop app he does all his work in, with its projects, tabs and agent panes.

- You see every project. Before you answer anything about the app, look with your Forge tools (get_app_state, list_panes_with_names, read_pane). Never guess what is open.
- You delegate. Real work (code, builds, fixes, research inside a repo) goes to an agent pane in the right project: open one with open_agent_pane, or type into one with type_into_pane. You never edit project code yourself and you never run builds yourself.
- Forge tells you what happens. A message that starts with "[Forge]" is Forge, not Steve: a pane finished, or a pane needs Steve. Pass on what matters in one short sentence. Do not answer a pane's question for Steve unless he told you to.
- Say plainly when something is outside what Forge can do, for example building or changing something outside Forge. Never pretend you did it.
- Keep replies short and natural. They may be read aloud: no headings, no tables, no code blocks unless Steve asks for them.
- Ask before anything risky: closing panes or tabs, deleting anything, sending messages, spending money, or changing a setting he did not ask for.
- Steve is red-green colourblind. Never describe a state by its colour alone.
- This folder is your home, not a project. Do not put work here.
`

/** The brain's whole reply to a note that needs nobody's ears; `forgeKnowledge` tells it so. */
export const BRAIN_QUIET = '[quiet]'

/** The voice agent's how-to for Forge's panes, agents, the Wall, the Board and the browser — from "What he asks of you" on. */
function sharedHowTo(): string {
  const at = MAIN_AGENT_RULES.indexOf('What he asks of you')
  return at >= 0 ? MAIN_AGENT_RULES.slice(at) : MAIN_AGENT_RULES
}

/**
 * What the brain knows about Forge itself, after the persona in each CLI's
 * instruction file. Compact on purpose (it rides every turn): a map of the
 * app and where to look, not the app pasted in. `docsDir` is the Forge
 * checkout's docs folder when there is one; its files are read on demand.
 */
export function forgeKnowledge(docsDir: string | null): string {
  let docs = ''
  if (docsDir && existsSync(docsDir)) {
    let files: string[] = []
    try {
      files = readdirSync(docsDir).filter((f) => f.endsWith('.md'))
    } catch {
      /* no list: the folder is still named */
    }
    docs = `
- Forge's own docs are in ${docsDir}${files.length ? ` (${files.join(', ')})` : ''}, with README.md one folder up. Read the one that fits when a question goes past this map; do not guess.`
  }
  return `# FORGE, THE APP
Forge is Steve's Windows desktop app for running coding agents (Claude Code, Codex, Gemini and others) in real terminal panes. Projects are down the left (the rail); each project has tabs, and a tab holds one or more panes, each named on its tab ("Zeb"). The voice bar sits at the bottom: Listen, the Dictate key and a text box — that is the voice agent, which can ask you things (a line starting "[The voice agent asks" or "[By voice") and hears what you pass it with say_to_voice_agent. Forge Brain is you: the brain icon in the top bar opens the Brain map, and Steve talks to you in the voice bar at the bottom. Forge Web puts the same app on his phone and in a browser; Forge Mobile is the Android app.

HANDOFF.md in your home, when it is there, is the note your last conversation left before a fresh start (Forge restarts you on a new conversation when your context window fills up): what it was tracking, the panes it handed work to, open questions. At the start of a new conversation, read it before anything else.

When Steve spoke (a message starting "[By voice"), your reply is read aloud in your own voice. Talk like a person: one to three short sentences, contractions, no lists, no code, no paths or links in the spoken part. Anything longer (steps, code, a list) goes after a blank line; only the opening is read out, and Forge tells him the rest is in the text.

Speech-to-text mishears him. When a [By voice] message does not make sense, or you would have to guess a name or an action, say what you think he meant and ask. Never act on a guess. Pane names sound alike: check list_panes_with_names.

Your reply to a [Forge] note about a pane is read aloud to Steve by Forge. One or two short sentences: who, what happened, what he must do. If nothing needs his ears (the pane only paused, work still runs in the background, a false alarm), reply with exactly ${BRAIN_QUIET}. Do not call say_to_voice_agent for a note reply. The note already carries the pane's last words; use read_pane only when that is not enough.

How to know and how to answer:
- What is open, running or asking: get_app_state, list_panes_with_names, read_pane. What your tools can do: describe_self (it speaks as the voice agent, Jarvis; your tools are the same, less the two that reach you).
- "How do I …?" about Forge: answer in one or two sentences naming the real control (the menu, the Settings section, the key), then offer to do it for him, and do it when he says yes. If a tool can do it, prefer doing it over explaining.
- Settings: get_settings lists what you may change and set_setting changes it (the theme, terminal text size, the rail, reduced motion, Wall text, voice replies and more); Steve's yes first unless he asked for that exact change. Everything else is his to change in Settings, which you can open on the right page with run_app_action {"kind":"open_settings","section":"…"}. Settings pages: Voice & Agent (voice); Forge Brain; Agents & CLIs — Profiles (agents), Keys (models), Panes, Foreman; Chatbots; Appearance — Theme & backdrop (appearance), Screenshots (shots); Shortcuts; Phone & Web — Forge Mobile, Forge Web, Remote Yes, Always on; Account (account); Updates; Advanced (advanced).${docs}

${sharedHowTo()}
`
}

/** The Forge MCP server's name in every engine's config — its tools are `mcp__forge__*` to Claude. */
export const BRAIN_MCP_SERVER = 'forge'

/**
 * The `statusLine` command in a Claude settings file, or null. Asked of Steve's
 * own ~/.claude/settings.json: his command is what leaves each session's
 * context numbers where Forge reads them (electron/web/agent-usage.ts), and the
 * brain's context ring is drawn from those.
 */
export function statusLineFrom(settingsFile: string): Record<string, unknown> | null {
  try {
    const line = (JSON.parse(readFileSync(settingsFile, 'utf8')) as { statusLine?: unknown } | null)?.statusLine
    if (!line || typeof line !== 'object') return null
    const { type, command } = line as { type?: unknown; command?: unknown }
    if (type === 'command' && typeof command === 'string' && command.trim()) return { ...(line as Record<string, unknown>) }
  } catch {
    /* no file, or not JSON: no status line */
  }
  return null
}

/**
 * Claude: Forge's brain tools (and the read-only browser tools) run without a
 * prompt; hands off code. `docsDir` (Forge's docs) is readable from the home.
 * `statusLine` is carried over from Steve's user settings, which the brain's
 * launch leaves out: without it no usage frame arrives and the ring shows "?".
 *
 * `remoteControlAtStartup` is off here because Steve's "on" also lives in
 * ~/.claude.json, which no launch flag leaves out: seen on Claude Code 2.1.287,
 * the slim launch still showed "/rc connecting…" until this said no. The brain
 * is never a Remote Control session (./launch.ts `brainCreateRequest`).
 */
export function claudeHomeSettings(docsDir: string | null = null, statusLine: Record<string, unknown> | null = null): Record<string, unknown> {
  return {
    remoteControlAtStartup: false,
    ...(statusLine ? { statusLine } : {}),
    permissions: {
      ...(docsDir ? { additionalDirectories: [docsDir] } : {}),
      allow: [
        `mcp__${BRAIN_MCP_SERVER}`,
        'mcp__forge-bridge__browser_open',
        'mcp__forge-bridge__browser_read',
        'mcp__forge-bridge__browser_text',
        'mcp__forge-bridge__browser_list',
        'mcp__forge-bridge__browser_screenshot',
        'mcp__forge-bridge__browser_close',
        // Steve's desktop, read-only: a look, the window list, a window's controls.
        'mcp__forge-bridge__screen_look',
        'mcp__forge-bridge__window_list',
        'mcp__forge-bridge__window_read',
        'Read',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch'
      ],
      // The brain delegates; it never edits or runs anything itself. Forge's own
      // run_command (launch-guard.ts) is its one way to run a program.
      deny: ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell']
    }
  }
}

export interface BrainMcpServer {
  node: string
  script: string
  linkFile: string
}

/** The stdio server entry: bridge/brain-mcp.mjs over the brain link. */
export function brainMcpEntry(server: BrainMcpServer): Record<string, unknown> {
  return { command: server.node, args: [server.script], env: { FORGE_BRAIN_LINK_FILE: server.linkFile } }
}

/** Claude's `--mcp-config` file for the brain pane. */
export function claudeMcpConfig(server: BrainMcpServer): Record<string, unknown> {
  return { mcpServers: { [BRAIN_MCP_SERVER]: { type: 'stdio', ...brainMcpEntry(server) } } }
}

/** Gemini CLI built-ins the brain must not have: no shell, no writing. */
const GEMINI_EXCLUDED = ['run_shell_command', 'write_file', 'replace']

/** Gemini's workspace settings: the Forge server, trusted so each call needs no yes. */
export function geminiHomeSettings(server: BrainMcpServer): Record<string, unknown> {
  return {
    mcpServers: { [BRAIN_MCP_SERVER]: { ...brainMcpEntry(server), trust: true, timeout: 120_000 } },
    tools: { exclude: GEMINI_EXCLUDED }
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * Make the home ready for a start. Idempotent. Returns the persona in force
 * (BRAIN.md as it now stands). `docsDir`: Forge's docs folder, or null.
 * `statusLine`: Claude's status line command for the home (`statusLineFrom`), or null.
 */
export function prepareBrainHome(
  home: string,
  server: BrainMcpServer,
  docsDir: string | null = null,
  statusLine: Record<string, unknown> | null = null
): string {
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(home, '.gemini'), { recursive: true })
  const personaFile = join(home, 'BRAIN.md')
  if (!existsSync(personaFile)) writeFileSync(personaFile, BRAIN_PERSONA, 'utf8')
  let persona = BRAIN_PERSONA
  try {
    const text = readFileSync(personaFile, 'utf8')
    if (text.trim()) persona = text
  } catch {
    /* unreadable: the built-in persona */
  }
  const instructions = `${persona.trimEnd()}

${forgeKnowledge(docsDir)}`
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) writeFileSync(join(home, name), instructions, 'utf8')
  writeJson(join(home, '.claude', 'settings.json'), claudeHomeSettings(docsDir && existsSync(docsDir) ? docsDir : null, statusLine))
  writeJson(join(home, '.gemini', 'settings.json'), geminiHomeSettings(server))
  return persona
}

/* ------------------------------------------------------------------ notes */

/** Is this reply the silent marker (`BRAIN_QUIET`) and nothing else? */
export function isQuietReply(reply: string): boolean {
  return reply.trim().toLowerCase() === BRAIN_QUIET
}

/** A pane's stop is news only after this much work … */
export const STOP_MIN_WORK_MS = 8000
/** … and only when the pane is still not working this long after it stopped. */
export const STOP_SETTLE_MS = 20_000

/**
 * Is a pane's stop worth a note, `STOP_SETTLE_MS` after it? Not when it went
 * back to work meanwhile: a turn ending is not the job ending. `workedMs` null
 * = Forge did not see the run, and the renderer's own 8 s rule vouches for it.
 */
export function stopIsNews(workedMs: number | null, busyAgain: boolean): boolean {
  return !busyAgain && (workedMs === null || workedMs >= STOP_MIN_WORK_MS)
}

/**
 * What a CLI shows in an empty composer that reads as a question. The
 * renderer's attention detector takes any screen line ending in "?" for one.
 */
export const IDLE_PLACEHOLDERS: readonly string[] = [
  // Codex
  'Got something you want to try?'
]

/** A menu's cursor row ("❯ 1. Yes"): a real choice, not a typed line. */
const CURSOR_CHOICE_RE = /^[❯›>]\s*\(?\d+[.)]\s/

/**
 * Is a pane's "question" not one? True for the pane's own input line — what
 * Steve is typing there, or the composer's hint — and for an idle placeholder.
 */
export function askingIsNoise(question: string): boolean {
  const line = question.trim()
  if (/^[❯›>]/.test(line) && !CURSOR_CHOICE_RE.test(line)) return true
  const lower = line.toLowerCase()
  return IDLE_PLACEHOLDERS.some((p) => lower.includes(p.toLowerCase()))
}

/** "Cleo in Lakeside needs Steve: Allow this command?" */
export function askingNote(label: string, question: string): string {
  const text = question ? `${label} needs Steve: ${question}` : `${label} needs Steve`
  return /[.?!:]$/.test(text) ? text : `${text}.`
}

/** The most of a pane's last words a note carries. */
const LAST_WORDS_MAX = 300

/** One plain line of at most `max` characters: no markdown marks, no line breaks. */
function oneLine(text: string, max: number): string {
  const line = text
    .replace(/^\s*#+\s*/gm, '')
    .replace(/[`*]/g, '')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

// A Claude pane's last words: in ../pane-reply.ts since the mini bar's Peek
// reads them too. Re-exported, so the brain's notes and checks keep one name.
export { paneWords } from '../pane-reply'
export type { PaneWords } from '../pane-reply'

/** 'Pax in forge stopped after 4 min. It said: "…" 2 background agents still running.' */
export function stopNote(label: string, workedMs: number | null, pane: PaneWords | null = null): string {
  const after = workedMs === null ? '' : workedMs < 60_000 ? ' after under 1 min' : ` after ${Math.round(workedMs / 60_000)} min`
  const parts = [`${label} stopped${after}.`]
  const said = pane ? oneLine(pane.lastWords, LAST_WORDS_MAX) : ''
  if (said) parts.push(`It said: "${said}"`)
  if (pane && pane.agents > 0) parts.push(`${pane.agents} background agent${pane.agents === 1 ? '' : 's'} still running.`)
  return parts.join(' ')
}
