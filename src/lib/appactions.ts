import type { AgentProfile, SplitDirection } from '@shared/types'

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
  | { kind: 'open_panes'; profileId: string; count: number; direction?: SplitDirection }
  | { kind: 'close_pane'; which: 'focused' }
  | { kind: 'close_tab'; which: 'current' }
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
   * Read this project's memory back, and wipe it.
   *
   * Grammar-only, both of them — deliberately absent from `ACTION_KINDS` and
   * the manifest, so a brain can neither claim to have recalled something nor
   * quietly delete what Steve told it to remember. He asks; only he asks.
   */
  | { kind: 'recall_memory' }
  | { kind: 'forget_memory' }

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
}

/** The UI actions the executor drives. Same ones the buttons call. */
export interface ActionRunner {
  newTab(profileId: string): void
  splitPane(paneId: string, direction: SplitDirection, profileId: string): void
  closePane(paneId: string): void
  closeTab(tabId: string): void
  selectProject(projectId: string): void
  selectTab(tabId: string): void
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

function distance(a: string, b: string): number {
  if (a === b) return 0
  const rows = a.length + 1
  const cols = b.length + 1
  let prev = new Array<number>(cols)
  let curr = new Array<number>(cols)
  for (let j = 0; j < cols; j++) prev[j] = j
  for (let i = 1; i < rows; i++) {
    curr[0] = i
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[cols - 1]!
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
  ki: 'kimi'
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

/* ------------------------------------------------------------- executor */

function plural(n: number, one: string): string {
  return n === 1 ? one : `${one}s`
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

      const room = Math.max(0, ctx.maxSessions - ctx.paneCount)
      const done = Math.min(requested, room)
      for (let i = 0; i < done; i++) run.newTab(profile.id)

      if (done === 0) {
        return { ok: false, summary: `Session limit (${ctx.maxSessions}) reached — nothing opened`, requested, done }
      }
      if (done < requested) {
        return {
          ok: true,
          summary: `Opened ${done} of ${requested} ${profile.name} ${plural(requested, 'tab')} — session limit (${ctx.maxSessions}) reached`,
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
      if (!ctx.focusedPaneId) {
        return fail('No pane to split — open a tab first', requested)
      }
      const room = Math.min(
        Math.max(0, ctx.maxSessions - ctx.paneCount),
        Math.max(0, ctx.maxPanesPerTab - ctx.panesInActiveTab)
      )
      const done = Math.min(requested, room)
      const direction: SplitDirection = action.direction ?? 'row'
      for (let i = 0; i < done; i++) run.splitPane(ctx.focusedPaneId, direction, profile.id)

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
      if (!ctx.focusedPaneId) return fail('Nothing focused to close')
      run.closePane(ctx.focusedPaneId)
      return { ok: true, summary: 'Closed the focused pane', requested: 1, done: 1 }
    }

    case 'close_tab': {
      if (!ctx.activeTabId) return fail('No tab open')
      const tab = ctx.tabs.find((t) => t.id === ctx.activeTabId)
      run.closeTab(ctx.activeTabId)
      return { ok: true, summary: `Closed ${tab ? `“${tab.title}”` : 'the tab'}`, requested: 1, done: 1 }
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

    default:
      return fail('I did not understand that')
  }
}
