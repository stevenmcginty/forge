import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { agentLogoFor } from '@shared/agent-logos'
import { isShellProfile, resolveProfile } from '@shared/agents'
import type { AgentStatus, MiniBarAgent, MiniBarCall, MiniBarState, MiniBarTarget } from '@shared/minibar'
import { collectLeaves } from '@shared/splitTree'
import { paneNameInTab } from '@shared/workspace'
import { barTarget, setBarTarget, useBarTarget } from '@/components/hub/barMode'
import { hubAsk, useHubView } from '@/components/hub/hubView'
import { barDraft, setBarDraft } from '@/lib/barDraft'
import { barSend, whenPaneReady } from '@/lib/barSend'
import { setMiniBox } from '@/lib/miniBarDictation'
import { activityOf } from '@/lib/paneActivity'
import { terminalHost, type PaneRuntime } from '@/lib/terminals'
import { useApp, type AppState } from '@/state/AppState'
import { agentReplyLine, isShellPrompt, useMiniNews } from './minibar/news'
import { useMiniVoice } from './minibar/voice'

/**
 * The mini bar's host (docs/MINI-BAR.md, 2 and 5.3-5.4): the main window's
 * renderer, which keeps running while Forge is minimised, is the only writer
 * of MiniBarState. The #minibar window is a view; main relays state to it and
 * its calls back here.
 *
 * Off (Forge is up) it holds nothing and publishes nothing. On (main says the
 * window was minimised) it publishes on every change, at most ten times a
 * second, and at least every 1.5 s even when nothing changed, so the view can
 * tell a stuck host from a quiet one. Timers, never requestAnimationFrame: a
 * minimised window may stop drawing frames.
 *
 * The hand-off: at minimise the big bar's words (lib/barDraft) and its target
 * (barMode) go to the bar; at restore the bar's last words come back. The
 * target needs no hand-back: picking an agent in the bar reveals its pane, so
 * the big window opens on the pane the bar was talking to.
 *
 * Two parts own their own fields and calls (src/state/minibar): voice.ts and
 * news.ts. Their slices are merged over the host's, and each call is offered
 * to them first.
 */

/** At most one publish per this long. */
const THROTTLE_MS = 100
/** A publish at least this often, change or not (the view gives up after 6 s). */
const HEARTBEAT_MS = 1500
/** How much of a pane's screen is read for its last line. */
const LINE_ROWS = 40
const LINE_MAX = 200

let rev = 0

export function MiniBarHost(): ReactNode {
  const { state } = useApp()
  const [on, setOn] = useState(false)
  /** The bar's words: the big bar's at minimise, then whatever the view last reported. */
  const draft = useRef('')

  useEffect(() => {
    const host = window.forge.minibarHost
    if (typeof host?.onMode !== 'function') return undefined
    let current = false
    return host.onMode((m) => {
      const next = m?.on === true
      if (next === current) return
      current = next
      // A draft from main: this host reloaded while the bar was up, and those
      // are the bar's words; otherwise the big bar's are handed over.
      if (next) draft.current = typeof m.draft === 'string' ? m.draft : barDraft()
      else setBarDraft(draft.current)
      setOn(next)
    })
  }, [])

  // The master switch (Settings, `miniBar`): off, and the host stays empty even
  // if a mode message slips through — no publishing, no news, no chimes.
  return on && state.settings.miniBar === true ? <Live draft={draft} /> : null
}

/* ----------------------------------------------------------- while it is on */

function Live({ draft }: { draft: MutableRefObject<string> }): null {
  const { state, actions } = useApp()
  const hub = useHubView()
  const target = useBarTarget()
  const voice = useMiniVoice()
  const news = useMiniNews()
  /**
   * The draft as published. It moves only when the host means the view to
   * take it — the hand-off, picked paths, words that could not be sent — never
   * to echo what the view itself reported.
   */
  const [out, setOut] = useState(() => draft.current)

  const live = useRef({ state, actions, hub })
  live.current = { state, actions, hub }

  /* ---- what to publish ---- */

  const build = (): MiniBarState => {
    const paneId = activePaneOf(state)
    const aim: MiniBarTarget = target === 'forge' || !paneId ? { kind: 'forge' } : { kind: 'pane', paneId }
    const agents = agentsOf(state)
    const active = state.projects.find((p) => p.id === state.activeProjectId) ?? null
    const own: MiniBarState = {
      rev: 0,
      at: 0,
      look: lookOf(),
      project: active ? { id: active.id, name: active.name } : null,
      projects: state.projects.map((p) => ({
        id: p.id,
        name: p.name,
        running: agents.filter((a) => a.projectId === p.id && isRunning(a.paneId)).length
      })),
      agents,
      target: aim,
      draft: out,
      dictation: { phase: 'off' },
      listen: { on: false, speaking: false, muted: false },
      keymap: [],
      talkKeys: { dictate: '', listen: '' },
      events: [],
      unseen: 0,
      toasts: [],
      peek: null,
      thread: [],
      speakUpdates: state.settings.miniSpeakUpdates !== false,
      tucked: state.settings.miniBarTucked === true
    }
    return { ...own, ...voice.slice, ...news.slice }
  }
  const buildRef = useRef(build)
  buildRef.current = build

  /* ---- publishing: on change (throttled) and on a heartbeat ---- */

  const timer = useRef(0)
  const last = useRef(0)
  const publish = useCallback((): void => {
    timer.current = 0
    last.current = Date.now()
    rev += 1
    window.forge.minibarHost?.publish?.({ ...buildRef.current(), rev, at: last.current })
  }, [])
  const schedule = useCallback((): void => {
    if (timer.current) return
    timer.current = window.setTimeout(publish, Math.max(0, last.current + THROTTLE_MS - Date.now()))
  }, [publish])

  // Every render is a possible change: settings, projects, panes, the hub, the target.
  useEffect(() => {
    schedule()
  })

  // Pane state moves without a render here; the heartbeat also refreshes the last lines.
  useEffect(() => {
    const offs = [terminalHost.subscribeBusy(schedule), terminalHost.subscribeAttention(schedule)]
    const beat = window.setInterval(schedule, HEARTBEAT_MS)
    return () => {
      offs.forEach((off) => off())
      window.clearInterval(beat)
      window.clearTimeout(timer.current)
      timer.current = 0
    }
  }, [schedule])

  /* ---- the view's calls ---- */

  const send = (text: string): void => {
    const message = text.replace(/\s+$/, '')
    if (!message.trim()) return
    // The view cleared its box with the send; a restore now must not bring the words back.
    draft.current = ''
    const { state: s } = live.current
    const paneId = activePaneOf(s)
    const toForge = barTarget() === 'forge' || !paneId
    const giveBack = (): void => {
      draft.current = message
      setOut(message)
    }
    const go = (): void => {
      const sent = barSend(message, { paneId, toForge, ask: (m) => hubAsk(live.current.hub, m, 'typed') })
      if (sent === 'failed') giveBack()
    }
    if (toForge || !paneId) return go()
    // A brand-new agent is not listening yet: never paste into the shell under it.
    void whenPaneReady(paneId, isShellPane(s, paneId)).then((ready) => (ready ? go() : giveBack()))
  }

  /** Make `paneId` the app's current pane, in whichever project it lives. */
  const reveal = (paneId: string): boolean => {
    const { state: s, actions: a } = live.current
    const projectId = projectOfPane(s, paneId)
    if (!projectId) return false
    if (s.activeProjectId !== projectId) a.selectProject(projectId)
    a.revealPane(paneId)
    return true
  }

  const addPaths = (paths: string[]): void => {
    const clean = paths.filter((p) => typeof p === 'string' && p.length > 0)
    if (clean.length === 0) return
    const quoted = clean.map((p) => `"${p}"`).join(' ')
    const before = draft.current
    const gap = before && !/\s$/.test(before) ? ' ' : ''
    const next = `${before}${gap}${quoted} `
    draft.current = next
    setOut(next)
  }

  const handle = (c: MiniBarCall): void => {
    if (voice.handle(c) || news.handle(c)) return
    const { state: s, actions: a } = live.current
    switch (c.t) {
      case 'send':
        send(c.text)
        return
      case 'setDraft':
        draft.current = typeof c.text === 'string' ? c.text : ''
        return
      case 'target':
        if (c.to.kind === 'forge') setBarTarget('forge')
        else if (reveal(c.to.paneId)) setBarTarget('pane')
        return
      case 'project':
        if (s.projects.some((p) => p.id === c.id) && s.activeProjectId !== c.id) a.selectProject(c.id)
        return
      case 'reveal':
        reveal(c.paneId)
        return
      case 'newAgent':
        // Ctrl+T opens a chooser in a window nobody can see; this is the phone's
        // "create-tab" instead: the project's default agent, as a new tab.
        if (s.activeProjectId) a.newTab()
        return
      case 'stop':
        // The phone's Stop: one ESC, the agent's own interrupt.
        if (terminalHost.has(c.paneId)) window.forge.pty.write(c.paneId, '\x1b')
        return
      case 'paths':
        addPaths(Array.isArray(c.paths) ? c.paths : [])
        return
      case 'tuck':
        a.patchSettings({ miniBarTucked: c.on === true })
        return
      default:
        return
    }
  }
  const handleRef = useRef(handle)
  handleRef.current = handle

  // Dictation's way into the mini bar's box (src/lib/miniBarDictation.ts).
  useEffect(
    () =>
      setMiniBox({
        text: () => draft.current,
        setText: (text) => {
          draft.current = text
          setOut(text)
        },
        send: (text) => handleRef.current({ t: 'send', text })
      }),
    []
  )

  useEffect(() => {
    const host = window.forge.minibarHost
    if (typeof host?.onCall !== 'function') return undefined
    return host.onCall((c) => {
      if (c && typeof c === 'object' && typeof c.t === 'string') handleRef.current(c)
    })
  }, [])

  return null
}

/* ----------------------------------------------------------------- readers */

/** The host's <html> data-* attributes, as they are (theme and look). */
function lookOf(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(document.documentElement.dataset)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function activePaneOf(state: AppState): string | null {
  const ws = state.activeProjectId ? state.workspaces[state.activeProjectId] : undefined
  const tab = ws?.tabs.find((t) => t.id === ws.activeTabId)
  return tab?.activePaneId ?? null
}

function projectOfPane(state: AppState, paneId: string): string | null {
  for (const [projectId, ws] of Object.entries(state.workspaces)) {
    if (ws.tabs.some((t) => collectLeaves(t.root).some((l) => l.id === paneId))) return projectId
  }
  return null
}

function isShellPane(state: AppState, paneId: string): boolean {
  for (const ws of Object.values(state.workspaces)) {
    for (const tab of ws.tabs) {
      const leaf = collectLeaves(tab.root).find((l) => l.id === paneId)
      if (leaf) return isShellProfile(resolveProfile(state.settings.agentProfiles, leaf.profileId))
    }
  }
  return false
}

function isRunning(paneId: string): boolean {
  const status = terminalHost.runtime(paneId).status
  return status === 'live' || status === 'starting'
}

/** Every pane in every open project, in project and tab order. */
function agentsOf(state: AppState): MiniBarAgent[] {
  const out: MiniBarAgent[] = []
  for (const project of state.projects) {
    const ws = state.workspaces[project.id]
    if (!ws) continue
    for (const tab of ws.tabs) {
      for (const leaf of collectLeaves(tab.root)) {
        const profile = resolveProfile(state.settings.agentProfiles, leaf.profileId)
        const line = agentReplyLine(leaf.id) ?? lastLine(leaf.id)
        out.push({
          projectId: project.id,
          tabId: tab.id,
          paneId: leaf.id,
          name: paneNameInTab(tab, leaf.id),
          // The maker's logo key when Forge knows it (a custom profile running
          // Claude is still Claude); the profile id otherwise.
          brand: agentLogoFor(profile)?.key ?? profile.id,
          status: statusOf(leaf.id, terminalHost.runtime(leaf.id)),
          ...(line ? { line } : {})
        })
      }
    }
  }
  return out
}

/** The pane's state as the chips name it, from the same readers the pane headers use. */
function statusOf(paneId: string, runtime: PaneRuntime): AgentStatus {
  switch (runtime.status) {
    case 'error':
    case 'exited':
      return 'stopped'
    case 'starting':
      return 'starting'
    case 'idle':
      return 'idle'
    default:
      break
  }
  if (terminalHost.isBusy(paneId)) return 'working'
  if (terminalHost.isAttention(paneId)) return 'asking'
  return activityOf(paneId, runtime).state === 'done' ? 'done' : 'idle'
}

/** The last non-empty line on the pane's screen that is not a shell prompt; J3c swaps in a Claude pane's last reply. */
function lastLine(paneId: string): string {
  const text = terminalHost.snapshotText(paneId, LINE_ROWS)
  if (!text) return ''
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line && !isShellPrompt(line)) return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line
  }
  return ''
}
