import { BRAIN_SETTINGS, brainSetting, type BrainSetting } from '@shared/brain-tools'
import type { Settings, VoiceAgentToolRequest, VoiceAgentToolResult, Workspace } from '@shared/types'
import type { LiveApp } from '../state/AppState'
import type { ActivityState } from './paneActivity'
import type { terminalHost as TerminalHost } from './terminals'
import {
  matchProfile,
  matchProject,
  paneLabel,
  resolvePaneTarget,
  resolveTabTarget,
  type ActionContext,
  type ActionOutcome,
  type ActionPane,
  type AppAction
} from './appactions'
import { ACTION_SPECS, buildStateSection, type ManifestSnapshot } from './appmanifest'
import { collectLeaves } from './splitTree'
import { runHubTool } from './realtime/tools-hub'
import { runMainAgentTool } from './realtime/tools-main'
import { AWAY_NOTE, forgeIsAway } from './showView'

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
   * The compact live manifest (src/lib/realtime/context.ts) — terminal names,
   * agents, state words. Handed to the realtime brains at session start and
   * when it changes; the Claude session gets it with a turn.
   */
  getAppContext?(): string
  /**
   * The executor's context right now — what `runAction` would resolve against.
   * Optional: only a browser's navigation (./realtime/web-nav.ts) reads it, to
   * resolve a project or a tab without switching the desktop to it.
   */
  actionContext?(): ActionContext | null
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

async function appState(deps: VoiceAgentToolDeps, everyProject = false): Promise<string> {
  const snapshot = await deps.getSnapshot()
  const r = everyProject ? await reach() : null
  return `${buildStateSection(r ? await withEveryProject(r, snapshot) : snapshot)}\n\n${capabilityList()}`
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
  deps: VoiceAgentToolDeps,
  opts?: { everyProject?: boolean }
): Promise<{ ok: true; result: string } | { ok: false; error: string }> {
  try {
    // The tools served from main (the Claude and CLI brains, Forge Brain) reach
    // every project; the realtime brains' own calls stay on the one on screen.
    if (opts?.everyProject) {
      const answered = await answerAcrossProjects(name, (args ?? {}) as Record<string, unknown>, deps)
      if (answered !== null) return { ok: true, result: answered }
    }
    switch (name) {
      case 'get_app_state':
        return { ok: true, result: await appState(deps, opts?.everyProject === true) }

      case 'run_app_action': {
        const action = asAction(args)
        if (!action) return { ok: false, error: 'that action had no "kind" — see the tool description' }
        const outcome = await deps.runAction(action)
        // Neither brings a minimised Forge back (only show_view does); say so.
        const unseen = outcome.ok && (action.kind === 'set_view' || action.kind === 'focus_tab') && forgeIsAway()
        return { ok: true, result: unseen ? `${describeOutcome(outcome)}\n${AWAY_NOTE}` : describeOutcome(outcome) }
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
        const hub = await runHubTool(name, (args ?? {}) as Record<string, unknown>, deps)
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

/* ----------------------------------------------- across every project
 *
 * The tools served from main — the Claude and CLI brains, Forge Brain — see
 * and act on every project, not only the one on screen, and never switch
 * Steve's screen to do it. The executor (./appactions.ts) is built for the
 * project on screen, so these answer from the live app state directly.
 */

/**
 * The live app as these tools reach it. Loaded on first use rather than
 * imported: scripts/realtime-check.mjs imports this module headless, and these
 * pull in React, xterm and the app state.
 */
interface Reach {
  app: LiveApp
  term: typeof TerminalHost
  activity(paneId: string): ActivityState
  panesOf(workspace: Workspace | null | undefined): ActionPane[]
  themes: Array<{ id: string; name: string }>
}

async function reach(): Promise<Reach | null> {
  const [{ readLiveApp }, { terminalHost }, { activityOf }, { buildActionPanes }, { BUILTIN_THEMES }] = await Promise.all([
    import('../state/AppState'),
    import('./terminals'),
    import('./paneActivity'),
    import('./actionPanes'),
    import('../theme/themes')
  ])
  const app = readLiveApp()
  if (!app) return null
  return {
    app,
    term: terminalHost,
    activity: (paneId) => activityOf(paneId, terminalHost.runtime(paneId)).state,
    panesOf: (ws) => buildActionPanes(ws, app.get().settings.agentProfiles),
    themes: [...BUILTIN_THEMES, ...app.get().settings.customThemes].map((t) => ({ id: t.id, name: t.name }))
  }
}

/** A pane's state, in the words the brain reads. `not started`: a pane Forge starts when its project is on screen. */
const STATE_WORD: Record<ActivityState, string> = {
  working: 'working',
  attention: 'needs you',
  done: 'done',
  idle: 'idle',
  starting: 'starting',
  dormant: 'not started',
  exited: 'exited',
  failed: 'failed'
}

interface Where {
  id: string
  name: string
  path: string
  onScreen: boolean
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** The project named `spoken`, or the one on screen for no name. A string is the refusal. */
function findProject(r: Reach, spoken: string): Where | string {
  const st = r.app.get()
  const id = spoken ? matchProject(st.projects, spoken)?.id : st.activeProjectId
  const project = st.projects.find((p) => p.id === id)
  if (!project) {
    const all = st.projects.map((p) => p.name).join(', ')
    return spoken ? `FAILED: no project called "${spoken}". Projects: ${all || 'none'}.` : 'FAILED: no project is open.'
  }
  return { id: project.id, name: project.name, path: project.path, onScreen: project.id === st.activeProjectId }
}

/**
 * A project's tabs, read into state first when this session has not had them
 * yet (as opening the project would, minus the switch) — so every answer about
 * it comes from the one copy the app itself acts on. Straight off disk only if
 * that fails.
 */
async function workspaceFor(r: Reach, projectId: string): Promise<Workspace | null> {
  if (await r.app.actions.loadWorkspace(projectId)) {
    const loaded = r.app.get().workspaces[projectId]
    if (loaded) return loaded
  }
  try {
    const saved = await window.forge?.store?.getWorkspace(projectId)
    return saved && Array.isArray(saved.tabs) ? saved : null
  } catch {
    return null
  }
}

/** One pane of `where`, by the same resolver send_prompt uses. A string is the refusal. */
async function paneIn(r: Reach, where: Where, target: string): Promise<ActionPane | string> {
  const ws = await workspaceFor(r, where.id)
  const panes = r.panesOf(ws)
  const focused = where.onScreen ? (ws?.tabs.find((t) => t.id === ws.activeTabId)?.activePaneId ?? null) : null
  const found = resolvePaneTarget(target, panes, focused)
  if (found.kind === 'ambiguous') {
    return `FAILED: more than one pane in ${where.name} matches — ${found.candidates.map(paneLabel).join(', ')}. Ask which one.`
  }
  if (found.kind === 'none') {
    return panes.length
      ? `FAILED: no pane in ${where.name} matches "${target}". Open there: ${panes.map(paneLabel).join(', ')}.`
      : `FAILED: no panes are open in ${where.name}.`
  }
  return found.pane
}

/** The snapshot with every project's terminals, and a state word on each. */
async function withEveryProject(r: Reach, snapshot: ManifestSnapshot): Promise<ManifestSnapshot> {
  const st = r.app.get()
  const word = (p: ActionPane): string => STATE_WORD[r.activity(p.paneId)]
  const here = r.panesOf(st.activeProjectId ? st.workspaces[st.activeProjectId] : null)
  const tabs = snapshot.tabs.map((tab) => ({
    ...tab,
    panes: tab.panes.map((pane) => {
      const live = here.find((p) => p.name === pane.name)
      return live ? { ...pane, status: word(live) } : pane
    })
  }))
  const others = st.projects.filter((p) => p.id !== st.activeProjectId)
  const otherProjects = await Promise.all(
    others.map(async (project) => {
      const panes = r.panesOf(await workspaceFor(r, project.id))
      return {
        name: project.name,
        panes: panes.length ? panes.map((p) => ({ name: p.name, profileName: p.profileName, status: word(p) })) : null
      }
    })
  )
  return { ...snapshot, tabs, otherProjects }
}

function listPanes(r: Reach, where: Where, panes: ActionPane[]): string {
  if (!panes.length) return `No panes are open in ${where.name}.`
  return [
    `${where.name}${where.onScreen ? ' (on screen)' : ''} — name · agent · state:`,
    ...panes.map((p) => `- ${p.name} · ${p.profileName} · ${STATE_WORD[r.activity(p.paneId)]}`)
  ].join('\n')
}

/** Type into a pane of a project not on screen, without bringing it forward. */
function typeElsewhere(r: Reach, where: Where, pane: ActionPane, text: string, submit: boolean): string {
  const status = r.term.runtime(pane.paneId).status
  if (status === 'idle') {
    return `FAILED: ${pane.name} in ${where.name} has not started yet — Forge starts a project's panes when it is on screen. Nothing was typed.`
  }
  // A pane still starting is PowerShell, which would run the text as a command.
  if (status === 'starting') return `FAILED: ${pane.name} in ${where.name} is still starting. Nothing was typed; try again in a moment.`
  if (status !== 'live') return `FAILED: ${pane.name} in ${where.name} is not running (${status}). Nothing was typed.`
  if (text) {
    if (/[\r\n]/.test(text)) r.term.paste(pane.paneId, text)
    else if (!r.term.type(pane.paneId, text)) return `FAILED: ${pane.name} in ${where.name} would not take the text.`
  }
  if (submit) r.term.submit(pane.paneId)
  if (!text) return `OK: pressed Enter in ${pane.name} (${where.name}).`
  return `OK: typed into ${pane.name} (${where.name})${submit ? ' and pressed Enter' : ' (not sent)'}.`
}

async function openElsewhere(r: Reach, where: Where, args: Record<string, unknown>): Promise<string> {
  const said = str(args['agent'])
  const profiles = r.app.get().settings.agentProfiles
  const profile = profiles.find((p) => p.id === said.toLowerCase()) ?? (said ? matchProfile(profiles, said) : null)
  if (!profile) return `FAILED: no agent called "${said || '(none given)'}". Agents here: ${profiles.map((p) => p.name).join(', ')}.`
  if (!(await r.app.actions.loadWorkspace(where.id))) return `FAILED: ${where.name}'s tabs could not be read, so nothing opened.`
  const prompt = str(args['prompt'])
  const name = str(args['name'])
  const submit = args['submit'] === true && profile.command.trim() !== ''
  const opened = r.app.actions.openAgentPane(name || profile.name, prompt, {
    profileId: profile.id,
    submit,
    projectId: where.id,
    ...(name ? { name } : {})
  })
  if (!opened) return `FAILED: Forge refused to open a ${profile.name} pane in ${where.name} — the session limit or that project's tab limit is reached.`
  const started = await startOffScreen(r, where.id, opened.paneId)
  return [
    `OK: opened ${opened.name} (${profile.name}) in ${where.name} (pane id ${opened.paneId}); Steve's screen stayed where it was.`,
    started
      ? `It is starting now, off screen${prompt ? `; the prompt goes in once it is ready${submit ? ' and is sent' : ', unsent'}` : ''}. read_pane shows it, and you hear when it finishes.`
      : `It starts the next time ${where.name} is on screen${prompt ? `; the prompt goes in once it is ready${submit ? ' and is sent' : ', unsent'}` : ''}.`
  ].join(' ')
}

/**
 * Start a pane just opened in a project that is not on screen, without
 * switching to it (TerminalHost.startHidden): the same launch its TerminalPane
 * would make — the profile's command with the pane's permission mode, the
 * project folder, the pane's Claude session id. The tab lands in state a
 * render after `openAgentPane` returns, so it is waited for briefly. False
 * when it never appeared (the pane then starts when its project is shown).
 */
async function startOffScreen(r: Reach, projectId: string, paneId: string): Promise<boolean> {
  const { launchCommand, leafPermissionMode, paneDisplayTitle, resolveProfile } = await import('./agents')
  for (let tries = 0; tries < 40; tries++) {
    const st = r.app.get()
    const project = st.projects.find((p) => p.id === projectId)
    const leaf = st.workspaces[projectId]?.tabs.flatMap((t) => collectLeaves(t.root)).find((l) => l.id === paneId)
    if (project && leaf) {
      const profile = resolveProfile(st.settings.agentProfiles, leaf.profileId)
      r.term.startHidden(paneId, {
        cwd: project.path,
        bootstrapCommand: launchCommand(profile, leafPermissionMode(leaf)),
        fontSize: st.settings.terminalFontSize,
        fontFamily: st.settings.terminalFontFamily,
        accent: profile.accent,
        projectName: project.name,
        paneTitle: paneDisplayTitle(profile, leaf.title),
        sessionId: leaf.sessionId,
        repoUrl: project.repoUrl
      })
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

async function closeTabIn(r: Reach, args: Record<string, unknown>): Promise<string> {
  const which = str(args['which'])
  if (!which) return 'FAILED: which tab? Give its name.'
  const where = findProject(r, str(args['project']))
  if (typeof where === 'string') return where
  if (!(await r.app.actions.loadWorkspace(where.id))) return `FAILED: ${where.name}'s tabs could not be read.`
  const ws = r.app.get().workspaces[where.id]
  if (!ws) return `FAILED: ${where.name}'s tabs could not be read.`
  // The confirmed call names the tab the check found, so a tab list that moved
  // while Steve was deciding cannot swap in another one.
  const tabId = str(args['tabId'])
  let tab = tabId ? ws.tabs.find((t) => t.id === tabId) : undefined
  if (tabId && !tab) return `FAILED: that tab in ${where.name} has already gone.`
  if (!tab) {
    const hit = resolveTabTarget(which, ws.tabs, where.onScreen ? ws.activeTabId : null)
    if (hit.kind === 'ambiguous') return `FAILED: more than one tab in ${where.name} matches — ${hit.candidates.map((t) => t.title).join(', ')}. Ask which one.`
    if (hit.kind === 'none') return `FAILED: no tab in ${where.name} matches "${which}". Tabs there: ${ws.tabs.map((t) => t.title).join(', ') || 'none'}.`
    tab = ws.tabs.find((t) => t.id === hit.tab.id)
  }
  if (!tab) return `FAILED: no tab in ${where.name} matches "${which}".`
  const panes = r.panesOf(ws).filter((p) => p.tabId === tab.id)
  const what = `the tab ${tab.title} in ${where.name} (${panes.map((p) => `${p.name} · ${p.profileName} · ${STATE_WORD[r.activity(p.paneId)]}`).join('; ')})`
  if (args['check'] === true) return `CHECK[${tab.id}]: close ${what}`
  r.app.actions.closeTab(tab.id, where.onScreen ? undefined : where.id)
  return `OK: closed ${what}.`
}

/** A setting's value as Steve would say it. */
function settingWords(value: unknown): string {
  if (value === true) return 'on'
  if (value === false) return 'off'
  return String(value)
}

function settingChoices(r: Reach, spec: BrainSetting): string[] {
  return spec.choices ? [...spec.choices] : r.themes.map((t) => t.id)
}

/** `raw` as a value `spec` allows. A string is the refusal. */
function settingValue(r: Reach, spec: BrainSetting, raw: unknown): { value: unknown } | string {
  const said = String(raw ?? '').trim().toLowerCase()
  if (spec.kind === 'boolean') {
    if (['true', 'on', 'yes', '1'].includes(said)) return { value: true }
    if (['false', 'off', 'no', '0'].includes(said)) return { value: false }
    return `FAILED: ${spec.key} is on or off, not "${said}".`
  }
  if (spec.kind === 'integer') {
    const n = Number(said)
    if (!Number.isInteger(n) || n < (spec.min ?? -Infinity) || n > (spec.max ?? Infinity)) {
      return `FAILED: ${spec.key} is a whole number from ${spec.min} to ${spec.max}.`
    }
    return { value: n }
  }
  const choices = settingChoices(r, spec)
  const byName = r.themes.find((t) => t.name.toLowerCase() === said)?.id
  const hit = choices.find((c) => c.toLowerCase() === said) ?? (spec.choices ? undefined : byName)
  return hit ? { value: hit } : `FAILED: ${spec.key} is one of ${choices.join(', ')}.`
}

function getSettings(r: Reach): string {
  const settings = r.app.get().settings as unknown as Record<string, unknown>
  return [
    'Settings you may change with set_setting (key — what it is: now; allowed):',
    ...BRAIN_SETTINGS.map((spec) => {
      const allowed =
        spec.kind === 'boolean'
          ? 'on/off'
          : spec.kind === 'integer'
            ? `${spec.min}–${spec.max}`
            : spec.choices
              ? spec.choices.join(', ')
              : r.themes.map((t) => `${t.id} (${t.name})`).join(', ')
      return `- ${spec.key} — ${spec.label}: ${settingWords(settings[spec.key])}; ${allowed}`
    }),
    'Nothing else is yours to change: keys, sign-ins, paths and the brains are Steve’s, in Settings.'
  ].join('\n')
}

function setSetting(r: Reach, args: Record<string, unknown>): string {
  const spec = brainSetting(str(args['key']))
  if (!spec) return `FAILED: "${str(args['key'])}" is not a setting you may change. Yours: ${BRAIN_SETTINGS.map((s) => s.key).join(', ')}.`
  const parsed = settingValue(r, spec, args['value'])
  if (typeof parsed === 'string') return parsed
  const current = (r.app.get().settings as unknown as Record<string, unknown>)[spec.key]
  if (current === parsed.value) return `OK: ${spec.label} is already ${settingWords(parsed.value)} — nothing changed.`
  if (args['check'] === true) {
    return `CHECK[]: change ${spec.label} from ${settingWords(current)} to ${settingWords(parsed.value)}`
  }
  r.app.actions.patchSettings({ [spec.key]: parsed.value } as Partial<Settings>)
  return `OK: ${spec.label} is now ${settingWords(parsed.value)}.`
}

async function createProject(args: Record<string, unknown>, deps: VoiceAgentToolDeps): Promise<string> {
  const name = str(args['name'])
  if (!name) return 'FAILED: no name — what should the project be called?'
  const folder = str(args['folder'])
  const first = await deps.runAction({ kind: 'create_project', name, ...(folder ? { parentDir: folder } : {}) })
  // Making a folder takes a moment, not minutes: the real answer is awaited.
  const outcome = first.pending ? await first.pending : first
  return outcome.ok ? `OK: ${outcome.summary}` : `FAILED: ${outcome.summary}`
}

/** Names this section answers (with `project`, for the pane tools). */
const ACROSS = new Set([
  'open_agent_pane',
  'type_into_pane',
  'read_pane',
  'list_panes_with_names',
  'run_app_action',
  'close_tab',
  'create_project',
  'get_settings',
  'set_setting',
  'pane_question',
  'pane_session'
])

/**
 * One cross-project call, answered — or null to leave it to the ordinary
 * answers (a pane tool with no `project`, or naming the one on screen).
 *
 * Two of these are asked by main itself and never offered to a model:
 * `pane_question` (is that pane asking something? — the confirm gate in
 * electron/voice-agent/host.ts) and `pane_session` (which Claude session and
 * folder does that pane run in? — list_subagents).
 */
async function answerAcrossProjects(name: string, args: Record<string, unknown>, deps: VoiceAgentToolDeps): Promise<string | null> {
  if (!ACROSS.has(name)) return null
  if (name === 'create_project') return createProject(args, deps)
  const action = name === 'run_app_action' ? asAction(args) : null
  // run_app_action is ours only for a send_prompt naming a project.
  if (name === 'run_app_action' && (action?.kind !== 'send_prompt' || !str(args['project']))) return null
  const spoken = str(args['project'])
  const paneTool = name === 'open_agent_pane' || name === 'type_into_pane' || name === 'read_pane' || name === 'run_app_action'
  if ((paneTool || name === 'list_panes_with_names') && !spoken) return null

  const r = await reach()
  if (!r) return 'FAILED: Forge is still starting up — try again in a moment.'
  switch (name) {
    case 'get_settings':
      return getSettings(r)
    case 'set_setting':
      return setSetting(r, args)
    case 'close_tab':
      return closeTabIn(r, args)
  }

  const where = findProject(r, spoken)
  if (typeof where === 'string') return name === 'pane_question' ? 'NOT ASKING' : where
  if (name === 'list_panes_with_names') return listPanes(r, where, r.panesOf(await workspaceFor(r, where.id)))
  // The project on screen: the ordinary tools do it, exactly as before.
  if (paneTool && where.onScreen) return null
  if (name === 'open_agent_pane') return openElsewhere(r, where, args)

  const target = str(args['target'])
  const pane = await paneIn(r, where, target)
  if (name === 'pane_question') {
    if (typeof pane === 'string' || !r.term.isAttention(pane.paneId)) return 'NOT ASKING'
    return `ASKING: ${pane.name} (${where.name}): ${r.term.attentionPrompt(pane.paneId) || 'a question on its screen'}`
  }
  if (typeof pane === 'string') return pane
  switch (name) {
    case 'pane_session': {
      const ws = await workspaceFor(r, where.id)
      const leaf = ws?.tabs.flatMap((t) => collectLeaves(t.root)).find((l) => l.id === pane.paneId)
      return JSON.stringify({ name: pane.name, project: where.name, cwd: where.path, sessionId: leaf?.sessionId ?? null })
    }
    case 'read_pane': {
      const want = Math.max(1, Math.min(PANE_READ_MAX_LINES, Math.floor(Number(args['lines']) || PANE_READ_DEFAULT_LINES)))
      const text = r.term.snapshotText(pane.paneId, want)
      if (text === null) return `${pane.name} in ${where.name} has not started yet, so there is nothing to read.`
      return `${pane.name} (${where.name}), last ${want} lines:\n${text.trim() || '(empty)'}`
    }
    case 'type_into_pane': {
      const text = String(args['text'] ?? '')
      const submit = args['submit'] === true
      if (!text.trim() && !submit) return 'FAILED: there is nothing to type.'
      return typeElsewhere(r, where, pane, text, submit)
    }
    case 'run_app_action': {
      // send_prompt: the same Enter rules as on screen (appactions.ts), minus
      // the countdown chip, which lives on a screen Steve is not looking at.
      const text = String(args['text'] ?? '').trim()
      if (!text) return 'FAILED: send_prompt needs the text to send.'
      const autoRelay = r.app.get().settings.voiceAutoRelay
      const submit = args['submit'] !== false && pane.agent && autoRelay
      const typed = typeElsewhere(r, where, pane, text, submit)
      if (submit || typed.startsWith('FAILED')) return typed
      const why = args['submit'] === false ? 'you asked me not to send it' : !pane.agent ? 'it is a plain shell' : 'auto-relay is off in Settings'
      return `${typed} Not sent: ${why}.`
    }
  }
  return null
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

    const outcome = await answerVoiceAgentTool(String(request.name ?? ''), request.args, deps, { everyProject: true })
    const result: VoiceAgentToolResult = outcome.ok
      ? // Never an empty answer: the model reads nothing as nothing having happened.
        { id, ok: true, result: outcome.result.trim() ? outcome.result : `Forge answered ${String(request.name)} with nothing.` }
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
