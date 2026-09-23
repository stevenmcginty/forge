import type { VoiceAgentToolRequest, VoiceAgentToolResult } from '@shared/types'
import { paneLabel, resolvePaneTarget, type ActionContext, type ActionOutcome, type AppAction } from './appactions'
import { ACTION_SPECS, buildStateSection, type ManifestSnapshot } from './appmanifest'
import { runHubTool } from './realtime/tools-hub'
import { runMainAgentTool } from './realtime/tools-main'

/**
 * The renderer's answer to the voice brain's questions.
 *
 * The brain lives in the main process and cannot see the app. Only this side
 * knows which tabs exist, which pane is focused, or what happens when you close
 * one — so when the Claude Agent SDK session calls `get_app_state` or
 * `run_app_action`, the call is relayed here and this module answers it.
 *
 * ## Why this replaces the manifest
 *
 * The Gemini/OpenRouter/Groq brains were handed a ~3,000-token capability
 * manifest as their system prompt on *every* turn, whether the turn was about
 * the app or not (see ./appmanifest.ts). The Claude brain is handed a static
 * persona and these tools instead: it pays for app state only when it asks, and
 * its prompt prefix is identical every turn, so it caches.
 *
 * The state text itself is still `buildStateSection` — the same rendering the
 * manifest brains get. Two renderings of "which terminal is Terminal 2" would
 * eventually disagree, and the whole point of the numbering is that Steve, the
 * model and the executor mean the same pane by it.
 *
 * ## Contract
 *
 * Exactly one answer per request id, always. A tool that throws, times out or
 * cannot be served still answers — with `ok: false` and a sentence saying why.
 * Never rejecting is the point: the host bounds every round trip at 15 seconds
 * and an unanswered tool is a model sat waiting to tell Steve nothing.
 *
 * Nothing here touches React. `registerVoiceAgentTools` is called once with the
 * live app's accessors and returns its own teardown.
 */

/** What this module needs from the app to be able to answer. */
export interface VoiceAgentToolDeps {
  /**
   * The app as the model should read it — the same snapshot `buildManifest`
   * takes. Rendered through `buildStateSection`, so it stays in step with what
   * the other brains are told.
   */
  getSnapshot(): ManifestSnapshot | Promise<ManifestSnapshot>
  /**
   * Run one action. Wraps `runAppAction` with the live context and runner; the
   * outcome's `summary` is what the model gets back, verbatim.
   */
  runAction(action: AppAction): ActionOutcome | Promise<ActionOutcome>
  /** This project's memory file, verbatim. Empty for a project with no history. */
  getProjectMemory(): string | Promise<string>
  /**
   * Add one fact to the active project's memory, through the same append the
   * learning loop uses. False means there was no active project to write to —
   * the only refusal this side can know about; anything that actually breaks
   * throws and is reported as itself.
   */
  remember(note: string): boolean | Promise<boolean>
  /**
   * A pane's recent screen text, by spoken target ("terminal 2", "the claude
   * one", "this"). Answers a sentence either way — an ambiguous or missing
   * target is said so rather than guessed. Optional: only the realtime brains
   * ask for it (src/lib/realtime/tools.ts).
   */
  readPane?(target: string, lines: number): string | Promise<string>
  /**
   * The compact live manifest (src/lib/realtime/context.ts) — call-signs,
   * agents, state words. Handed to the realtime brains at session start and
   * when it changes; the Claude session gets it with a turn.
   */
  getAppContext?(): string
}

/** Undo the registration. Safe to call twice. */
export type Unregister = () => void

/** The preload surface this module needs. */
interface ForgeVoiceAgentTools {
  onToolRequest(cb: (request: VoiceAgentToolRequest) => void): () => void
  toolResult(result: VoiceAgentToolResult): Promise<boolean>
}

function bridge(): ForgeVoiceAgentTools | null {
  const forge = (window as unknown as { forge?: { voiceAgent?: ForgeVoiceAgentTools } }).forge
  return forge?.voiceAgent ?? null
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ----------------------------------------------------------------- answers */

/**
 * The capability list that rides along with app state.
 *
 * `run_app_action`'s own description carries the argument shapes; this is the
 * shorter reminder of what exists at all, kept next to the state so the model
 * sees both in one read. Generated from `ACTION_SPECS` so a new action shows up
 * here the day it lands, exactly as it does in the manifest.
 */
function capabilityList(): string {
  const kinds = ACTION_SPECS.map((spec) => spec.kind).join(', ')
  return [
    '# WHAT YOU CAN DO',
    `run_app_action kinds: ${kinds}`,
    'Anything not on that list does not exist — say so rather than doing the nearest thing.'
  ].join('\n')
}

async function appState(deps: VoiceAgentToolDeps): Promise<string> {
  const snapshot = await deps.getSnapshot()
  return `${buildStateSection(snapshot)}\n\n${capabilityList()}`
}

/**
 * Turn an outcome into the sentence the model reads.
 *
 * Two things it must never lose. First, `ok` — a partial or refused action has
 * a perfectly cheerful-sounding summary ("Switched to forge — say that again to
 * open tabs there") and the model has to be able to tell it apart from success.
 * Second, the asynchronous case: `pending` means the work has *started*, and
 * the summary is provisional. Awaiting it here would blow the host's 15-second
 * bound on a Veo call that takes three minutes, so the model is told plainly
 * that it is in flight and must not report it as finished.
 */
function describeOutcome(outcome: ActionOutcome): string {
  const lines = [outcome.ok ? `OK: ${outcome.summary}` : `FAILED: ${outcome.summary}`]
  if (outcome.requested > 1 || outcome.done !== (outcome.ok ? outcome.requested : 0)) {
    lines.push(`(asked for ${outcome.requested}, done ${outcome.done})`)
  }
  if (outcome.pending) {
    lines.push(
      'This is still running and is NOT finished. Tell Steve it has started and roughly how long it takes. Do not report it as done.'
    )
    // Nothing awaits this here, but an unhandled rejection would surface as a
    // renderer error dialog for a failure the model was never going to see.
    void Promise.resolve(outcome.pending).catch(() => undefined)
  }
  if (outcome.paths?.length) lines.push(`Files: ${outcome.paths.join(', ')}`)
  return lines.join('\n')
}

/**
 * An action object off the wire, checked just enough to hand on.
 *
 * Deliberately shallow: `runAppAction` already validates every field it uses
 * and answers "I did not understand that" for an unknown kind, so a second
 * schema here would be a second thing to keep in step with the union. All this
 * catches is the shape that would throw before reaching it.
 */
function asAction(args: unknown): AppAction | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const kind = (args as { kind?: unknown }).kind
  if (typeof kind !== 'string' || !kind.trim()) return null
  return args as AppAction
}

/**
 * One tool call, answered. The Claude brain's IPC bridge below and the
 * realtime brains (src/lib/realtime/tools.ts) both come through here, so a
 * tool means the same thing whichever brain called it.
 *
 * Never rejects: a tool that throws is answered with `ok: false` and why.
 */
export async function answerVoiceAgentTool(
  name: string,
  args: unknown,
  deps: VoiceAgentToolDeps
): Promise<{ ok: true; result: string } | { ok: false; error: string }> {
  try {
    switch (name) {
      case 'get_app_state':
        return { ok: true, result: await appState(deps) }

      case 'run_app_action': {
        const action = asAction(args)
        if (!action) return { ok: false, error: 'that action had no "kind" — see the tool description' }
        return { ok: true, result: describeOutcome(await deps.runAction(action)) }
      }

      case 'get_project_memory': {
        const memory = (await deps.getProjectMemory()).trim()
        return { ok: true, result: memory || 'Nothing remembered about this project yet.' }
      }

      case 'remember': {
        const note = String((args as { note?: unknown })?.note ?? '').trim()
        if (!note) return { ok: false, error: 'that note was empty — there was nothing to remember' }
        return (await deps.remember(note))
          ? { ok: true, result: 'Noted — that is in this project’s memory now.' }
          : { ok: false, error: 'no project is open, so there is nowhere to keep that' }
      }

      default: {
        // open_agent_pane, type_into_pane, help_prompt, read_pane — the same
        // answers the realtime brains get (shared/brain-tools.ts).
        const main = await runMainAgentTool(name, (args ?? {}) as Record<string, unknown>, deps)
        if (main) return { ok: true, result: main.text }
        const hub = await runHubTool(name, (args ?? {}) as Record<string, unknown>)
        if (hub) return { ok: true, result: hub.text }
        return { ok: false, error: `Forge has no tool called ${name}` }
      }
    }
  } catch (err) {
    // The model gets the reason, not a hang. Whatever broke in the executor
    // is something it can tell Steve about and carry on from.
    return { ok: false, error: errText(err) }
  }
}

/** Lines a pane read returns when the model does not say. */
export const PANE_READ_DEFAULT_LINES = 40
export const PANE_READ_MAX_LINES = 200

/**
 * A pane's recent screen, as the sentence-plus-text the model reads.
 *
 * Resolved exactly the way send_prompt resolves its target, so "terminal 2"
 * reads the pane "terminal 2" would type into — and an ambiguous target is
 * asked about, never guessed. `read` is the terminal host's snapshotText,
 * passed in so this stays importable without xterm.
 */
export function describePaneText(
  ctx: Pick<ActionContext, 'panes' | 'focusedPaneId'> | null,
  target: string,
  lines: number,
  read: (paneId: string, lines: number) => string | null
): string {
  const panes = ctx?.panes ?? []
  const want = Math.max(1, Math.min(PANE_READ_MAX_LINES, Math.floor(Number(lines) || PANE_READ_DEFAULT_LINES)))
  const found = resolvePaneTarget(String(target ?? ''), panes, ctx?.focusedPaneId ?? null)
  if (found.kind === 'ambiguous') {
    return `FAILED: more than one pane matches — ${found.candidates.map(paneLabel).join(', ')}. Ask which one.`
  }
  if (found.kind === 'none') {
    return panes.length ? `FAILED: no pane matches "${target}". Open panes: ${panes.map(paneLabel).join(', ')}.` : 'FAILED: no panes are open.'
  }
  const text = read(found.pane.paneId, want)
  if (text === null) return `${paneLabel(found.pane)} is not on screen yet, so there is nothing to read — focus its tab first.`
  return `${paneLabel(found.pane)}, last ${want} lines:
${text.trim() || '(empty)'}`
}

/**
 * The deps the voice agent registered last, for the realtime brains. Null
 * before the VoiceAgentProvider mounts, and after it unmounts.
 */
let liveDeps: VoiceAgentToolDeps | null = null

export function currentVoiceAgentToolDeps(): VoiceAgentToolDeps | null {
  return liveDeps
}

/* ---------------------------------------------------------------- registry */

/**
 * Wire the brain's tool calls to the live app.
 *
 * Call once, with accessors that read current state rather than a captured
 * copy — the session outlives every render, so a snapshot taken at
 * registration time would be answering about a Forge from ten minutes ago.
 *
 * Returns the unregister. Registering twice would answer every request twice,
 * and the host discards the second answer, so it is not fatal — but it is not
 * free either.
 */
export function registerVoiceAgentTools(deps: VoiceAgentToolDeps): Unregister {
  // Kept before the bridge check: the realtime brains answer through these
  // same deps in the renderer and need no IPC at all.
  liveDeps = deps
  const forget = (): void => {
    if (liveDeps === deps) liveDeps = null
  }
  const api = bridge()
  if (!api) {
    // A stale preload rather than broken wiring — see src/lib/agentbrain.ts.
    console.error('[voice-agent] window.forge.voiceAgent is missing; tools are not wired up.')
    return forget
  }

  const answer = async (request: VoiceAgentToolRequest): Promise<void> => {
    const id = String(request?.id ?? '')
    if (!id) return

    const outcome = await answerVoiceAgentTool(String(request.name ?? ''), request.args, deps)
    const result: VoiceAgentToolResult = outcome.ok
      ? { id, ok: true, result: outcome.result }
      : { id, ok: false, error: outcome.error }

    try {
      await api.toolResult(result)
    } catch (err) {
      console.error('[voice-agent] could not deliver a tool result:', err)
    }
  }

  const off = api.onToolRequest((request) => {
    void answer(request)
  })
  return () => {
    off()
    forget()
  }
}
