import type { GitSnapshot } from '@shared/types'
import type { NavPane } from '../hubnav'

/**
 * The live app manifest every Agent brain is handed: compact, current, and
 * re-sent only when it changed.
 *
 * Fields, in the order the model reads them (named in b7-api.md):
 *   project   — the open project, its git branch when known, the other projects
 *   tabs      — number, title, which is current
 *   panes     — call-sign, panel number, tab, agent type (the profile name —
 *               Claude Code, Codex, Gemini, GLM…), state word (working / ready /
 *               asking / starting / exited), FOCUSED on the active one
 * The last lines of a pane are NOT here — that is read_pane, on demand.
 *
 * ~40 tokens a pane; a busy 12-pane project is well under 1k. The Claude
 * session gets it prepended to a turn when it differs from the last one it saw
 * (VoiceAgent); a realtime session gets it at start, at rollover, and — at most
 * every CONTEXT_MIN_GAP_MS — when it changes (VoiceHubController).
 */

export const CONTEXT_MIN_GAP_MS = 20_000

export type PaneStateWord = 'working' | 'ready' | 'asking' | 'starting' | 'idle' | 'exited'

export interface ContextPane extends NavPane {
  state: PaneStateWord
}

export interface AppContextInput {
  projectName: string | null
  otherProjects: string[]
  branch: string | null
  tabs: Array<{ number: number; title: string; active: boolean }>
  panes: ContextPane[]
}

export function buildAppContext(input: AppContextInput): string {
  const lines: string[] = ['# FORGE RIGHT NOW (live app state; it replaces any earlier one)']
  if (!input.projectName) {
    lines.push('project: none open')
  } else {
    lines.push(`project: ${input.projectName}${input.branch ? ` · branch ${input.branch}` : ''}`)
  }
  if (input.otherProjects.length) lines.push(`other projects: ${input.otherProjects.slice(0, 12).join(', ')}`)
  if (!input.tabs.length) {
    lines.push('tabs: none')
  } else {
    lines.push(
      `tabs (not on screen — say call-signs, never "tab 2"): ${input.tabs.map((t) => `${t.number} "${t.title}"${t.active ? ' [current]' : ''}`).join(', ')}`
    )
  }
  if (!input.panes.length) {
    lines.push('panes: none — open one with open_agent_pane')
  } else {
    lines.push('panes (call-sign, panel, tab, agent, state):')
    for (const p of input.panes) {
      const name = p.callSign ?? `Panel ${p.number}`
      const agent = p.agent ? p.profileName : `${p.profileName} (plain shell)`
      lines.push(`- ${name} · panel ${p.number} · tab ${p.tabNumber} · ${agent} · ${p.state}${p.focused ? ' · FOCUSED' : ''}`)
    }
  }
  return lines.join('\n')
}

/* ---------------------------------------------------------------- branch */

/** The newest git snapshot per project, from whatever watch the rail runs. */
const branches = new Map<string, GitSnapshot>()
let listening = false

function listen(): void {
  if (listening) return
  const git = (window as unknown as { forge?: { git?: { onSnapshot?: (cb: (s: GitSnapshot) => void) => () => void } } }).forge?.git
  if (!git?.onSnapshot) return
  listening = true
  git.onSnapshot((s) => {
    const held = branches.get(s.projectId)
    if (!held || s.seq >= held.seq) branches.set(s.projectId, s)
  })
}

export function projectBranch(projectId: string | null): string | null {
  listen()
  if (!projectId) return null
  const snap = branches.get(projectId)
  if (!snap || snap.presence !== 'ok') return null
  return snap.detached ? 'detached' : snap.branch
}

/* ---------------------------------------------------------- send on change */

/**
 * Remembers what a brain was last told, so a turn only carries the manifest
 * when it changed. One per brain session; `reset()` when the session restarts.
 */
export class ContextTracker {
  private last = ''
  private lastAt = 0

  /** The text to send, or null when the brain already has this exact state. */
  take(current: string, now = Date.now(), minGapMs = 0): string | null {
    if (current === this.last) return null
    if (minGapMs && now - this.lastAt < minGapMs) return null
    this.last = current
    this.lastAt = now
    return current
  }

  reset(): void {
    this.last = ''
    this.lastAt = 0
  }
}
