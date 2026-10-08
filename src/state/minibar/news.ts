import { useEffect, useMemo, useRef, useState } from 'react'
import { agentLogoFor } from '@shared/agent-logos'
import { commandExe, isClaudeCommand, resolveProfile } from '@shared/agents'
import type { MiniBarCall, MiniBarChoice, MiniBarEvent, MiniBarPeek, MiniBarState, MiniBarTurn } from '@shared/minibar'
import { collectLeaves } from '@shared/splitTree'
import { paneNameInTab } from '@shared/workspace'
import { setBarTarget } from '@/components/hub/barMode'
import { hubAsk, useHubView } from '@/components/hub/hubView'
import { useQuietDictation } from '@/hooks/useDictation'
import { barDictationPhase } from '@/lib/barDictation'
import { barSend } from '@/lib/barSend'
import { earconAgentAsking, earconAgentDone } from '@/lib/earcon'
import { activityOf } from '@/lib/paneActivity'
import { terminalHost } from '@/lib/terminals'
import { createAnnouncer, replyGist, type NewsItem } from '@/state/announcer'
import { useApp, type AppState } from '@/state/AppState'
import { answerKeys, readAsk, sendAnswerKeys, type ParsedAsk } from '../../../web/src/lib/answer-options'
import type { MiniBarPart } from './part'

/**
 * The mini bar's news: done / asking / stopped events, the toasts, Activity,
 * Peek, the chat with Forge and spoken updates (docs/MINI-BAR.md, 4.9 to 4.11).
 *
 * Mounted only while the bar is on (MiniBarHost's `Live`), so news is what
 * happened while Forge was minimised. No new detection: the same pane signals
 * the pane headers and the phone use (terminalHost busy / attention, the
 * runtime's exit), read the way lib/paneActivity.ts reads them:
 *
 *   done      quiet, not asking, after DONE_MIN_WORK_MS or more of work;
 *   asking    the pane settled on a question (`attentionPrompt`);
 *   stopped   the process ended (live or starting, then exited or failed).
 *
 * Each one is an Activity row (last 30), a toast (8 s, at most 3; three or
 * more of one kind within 5 s are one toast), a chime (`miniChime`), and a
 * spoken line (src/state/announcer.ts) when "Speak updates" is on.
 *
 * Peek reads a Claude pane's last reply from its session (`panes.lastReply`),
 * any other pane's screen. An asking pane's choices are read with the phone's
 * own parser (web/src/lib/answer-options.ts) and answered with the phone's
 * keys, so desktop and phone answer the same way.
 */

/** A stretch shorter than this finishing is not news (lib/paneActivity.ts, lib/terminals.ts). */
const DONE_MIN_WORK_MS = 8000
const MAX_EVENTS = 30
const MAX_TOASTS = 3
const TOAST_MS = 8000
/** This many of one kind within BURST_WINDOW_MS show as one toast. */
const BURST_MIN = 3
const BURST_WINDOW_MS = 5000
/** Peek: the screen lines shown for a non-Claude pane, and read for a question's menu. */
const PEEK_ROWS = 40
/** Peek refreshes this often while its pane works. */
const PEEK_WORKING_MS = 2000
const THREAD_TURNS = 10
const LINE_MAX = 200
/** How often the announcer looks for a quiet moment. */
const SPEAK_TICK_MS = 500
/** The mic level that counts as Steve talking (VoiceAgent's MIC_VOICED_LEVEL). */
const MIC_VOICED_LEVEL = 0.35
/** After a voiced mic level, Listen is "hearing him" for this long. */
const VOICED_HOLD_MS = 1500
/** One chime per kind per this long: a burst is one sound, not five. */
const CHIME_GAP_MS = 1500

/* ------------------------------------------------- a Claude pane's last word */

/**
 * The first sentence of each Claude pane's last reply, by pane. Filled when a
 * pane is done and when Peek reads a reply; MiniBarHost can show it as the
 * agent's `line` in place of the last screen line.
 */
const replyLines = new Map<string, string>()

/** A Claude pane's last reply, one sentence; undefined for other panes or before one is read. */
export function agentReplyLine(paneId: string): string | undefined {
  return replyLines.get(paneId)
}

function firstSentence(text: string): string {
  const gist = replyGist(text)
  const one = gist.match(/^[^.!?]+[.!?]+(?=\s|$)/)?.[0] ?? gist
  const line = one.trim()
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line
}

/* ------------------------------------------------------------------- panes */

interface PaneInfo {
  projectId: string
  tabId: string
  name: string
  brand: string
  /** Claude Code: its last reply can be read from the session. */
  claude: boolean
  /** Its menus pick a row on the digit key (the phone's rule: Claude Code and Gemini CLI). */
  digits: boolean
}

function paneInfo(state: AppState, paneId: string): PaneInfo | null {
  for (const project of state.projects) {
    const ws = state.workspaces[project.id]
    if (!ws) continue
    for (const tab of ws.tabs) {
      const leaf = collectLeaves(tab.root).find((l) => l.id === paneId)
      if (!leaf) continue
      const profile = resolveProfile(state.settings.agentProfiles, leaf.profileId)
      const exe = commandExe(profile.command)
      return {
        projectId: project.id,
        tabId: tab.id,
        name: paneNameInTab(tab, leaf.id),
        brand: agentLogoFor(profile)?.key ?? profile.id,
        claude: isClaudeCommand(profile.command),
        digits: exe === 'claude' || exe === 'gemini'
      }
    }
  }
  return null
}

function paneIdsOf(state: AppState): string[] {
  const out: string[] = []
  for (const project of state.projects) {
    const ws = state.workspaces[project.id]
    if (!ws) continue
    for (const tab of ws.tabs) for (const leaf of collectLeaves(tab.root)) out.push(leaf.id)
  }
  return out
}

/**
 * A shell's prompt, not something an agent said: PowerShell `PS C:\proj>`,
 * cmd `C:\proj>`, bash/zsh `steve@pc:~/proj$`, `~/proj $` or a bare `$`, and
 * Git Bash's header line `steve@pc MINGW64 ~/proj`. Text typed after the
 * prompt counts as the prompt too.
 */
const SHELL_PROMPTS = [
  /^PS\s[^>]*>/,
  /^[A-Za-z]:\\[^>]*>/,
  /^(\([^)]*\)\s*)?[\w.-]+@[\w.-]+[^$#%]*[$#%](\s|$)/,
  /^[~/]\S*\s?[$#%](\s|$)/,
  /^[$#%]$|^\$\s/,
  /^[\w.-]+@[\w.-]+\s+(MINGW|MSYS|UCRT|CLANG)\w*\s/
]

export function isShellPrompt(line: string): boolean {
  return SHELL_PROMPTS.some((re) => re.test(line))
}

/** The last non-empty line on the pane's screen that is not a shell prompt. */
function screenLine(paneId: string): string {
  const lines = (terminalHost.snapshotText(paneId, PEEK_ROWS) ?? '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line && !isShellPrompt(line)) return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line
  }
  return ''
}

function screenRows(paneId: string): string[] {
  return (terminalHost.snapshotText(paneId, PEEK_ROWS) ?? '').split('\n')
}

function isAlive(paneId: string): boolean {
  const status = terminalHost.runtime(paneId).status
  return status === 'live' || status === 'starting'
}

let seq = 0

/* ---------------------------------------------------------------- the hook */

export function useMiniNews(): MiniBarPart {
  const { state, actions } = useApp()
  const hub = useHubView()
  const dictation = useQuietDictation()
  const speakUpdates = state.settings.miniSpeakUpdates !== false

  const [events, setEvents] = useState<MiniBarEvent[]>([])
  const [toasts, setToasts] = useState<string[]>([])
  const [seenAt, setSeenAt] = useState(0)
  const [peekPane, setPeekPane] = useState<string | null>(null)
  const [peek, setPeek] = useState<MiniBarPeek | null>(null)

  const live = useRef({ state, actions, hub, speakUpdates, listening: dictation.listening, peekPane })
  live.current = { state, actions, hub, speakUpdates, listening: dictation.listening, peekPane }
  const eventsRef = useRef(events)
  eventsRef.current = events

  /* ---- toasts: 8 s each from the moment they show ---- */

  const toastTimers = useRef(new Map<string, number>())
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const setToastList = (next: string[]): void => {
    for (const id of toastTimers.current.keys()) {
      if (next.includes(id)) continue
      window.clearTimeout(toastTimers.current.get(id))
      toastTimers.current.delete(id)
    }
    toastsRef.current = next
    setToasts(next)
  }
  const dropToast = (id: string): void => setToastList(toastsRef.current.filter((t) => t !== id))
  const dropToastRef = useRef(dropToast)
  dropToastRef.current = dropToast
  useEffect(() => {
    const timers = toastTimers.current
    return () => {
      timers.forEach((t) => window.clearTimeout(t))
      timers.clear()
    }
  }, [])

  /* ---- spoken updates ---- */

  const brainPanes = useRef(new Set<string>())
  const voicedAt = useRef(0)
  const [announcer] = useState(() =>
    createAnnouncer({
      now: () => Date.now(),
      // The master switch first: with the mini bar off Forge never speaks up on its own.
      on: () => live.current.state.settings.miniBar === true && live.current.speakUpdates,
      quiet: () => {
        const { hub: h, listening } = live.current
        if (listening || barDictationPhase() !== 'off') return false
        if (h.phase === 'speaking') return false
        return Date.now() - voicedAt.current > VOICED_HOLD_MS
      },
      brainOwns: (paneId) => brainPanes.current.has(paneId),
      say: (text) => live.current.hub.say?.(text, { kind: 'announce' })
    })
  )

  useEffect(() => {
    const beat = window.setInterval(() => {
      const h = live.current.hub
      // Listen hears him: the mic is really recording and his voice is on it.
      if (h.phase !== 'off' && h.capturing === true) {
        try {
          if (h.readLevels().mic >= MIC_VOICED_LEVEL) voicedAt.current = Date.now()
        } catch {
          /* no levels: nothing heard */
        }
      }
      announcer.tick()
    }, SPEAK_TICK_MS)
    return () => window.clearInterval(beat)
  }, [announcer])

  /** Hand one item to the announcer, after asking main which panes the Brain is minding. */
  const announce = (item: NewsItem): void => {
    const opened = window.forge.brain?.openedPanes?.()
    if (!opened) {
      announcer.push(item)
      return
    }
    void opened
      .then((ids) => {
        brainPanes.current = new Set(Array.isArray(ids) ? ids : [])
      })
      .catch(() => undefined)
      .finally(() => announcer.push(item))
  }

  /* ---- an event ---- */

  const chimedAt = useRef<Record<string, number>>({})
  const chime = (kind: MiniBarEvent['kind']): void => {
    // Stopped already has its sound: the terminal's exit blip (terminals.ts chimeOnExit).
    // No chimes at all with the mini bar switched off.
    const s = live.current.state.settings
    if (s.miniBar !== true || s.miniChime === false || kind === 'stopped') return
    const now = Date.now()
    if (now - (chimedAt.current[kind] ?? 0) < CHIME_GAP_MS) return
    chimedAt.current[kind] = now
    if (kind === 'done') earconAgentDone()
    else earconAgentAsking()
  }

  const addEvent = (one: MiniBarEvent): void => {
    // A burst of one kind is one toast, the newest, naming them all: the cards
    // it replaces fold into the bell. Activity still lists each event.
    const burst = [one, ...eventsRef.current].filter((e) => e.kind === one.kind && one.at - e.at <= BURST_WINDOW_MS)
    const names = [...new Set(burst.map((e) => e.name).reverse())]
    const ev: MiniBarEvent = burst.length >= BURST_MIN && names.length > 1 ? { ...one, group: names } : one
    eventsRef.current = [ev, ...eventsRef.current].slice(0, MAX_EVENTS)
    setEvents(eventsRef.current)
    const folded = new Set(burst.length >= BURST_MIN ? burst.map((e) => e.id) : [])
    setToastList([ev.id, ...toastsRef.current.filter((id) => !folded.has(id))].slice(0, MAX_TOASTS))
    toastTimers.current.set(
      ev.id,
      window.setTimeout(() => dropToastRef.current(ev.id), TOAST_MS)
    )
  }

  const patchLine = (id: string, line: string): void => {
    eventsRef.current = eventsRef.current.map((e) => (e.id === id ? { ...e, line } : e))
    setEvents(eventsRef.current)
  }

  const emit = (kind: MiniBarEvent['kind'], paneId: string, extra: { since?: number; workedMs?: number } = {}): void => {
    const info = paneInfo(live.current.state, paneId)
    if (!info) return
    const at = Date.now()
    const prompt = kind === 'asking' ? terminalHost.attentionPrompt(paneId) : ''
    // A Claude pane's own words replace this when its reply is read, below.
    const line = screenLine(paneId)
    const ev: MiniBarEvent = {
      id: `ev-${at.toString(36)}-${++seq}`,
      at,
      kind,
      projectId: info.projectId,
      paneId,
      name: info.name,
      brand: info.brand,
      ...(extra.workedMs ? { workedMs: extra.workedMs } : {}),
      ...(line ? { line } : {}),
      ...(prompt ? { prompt } : {})
    }
    addEvent(ev)
    chime(kind)
    const item: NewsItem = { kind, paneId, name: info.name, at, ...(prompt ? { prompt } : {}) }
    const lastReply = window.forge.panes?.lastReply
    if (kind !== 'done' || !info.claude || typeof lastReply !== 'function') {
      announce(item)
      return
    }
    // A Claude pane that is done: its own last words, when they are from this stretch of work.
    void lastReply(paneId)
      .then((reply) => {
        const fresh = reply && reply.text.trim() && reply.at >= (extra.since ?? 0) - 1000 ? reply : null
        if (fresh) {
          const one = firstSentence(fresh.text)
          if (one) {
            replyLines.set(paneId, one)
            patchLine(ev.id, one)
          }
        }
        announce(fresh ? { ...item, reply: fresh.text } : item)
      })
      .catch(() => announce(item))
  }
  const emitRef = useRef(emit)
  emitRef.current = emit

  /* ---- the signals: busy, attention ---- */

  useEffect(() => {
    const track = new Map<string, { busy: boolean; since: number; attention: boolean }>()
    const sample = (): void => {
      const now = Date.now()
      for (const id of paneIdsOf(live.current.state)) {
        const busy = terminalHost.isBusy(id)
        const attention = terminalHost.isAttention(id)
        const t = track.get(id)
        if (!t) {
          // Already working at minimise: its stretch began when the header says it did.
          const since = busy ? activityOf(id, terminalHost.runtime(id)).since : 0
          track.set(id, { busy, since, attention })
          continue
        }
        if (busy && !t.busy) t.since = now
        if (!busy && t.busy && !attention && isAlive(id) && now - t.since >= DONE_MIN_WORK_MS) {
          emitRef.current('done', id, { since: t.since, workedMs: now - t.since })
        }
        if (attention && !t.attention) emitRef.current('asking', id)
        t.busy = busy
        t.attention = attention
      }
    }
    // A pane going quiet tells the busy listeners before it decides whether it
    // is asking (terminals.ts `settle`): look once that has run.
    const soon = (): void => queueMicrotask(sample)
    sample()
    const offs = [terminalHost.subscribeBusy(soon), terminalHost.subscribeAttention(soon)]
    return () => offs.forEach((off) => off())
  }, [])

  /* ---- the signals: a process that ends ---- */

  const paneSig = paneIdsOf(state).join('|')
  useEffect(() => {
    const ids = paneSig ? paneSig.split('|') : []
    const offs = ids.map((id) => {
      let was = terminalHost.runtime(id).status
      return terminalHost.subscribeRuntime(id, (r) => {
        const before = was
        was = r.status
        if ((r.status === 'exited' || r.status === 'error') && (before === 'live' || before === 'starting')) {
          emitRef.current('stopped', id)
        }
      })
    })
    return () => offs.forEach((off) => off())
  }, [paneSig])

  // Each Claude pane's last word, read once; a pane that is done reads it again (`emit`).
  useEffect(() => {
    const lastReply = window.forge.panes?.lastReply
    if (typeof lastReply !== 'function' || !paneSig) return
    for (const id of paneSig.split('|')) {
      if (replyLines.has(id) || !paneInfo(live.current.state, id)?.claude) continue
      void lastReply(id)
        .then((reply) => {
          const one = reply?.text ? firstSentence(reply.text) : ''
          if (one && !replyLines.has(id)) replyLines.set(id, one)
        })
        .catch(() => undefined)
    }
  }, [paneSig])

  /* ---- Peek ---- */

  /** The question each peeked pane is asking, as the buttons were built from it. */
  const asks = useRef(new Map<string, ParsedAsk>())

  const askingOf = (paneId: string): MiniBarPeek['asking'] => {
    if (!terminalHost.isAttention(paneId)) {
      asks.current.delete(paneId)
      return undefined
    }
    const prompt = terminalHost.attentionPrompt(paneId)
    const ask = readAsk(prompt, screenRows(paneId))
    asks.current.set(paneId, ask)
    const choices: MiniBarChoice[] = ask.options.map((o) => ({ id: String(o.n), label: o.label }))
    return { prompt: ask.question || prompt, choices }
  }

  const refreshPeek = (paneId: string): void => {
    const asking = askingOf(paneId)
    const fromScreen = (): MiniBarPeek => ({
      paneId,
      source: 'screen',
      text: terminalHost.snapshotText(paneId, PEEK_ROWS) ?? '',
      at: Date.now(),
      ...(asking ? { asking } : {})
    })
    const info = paneInfo(live.current.state, paneId)
    const lastReply = window.forge.panes?.lastReply
    if (!info?.claude || typeof lastReply !== 'function') {
      setPeek(fromScreen())
      return
    }
    void lastReply(paneId)
      .then((reply) => {
        if (live.current.peekPane !== paneId) return
        if (!reply || !reply.text.trim()) {
          setPeek(fromScreen())
          return
        }
        const one = firstSentence(reply.text)
        if (one) replyLines.set(paneId, one)
        setPeek({ paneId, source: 'reply', text: reply.text, at: reply.at, ...(asking ? { asking } : {}) })
      })
      .catch(() => {
        if (live.current.peekPane === paneId) setPeek(fromScreen())
      })
  }
  const refreshPeekRef = useRef(refreshPeek)
  refreshPeekRef.current = refreshPeek

  // Refresh when the pane goes quiet or starts or stops asking, and every 2 s while it works.
  useEffect(() => {
    if (!peekPane) return undefined
    let busy = terminalHost.isBusy(peekPane)
    let attention = terminalHost.isAttention(peekPane)
    const look = (): void => {
      const nowBusy = terminalHost.isBusy(peekPane)
      const nowAttention = terminalHost.isAttention(peekPane)
      const changed = (busy && !nowBusy) || attention !== nowAttention
      busy = nowBusy
      attention = nowAttention
      if (changed) refreshPeekRef.current(peekPane)
    }
    const soon = (): void => queueMicrotask(look)
    const offs = [terminalHost.subscribeBusy(soon), terminalHost.subscribeAttention(soon)]
    const beat = window.setInterval(() => {
      if (terminalHost.isBusy(peekPane)) refreshPeekRef.current(peekPane)
    }, PEEK_WORKING_MS)
    return () => {
      offs.forEach((off) => off())
      window.clearInterval(beat)
    }
  }, [peekPane])

  /** Make `paneId` the app's current pane and the bar's target. */
  const aimAt = (paneId: string): void => {
    const { state: s, actions: a } = live.current
    const info = paneInfo(s, paneId)
    if (!info) return
    if (s.activeProjectId !== info.projectId) a.selectProject(info.projectId)
    a.revealPane(paneId)
    setBarTarget('pane')
  }

  const answer = (paneId: string, choiceId: string): void => {
    // The question has gone: a digit now would land in the agent's next prompt.
    if (!terminalHost.isAttention(paneId) || !terminalHost.has(paneId)) return
    const info = paneInfo(live.current.state, paneId)
    const fresh = readAsk(terminalHost.attentionPrompt(paneId), screenRows(paneId))
    const pick = (ask: ParsedAsk | undefined): { ask: ParsedAsk; index: number } | null => {
      const index = ask ? ask.options.findIndex((o) => String(o.n) === choiceId) : -1
      return ask && index >= 0 ? { ask, index } : null
    }
    const chosen = pick(fresh) ?? pick(asks.current.get(paneId))
    if (!chosen) return
    const keys = answerKeys(chosen.ask, chosen.index, info?.digits ?? false)
    void sendAnswerKeys(keys, (data) => window.forge.pty.write(paneId, data))
  }

  /* ---- the view's calls ---- */

  const handle = (c: MiniBarCall): boolean => {
    switch (c.t) {
      case 'peek':
        if (typeof c.paneId !== 'string' || !paneInfo(live.current.state, c.paneId)) return true
        live.current.peekPane = c.paneId
        setPeekPane(c.paneId)
        if (peek?.paneId !== c.paneId) setPeek(null)
        refreshPeek(c.paneId)
        return true
      case 'closePeek':
        live.current.peekPane = null
        setPeekPane(null)
        setPeek(null)
        return true
      case 'reply': {
        const message = typeof c.text === 'string' ? c.text.replace(/\s+$/, '') : ''
        if (!message.trim() || !paneInfo(live.current.state, c.paneId)) return true
        aimAt(c.paneId)
        barSend(message, { paneId: c.paneId, toForge: false, ask: (m) => hubAsk(live.current.hub, m, 'typed') })
        return true
      }
      case 'answer':
        answer(c.paneId, c.choiceId)
        return true
      case 'seen':
        setSeenAt(Date.now())
        return true
      case 'dismissToast':
        dropToast(c.id)
        return true
      case 'speakUpdates':
        if (c.on !== true) announcer.clear()
        live.current.actions.patchSettings({ miniSpeakUpdates: c.on === true })
        return true
      default:
        return false
    }
  }
  const handleRef = useRef(handle)
  handleRef.current = handle

  /* ---- the chat with Forge: the hub's own turns, not fading ---- */

  const captions = hub.captions
  const thread = useMemo<MiniBarTurn[]>(
    () =>
      captions
        .filter((c) => c.final && c.text.trim())
        .slice(-THREAD_TURNS)
        .map((c): MiniBarTurn => ({ who: c.role === 'user' ? 'you' : 'forge', text: c.text, at: c.at })),
    [captions]
  )

  const unseen = useMemo(() => events.filter((e) => e.at > seenAt).length, [events, seenAt])

  return useMemo(() => {
    const slice: Partial<MiniBarState> = { events, unseen, toasts, peek, thread, speakUpdates }
    return { slice, handle: (c: MiniBarCall) => handleRef.current(c) }
  }, [events, unseen, toasts, peek, thread, speakUpdates])
}
