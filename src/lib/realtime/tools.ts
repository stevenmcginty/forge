import { BRAIN_ASK_WAIT_MS } from '@shared/brain'
import type { ForgeApi } from '@shared/api'
import type { RealtimeToolSpec } from '@shared/realtime'
import {
  answerVoiceAgentTool,
  currentVoiceAgentToolDeps,
  type VoiceAgentToolDeps
} from '../agenttools'
import { ACTION_SPECS } from '../appmanifest'
import { toolLabel } from '../toolLabels'
import type { RealtimeToolAnswer } from './session'
import { geminiToolDeclarations, openAIToolSpecs } from './tool-format'
import { HUB_REALTIME_TOOLS, runHubTool } from './tools-hub'
import { BROWSER_REALTIME_TOOLS, runBrowserHubTool } from './tools-browser'
import { MAIN_REALTIME_TOOLS, runMainAgentTool } from './tools-main'

/**
 * The realtime brains' tools: ONE list, handed to both Gemini Live and GPT
 * Realtime, and answered by the implementations the Claude brain already uses.
 *
 * Nothing here re-implements an action. get_app_state, run_app_action,
 * get_project_memory and remember go through `answerVoiceAgentTool` in
 * ../agenttools.ts — the very function the Claude brain's IPC bridge calls —
 * with the deps the VoiceAgentProvider registered. run_app_action's `kind` is
 * an enum generated from ACTION_SPECS, so the model is offered exactly the
 * kinds `runAppAction` implements, no more and no fewer; the check script
 * holds that 1:1.
 *
 * The flat parameter list (rather than an `action` object, as the Claude
 * brain's MCP tool takes) is for the voice models: a nested free-form object is
 * where a speech-to-speech model is most likely to drop a field.
 */

/* ------------------------------------------------------------ run_app_action */

export const REALTIME_ACTION_KINDS: string[] = ACTION_SPECS.map((spec) => spec.kind)

/**
 * JSON types for the action fields that are not strings. Every other field an
 * ACTION_SPECS example names is a string (spoken targets, names, modes).
 */
const FIELD_TYPES: Record<string, 'integer' | 'boolean'> = {
  count: 'integer',
  index: 'integer',
  duration: 'integer',
  flesh: 'boolean',
  submit: 'boolean'
}

/**
 * Every field any ACTION_SPECS example mentions, read out of the examples
 * themselves so a new field shows up the day its spec does. `submit` is added
 * by hand: it is a real send_prompt field (see AppAction) that the manifest's
 * example leaves out because the JSON brains never set it.
 */
export function actionFieldNames(): string[] {
  const names = new Set<string>()
  for (const spec of ACTION_SPECS) {
    for (const m of spec.args.matchAll(/"([A-Za-z]+)"\s*:/g)) {
      if (m[1] !== 'kind') names.add(m[1]!)
    }
  }
  names.add('submit')
  return [...names].sort()
}

function runAppActionSpec(): RealtimeToolSpec {
  const properties: Record<string, unknown> = {
    kind: { type: 'string', enum: REALTIME_ACTION_KINDS, description: 'Which action. See the list above.' }
  }
  for (const name of actionFieldNames()) {
    properties[name] = { type: FIELD_TYPES[name] ?? 'string' }
  }
  return {
    name: 'run_app_action',
    description: [
      'Do something to Forge. Pass `kind` and only that kind’s fields. The result says what actually happened — report that, never the request.',
      'For send_prompt put the whole brief in `text` and set submit true to press Enter. Closing tabs or panes is DESTRUCTIVE: confirm with him first.',
      ...ACTION_SPECS.map((spec) => `- ${spec.kind}: ${spec.what} e.g. ${spec.args}`)
    ].join('\n'),
    parameters: { type: 'object', properties, required: ['kind'] }
  }
}

/* -------------------------------------------------------------- forge brain */

/**
 * The way from a realtime voice agent to Forge Brain (shared/brain.ts), the
 * same pair electron/voice-agent/host.ts gives the Claude session. Always
 * declared, because a live session's tools are fixed when it opens; while the
 * brain is off the answer says so, in words the model can say.
 */
export const BRAIN_REALTIME_TOOLS: RealtimeToolSpec[] = [
  {
    name: 'ask_brain',
    description:
      'Ask Forge Brain — the app-level agent that sees every project and runs the agents — a question, and wait up to a minute for its answer. For anything across projects, or that Forge Brain is running. Say its answer in your own words, briefly. When it is off, or still working, the result says so.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: 'The question, in plain words, with what Steve asked' } },
      required: ['question']
    }
  },
  {
    name: 'tell_brain',
    description:
      'Hand Forge Brain a job to do and do not wait: it works on it and reports back by itself when it is done. For work that takes a while or spans projects. Tell Steve in one line that the brain has it.',
    parameters: {
      type: 'object',
      properties: { job: { type: 'string', description: 'The job, in plain words, with everything Steve said about it' } },
      required: ['job']
    }
  }
]

async function runBrainTool(name: string, args: Record<string, unknown>, waitMs: number): Promise<RealtimeToolAnswer | null> {
  if (name !== 'ask_brain' && name !== 'tell_brain') return null
  const brain = window.forge.brain
  if (!brain?.ask) return { ok: false, text: 'FAILED: this window cannot reach Forge Brain until Forge is restarted.' }
  if (name === 'ask_brain') {
    const question = String(args.question ?? '').trim()
    if (!question) return { ok: false, text: 'FAILED: ask_brain needs a question.' }
    const answer = await brain.ask(`[The voice agent asks, for Steve] ${question}`, waitMs)
    if (answer.ok) return { ok: true, text: `Forge Brain says: ${answer.text}` }
    return { ok: false, text: answer.late ? `STILL WORKING: ${answer.error}` : `FAILED: ${answer.error}` }
  }
  const job = String(args.job ?? '').trim()
  if (!job) return { ok: false, text: 'FAILED: tell_brain needs a job.' }
  const sent = await brain.send(`[A job from Steve, through the voice agent] ${job} — when it is done, tell him with say_to_voice_agent.`)
  return sent.ok
    ? { ok: true, text: `OK: Forge Brain has it${sent.queued ? ' (queued behind what it is doing)' : ''}. It will report back.` }
    : { ok: false, text: `FAILED: ${sent.error}` }
}

const NO_ARGS = { type: 'object', properties: {} }

/* ------------------------------------------------------------ the desktop */

/**
 * Steve's own desktop — his Chrome, any program, a dialog — read as numbered
 * controls and worked by number: the same engine (electron/desktop-hands.ts)
 * and the same names and args as forge-bridge's window_* tools
 * (bridge/desktop-tools.mjs), reached through `window.forge.desktop.op`.
 * take_screenshot is the look: it also names the window in front and lists
 * the open ones.
 */
const DESKTOP_SCOPE =
  "Acts on Steve's own desktop apps and his own Chrome, not Forge. For Forge's own browser tabs use the browser_* tools instead."
const DESKTOP_CONFIRM =
  'Ask Steve before submitting a form, buying anything or sending a message. Never type passwords or card details — ask Steve to type them himself.'

/** What a window tool says while the preload is older than `window.forge.desktop`. */
export const DESKTOP_RESTART = 'FAILED: Desktop tools need a Forge restart.'
/** What a window tool says from any session but the desk's realtime brain (Gemini Live, GPT Realtime), e.g. Forge Web. */
export const DESKTOP_DESK_ONLY = 'FAILED: Desktop tools work only at the desk.'

export const DESKTOP_REALTIME_TOOLS: RealtimeToolSpec[] = [
  {
    name: 'window_list',
    description: `Lists every open window on Steve's desktop, front first: number, app and title. Forge's own windows are left out. Read-only. ${DESKTOP_SCOPE}`,
    parameters: NO_ARGS
  },
  {
    name: 'window_read',
    description: [
      `Reads one window's on-screen controls as a numbered list: [n] type "name" = "value" (ticked, disabled, password). Read-only — it brings nothing forward. ${DESKTOP_SCOPE}`,
      'The numbers are what window_click and window_type take. They last until the window changes: read again after every click or form step, and never act on a number you did not just receive.'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        window: {
          type: 'string',
          description: 'Which window: its number from take_screenshot or window_list, or words from its title or app name, e.g. "chrome". Omit for the window in front.'
        }
      }
    }
  },
  {
    name: 'window_click',
    description: [
      `Clicks a control by its number from your last window_read (the window is brought forward first), or a point by x and y in your last take_screenshot picture. It says what happened. ${DESKTOP_SCOPE}`,
      DESKTOP_CONFIRM
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'The number in square brackets from your last window_read.' },
        x: { type: 'number', description: 'Instead of ref: left-to-right pixel in the last take_screenshot picture.' },
        y: { type: 'number', description: 'Instead of ref: top-to-bottom pixel in the last take_screenshot picture.' }
      }
    }
  },
  {
    name: 'window_type',
    description: [
      `Types text. With ref (a number from your last window_read) that box's text is replaced; without it the keys go where the cursor is in the window you last read (or the front window). enter: true presses Enter after. A password box is refused. ${DESKTOP_SCOPE}`,
      DESKTOP_CONFIRM
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Optional: the number in square brackets from your last window_read.' },
        text: { type: 'string', description: 'The text to type, exactly as it should appear.' },
        enter: { type: 'boolean', description: 'Optional: press Enter after typing (usually submits).' }
      },
      required: ['text']
    }
  },
  {
    name: 'window_key',
    description: [
      `Presses keys in a window (brought forward first): e.g. "Tab", "Shift+Tab", "Enter", "Escape", "Down Down Enter", "Ctrl+A". Up to 30 keys. ${DESKTOP_SCOPE}`,
      DESKTOP_CONFIRM
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: 'The keys, separated by spaces, e.g. "Tab Tab Enter" or "Ctrl+A".' },
        window: {
          type: 'string',
          description: 'Which window: its number from window_list, or words from its title or app name. Omit for the window you last read, or the one in front.'
        }
      },
      required: ['keys']
    }
  },
  // Launching and opening: the Claude brain's own tools, answered in main by the
  // same guarded functions (electron/voice-agent/desktop-open.ts).
  {
    name: 'list_desktop_apps',
    description: "Lists every app installed on Steve's PC that the Start menu can launch: names for open_desktop_app. Read-only.",
    parameters: NO_ARGS
  },
  {
    name: 'open_desktop_app',
    description:
      'Launches an installed app on Steve\'s desktop by name, e.g. "Spotify", "Notepad". It says what launched, or the near misses. Agents and consoles are refused: use open_agent_pane.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The app, as Steve said it.' } },
      required: ['name']
    }
  },
  {
    name: 'open_file_or_link',
    description:
      'Opens a file or folder in its Windows app, or a web address. A search is a search URL, e.g. https://www.google.com/search?q=… A web address opens in Steve\'s own browser when where is "desktop" or Forge is minimised, otherwise in Forge\'s browser.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'An absolute path or an http(s) URL.' },
        where: {
          type: 'string',
          enum: ['desktop', 'forge'],
          description: 'Web addresses only: "desktop" = his own browser (he names Chrome or his browser), "forge" = Forge\'s. Omit to go by whether Forge is minimised.'
        }
      },
      required: ['target']
    }
  }
]

const DESKTOP_TOOL_NAMES = new Set(DESKTOP_REALTIME_TOOLS.map((t) => t.name))

/** `window.forge.desktop`, or undefined: an older preload, or no window at all (the check scripts). */
function desktopApi(): ForgeApi['desktop'] {
  return typeof window === 'undefined' ? undefined : window.forge?.desktop
}

/**
 * The last take_screenshot picture's width over the screen capture's: the
 * model sees a shrunk copy, and main's window_click x,y are in the capture's
 * pixels (it notes that size when it takes the shot). null = no shot yet.
 */
let lastShotScale: number | null = null

async function runDesktopTool(name: string, args: Record<string, unknown>, on: boolean): Promise<RealtimeToolAnswer | null> {
  if (!DESKTOP_TOOL_NAMES.has(name)) return null
  if (!on) return { ok: false, text: DESKTOP_DESK_ONLY }
  const desktop = desktopApi()
  if (typeof desktop?.op !== 'function') return { ok: false, text: DESKTOP_RESTART }
  let opArgs = args
  if (name === 'window_click' && args.ref == null && (args.x != null || args.y != null)) {
    if (lastShotScale === null) {
      return { ok: false, text: 'FAILED: Nothing was clicked: call take_screenshot first, then give x and y in that picture.' }
    }
    const scale = lastShotScale
    opArgs = { ...args, x: Math.round(Number(args.x) / scale), y: Math.round(Number(args.y) / scale) }
  }
  const reply = await desktop.op(name, opArgs)
  return { ok: reply.ok, text: `${reply.ok ? 'OK' : 'FAILED'}: ${reply.text}` }
}

/**
 * The words that go with a take_screenshot picture: the window in front and
 * every open window, so one look says what Steve is in and what to
 * window_read. '' with no desktop tools (an older preload) or when the list fails.
 */
async function desktopSummary(): Promise<string> {
  const desktop = desktopApi()
  if (typeof desktop?.op !== 'function') return ''
  try {
    const reply = await desktop.op('window_list', {})
    if (!reply.ok) return ''
    const rows = reply.text.split('\n').filter((l) => /^\d+\. /.test(l))
    const front = rows.find((l) => !/\(minimised\)$/.test(l))
    return [
      `In front: ${front ? front.replace(/^\d+\. /, '') : 'nothing apart from Forge'}.`,
      'Open windows, front first (Forge left out):',
      rows.length ? rows.join('\n') : 'none',
      'To act in one: window_read it by number or name, then window_click / window_type / window_key by the numbers it gives.'
    ].join('\n')
  } catch {
    return ''
  }
}

/* ---------------------------------------------------------------- the list */

/** Tools B2 fills in. Declared now so both providers already know the names. */
export const STUB_TOOL_NAMES: readonly string[] = []

export const REALTIME_TOOLS: RealtimeToolSpec[] = [
  {
    name: 'get_app_state',
    description:
      'Read what is open in Forge right now: projects, the tabs and terminal panes in the active one, which is focused, and what each runs. Call before answering anything about the app.',
    parameters: NO_ARGS
  },
  runAppActionSpec(),
  {
    name: 'get_project_memory',
    description: 'Read what Forge has learned about the active project in earlier sessions.',
    parameters: NO_ARGS
  },
  {
    name: 'remember',
    description:
      'Keep one plain fact in the active project’s memory for later sessions. Only for decisions and standing preferences, never chit-chat.',
    parameters: {
      type: 'object',
      properties: { note: { type: 'string', description: 'The fact, as one plain sentence' } },
      required: ['note']
    }
  },
  {
    name: 'take_screenshot',
    description:
      'Look at the primary display. For something visible that is not app structure — a rendered page, an error, a design. For tabs and panes use get_app_state.',
    parameters: NO_ARGS
  },
  ...MAIN_REALTIME_TOOLS,
  ...HUB_REALTIME_TOOLS,
  ...BROWSER_REALTIME_TOOLS,
  ...BRAIN_REALTIME_TOOLS
]

/**
 * The desk's realtime sessions (Gemini Live, GPT Realtime): REALTIME_TOOLS with the desktop tools after
 * take_screenshot, whose words then say what one look gives.
 */
const DESK_TOOLS: RealtimeToolSpec[] = REALTIME_TOOLS.flatMap((t) =>
  t.name === 'take_screenshot'
    ? [
        {
          ...t,
          description:
            'Look at Steve\'s whole screen now — any app, Forge minimised or not — and get the window in front and every open window by number. Call it first when he says "this", "my screen", "this page", "this form" or "this app". For tabs and panes use get_app_state.'
        },
        ...DESKTOP_REALTIME_TOOLS
      ]
    : [t]
)

/** Whether a session has Steve's desktop: the desk's Gemini Live or GPT Realtime, never Forge Web. */
export function desktopToolsOn(provider: string, opts: { web?: boolean } = {}): boolean {
  return (provider === 'gemini-live' || provider === 'gpt-realtime' || provider === 'gpt-realtime-mini') && opts.web !== true
}

/** The tools a realtime session is opened with. */
export function realtimeToolsFor(provider: string, opts: { web?: boolean } = {}): RealtimeToolSpec[] {
  return desktopToolsOn(provider, opts) ? DESK_TOOLS : REALTIME_TOOLS
}

/* ---------------------------------------------------------------- answers */

/** The in-flight label for the hub's recent-actions list ("Opening tabs"). */
export function realtimeToolLabel(name: string, args: Record<string, unknown>): string {
  if (name === 'run_app_action' && typeof args.kind === 'string') return toolLabel(args.kind)
  if (name === 'read_pane') return 'Reading a terminal'
  return toolLabel(name)
}

/**
 * The finished label: the first line of what the tool said, without the
 * OK:/FAILED: marker — "Opened 2 Claude tabs", not "run_app_action".
 */
export function realtimeResultLabel(name: string, answer: RealtimeToolAnswer): string {
  const first = (answer.text.split('\n')[0] ?? '').replace(/^(OK|FAILED):\s*/, '').trim()
  if (name === 'run_app_action' && first) return first
  if (name === 'take_screenshot') return answer.ok ? 'Looked at the screen' : first || 'Could not see the screen'
  if (name === 'read_pane') return answer.ok ? (first.split(',')[0] ?? 'Read a terminal') : first
  if (!answer.ok) return first || `${toolLabel(name)} failed`
  return toolLabel(name).replace(/^./, (c) => c.toUpperCase())
}

/**
 * Downscale a screenshot to something a data channel will carry: OpenAI's
 * WebRTC channel refuses messages over 256 KB, and a 1080p PNG in base64 is
 * several megabytes. 1024 wide JPEG is plenty for "what's on my screen".
 */
async function shrinkScreenshot(base64: string, mime: string): Promise<{ mime: string; base64: string; scale: number }> {
  const img = new Image()
  img.src = `data:${mime};base64,${base64}`
  await img.decode()
  const scale = Math.min(1, 1024 / Math.max(1, img.naturalWidth))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.naturalWidth * scale)
  canvas.height = Math.round(img.naturalHeight * scale)
  const g = canvas.getContext('2d')
  if (!g) throw new Error('no 2D canvas')
  g.drawImage(img, 0, 0, canvas.width, canvas.height)
  const url = canvas.toDataURL('image/jpeg', 0.6)
  return { mime: 'image/jpeg', base64: url.slice(url.indexOf(',') + 1), scale: canvas.width / Math.max(1, img.naturalWidth) }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface RealtimeToolEnv {
  /** The voice agent's live deps. Defaults to whatever it registered last. */
  deps?: VoiceAgentToolDeps | null
  /** Screen capture. Defaults to window.forge.realtime.screenshot. */
  screenshot?: () => Promise<{ mime: string; base64: string } | null>
  /** How long ask_brain waits for the brain. A browser's call passes less: its requests die at 30 s. */
  brainWaitMs?: number
  /** The desk's realtime brain (`desktopToolsOn`): the window tools run and take_screenshot lists the windows. Off by default. */
  desktop?: boolean
}

/**
 * Answer one realtime tool call. Never rejects — like the Claude brain's
 * bridge, a failure is an answer (`ok: false`) the model can say out loud.
 */
export async function runRealtimeTool(
  name: string,
  args: Record<string, unknown>,
  env: RealtimeToolEnv = {}
): Promise<RealtimeToolAnswer> {
  const deps = env.deps === undefined ? currentVoiceAgentToolDeps() : env.deps
  try {
    const main = await runMainAgentTool(name, args, deps)
    if (main) return main
    const hub = await runHubTool(name, args, deps)
    if (hub) return hub
    const browser = await runBrowserHubTool(name, args)
    if (browser) return browser
    const brain = await runBrainTool(name, args, env.brainWaitMs ?? BRAIN_ASK_WAIT_MS)
    if (brain) return brain
    const desktop = await runDesktopTool(name, args, env.desktop === true)
    if (desktop) return desktop
    switch (name) {
      case 'get_app_state':
      case 'get_project_memory':
      case 'remember':
      case 'run_app_action': {
        if (!deps) return { ok: false, text: 'FAILED: Forge’s app tools are not ready yet — try again in a moment.' }
        const out = await answerVoiceAgentTool(name, args, deps)
        return out.ok ? { ok: !out.result.startsWith('FAILED'), text: out.result } : { ok: false, text: `FAILED: ${out.error}` }
      }

      case 'take_screenshot': {
        const summary = env.desktop === true ? desktopSummary() : Promise.resolve('')
        const shot = env.screenshot
          ? await env.screenshot()
          : await (async () => {
              const res = await window.forge.realtime?.screenshot()
              if (!res) return null
              if (!res.ok) throw new Error(res.error)
              const small = await shrinkScreenshot(res.base64, res.mime)
              lastShotScale = small.scale
              return { mime: small.mime, base64: small.base64 }
            })()
        if (!shot) return { ok: false, text: 'FAILED: screen capture is not available in this build.' }
        const words = await summary
        return { ok: true, text: `OK: the screenshot follows as an image.${words ? `\n${words}` : ''}`, image: shot }
      }

      default:
        return { ok: false, text: `FAILED: Forge has no tool called ${name}.` }
    }
  } catch (err) {
    return { ok: false, text: `FAILED: ${errText(err)}` }
  }
}

/* ---------------------------------------------------- provider formatting */

/** OpenAI's function tool shape — the conversion lives in ./tool-format.ts. */
export function toOpenAITools(tools: RealtimeToolSpec[] = REALTIME_TOOLS): RealtimeToolSpec[] {
  return openAIToolSpecs(tools)
}

/** Gemini's function declarations — the conversion lives in ./tool-format.ts. */
export function toGeminiTools(tools: RealtimeToolSpec[] = REALTIME_TOOLS): Array<Record<string, unknown>> {
  return geminiToolDeclarations(tools)
}
