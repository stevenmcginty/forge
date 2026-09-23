import type { RealtimeToolSpec } from '@shared/realtime'
import {
  answerVoiceAgentTool,
  currentVoiceAgentToolDeps,
  PANE_READ_DEFAULT_LINES,
  PANE_READ_MAX_LINES,
  type VoiceAgentToolDeps
} from '../agenttools'
import { ACTION_SPECS } from '../appmanifest'
import { toolLabel } from '../toolLabels'
import type { RealtimeToolAnswer } from './session'

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

/* ---------------------------------------------------------------- the list */

const NO_ARGS = { type: 'object', properties: {} }

/** Tools B2 fills in. Declared now so both providers already know the names. */
export const STUB_TOOL_NAMES: readonly string[] = ['focus_pane_by_name', 'show_on_canvas']

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
    name: 'read_pane',
    description:
      'Read the recent screen text of one terminal pane — what an agent has been saying or printing. target is spoken: "terminal 2", "the claude one", "this" for the focused pane.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Which pane, in words' },
        lines: { type: 'integer', description: `How many lines, default ${PANE_READ_DEFAULT_LINES}, at most ${PANE_READ_MAX_LINES}` }
      },
      required: ['target']
    }
  },
  {
    name: 'take_screenshot',
    description:
      'Look at the primary display. For something visible that is not app structure — a rendered page, an error, a design. For tabs and panes use get_app_state.',
    parameters: NO_ARGS
  },
  {
    name: 'focus_pane_by_name',
    description: 'Bring a pane forward by its name or call sign, e.g. "the reviewer". Not available yet — say so if asked.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The pane’s name or call sign' } },
      required: ['name']
    }
  },
  {
    name: 'show_on_canvas',
    description: 'Show something on Forge’s canvas — an image, a file, a pane. Not available yet — say so if asked.',
    parameters: {
      type: 'object',
      properties: { what: { type: 'string', description: 'What to show, in words' } },
      required: ['what']
    }
  }
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
    switch (name) {
      case 'get_app_state':
      case 'get_project_memory':
      case 'remember':
      case 'run_app_action': {
        if (!deps) return { ok: false, text: 'FAILED: Forge’s app tools are not ready yet — try again in a moment.' }
        const out = await answerVoiceAgentTool(name, args, deps)
        return out.ok ? { ok: !out.result.startsWith('FAILED'), text: out.result } : { ok: false, text: `FAILED: ${out.error}` }
      }

      case 'read_pane': {
        if (!deps?.readPane) return { ok: false, text: 'FAILED: reading panes is not available in this build.' }
        const text = await deps.readPane(String(args.target ?? ''), Number(args.lines ?? PANE_READ_DEFAULT_LINES))
        return { ok: !text.startsWith('FAILED'), text }
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

      // TODO(B2): focus a pane by its name / call sign. Replace this answer
      // with the real handler; the declaration above stays as it is.
      case 'focus_pane_by_name':
      // TODO(B2): put something on the canvas. Same deal.
      case 'show_on_canvas':
        return { ok: false, text: `FAILED: ${name.replace(/_/g, ' ')} is not available yet.` }

      default:
        return { ok: false, text: `FAILED: Forge has no tool called ${name}.` }
    }
  } catch (err) {
    return { ok: false, text: `FAILED: ${errText(err)}` }
  }
}

/* ---------------------------------------------------- provider formatting */

/** OpenAI's function tool shape (the session config in main adds `type`). */
export function toOpenAITools(tools: RealtimeToolSpec[] = REALTIME_TOOLS): RealtimeToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
}

/**
 * Gemini's Schema is OpenAPI-flavoured: upper-case type names and no
 * `additionalProperties`. Converted rather than written twice.
 */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'additionalProperties') continue
    if (key === 'type' && typeof value === 'string') out.type = value.toUpperCase()
    else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toGeminiSchema(v)])
      )
    } else out[key] = toGeminiSchema(value)
  }
  return out
}

export function toGeminiTools(tools: RealtimeToolSpec[] = REALTIME_TOOLS): Array<Record<string, unknown>> {
  return [
    {
      functionDeclarations: tools.map((t) => {
        const hasParams = Object.keys((t.parameters.properties as Record<string, unknown>) ?? {}).length > 0
        return hasParams
          ? { name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) }
          : { name: t.name, description: t.description }
      })
    }
  ]
}
