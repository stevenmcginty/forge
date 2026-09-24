import { MAX_TABS_PER_PROJECT } from '@shared/ipc'
import { distance, listTerminals, resolveTerminal, type TerminalResolution } from '@shared/terminal-names'
import type { AgentProfile, SplitDirection } from '@shared/types'
import { skillHandler } from './skillbus'

/**
 * The things the voice agent is allowed to do to Forge.
 *
 * An `AppAction` is a plain, serialisable intent — never a closure — so it can
 * come from the deterministic grammar (`voicecommands.ts`) today or from a real
 * brain's structured output later, and be checked, logged or replayed either
 * way. The executor is the only place that touches the app, and it goes through
 * exactly the same `AppState` actions the buttons use: no back doors, no second
 * implementation of "open a tab".
 *
 * This module is pure: hand it a context snapshot and a runner and it tells you
 * what it did. That is what makes it testable without a renderer.
 */

export type AppAction =
  | { kind: 'open_tabs'; profileId: string; count: number; projectName?: string }
  | {
      kind: 'open_panes'
      profileId: string
      count: number
      direction?: SplitDirection
      /**
       * Split beside this pane rather than the focused one. Foreman sets it to
       * the pane it is driving, so a hire lands in that pane's project and tab
       * whatever the human is looking at by then.
       */
      anchorPaneId?: string
      /** A hire's name, when Foreman gave one: its tab's, so its first terminal's. */
      name?: string
    }
  /**
   * `which` is spoken, not an enum: 'focused' / 'current' still mean what they
   * always did, but "tab one", "the second one" and "notes" now work too. They
   * used to be the literal strings only, which is how "close tab one" ended up
   * being answered with *focus_tab* — the model had no closing action that
   * could take a number, so it reached for the one that could.
   */
  | { kind: 'close_pane'; which: string }
  | { kind: 'close_tab'; which: string }
  /** Bulk: "close all three tabs", "close everything", "close the kimi ones". */
  | { kind: 'close_tabs'; which: string }
  /** Make a folder and put it in the rail. Never picks a folder for him. */
  | { kind: 'create_project'; name: string; parentDir?: string }
  | { kind: 'rename_tab'; which: string; name: string }
  | { kind: 'set_view'; mode: 'tabs' | 'mosaic' }
  | { kind: 'open_settings'; section?: string }
  | { kind: 'switch_project'; name: string }
  | { kind: 'focus_tab'; index: number }
  | { kind: 'new_project_hint' }
  /** Real image generation. 1–4, each one a separate API call. */
  | { kind: 'make_image'; description: string; count: number; aspect?: string }
  | { kind: 'edit_image'; path: string; instruction: string }
  /**
   * Real video generation (Veo). One clip per call and it takes minutes, not
   * seconds, so there is deliberately no `count`.
   */
  | { kind: 'make_video'; description: string; aspect?: string; duration?: number }
  /**
   * Type `/<name>` into a pane, unsubmitted.
   *
   * Never submitted, deliberately: a skill is a long instruction the agent is
   * about to follow, and the last look at it belongs to Steve — so unlike
   * `send_prompt` there is no `submit` here at all, not even an opt-in.
   *
   * `target` is spoken and goes through the same `resolvePaneTarget` as
   * `send_prompt`: a terminal's name ("Zeb"), "the kimi one", or nothing at
   * all for the focused pane.
   */
  | { kind: 'use_skill'; name: string; target?: string }
  /**
   * Read this project's memory back, and wipe it.
   *
   * Grammar-only, both of them — deliberately absent from `ACTION_KINDS` and
   * the manifest, so a brain can neither claim to have recalled something nor
   * quietly delete what Steve told it to remember. He asks; only he asks.
   */
  | { kind: 'recall_memory' }
  | { kind: 'forget_memory' }
  /**
   * Hand a prompt to one of the open terminals — "in Zeb, build me a landing
   * page". `target` is spoken, not an id ("Zeb", "the claude one", "this"),
   * and is resolved by `resolvePaneTarget` below. `flesh` records
   * whether the brain expanded a half-sentence into a real brief, so the chip
   * can say so. `submit` false means type it and leave the Enter to Steve.
   */
  | { kind: 'send_prompt'; target: string; text: string; flesh?: boolean; submit?: boolean }
  /**
   * A new agent pane INSIDE Forge — the main agent's open_agent_pane tool
   * (shared/brain-tools.ts). `agent` is spoken ("codex", "the gemini one") and
   * matched like every profile; `prompt` is typed in once the agent is up.
   * Not in ACTION_SPECS: the JSON brains already have open_tabs.
   *
   * `anchorPaneId` is the pane that asked, when a pane agent asked: the new
   * agent then opens in that pane's project, never in whichever one Steve is
   * looking at by the time the call lands. Absent (voice, the hub), it is the
   * project on screen.
   *
   * `name` is the new terminal's name when the caller chose one ("Blue Car");
   * absent, it takes the next free tab name like a tab opened by hand.
   */
  | { kind: 'open_agent_pane'; agent: string; prompt?: string; name?: string; submit?: boolean; anchorPaneId?: string }

/** Image generation is the one thing here that cannot finish synchronously. */
export const MAX_GENERATED_IMAGES = 4

/** Veo's own limits, repeated here so an action is rejected before any spend. */
export const MIN_VIDEO_SECONDS = 4
export const MAX_VIDEO_SECONDS = 8
/** Veo accepts landscape and portrait only — not the image aspect list. */
export const VIDEO_ASPECT_RATIOS: readonly string[] = ['16:9', '9:16']

export interface ActionProject {
  id: string
  name: string
}

/**
 * One open terminal, as the agent sees it.
 *
 * `name` is the terminal's one name: its tab's ("Zeb"), or "Zeb 2" for a pane
 * split into that tab (shared/terminal-names.ts). It is what every brain is
 * shown and what every answer says.
 *
 * `number` is assigned by walking the tabs in order and the panes inside each
 * tab in order, which is exactly the order `buildManifest` prints. It is still
 * understood when said ("terminal two") but never printed.
 */
export interface ActionPane {
  paneId: string
  tabId: string
  tabNumber: number
  tabTitle: string
  /** 1-based, across every tab in the active project. */
  number: number
  /** The terminal's one name. */
  name: string
  profileId: string
  profileName: string
  /**
   * The shell can still be reached.
   *
   * Not "is on screen": Forge only mounts the *active* tab's panes, so a
   * terminal in a background tab has no xterm and no PTY until you visit it —
   * `idle`, not dead. Dispatching to it is perfectly legitimate; the runner
   * brings its tab forward and waits for the shell to come up. Only `exited`
   * and `error` mean there is nothing there to talk to.
   */
  live: boolean
  focused: boolean
  /**
   * Runs a coding agent rather than a bare prompt-less shell. Only these ever
   * get an Enter pressed for them.
   */
  agent: boolean
  /** Monotonic focus recency; 0 means "never focused this session". */
  lastFocusedAt: number
}

/** Everything the executor is allowed to know, snapshotted at call time. */
export interface ActionContext {
  projects: ActionProject[]
  profiles: AgentProfile[]
  defaultProfileId: string
  activeProjectId: string | null
  activeProjectName: string | null
  /** Projects whose saved workspace has been read off disk already. */
  loadedProjectIds: string[]
  tabs: Array<{ id: string; title: string }>
  activeTabId: string | null
  focusedPaneId: string | null
  /** Shells open across every project. */
  paneCount: number
  panesInActiveTab: number
  maxSessions: number
  maxPanesPerTab: number
  /** Every pane in the active project, in spoken-handle order. */
  panes?: ActionPane[]
  /** Settings.voiceAutoRelay — false means never press Enter for him. */
  autoRelay?: boolean
}

/** The UI actions the executor drives. Same ones the buttons call. */
export interface ActionRunner {
  newTab(profileId: string): void
  splitPane(paneId: string, direction: SplitDirection, profileId: string): void
  /**
   * Foreman's hires: a tab of their own beside the anchor pane's tab, in its
   * project. Optional because only Foreman's runner has it; without it an
   * anchored `open_panes` falls back to splitting the anchor's tab. Answers
   * how many panes it opened and a sentence about where — and the new panes'
   * ids, so the answer can name them before they are running.
   */
  hireTab?(
    anchorPaneId: string,
    profileId: string,
    count: number,
    name?: string
  ): { ok: boolean; done: number; summary: string; paneIds?: string[] }
  closePane(paneId: string): void
  closeTab(tabId: string): void
  selectProject(projectId: string): void
  selectTab(tabId: string): void
  renameTab?(tabId: string, title: string): void
  /** Rename a split pane — "Zeb 2" — which has a name of its own, not its tab's. */
  renamePane?(paneId: string, title: string): void
  setViewMode?(mode: 'tabs' | 'mosaic'): void
  openSettings?(section?: string): void
  /**
   * Media generation — optional, and asynchronous.
   *
   * Everything else in this file is a synchronous state change, which is what
   * keeps the executor pure and testable. Generating an image is a 6-second
   * network call, so these return a promise instead and the executor hands it
   * back on `ActionOutcome.pending` for the caller to await. A runner that does
   * not implement them (a test double, a head-less script) makes the action fail
   * honestly rather than silently doing nothing.
   */
  makeImage?(request: { description: string; count: number; aspect?: string }): Promise<ActionOutcome>
  editImage?(request: { path: string; instruction: string }): Promise<ActionOutcome>
  /**
   * Video is the same pattern as the two above but an order of magnitude
   * slower — one to three minutes of submit-poll-download. The provisional
   * summary says so, and exactly one final outcome replaces it.
   */
  makeVideo?(request: { description: string; aspect?: string; duration?: number }): Promise<ActionOutcome>
  /**
   * Project memory, which lives in a file the main process owns — so reading it
   * back and clearing it are IPC round trips, asynchronous like the media ones.
   * Neither costs a model call: the answer is read off disk.
   */
  recallMemory?(): Promise<ActionOutcome>
  forgetMemory?(): Promise<ActionOutcome>
  /**
   * Type a skill into an already-resolved pane. Synchronous, like the layout
   * actions — it types and returns; nothing is submitted and nothing is awaited.
   *
   * It is handed an `ActionPane` rather than a spoken target for the same reason
   * `sendPrompt` is: `resolvePaneTarget` has already refused to guess, so by the
   * time a runner sees this there is exactly one pane it can mean.
   *
   * Optional, and when a runner does not supply it the executor falls back to
   * whatever the renderer registered on `skillbus`. That indirection exists
   * because the runner is assembled inside VoicePanel while the thing that can
   * reach a terminal lives with the skills rail — see src/lib/skillbus.ts.
   */
  useSkill?(request: { name: string; pane: ActionPane }): ActionOutcome
  /**
   * Deliver a prompt to a pane. Asynchronous for the same reason the media
   * actions are, but for a nicer reason: when `submit` is true the caller holds
   * the text on screen for a grace beat first ("sending to Terminal 2… say
   * 'wait' to hold"), so the promise settles after Steve has had a chance to
   * stop it. With `submit` false it types and resolves at once.
   */
  sendPrompt?(request: {
    pane: ActionPane
    text: string
    submit: boolean
    /** Why it is not being submitted, when it is not. */
    holdReason?: string
    flesh?: boolean
  }): Promise<ActionOutcome>
  /**
   * Close several tabs at once, after a grace beat.
   *
   * Closing one tab is undoable in the sense that you can open another; closing
   * five kills five live agent sessions in one breath on the strength of one
   * misheard word. So bulk close borrows auto-relay's countdown: the chip says
   * what is about to happen and "wait" stops it.
   */
  closeMany?(request: { tabIds: string[]; label: string }): Promise<ActionOutcome>
  /**
   * A new tab running `profileId`, with `prompt` pasted in once the agent is
   * ready (AppState openAgentPane). `name` is the caller's name for it; absent,
   * it takes the next free tab name. Without this runner, open_agent_pane falls
   * back to newTab and the prompt is dropped, and says so.
   *
   * Answers the new pane's id and the name it ended up with ("Blue Car 2" when
   * "Blue Car" was taken) — or the id alone, from a runner that does not know
   * the name — or null when Forge refused to open one (the session or tab
   * limit). A runner that answers nothing is taken at its word.
   * `anchorPaneId` is passed on from the action — see open_agent_pane.
   */
  openAgentPane?(request: {
    profileId: string
    title: string
    prompt: string
    submit: boolean
    name?: string
    anchorPaneId?: string
  }): { paneId: string; name: string } | string | null | void
  /** Create a folder and add it to the rail. Main process does the creating. */
  createProject?(request: { name: string; parentDir?: string }): Promise<ActionOutcome>
}

export interface ActionOutcome {
  /** False when nothing happened — the summary then says why. */
  ok: boolean
  /** One human line: what actually happened, not what was asked for. */
  summary: string
  requested: number
  done: number
  /**
   * Set only by the asynchronous actions. The summary above is provisional
   * ("Generating…"); await this for the real one and replace it.
   */
  pending?: Promise<ActionOutcome>
  /** Absolute paths this action produced, once it has finished. */
  paths?: string[]
  /** The panes this action opened, by id — open_agent_pane and hires set it. */
  paneIds?: string[]
}

/* ------------------------------------------------------------- matching */

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Vowel-stripped, de-doubled skeleton: "kimmy" and "kimi" collapse together. */
function soundKey(s: string): string {
  return norm(s)
    .replace(/(.)\1+/g, '$1')
    .replace(/[aeiou]/g, '')
}

/** How close is close enough — short words get less rope. */
function closeEnough(a: string, b: string): boolean {
  if (!a || !b) return false
  const limit = Math.max(a.length, b.length) <= 4 ? 1 : 2
  if (distance(a, b) <= limit) return true
  const ka = soundKey(a)
  const kb = soundKey(b)
  return ka.length > 1 && kb.length > 1 && distance(ka, kb) <= 1
}

/** Spoken words that mean a built-in profile. Only used if that profile exists. */
const PROFILE_ALIASES: Record<string, string> = {
  shell: 'pwsh',
  powershell: 'pwsh',
  pwsh: 'pwsh',
  ps: 'pwsh',
  posh: 'pwsh',
  cc: 'claude',
  claudecode: 'claude',
  // norm() strips the space out of "open ai", so both spellings land here — and
  // "openai" must not be left to the sounds-close pass, which would otherwise
  // hand it to `opencode` (same first syllable, one edit apart once vowels go).
  openai: 'codex',
  cx: 'codex',
  ki: 'kimi',
  oc: 'opencode',
  // "deep seek" and "deepseek v4" both norm() down to something that is not the
  // profile id, and "v4" on its own is the shortest thing anyone will actually
  // say for it.
  deepseek: 'deepseek',
  deepseekv4: 'deepseek',
  ds: 'deepseek',
  v4: 'deepseek',
  // "glm 5.3" and "glm five three" both collapse here. "zai" is the company
  // name; it must not be left to the sounds-close pass, which would otherwise
  // have nothing useful to hand it to.
  glm: 'glm',
  glm5: 'glm',
  glm53: 'glm',
  glmfive: 'glm',
  glmfivethree: 'glm',
  zai: 'glm',
  // What dictation actually produces for "Qwen". These have to be spelled out
  // rather than left to the sounds-close pass, which hands "gwen" to `gemini`
  // (same first letter, one edit apart once the vowels go).
  qwin: 'qwen',
  gwen: 'qwen',
  quen: 'qwen',
  qw: 'qwen'
}

/** Resolve a spoken name to a profile: exact, prefix, then sounds-close. */
export function matchProfile(profiles: AgentProfile[], spoken: string): AgentProfile | null {
  const q = norm(spoken)
  if (!q) return null

  const aliasId = PROFILE_ALIASES[q]
  if (aliasId) {
    const hit = profiles.find((p) => p.id === aliasId)
    if (hit) return hit
  }

  for (const p of profiles) if (norm(p.badge) === q || norm(p.name) === q) return p
  if (q.length >= 3) {
    for (const p of profiles) {
      const n = norm(p.name)
      if (n.startsWith(q) || q.startsWith(n)) return p
    }
    // First word of a multi-word name: "claude" for "Claude Code".
    for (const p of profiles) {
      const first = norm(p.name.split(/\s+/)[0] ?? '')
      if (first && (first === q || first.startsWith(q) || q.startsWith(first))) return p
    }
    for (const p of profiles) if (closeEnough(q, norm(p.name))) return p
  }
  return null
}

/** Same idea for projects — they are named after folders, so sound matters. */
export function matchProject(projects: ActionProject[], spoken: string): ActionProject | null {
  const q = norm(spoken)
  if (!q) return null
  for (const p of projects) if (norm(p.name) === q) return p
  for (const p of projects) {
    const n = norm(p.name)
    if (n && (n.startsWith(q) || q.startsWith(n))) return p
  }
  for (const p of projects) if (closeEnough(q, norm(p.name))) return p
  return null
}

/* --------------------------------------------------------- pane targeting */

/**
 * Spoken words for "the one I am looking at".
 */
const THIS_PANE = new Set([
  'this',
  'here',
  'current',
  'focused',
  'it',
  'that',
  'thisone',
  'thispane',
  'thisterminal',
  'currentpane',
  'currentterminal',
  'activepane'
])

/** Nouns that mean "a terminal" when someone is naming one. */
const TARGET_NOUNS = new Set([
  'terminal',
  'terminals',
  'tab',
  'tabs',
  'pane',
  'panes',
  'window',
  'windows',
  'shell',
  'shells',
  'session',
  'sessions',
  'instance',
  'instances',
  'one',
  'the'
])

/** Nouns a bare "one" can be counting: "terminal one" is pane 1. */
const NUMBERABLE = new Set([
  'terminal',
  'terminals',
  'tab',
  'tabs',
  'pane',
  'panes',
  'window',
  'windows',
  'shell',
  'shells',
  'session',
  'sessions',
  'instance',
  'instances',
  'number'
])

const SPOKEN_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  last: -1
}

export type TargetResolution =
  | { kind: 'pane'; pane: ActionPane }
  /** Several equally good matches. Never guessed between — always asked about. */
  | { kind: 'ambiguous'; candidates: ActionPane[] }
  | { kind: 'none'; candidates: ActionPane[] }

function targetTokens(spoken: string): string[] {
  return spoken
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Resolve "Zeb" / "the claude one" / "this" / "terminal two" to exactly one pane.
 *
 * A terminal's name first — the one on its tab, the only one Steve sees — by
 * `resolveTerminal` (shared/terminal-names.ts), the resolver every tool uses.
 * What a name cannot settle goes to the handles below: a number, "this", the
 * agent running in it. Anything with two equally good answers comes back
 * `ambiguous` rather than picking one — sending a brief to the wrong agent is
 * worse than being asked which one.
 */
export function resolvePaneTarget(
  spoken: string,
  panes: ActionPane[],
  focusedPaneId: string | null
): TargetResolution {
  const all = panes ?? []
  if (all.length === 0) return { kind: 'none', candidates: [] }
  const hit = resolveTerminal(spoken ?? '', all, {
    fallback: () => asTerminal(resolveByHandle(spoken, all, focusedPaneId)),
    isKindWord: (word) => all.some((p) => namesAgent(p, word))
  })
  if (hit.kind === 'one') return { kind: 'pane', pane: hit.pane }
  if (hit.kind === 'ambiguous') return { kind: 'ambiguous', candidates: hit.matches }
  return { kind: 'none', candidates: all }
}

function asTerminal(r: TargetResolution): TerminalResolution<ActionPane> {
  if (r.kind === 'pane') return { kind: 'one', pane: r.pane }
  if (r.kind === 'ambiguous') return { kind: 'ambiguous', matches: r.candidates }
  return { kind: 'none' }
}

/** Exactly an agent word for this pane: its id, its name, that name's first word, or an alias. */
function namesAgent(pane: ActionPane, key: string): boolean {
  if (PROFILE_ALIASES[key] === pane.profileId) return true
  return key === norm(pane.profileId) || key === norm(pane.profileName) || key === norm(pane.profileName.split(/\s+/)[0] ?? '')
}

/**
 * Everything but a name: a number, "this", a bare noun, an agent word — what
 * `resolvePaneTarget` understood before terminals had names, kept because it is
 * still what people say ("terminal two", "the claude one").
 */
function resolveByHandle(spoken: string, all: ActionPane[], focusedPaneId: string | null): TargetResolution {

  const focused = all.find((p) => p.paneId === focusedPaneId) ?? all.find((p) => p.focused) ?? null
  const raw = (spoken ?? '').trim()
  const tokens = targetTokens(raw)

  if (tokens.length === 0) {
    return focused ? { kind: 'pane', pane: focused } : { kind: 'none', candidates: all }
  }

  /* --- a number: "terminal two", "tab 3", "the second one" ---------------
   *
   * "one" is the awkward word: "terminal one" is a number and "the claude one"
   * is not. It only counts as 1 directly after a noun that can be numbered, or
   * on its own.
   *
   * This runs *first*, ahead of the "this"/bare-noun branches, and that
   * ordering is the whole point. "one" has to live in TARGET_NOUNS so that
   * "the claude one" strips down to "claude" — but that same membership means
   * "terminal one" strips down to nothing at all, and a target with no
   * meaningful words used to fall through to "the pane he is looking at". Said
   * out loud with six terminals open, "in terminal one, <prompt>" delivered the
   * prompt to terminal six. Numbers are the one handle that cannot be misread,
   * so they are read before anything else gets a chance to be helpful.
   */
  let wanted: number | null = null
  for (const [i, t] of tokens.entries()) {
    if (/^\d+$/.test(t)) {
      wanted = Number(t)
      break
    }
    const spelledOut = SPOKEN_NUMBERS[t]
    if (spelledOut === undefined) continue
    if (t === 'one' && tokens.length > 1 && !NUMBERABLE.has(tokens[i - 1] ?? '')) continue
    wanted = spelledOut === -1 ? all.length : spelledOut
    break
  }
  if (wanted !== null) {
    const hit = all.find((p) => p.number === wanted)
    return hit ? { kind: 'pane', pane: hit } : { kind: 'none', candidates: all }
  }

  /* --- "this", "here", or a bare noun ------------------------------------ */
  const meaningful = tokens.filter((t) => !TARGET_NOUNS.has(t))
  if (meaningful.length > 0 && meaningful.every((t) => THIS_PANE.has(t))) {
    return focused ? { kind: 'pane', pane: focused } : { kind: 'none', candidates: all }
  }
  if (meaningful.length === 0) {
    // "the terminal" with exactly one open is unambiguous; otherwise ask.
    if (all.length === 1) return { kind: 'pane', pane: all[0]! }
    return focused ? { kind: 'pane', pane: focused } : { kind: 'ambiguous', candidates: all }
  }

  /* --- an agent: "the claude one", "the kimi pane" ----------------------- */
  const byAgent = all.filter((p) => meaningful.some((t) => matchesProfileWord(p, t)))
  if (byAgent.length === 1) return { kind: 'pane', pane: byAgent[0]! }
  if (byAgent.length > 1) return pickAmong(byAgent, focused)

  return { kind: 'none', candidates: all }
}

/**
 * Several matched. The one you are *in* is what "the claude one" means when you
 * are sitting in a Claude pane; failing that, the one you were in most recently.
 * If nothing has ever been focused there is no honest tie-break, so ask.
 */
function pickAmong(candidates: ActionPane[], focused: ActionPane | null): TargetResolution {
  if (focused && candidates.some((c) => c.paneId === focused.paneId)) {
    return { kind: 'pane', pane: focused }
  }
  const ranked = [...candidates].sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)
  const best = ranked[0]!
  const runnerUp = ranked[1]!
  if (best.lastFocusedAt > 0 && best.lastFocusedAt > runnerUp.lastFocusedAt) {
    return { kind: 'pane', pane: best }
  }
  return { kind: 'ambiguous', candidates }
}

/** Does one spoken word name the agent running in this pane? */
function matchesProfileWord(pane: ActionPane, word: string): boolean {
  const q = norm(word)
  if (q.length < 2) return false
  if (PROFILE_ALIASES[q] === pane.profileId) return true
  if (q === norm(pane.profileId)) return true
  const n = norm(pane.profileName)
  if (!n) return false
  if (n === q || n.startsWith(q) || q.startsWith(n)) return true
  const first = norm(pane.profileName.split(/\s+/)[0] ?? '')
  if (first && (first === q || first.startsWith(q))) return true
  return closeEnough(q, n)
}

/** "Zeb" — how a pane is named back to the user: its one name, nothing else. */
export function paneLabel(pane: ActionPane): string {
  return pane.name
}

/**
 * A terminal named outright — "Zeb 2" — by name alone: no numbers, no agent
 * words. The tab actions try it first, so a split pane's name reaches the pane
 * rather than prefix-matching its tab ("Zeb 2" is not "Zeb").
 */
function paneNamed(spoken: string, panes: ActionPane[]): ActionPane | null {
  const hit = resolveTerminal(spoken ?? '', panes)
  return hit.kind === 'one' ? hit.pane : null
}

/** The first pane in its tab — the one whose name is the tab's. */
function isTabsOwnPane(pane: ActionPane, panes: ActionPane[]): boolean {
  return panes.find((p) => p.tabId === pane.tabId)?.paneId === pane.paneId
}

/* ---------------------------------------------------------- tab targeting */

export interface ActionTab {
  id: string
  title: string
}

export type TabResolution =
  | { kind: 'tab'; tab: ActionTab; index: number }
  | { kind: 'ambiguous'; candidates: ActionTab[] }
  | { kind: 'none'; candidates: ActionTab[] }

/**
 * "tab one", "the second tab", "notes", "this".
 *
 * Same shape and same refusal to guess as `resolvePaneTarget`, because a
 * mis-resolved close is the one mistake here that destroys work.
 */
export function resolveTabTarget(spoken: string, tabs: ActionTab[], activeTabId: string | null): TabResolution {
  const all = tabs ?? []
  if (all.length === 0) return { kind: 'none', candidates: [] }
  const activeIndex = all.findIndex((t) => t.id === activeTabId)
  const active = activeIndex >= 0 ? all[activeIndex]! : null

  const tokens = targetTokens(spoken ?? '')
  const meaningful = tokens.filter((t) => !TARGET_NOUNS.has(t))
  const currentWord = (t: string): boolean => THIS_PANE.has(t) || t === 'current'

  if (tokens.length === 0 || (meaningful.length > 0 && meaningful.every(currentWord))) {
    return active ? { kind: 'tab', tab: active, index: activeIndex } : { kind: 'none', candidates: all }
  }
  if (meaningful.length === 0) {
    if (all.length === 1) return { kind: 'tab', tab: all[0]!, index: 0 }
    return active ? { kind: 'tab', tab: active, index: activeIndex } : { kind: 'ambiguous', candidates: all }
  }

  let wanted: number | null = null
  for (const [i, t] of tokens.entries()) {
    if (/^\d+$/.test(t)) {
      wanted = Number(t)
      break
    }
    const n = SPOKEN_NUMBERS[t]
    if (n === undefined) continue
    if (t === 'one' && tokens.length > 1 && !NUMBERABLE.has(tokens[i - 1] ?? '')) continue
    wanted = n === -1 ? all.length : n
    break
  }
  if (wanted !== null) {
    const tab = all[wanted - 1]
    return tab ? { kind: 'tab', tab, index: wanted - 1 } : { kind: 'none', candidates: all }
  }

  const q = norm(meaningful.join(' '))
  const exact = all.filter((t) => norm(t.title) === q)
  const hits = exact.length
    ? exact
    : all.filter((t) => {
        const n = norm(t.title)
        return n.length > 1 && (n.startsWith(q) || q.startsWith(n))
      })
  if (hits.length === 1) return { kind: 'tab', tab: hits[0]!, index: all.indexOf(hits[0]!) }
  if (hits.length > 1) return { kind: 'ambiguous', candidates: hits }
  return { kind: 'none', candidates: all }
}

/** "Zeb, Viggo" — candidates by name, for asking which. Tab numbers are never printed. */
function listTabs(tabs: ActionTab[]): string {
  return tabs
    .slice(0, 8)
    .map((t) => t.title)
    .join(', ')
}

/* ------------------------------------------------------------- executor */

function plural(n: number, one: string): string {
  return n === 1 ? one : `${one}s`
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function fail(summary: string, requested = 1): ActionOutcome {
  return { ok: false, summary, requested, done: 0 }
}

export function runAppAction(action: AppAction, ctx: ActionContext, run: ActionRunner): ActionOutcome {
  switch (action.kind) {
    case 'open_tabs': {
      const profile = ctx.profiles.find((p) => p.id === action.profileId)
      if (!profile) return fail('I do not know that agent')
      const requested = Math.max(1, Math.floor(action.count))

      // A named project means "over there" — but only once its saved layout has
      // been read, otherwise opening a tab would overwrite it.
      if (action.projectName) {
        const target = matchProject(ctx.projects, action.projectName)
        if (!target) return fail(`No project called “${action.projectName}”`, requested)
        if (target.id !== ctx.activeProjectId) {
          run.selectProject(target.id)
          if (!ctx.loadedProjectIds.includes(target.id)) {
            return {
              ok: true,
              summary: `Switched to ${target.name} — say that again to open ${plural(requested, 'tab')} there`,
              requested,
              done: 0
            }
          }
        }
      }

      if (!ctx.activeProjectId && !action.projectName) {
        return fail('No project open — add a folder with + in the rail first', requested)
      }

      // Two ceilings: the project's tab cap is the one people actually meet;
      // the app-wide session backstop still applies underneath it.
      const tabRoom = Math.max(0, MAX_TABS_PER_PROJECT - ctx.tabs.length)
      const sessionRoom = Math.max(0, ctx.maxSessions - ctx.paneCount)
      const room = Math.min(tabRoom, sessionRoom)
      const done = Math.min(requested, room)
      for (let i = 0; i < done; i++) run.newTab(profile.id)

      const ceiling =
        tabRoom <= sessionRoom
          ? `a project holds at most ${MAX_TABS_PER_PROJECT} tabs`
          : `session limit (${ctx.maxSessions}) reached`
      if (done === 0) {
        return { ok: false, summary: `${capitalise(ceiling)} — nothing opened`, requested, done }
      }
      if (done < requested) {
        return {
          ok: true,
          summary: `Opened ${done} of ${requested} ${profile.name} ${plural(requested, 'tab')} — ${ceiling}`,
          requested,
          done
        }
      }
      return {
        ok: true,
        summary: `Opened ${done} ${profile.name} ${plural(done, 'tab')}`,
        requested,
        done
      }
    }

    case 'open_panes': {
      const profile = ctx.profiles.find((p) => p.id === action.profileId)
      if (!profile) return fail('I do not know that agent')
      const requested = Math.max(1, Math.floor(action.count))
      let target = ctx.focusedPaneId
      let panesInTab = ctx.panesInActiveTab
      if (action.anchorPaneId && run.hireTab) {
        const wanted = String(action.name ?? '').trim()
        const hired = wanted
          ? run.hireTab(action.anchorPaneId, profile.id, requested, wanted)
          : run.hireTab(action.anchorPaneId, profile.id, requested)
        const ids = hired.paneIds ?? []
        return {
          ok: hired.ok,
          // The ids in the sentence itself: a hire is not running yet when this
          // answer goes back, so no list of live panes can name it.
          summary: ids.length ? `${hired.summary}. Pane ${plural(ids.length, 'id')}: ${ids.join(', ')}` : hired.summary,
          requested,
          done: hired.done,
          ...(ids.length ? { paneIds: ids } : {})
        }
      }
      if (action.anchorPaneId) {
        const anchor = ctx.panes?.find((p) => p.paneId === action.anchorPaneId)
        if (!anchor) return fail('The pane Foreman is driving is no longer open — nothing split', requested)
        target = anchor.paneId
        panesInTab = ctx.panes?.filter((p) => p.tabId === anchor.tabId).length ?? panesInTab
      }
      if (!target) {
        return fail('No pane to split — open a tab first', requested)
      }
      const room = Math.min(
        Math.max(0, ctx.maxSessions - ctx.paneCount),
        Math.max(0, ctx.maxPanesPerTab - panesInTab)
      )
      const done = Math.min(requested, room)
      const direction: SplitDirection = action.direction ?? 'row'
      for (let i = 0; i < done; i++) run.splitPane(target, direction, profile.id)

      if (done === 0) {
        return {
          ok: false,
          summary: `This tab is full (${ctx.maxPanesPerTab} panes) — nothing split`,
          requested,
          done
        }
      }
      if (done < requested) {
        return {
          ok: true,
          summary: `Split ${done} of ${requested} ${profile.name} ${plural(requested, 'pane')} — limit reached`,
          requested,
          done
        }
      }
      return { ok: true, summary: `Split ${done} ${profile.name} ${plural(done, 'pane')}`, requested, done }
    }

    case 'close_pane': {
      const which = (action.which ?? '').trim()
      const bare = !which || which === 'focused'
      if (bare) {
        if (!ctx.focusedPaneId) return fail('Nothing focused to close')
        run.closePane(ctx.focusedPaneId)
        return { ok: true, summary: 'Closed the focused pane', requested: 1, done: 1 }
      }
      const resolved = resolvePaneTarget(which, ctx.panes ?? [], ctx.focusedPaneId)
      if (resolved.kind === 'ambiguous') return fail(`Which one? ${listTerminals(resolved.candidates)}`)
      if (resolved.kind === 'none') {
        if (resolved.candidates.length === 0) return fail('No terminals open')
        return fail(`No terminal called “${which}”. Open now: ${listTerminals(resolved.candidates)}`)
      }
      run.closePane(resolved.pane.paneId)
      return { ok: true, summary: `Closed ${paneLabel(resolved.pane)}`, requested: 1, done: 1 }
    }

    case 'close_tab': {
      const which = (action.which ?? '').trim()
      // A terminal's name closes the tab it is in: "close Zeb 2" is Zeb's tab.
      const named = which && which !== 'current' ? paneNamed(which, ctx.panes ?? []) : null
      const owner = named ? ctx.tabs.findIndex((t) => t.id === named.tabId) : -1
      const resolved: TabResolution =
        owner >= 0
          ? { kind: 'tab', tab: ctx.tabs[owner]!, index: owner }
          : resolveTabTarget(which === 'current' ? '' : which, ctx.tabs, ctx.activeTabId)
      if (resolved.kind === 'ambiguous') {
        return fail(`Which tab? ${listTabs(resolved.candidates)}`)
      }
      if (resolved.kind === 'none') {
        if (ctx.tabs.length === 0) return fail('No tab open')
        return fail(`No tab called “${which}”. Open now: ${listTabs(ctx.tabs)}`)
      }
      run.closeTab(resolved.tab.id)
      return { ok: true, summary: `Closed “${resolved.tab.title}”`, requested: 1, done: 1 }
    }

    /**
     * "Close all three tabs." Bulk, and therefore deliberate: anything over one
     * tab goes through the runner's countdown so a misheard sentence can be
     * stopped before five live sessions die for it.
     */
    case 'close_tabs': {
      const which = (action.which ?? 'all').trim().toLowerCase()
      const tabs = ctx.tabs
      if (tabs.length === 0) return fail('No tabs open')

      let victims: ActionTab[]
      let label: string
      if (/\bother/.test(which)) {
        victims = tabs.filter((t) => t.id !== ctx.activeTabId)
        label = 'every other tab'
      } else if (which === 'all' || which === 'everything' || which === '' || /\ball\b|\bevery\b/.test(which)) {
        victims = [...tabs]
        label = 'every tab'
      } else {
        // A profile word: "close the kimi ones". A tab counts if any pane in it
        // runs that agent.
        const panes = ctx.panes ?? []
        const matched = new Set(
          panes.filter((p) => matchesProfileWord(p, which.replace(/\b(ones?|tabs?|terminals?|the)\b/g, '').trim())).map((p) => p.tabId)
        )
        victims = tabs.filter((t) => matched.has(t.id))
        label = `the ${which} tabs`
        if (victims.length === 0) return fail(`No tabs are running “${which}”`)
      }

      if (victims.length === 0) return fail('Nothing to close')
      if (victims.length === 1) {
        run.closeTab(victims[0]!.id)
        return { ok: true, summary: `Closed “${victims[0]!.title}”`, requested: 1, done: 1 }
      }
      if (!run.closeMany) return fail('Closing several at once is not available here')
      return {
        ok: true,
        summary: `Closing ${victims.length} tabs (${label})… say “wait” to stop`,
        requested: victims.length,
        done: 0,
        pending: run.closeMany({ tabIds: victims.map((t) => t.id), label })
      }
    }

    case 'rename_tab': {
      const name = action.name.trim()
      if (!name) return fail('No new name given')
      // A terminal's name first. A split pane ("Zeb 2") has a name of its own
      // and is renamed on its own; the first pane in a tab is named by its tab.
      const panes = ctx.panes ?? []
      const named = action.which && action.which !== 'current' ? paneNamed(action.which, panes) : null
      if (named && !isTabsOwnPane(named, panes)) {
        if (!run.renamePane) return fail('Renaming is not available here')
        run.renamePane(named.paneId, name)
        return { ok: true, summary: `Renamed “${named.name}” to “${name}”`, requested: 1, done: 1 }
      }
      const owner = named ? ctx.tabs.findIndex((t) => t.id === named.tabId) : -1
      const resolved: TabResolution =
        owner >= 0
          ? { kind: 'tab', tab: ctx.tabs[owner]!, index: owner }
          : resolveTabTarget(action.which === 'current' ? '' : action.which, ctx.tabs, ctx.activeTabId)
      if (resolved.kind === 'ambiguous') return fail(`Which tab? ${listTabs(resolved.candidates)}`)
      if (resolved.kind === 'none') return fail(ctx.tabs.length ? `No tab called “${action.which}”` : 'No tab open')
      if (!run.renameTab) return fail('Renaming is not available here')
      run.renameTab(resolved.tab.id, name)
      return { ok: true, summary: `Renamed “${resolved.tab.title}” to “${name}”`, requested: 1, done: 1 }
    }

    case 'set_view': {
      if (!run.setViewMode) return fail('Switching the view is not available here')
      run.setViewMode(action.mode)
      return {
        ok: true,
        summary: action.mode === 'mosaic' ? 'Showing the Wall — every terminal at once' : 'Full screen — one terminal at a time',
        requested: 1,
        done: 1
      }
    }

    case 'open_settings': {
      if (!run.openSettings) return fail('Settings cannot be opened from here')
      run.openSettings(action.section)
      return {
        ok: true,
        summary: action.section ? `Opened Settings — ${action.section}` : 'Opened Settings',
        requested: 1,
        done: 1
      }
    }

    case 'create_project': {
      const name = action.name.trim()
      if (!name) return fail('No name — what should the project be called?')
      if (!run.createProject) return fail('Creating projects is not available here')
      const request: { name: string; parentDir?: string } = { name }
      if (action.parentDir) request.parentDir = action.parentDir
      return {
        ok: true,
        summary: `Creating “${name}”…`,
        requested: 1,
        done: 0,
        pending: run.createProject(request)
      }
    }

    case 'switch_project': {
      const target = matchProject(ctx.projects, action.name)
      if (!target) return fail(`No project called “${action.name}”`)
      if (target.id === ctx.activeProjectId) {
        return { ok: true, summary: `Already in ${target.name}`, requested: 1, done: 0 }
      }
      run.selectProject(target.id)
      return { ok: true, summary: `Switched to ${target.name}`, requested: 1, done: 1 }
    }

    case 'focus_tab': {
      const tab = ctx.tabs[action.index]
      if (!tab) {
        return fail(
          ctx.tabs.length === 0 ? 'No tabs open' : `There is no tab ${action.index + 1} — ${ctx.tabs.length} open`
        )
      }
      run.selectTab(tab.id)
      return { ok: true, summary: `Switched to “${tab.title}”`, requested: 1, done: 1 }
    }

    case 'new_project_hint':
      // Deliberately no folder picker from voice: choosing a folder is a
      // deliberate, sighted act.
      return {
        ok: true,
        summary: 'Use + at the top of the projects rail to add a folder — I will not pick one for you',
        requested: 1,
        done: 0
      }

    case 'make_image': {
      const description = action.description.trim()
      if (!description) return fail('No description — I will not generate a picture of nothing')
      if (!run.makeImage) return fail('Image generation is not available here')
      const requested = Math.min(MAX_GENERATED_IMAGES, Math.max(1, Math.floor(action.count || 1)))
      const request: { description: string; count: number; aspect?: string } = { description, count: requested }
      if (action.aspect) request.aspect = action.aspect
      return {
        ok: true,
        summary: `Generating ${requested} ${plural(requested, 'image')}…`,
        requested,
        done: 0,
        pending: run.makeImage(request)
      }
    }

    case 'edit_image': {
      const path = action.path.trim()
      const instruction = action.instruction.trim()
      if (!path) return fail('No image to edit — give me the file path')
      if (!instruction) return fail('No instruction — tell me what to change')
      if (!run.editImage) return fail('Image editing is not available here')
      return {
        ok: true,
        summary: 'Editing the image…',
        requested: 1,
        done: 0,
        pending: run.editImage({ path, instruction })
      }
    }

    /**
     * "Use the release checklist in terminal two."
     *
     * Shares `send_prompt`'s target resolution exactly — same spoken handles,
     * same refusal to guess between two panes — because the two actions differ
     * only in what gets typed, and having "terminal two" mean one pane for a
     * prompt and another for a skill would be indefensible.
     *
     * Where it does NOT follow send_prompt is Enter: a skill is never submitted,
     * whatever auto-relay says. It is a long instruction the agent is about to
     * act on, and the last look at it is Steve's.
     */
    case 'use_skill': {
      const name = action.name.trim().replace(/^\//, '')
      if (!name) return fail('Which skill?')

      const resolved = resolvePaneTarget(action.target ?? '', ctx.panes ?? [], ctx.focusedPaneId)
      if (resolved.kind === 'none') {
        if (resolved.candidates.length === 0) return fail('No terminals open — say “open a claude terminal” first')
        return fail(`No terminal called “${action.target}”. Open now: ${listTerminals(resolved.candidates)}`)
      }
      if (resolved.kind === 'ambiguous') return fail(`Which one? ${listTerminals(resolved.candidates)}`)

      const pane = resolved.pane
      if (!pane.live) return fail(`${paneLabel(pane)}’s shell has exited — nothing to type it into`)

      const runSkill = run.useSkill ?? skillHandler()
      if (!runSkill) return fail('Skills are not available here')
      return runSkill({ name, pane })
    }

    case 'make_video': {
      const description = action.description.trim()
      if (!description) return fail('No description — I will not generate a video of nothing')
      if (!run.makeVideo) return fail('Video generation is not available here')
      if (action.aspect && !VIDEO_ASPECT_RATIOS.includes(action.aspect)) {
        return fail(`Video has to be ${VIDEO_ASPECT_RATIOS.join(' or ')} — landscape or portrait`)
      }
      if (
        action.duration !== undefined &&
        (!Number.isFinite(action.duration) || action.duration < MIN_VIDEO_SECONDS || action.duration > MAX_VIDEO_SECONDS)
      ) {
        return fail(`Video has to be ${MIN_VIDEO_SECONDS}–${MAX_VIDEO_SECONDS} seconds long`)
      }
      const request: { description: string; aspect?: string; duration?: number } = { description }
      if (action.aspect) request.aspect = action.aspect
      if (action.duration !== undefined) request.duration = action.duration
      return {
        ok: true,
        summary: 'Rendering video… (can take a couple of minutes)',
        requested: 1,
        done: 0,
        pending: run.makeVideo(request)
      }
    }

    case 'recall_memory': {
      if (!ctx.activeProjectId) return fail('No project open — there is nothing for me to remember yet')
      if (!run.recallMemory) return fail('Project memory is not available here')
      return {
        ok: true,
        summary: 'Reading what I remember…',
        requested: 1,
        done: 0,
        pending: run.recallMemory()
      }
    }

    case 'forget_memory': {
      if (!ctx.activeProjectId) return fail('No project open — there is no memory to forget')
      if (!run.forgetMemory) return fail('Project memory is not available here')
      return {
        ok: true,
        summary: 'Forgetting…',
        requested: 1,
        done: 0,
        pending: run.forgetMemory()
      }
    }

    /**
     * The free-flow one: "in Zeb, build me a landing page".
     *
     * Three rules, in order of how much damage getting them wrong would do:
     *   1. Never guess between two panes — ask, and list them by name.
     *   2. Never press Enter in a plain shell. A misheard sentence typed at a
     *      PowerShell prompt is a command; at a coding agent it is a question.
     *   3. Never press Enter at all unless Settings says to (voiceAutoRelay).
     * Everything that is not submitted is still typed in, ready for him.
     */
    case 'send_prompt': {
      const text = action.text.trim()
      const panes = ctx.panes ?? []
      const resolved = resolvePaneTarget(action.target, panes, ctx.focusedPaneId)

      if (resolved.kind === 'none') {
        if (resolved.candidates.length === 0) return fail('No terminals open — say “open a claude terminal” first')
        return fail(`No terminal called “${action.target}”. Open now: ${listTerminals(resolved.candidates)}`)
      }
      if (resolved.kind === 'ambiguous') {
        return fail(`Which one? ${listTerminals(resolved.candidates)}`)
      }

      const pane = resolved.pane
      if (!text) return fail(`Nothing to send to ${paneLabel(pane)} — the prompt is empty`)
      if (!pane.live) return fail(`${paneLabel(pane)}’s shell has exited — nothing to send it to`)
      if (!run.sendPrompt) return fail('Sending prompts is not available here')

      const wanted = action.submit !== false
      let holdReason: string | undefined
      if (!wanted) holdReason = 'you asked me not to send it'
      else if (!pane.agent) holdReason = 'it is a plain shell, so I will not press Enter for you'
      else if (!ctx.autoRelay) holdReason = 'auto-relay is off in Settings'
      const submit = wanted && pane.agent && ctx.autoRelay === true

      const request: Parameters<NonNullable<ActionRunner['sendPrompt']>>[0] = { pane, text, submit }
      if (holdReason) request.holdReason = holdReason
      if (action.flesh !== undefined) request.flesh = action.flesh

      return {
        ok: true,
        summary: submit
          ? `Sending to ${paneLabel(pane)}… say “wait” to hold`
          : `Typing into ${paneLabel(pane)} — ${holdReason}`,
        requested: 1,
        done: 0,
        pending: run.sendPrompt(request)
      }
    }

    case 'open_agent_pane': {
      const said = String(action.agent ?? '').trim()
      const profile =
        ctx.profiles.find((p) => p.id === said.toLowerCase()) ?? (said ? matchProfile(ctx.profiles, said) : null)
      if (!profile) {
        const names = ctx.profiles.map((p) => p.name).join(', ')
        return fail(`No agent called “${said || '(none given)'}”. Agents here: ${names || 'none configured'}`)
      }
      if (!ctx.activeProjectId) return fail('No project open — add a folder with + in the rail first')
      if (ctx.tabs.length >= MAX_TABS_PER_PROJECT) {
        return fail(`A project holds at most ${MAX_TABS_PER_PROJECT} tabs — close one first`)
      }
      if (ctx.paneCount >= ctx.maxSessions) return fail(`Session limit (${ctx.maxSessions}) reached — close a pane first`)
      const prompt = String(action.prompt ?? '').trim()
      const name = String(action.name ?? '').trim()
      // Enter only for a real agent, and only when asked: a plain shell runs
      // what it is given.
      const submit = action.submit === true && profile.command.trim() !== ''
      // An anchored open always goes through openAgentPane, prompt or not: it
      // is the runner that knows which project the anchor pane lives in, and
      // newTab only ever opens in the one on screen.
      const anchor = String(action.anchorPaneId ?? '').trim()
      if ((prompt || anchor) && run.openAgentPane) {
        const opened = run.openAgentPane({
          profileId: profile.id,
          title: name || profile.name,
          prompt,
          submit,
          ...(name ? { name } : {}),
          ...(anchor ? { anchorPaneId: anchor } : {})
        })
        if (opened === null) {
          return fail(`Forge refused to open a ${profile.name} pane — the session or tab limit is reached, or its project is not open`)
        }
        const paneId = typeof opened === 'string' ? opened : opened?.paneId
        // The name it ended up with, which is not always the one asked for:
        // "Blue Car" already taken makes this one "Blue Car 2".
        const called = (typeof opened === 'object' ? opened?.name : '') || name
        return {
          ok: true,
          summary: `Opened ${called ? `${called} (${profile.name})` : `a new ${profile.name} pane`} inside Forge${paneId ? ` (pane id ${paneId})` : ''}${prompt ? ` — the prompt goes in when it is ready${submit ? ' and is sent' : ', unsent'}` : ''}`,
          requested: 1,
          done: 1,
          ...(paneId ? { paneIds: [paneId] } : {})
        }
      }
      run.newTab(profile.id)
      return {
        ok: true,
        summary: `Opened a new ${profile.name} pane inside Forge${name ? ` (it could not be named “${name}” here — rename it with rename_tab)` : ''}${prompt ? ' (the prompt could not be typed here — send it with type_into_pane)' : ''}`,
        requested: 1,
        done: 1
      }
    }

    default:
      return fail('I did not understand that')
  }
}
