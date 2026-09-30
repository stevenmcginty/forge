import { BRAIN_ASK_WAIT_MS } from '@shared/brain'
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

/* ---------------------------------------------------------------- the list */

const NO_ARGS = { type: 'object', properties: {} }

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
async function shrinkScreenshot(base64: string, mime: string): Promise<{ mime: string; base64: string }> {
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
  return { mime: 'image/jpeg', base64: url.slice(url.indexOf(',') + 1) }
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
        const shot = env.screenshot
          ? await env.screenshot()
          : await (async () => {
              const res = await window.forge.realtime?.screenshot()
              if (!res) return null
              if (!res.ok) throw new Error(res.error)
              return shrinkScreenshot(res.base64, res.mime)
            })()
        if (!shot) return { ok: false, text: 'FAILED: screen capture is not available in this build.' }
        return { ok: true, text: 'OK: the screenshot follows as an image.', image: shot }
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
