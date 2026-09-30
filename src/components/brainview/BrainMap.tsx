import { useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { BRAIN_ENGINE_NAME, BRAIN_PROJECT_NAME, isBrainProject, type BrainStatus } from '@shared/brain'
import { collectLeaves } from '@shared/splitTree'
import type { AgentProfile, Project, Workspace } from '@shared/types'
import { paneNameInTab } from '@shared/workspace'
import { launchCommand, leafPermissionMode, paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { reducedMotion } from '@/lib/motion'
import { ACTIVITY_WORD, type ActivityState, type PaneActivity } from '@/lib/paneActivity'
import { shellMode } from '@/lib/shellSlots'
import { terminalHost, type TerminalSpec } from '@/lib/terminals'
import { uiCommands } from '@/lib/uiCommands'
import { useActions, useAppSelector, useAppStateGetter, shallowEqual } from '@/state/AppState'
import { VoiceAgentContext } from '@/state/VoiceAgent'
import { AgentBadge } from '../AgentBadge'
import { Icon } from '../Icon'
import { StateChip, StateGlyph } from '../shell/StateChip'
import { lastLines } from './activity'
import { ContextRing, contextWords, useBrainContext } from '../brain/BrainContext'
import { BrainConversation } from './BrainConversation'
import { BrainGlyph } from './BrainGlyph'
import { MapEngine, type BrainMood, type Palette } from './engine'
import { PaneDoor, type DoorTarget } from './PaneDoor'
import { parseColor, type MapAgent, type MapProject } from './scene'
import './BrainMap.css'

/**
 * Forge Brain's expanded view: a living map of everything Forge is doing, and
 * a door into any agent's terminal.
 *
 * Read it from the middle out. Forge Brain at the centre; around it every
 * project as a hub with its agents fanned outward, each wearing its maker's
 * mark and its state as a shape (a moving ring, a diamond, a tick, a still
 * ring); in front, the way in — you, then the voice agent. Pulses travel the
 * links when something happens: the brain handing work out, an agent
 * finishing, an agent needing you, you talking.
 *
 * Point at anything for its card. Click an agent and its real terminal opens
 * over the map (typing works); "Go to it" switches Forge there. Esc closes.
 *
 * All of it is read from what the renderer already holds — every project's
 * layout (loaded read-only for projects not visited yet), terminalHost's busy
 * and attention facts, the brain's status, the voice agent's phase. Nothing
 * here writes app state except by the same actions the Agents menu uses.
 */

/**
 * Past this many, the quietest projects (fewest agents, never the one on
 * screen) are left off and the footer counts them. The layout holds 30 at
 * 1920×1080 without a label touching another; beyond that labels go one-line
 * and lanes stagger, and it may crowd.
 */
const MAX_PROJECTS = 32
const HEAD_H = 64
const FOOT_H = 46

const MOOD_WORD: Record<BrainMood, string> = {
  off: 'Off',
  starting: 'Starting',
  idle: 'Ready',
  busy: 'Working',
  asking: 'Needs you',
  error: 'Stopped'
}

const MOOD_GLYPH: Record<BrainMood, ActivityState> = {
  off: 'dormant',
  starting: 'starting',
  idle: 'idle',
  busy: 'working',
  asking: 'attention',
  error: 'failed'
}

const VOICE_WORD: Record<string, string> = {
  off: 'Off',
  warming: 'Waking',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  replied: 'Replied',
  error: 'Error'
}

function buildModel(
  projects: Project[],
  workspaces: Record<string, Workspace>,
  extra: Record<string, Workspace>,
  profiles: AgentProfile[],
  activeProjectId: string | null
): { list: MapProject[]; hidden: number } {
  const all = projects
    .filter((p) => !isBrainProject(p))
    .map((p): MapProject => {
      const ws = workspaces[p.id] ?? extra[p.id]
      const agents: MapAgent[] = []
      for (const tab of Array.isArray(ws?.tabs) ? ws.tabs : []) {
        if (!tab?.root || tab.root.type === 'chat') continue
        for (const leaf of collectLeaves(tab.root)) {
          if (!leaf || typeof leaf.id !== 'string') continue
          agents.push({
            key: `a:${leaf.id}`,
            paneId: leaf.id,
            projectId: p.id,
            name: safeName(() => paneNameInTab(tab, leaf.id)) || text(leaf.title) || 'Terminal',
            profile: resolveProfile(profiles, leaf.profileId),
            leaf
          })
        }
      }
      return {
        key: `p:${p.id}`,
        id: p.id,
        name: text(p.name) || text(p.id) || 'Project',
        color: projectColor(p.color, p.id),
        path: text(p.path),
        repoUrl: p.repoUrl,
        agents,
        active: p.id === activeProjectId
      }
    })
  if (all.length <= MAX_PROJECTS) return { list: all, hidden: 0 }
  // Too many to draw well: the ones with agents (and the one on screen) first.
  const ranked = [...all].sort((a, b) => Number(b.active) - Number(a.active) || b.agents.length - a.agents.length)
  const keep = new Set(ranked.slice(0, MAX_PROJECTS).map((p) => p.id))
  return { list: all.filter((p) => keep.has(p.id)), hidden: all.length - keep.size }
}

/** A string, or '' for anything else: saved data is never trusted to have every field. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function safeName(read: () => unknown): string {
  try {
    return text(read())
  } catch {
    return ''
  }
}

const FALLBACK_COLORS = ['#7aa2ff', '#ff9f43', '#c77dff', '#4dd4ac', '#ff6b9a', '#f2c94c', '#56ccf2', '#a0e060']

/** The project's own dot colour when it is a usable hex; otherwise a steady pick from its id. */
function projectColor(color: unknown, id: unknown): string {
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color.trim())) return color.trim()
  const key = text(id)
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length]!
}

function readPalette(probe: HTMLElement): Palette {
  const read = (name: string): ReturnType<typeof parseColor> => {
    probe.style.color = `var(${name})`
    return parseColor(getComputedStyle(probe).color)
  }
  return {
    accent: read('--accent'),
    ink: read('--text-primary'),
    muted: read('--text-muted'),
    warn: read('--warn'),
    ok: read('--ok'),
    bg: read('--bg-base'),
    dark: document.documentElement.dataset['appearance'] !== 'light'
  }
}

type Hover = { key: string } | null

export function BrainMap({ closing, onClose }: { closing: boolean; onClose: () => void }): ReactNode {
  const projects = useAppSelector((s) => s.projects)
  const workspaces = useAppSelector((s) => s.workspaces)
  const profiles = useAppSelector((s) => s.settings.agentProfiles)
  const activeProjectId = useAppSelector((s) => s.activeProjectId)
  const type = useAppSelector(
    (s) => ({ fontSize: s.settings.terminalFontSize, fontFamily: s.settings.terminalFontFamily }),
    shallowEqual
  )
  const you = useAppSelector((s) => ({ name: s.settings.accountName, color: s.settings.accountColor }), shallowEqual)
  const actions = useActions()
  const getState = useAppStateGetter()
  const voice = useContext(VoiceAgentContext)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const probeRef = useRef<HTMLSpanElement | null>(null)
  const engineRef = useRef<MapEngine | null>(null)
  const [, setStatesVersion] = useState(0)
  const [brain, setBrain] = useState<BrainStatus | null>(null)
  const [extra, setExtra] = useState<Record<string, Workspace>>({})
  const [hover, setHover] = useState<Hover>(null)
  const [door, setDoor] = useState<DoorTarget | null>(null)
  const [reply, setReply] = useState('')
  /** A project opened out by its "+N not open" chip, until the chip is clicked again. */
  const [pinned, setPinned] = useState<string | null>(null)
  /** The project opened out by pointing or focus; lingers a moment so the pointer can reach its agents. */
  const [pointed, setPointed] = useState<string | null>(null)
  const hideTimer = useRef(0)

  /* ----------------------------------------------------------- the data */

  // Projects not visited this session have no workspace in app state: read
  // their saved layouts, once, so their agents are on the map too.
  useEffect(() => {
    let cancelled = false
    const missing = projects.filter((p) => !isBrainProject(p) && !workspaces[p.id] && !extra[p.id])
    if (missing.length === 0) return undefined
    void Promise.all(
      missing.map(async (p) => {
        try {
          return [p.id, await window.forge?.store?.getWorkspace?.(p.id)] as const
        } catch {
          return [p.id, null] as const
        }
      })
    ).then((rows) => {
      if (cancelled) return
      setExtra((prev) => {
        const next = { ...prev }
        for (const [id, ws] of rows) next[id] = ws && Array.isArray(ws.tabs) ? ws : { tabs: [], activeTabId: null }
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [projects, workspaces, extra])

  const model = useMemo(
    () => buildModel(projects, workspaces, extra, profiles, activeProjectId),
    [projects, workspaces, extra, profiles, activeProjectId]
  )

  // The brain: its status, and every line it hands the voice agent.
  useEffect(() => {
    const api = window.forge?.brain
    if (!api) return undefined
    let live = true
    void api
      .status?.()
      .then((s) => {
        if (live && s) setBrain(s)
      })
      .catch(() => {})
    const offStatus = api.onStatus?.((s) => setBrain(s))
    const offSays = api.onSays?.(() => engineRef.current?.brainSays())
    return () => {
      live = false
      offStatus?.()
      offSays?.()
    }
  }, [])

  /* --------------------------------------------------------- the engine */

  useEffect(() => {
    const canvas = canvasRef.current
    const root = rootRef.current
    const probe = probeRef.current
    if (!canvas || !root || !probe) return undefined
    const engine = new MapEngine(canvas, { onStates: () => setStatesVersion((n) => n + 1) })
    engineRef.current = engine
    engine.setMotion(!reducedMotion())
    engine.setPalette(readPalette(probe))
    const size = (): void => engine.setSize(root.clientWidth, root.clientHeight, HEAD_H, FOOT_H)
    size()
    const ro = new ResizeObserver(size)
    ro.observe(root)
    // Theme and reduced-motion changes both land on <html>'s attributes.
    const mo = new MutationObserver(() => {
      engine.setPalette(readPalette(probe))
      engine.setMotion(!reducedMotion())
    })
    mo.observe(document.documentElement, { attributes: true })
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const onMq = (): void => engine.setMotion(!reducedMotion())
    mq?.addEventListener?.('change', onMq)
    engine.start()
    return () => {
      ro.disconnect()
      mo.disconnect()
      mq?.removeEventListener?.('change', onMq)
      engine.destroy()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    engineRef.current?.setModel(model.list)
  }, [model])

  useEffect(() => {
    engineRef.current?.setBrain(brain)
  }, [brain])

  const voicePhase = voice?.phase ?? 'off'
  const voiceCapturing = voice?.capturing ?? false
  useEffect(() => {
    engineRef.current?.setVoice({ phase: voicePhase, capturing: voiceCapturing })
  }, [voicePhase, voiceCapturing])

  useEffect(() => {
    engineRef.current?.setHover(hover?.key ?? null)
  }, [hover])

  // Pointing at a project (or focusing it), or at one of its not-open agents, opens it out.
  const hoverProject = ((): string | null => {
    const key = hover?.key
    if (!key) return null
    if (key.startsWith('p:')) return key
    if (!key.startsWith('a:')) return null
    const paneId = key.slice(2)
    const owner = model.list.find((p) => p.agents.some((a) => a.paneId === paneId))
    return owner && engineRef.current?.stateOf(paneId).state === 'dormant' ? owner.key : null
  })()
  useEffect(() => {
    if (hoverProject) {
      setPointed(hoverProject)
      return undefined
    }
    const t = window.setTimeout(() => setPointed(null), 420)
    return () => window.clearTimeout(t)
  }, [hoverProject])

  const reveal = pointed ?? pinned
  useEffect(() => {
    engineRef.current?.setReveal(reveal)
  }, [reveal])

  const togglePin = useCallback((key: string) => setPinned((p) => (p === key ? null : key)), [])

  useEffect(() => {
    engineRef.current?.setPaused(door !== null)
  }, [door])

  // "Working 12m" clocks move on their own.
  useEffect(() => {
    const t = window.setInterval(() => setStatesVersion((n) => n + 1), 15_000)
    return () => window.clearInterval(t)
  }, [])

  /* -------------------------------------------------------------- keys */

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // With a terminal open, Esc is the agent's (it interrupts Claude).
      if (door) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [door, onClose])

  // Focus comes to the map when it opens, so Esc and Tab work at once.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  /* ------------------------------------------------------------ actions */

  const specFor = useCallback(
    (project: MapProject, agent: MapAgent): TerminalSpec => ({
      cwd: project.path,
      bootstrapCommand: launchCommand(agent.profile, leafPermissionMode(agent.leaf)),
      fontSize: type.fontSize,
      fontFamily: type.fontFamily,
      accent: agent.profile.accent,
      projectName: project.name,
      paneTitle: paneDisplayTitle(agent.profile, agent.leaf.title),
      sessionId: agent.leaf.sessionId,
      repoUrl: project.repoUrl
    }),
    [type.fontSize, type.fontFamily]
  )

  const goTo = useCallback(
    (projectId: string, paneId: string | null) => {
      setDoor(null)
      onClose()
      if (getState().activeProjectId !== projectId) actions.selectProject(projectId)
      if (shellMode.get()) uiCommands.run('set-mode', 'agents')
      if (!paneId) return
      let tries = 0
      const reveal = (): void => {
        if (!getState().workspaces[projectId] && tries++ < 60) {
          window.setTimeout(reveal, 50)
          return
        }
        actions.revealPane(paneId)
        actions.setViewMode('tabs')
        requestAnimationFrame(() => requestAnimationFrame(() => terminalHost.focus(paneId)))
      }
      reveal()
    },
    [actions, getState, onClose]
  )

  const openAgent = useCallback(
    (project: MapProject, agent: MapAgent) => {
      // Not opened this session: there is no terminal to borrow. Going to it starts it.
      if (!terminalHost.has(agent.paneId)) {
        goTo(project.id, agent.paneId)
        return
      }
      setHover(null)
      setDoor({
        paneId: agent.paneId,
        name: agent.name,
        subtitle: project.name,
        profile: agent.profile,
        projectId: project.id,
        spec: specFor(project, agent)
      })
    },
    [goTo, specFor]
  )

  const openBrain = useCallback(() => {
    const paneId = brain?.enabled ? brain.paneId : null
    if (!paneId) return
    setHover(null)
    const accent = text(getComputedStyle(document.documentElement).getPropertyValue('--accent')).trim() || '#C6FF4A'
    setDoor({
      paneId,
      name: BRAIN_PROJECT_NAME,
      subtitle: `${BRAIN_ENGINE_NAME[brain!.engine]} · the app's own agent`,
      profile: null,
      projectId: null,
      spec: {
        // Main launches the brain pane its own way whatever these say (electron/brain/launch.ts).
        cwd: '',
        bootstrapCommand: '',
        fontSize: type.fontSize,
        fontFamily: type.fontFamily,
        accent,
        projectName: BRAIN_PROJECT_NAME,
        paneTitle: BRAIN_PROJECT_NAME
      }
    })
  }, [brain, type.fontSize, type.fontFamily])

  /* ------------------------------------------------------------- hover */

  const show = useCallback((key: string) => {
    window.clearTimeout(hideTimer.current)
    setHover((h) => (h?.key === key ? h : { key }))
    setReply('')
  }, [])
  const cardRef = useRef<HTMLDivElement | null>(null)
  const hideSoon = useCallback(() => {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      // Never snatch the card away from someone typing an answer into it.
      if (cardRef.current?.contains(document.activeElement)) return
      setHover(null)
    }, 240)
  }, [])
  const keep = useCallback(() => window.clearTimeout(hideTimer.current), [])
  useEffect(() => () => window.clearTimeout(hideTimer.current), [])

  const bind = useCallback((key: string) => (el: HTMLElement | null) => engineRef.current?.bindNode(key, el), [])
  const bindCard = useCallback((el: HTMLDivElement | null) => {
    cardRef.current = el
    engineRef.current?.bindCard(el, el ? (el.dataset['for'] ?? null) : null)
  }, [])

  /* -------------------------------------------------------------- render */

  const engine = engineRef.current
  const stateOf = (paneId: string): PaneActivity => engine?.stateOf(paneId) ?? { state: 'dormant', since: Date.now() }
  const mood: BrainMood = !brain || !brain.enabled ? 'off' : brain.state
  const context = useBrainContext()

  let agents = 0
  const counts: Record<'working' | 'attention' | 'done', number> = { working: 0, attention: 0, done: 0 }
  for (const p of model.list)
    for (const a of p.agents) {
      agents++
      const s = stateOf(a.paneId).state
      if (s === 'working' || s === 'attention' || s === 'done') counts[s]++
    }

  const hovered = hover ? findNode(model.list, hover.key) : null
  const doorActivity = door ? (door.projectId ? stateOf(door.paneId) : brainActivity(mood)) : null

  return (
    <div
      className="bmap"
      data-state={closing ? 'closing' : 'open'}
      data-shell-overlay=""
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Forge Brain — map of every project and agent"
      onPointerMove={(e) => {
        const r = rootRef.current?.getBoundingClientRect()
        if (!r) return
        engineRef.current?.setPointer(((e.clientX - r.left) / r.width - 0.5) * 2, ((e.clientY - r.top) / r.height - 0.5) * 2)
      }}
      onPointerLeave={() => engineRef.current?.setPointer(0, 0)}
    >
      <span className="bmap__probe" ref={probeRef} aria-hidden="true" />
      <canvas className="bmap__canvas" ref={canvasRef} aria-hidden="true" />

      <header className="bmap__head">
        <div className="bmap__title">
          <span className="bmap__mark">
            <BrainGlyph size={20} />
          </span>
          <span className="bmap__titles">
            <span className="bmap__eyebrow">Forge Brain</span>
            <span className="bmap__h">Everything Forge is doing</span>
          </span>
        </div>
        <ol className="bmap__flow" aria-label="How work flows">
          <li>You</li>
          <li>Voice</li>
          <li>Brain</li>
          <li>Projects</li>
          <li>Agents</li>
        </ol>
        <div className="bmap__stats">
          <span className="bmap__stat">
            <b>{model.list.length + model.hidden}</b> projects
          </span>
          <span className="bmap__stat">
            <b>{agents}</b> agents
          </span>
          <span className="bmap__stat" data-state="working">
            <StateGlyph state="working" />
            <b>{counts.working}</b> working
          </span>
          <span className="bmap__stat" data-state="attention">
            <StateGlyph state="attention" />
            <b>{counts.attention}</b> need you
          </span>
          {counts.done > 0 ? (
            <span className="bmap__stat" data-state="done">
              <StateGlyph state="done" />
              <b>{counts.done}</b> done
            </span>
          ) : null}
        </div>
        <button type="button" className="bmap-btn bmap-btn--ghost bmap__close" onClick={onClose} title="Close the map (Esc)">
          <span className="bmap__kbd">Esc</span>
          <Icon name="close" size={13} />
        </button>
      </header>

      <Confirms brain={brain} strip />

      <div className="bmap__nodes">
        {/* The brain, at the centre. */}
        <div className="bmap-anchor" ref={bind('brain')}>
          <button
            type="button"
            className="bmap-core"
            data-mood={mood}
            aria-label={`Forge Brain — ${MOOD_WORD[mood]}${context.shown ? `, ${contextWords(context)}` : ''}`}
            onPointerEnter={() => show('brain')}
            onPointerLeave={hideSoon}
            onFocus={() => show('brain')}
            onBlur={hideSoon}
            onClick={openBrain}
          >
            <span className="bmap-core__name">Forge Brain</span>
            <span className="bmap-core__state">
              <StateGlyph state={MOOD_GLYPH[mood]} />
              {MOOD_WORD[mood]}
              {context.shown ? (
                <span className="bmap-core__ctx">
                  {' · '}
                  <ContextRing view={context} />
                </span>
              ) : null}
              {brain?.queued ? <span className="bmap-core__q"> · {brain.queued} waiting</span> : null}
              {brain?.confirms?.length ? <span className="bmap-core__ask"> · {brain.confirms.length} to allow</span> : null}
            </span>
          </button>
        </div>

        {/* The way in: the voice agent, then you. */}
        <div className="bmap-anchor" ref={bind('voice')}>
          <button
            type="button"
            className="bmap-stem"
            data-on={voicePhase !== 'off' ? 'true' : undefined}
            onPointerEnter={() => show('voice')}
            onPointerLeave={hideSoon}
            onFocus={() => show('voice')}
            onBlur={hideSoon}
          >
            <span className="bmap-stem__disc">
              <Icon name="mic" size={15} />
            </span>
            <span className="bmap-node__name">Voice{voice?.brainName ? ` · ${voice.brainName}` : ''}</span>
            <span className="bmap-node__state">{VOICE_WORD[voicePhase] ?? voicePhase}</span>
          </button>
        </div>
        <div className="bmap-anchor" ref={bind('you')}>
          <div className="bmap-stem bmap-stem--you" style={{ '--you': you.color } as CSSProperties}>
            <span className="bmap-stem__disc bmap-stem__disc--you">{(text(you.name) || 'You').slice(0, 1).toUpperCase()}</span>
            <span className="bmap-node__name">You</span>
          </div>
        </div>

        {model.list.map((p) => (
          <ProjectNodes
            key={p.id}
            project={p}
            bind={bind}
            stateOf={stateOf}
            show={show}
            hideSoon={hideSoon}
            open={reveal === p.key}
            pinned={pinned === p.key}
            onFold={() => togglePin(p.key)}
            onOpen={openAgent}
            onGoProject={() => goTo(p.id, null)}
          />
        ))}
      </div>

      {hovered ? (
        <div
          className="bmap-card"
          ref={bindCard}
          key={hover!.key}
          data-for={hover!.key}
          onPointerEnter={keep}
          onPointerLeave={hideSoon}
          onFocus={keep}
          onBlur={hideSoon}
        >
          <CardBody
            node={hovered}
            brain={brain}
            mood={mood}
            voicePhase={voicePhase}
            voiceName={voice?.brainName ?? ''}
            stateOf={stateOf}
            reply={reply}
            setReply={setReply}
            onOpen={openAgent}
            onOpenBrain={openBrain}
            onGo={goTo}
          />
        </div>
      ) : null}

      <footer className="bmap__foot">
        <ul className="bmap__legend" aria-label="What the shapes mean">
          <li data-state="working">
            <StateGlyph state="working" /> Working <i>moving ring</i>
          </li>
          <li data-state="attention">
            <StateGlyph state="attention" /> Needs you <i>diamond</i>
          </li>
          <li data-state="done">
            <StateGlyph state="done" /> Done <i>tick</i>
          </li>
          <li data-state="idle">
            <StateGlyph state="idle" /> Ready <i>still ring</i>
          </li>
          <li data-state="dormant">
            <StateGlyph state="dormant" /> Not open <i>+n on its project, dotted when shown</i>
          </li>
        </ul>
        <span className="bmap__hint">
          {model.hidden > 0 ? `${model.hidden} quiet projects not drawn · ` : ''}Point at a project to show its not-open agents ·
          click an agent to open it here
        </span>
      </footer>

      {door && doorActivity ? (
        <PaneDoor
          key={door.paneId}
          target={door}
          activity={doorActivity}
          accent={door.profile?.accent ?? 'var(--accent)'}
          onBack={() => {
            const id = door.paneId
            setDoor(null)
            requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-node="a:${CSS.escape(id)}"]`)?.focus())
          }}
          onGo={door.projectId ? () => goTo(door.projectId!, door.paneId) : null}
          conversation={
            door.projectId === null ? <BrainConversation sessionId={brain?.sessionId ?? null} engine={text(brain?.engine)} /> : undefined
          }
        />
      ) : null}
    </div>
  )
}

const RISK_WORD: Record<string, string> = { low: 'Low risk', medium: 'Some risk', high: 'High risk' }

/**
 * What the brain is waiting for Steve to allow, each with Yes and No. Shown on
 * the map itself (under the header) and in the brain's card: a confirm must
 * never be something you have to go looking for.
 */
function Confirms({ brain, strip = false }: { brain: BrainStatus | null; strip?: boolean }): ReactNode {
  const list = Array.isArray(brain?.confirms) ? brain!.confirms : []
  const [sent, setSent] = useState<Record<string, boolean>>({})
  if (list.length === 0) return null
  const answer = (id: string, allow: boolean): void => {
    setSent((m) => ({ ...m, [id]: true }))
    void window.forge?.brain
      ?.confirm?.({ id, allow })
      ?.catch(() => setSent((m) => ({ ...m, [id]: false })))
  }
  return (
    <ul className={strip ? 'bmap-asks' : 'bmap-card__asks'} aria-label="Forge Brain asks you">
      {list.map((c) => (
        <li key={text(c?.id)} className="bmap-ask" data-risk={text(c?.risk)}>
          <span className="bmap-ask__glyph" aria-hidden="true">
            <StateGlyph state="attention" />
          </span>
          <span className="bmap-ask__text">
            <span className="bmap-ask__what">{text(c?.summary) || text(c?.tool) || 'An action'}</span>
            <span className="bmap-ask__risk">{RISK_WORD[text(c?.risk)] ?? 'Asks first'}</span>
          </span>
          <button
            type="button"
            className="bmap-btn bmap-btn--cta"
            disabled={sent[text(c?.id)] === true}
            onClick={() => answer(text(c?.id), true)}
          >
            Yes
          </button>
          <button type="button" className="bmap-btn" disabled={sent[text(c?.id)] === true} onClick={() => answer(text(c?.id), false)}>
            No
          </button>
        </li>
      ))}
    </ul>
  )
}

function brainActivity(mood: BrainMood): PaneActivity {
  return { state: MOOD_GLYPH[mood], since: Date.now() }
}

/* ------------------------------------------------------------------ nodes */

function ProjectNodes({
  project,
  bind,
  stateOf,
  show,
  hideSoon,
  onOpen,
  onGoProject,
  open,
  pinned,
  onFold
}: {
  project: MapProject
  bind: (key: string) => (el: HTMLElement | null) => void
  stateOf: (paneId: string) => PaneActivity
  show: (key: string) => void
  hideSoon: () => void
  onOpen: (project: MapProject, agent: MapAgent) => void
  onGoProject: () => void
  open: boolean
  pinned: boolean
  onFold: () => void
}): ReactNode {
  // Working, needing you, ready and done agents are always drawn beside the
  // project; the ones not open fold into a count on it.
  const folded = project.agents.filter((a) => stateOf(a.paneId).state === 'dormant').length
  const quiet = folded === project.agents.length
  return (
    <>
      <div className="bmap-anchor" ref={bind(project.key)}>
        <div
          className="bmap-plabel"
          data-active={project.active ? 'true' : undefined}
          data-quiet={quiet ? 'true' : undefined}
          data-open={open ? 'true' : undefined}
          style={{ '--proj': project.color } as CSSProperties}
          onPointerEnter={() => show(project.key)}
          onPointerLeave={hideSoon}
        >
          <button
            type="button"
            className="bmap-proj"
            aria-label={`${project.name}${folded ? `, ${folded} not open` : ''} — go to project`}
            onFocus={() => show(project.key)}
            onBlur={hideSoon}
            onClick={onGoProject}
          >
            <span className="bmap-proj__name">{project.name}</span>
          </button>
          <span className="bmap-proj__meta">
            {folded > 0 ? (
              <button
                type="button"
                className="bmap-proj__fold"
                aria-expanded={open}
                aria-pressed={pinned}
                aria-label={`${pinned ? 'Hide' : 'Show'} ${folded} not-open agent${folded === 1 ? '' : 's'} in ${project.name}`}
                title={pinned ? 'Fold them away again' : 'Show them (and keep them shown)'}
                onFocus={() => show(project.key)}
                onBlur={hideSoon}
                onClick={onFold}
              >
                <StateGlyph state="dormant" />
                <span className="bmap-proj__fold-n">+{folded}</span>
                <span className="bmap-proj__fold-w"> not open</span>
              </button>
            ) : (
              <span className="bmap-proj__count">
                {project.agents.length === 0 ? 'no agents' : `${project.agents.length} agent${project.agents.length === 1 ? '' : 's'}`}
              </span>
            )}
            {project.active ? <span className="bmap-proj__here">here</span> : null}
          </span>
        </div>
      </div>
      {project.agents.map((a) => {
        const activity = stateOf(a.paneId)
        return (
          <div className="bmap-anchor" ref={bind(a.key)} key={a.key}>
            <button
              type="button"
              className="bmap-agent"
              data-node={a.key}
              data-state={activity.state}
              style={{ '--pane-accent': a.profile.accent, '--proj': project.color } as CSSProperties}
              aria-label={`${a.name}, ${a.profile.name} in ${project.name} — ${ACTIVITY_WORD[activity.state]}`}
              onPointerEnter={() => show(a.key)}
              onPointerLeave={hideSoon}
              onFocus={() => show(a.key)}
              onBlur={hideSoon}
              onClick={() => onOpen(project, a)}
            >
              <span className="bmap-agent__disc">
                <AgentBadge profile={a.profile} />
                {activity.state === 'attention' ? (
                  <span className="bmap-agent__flag" aria-hidden="true">
                    !
                  </span>
                ) : null}
                {activity.state === 'done' ? (
                  <span className="bmap-agent__flag bmap-agent__flag--done" aria-hidden="true">
                    <svg width="9" height="9" viewBox="0 0 10 10">
                      <path d="M1.4 5.4 L4 7.8 L8.8 2.4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                ) : null}
              </span>
              <span className="bmap-node__name">{a.name}</span>
              <span className="bmap-node__state" data-state={activity.state}>
                <StateGlyph state={activity.state} />
                {ACTIVITY_WORD[activity.state]}
              </span>
            </button>
          </div>
        )
      })}
    </>
  )
}

/* ------------------------------------------------------------------- card */

type FoundNode =
  | { kind: 'brain' }
  | { kind: 'voice' }
  | { kind: 'project'; project: MapProject }
  | { kind: 'agent'; project: MapProject; agent: MapAgent }

function findNode(list: MapProject[], key: string): FoundNode | null {
  if (key === 'brain') return { kind: 'brain' }
  if (key === 'voice') return { kind: 'voice' }
  for (const p of list) {
    if (p.key === key) return { kind: 'project', project: p }
    for (const a of p.agents) if (a.key === key) return { kind: 'agent', project: p, agent: a }
  }
  return null
}

function CardBody({
  node,
  brain,
  mood,
  voicePhase,
  voiceName,
  stateOf,
  reply,
  setReply,
  onOpen,
  onOpenBrain,
  onGo
}: {
  node: FoundNode
  brain: BrainStatus | null
  mood: BrainMood
  voicePhase: string
  voiceName: string
  stateOf: (paneId: string) => PaneActivity
  reply: string
  setReply: (text: string) => void
  onOpen: (project: MapProject, agent: MapAgent) => void
  onOpenBrain: () => void
  onGo: (projectId: string, paneId: string | null) => void
}): ReactNode {
  if (node.kind === 'brain') {
    return (
      <>
        <div className="bmap-card__head">
          <BrainGlyph size={18} />
          <span className="bmap-card__title">Forge Brain</span>
          <StateChip activity={brainActivity(mood)} compact />
        </div>
        {mood === 'off' ? (
          <p className="bmap-card__text">
            Off. Turn it on in Settings; Forge works without it.
          </p>
        ) : (
          <>
            <dl className="bmap-card__facts">
              <dt>State</dt>
              <dd>{MOOD_WORD[mood]}</dd>
              <dt>Runs on</dt>
              <dd>{brain ? (BRAIN_ENGINE_NAME[brain.engine] ?? text(brain.engine)) : '—'}</dd>
              <dt>Waiting</dt>
              <dd>
                {brain?.queued ?? 0} message{brain?.queued === 1 ? '' : 's'}
              </dd>
            </dl>
            {mood === 'error' && text(brain?.error) ? <p className="bmap-card__text">{text(brain?.error)}</p> : null}
            <Confirms brain={brain} />
            {brain?.paneId ? null : (
              <p className="bmap-card__text bmap-card__text--dim">Its terminal appears here once it has started.</p>
            )}
          </>
        )}
        {brain?.enabled && brain.paneId ? (
          <div className="bmap-card__actions">
            <button type="button" className="bmap-btn bmap-btn--cta" onClick={onOpenBrain}>
              <Icon name="terminal" size={13} />
              Open its terminal
            </button>
          </div>
        ) : null}
      </>
    )
  }

  if (node.kind === 'voice') {
    return (
      <>
        <div className="bmap-card__head">
          <Icon name="mic" size={15} />
          <span className="bmap-card__title">Voice agent</span>
          <span className="bmap-card__tag">{VOICE_WORD[voicePhase] ?? voicePhase}</span>
        </div>
        <p className="bmap-card__text">
          {voiceName ? `${voiceName} listens and answers out loud.` : 'Listens and answers out loud.'} It can hand work to Forge Brain, and
          the brain speaks back through it.
        </p>
      </>
    )
  }

  if (node.kind === 'project') {
    const p = node.project
    const by: Partial<Record<ActivityState, number>> = {}
    for (const a of p.agents) {
      const s = stateOf(a.paneId).state
      by[s] = (by[s] ?? 0) + 1
    }
    return (
      <>
        <div className="bmap-card__head">
          <span className="bmap-card__dot" style={{ background: p.color }} />
          <span className="bmap-card__title">{p.name}</span>
          {p.active ? <span className="bmap-card__tag">on screen</span> : null}
        </div>
        <p className="bmap-card__path">{p.path}</p>
        {p.agents.length === 0 ? (
          <p className="bmap-card__text">No agents open in this project.</p>
        ) : (
          <ul className="bmap-card__tally">
            {(Object.keys(by) as ActivityState[]).map((s) => (
              <li key={s} data-state={s}>
                <StateGlyph state={s} />
                <b>{by[s]}</b> {ACTIVITY_WORD[s].toLowerCase()}
              </li>
            ))}
          </ul>
        )}
        <div className="bmap-card__actions">
          <button type="button" className="bmap-btn bmap-btn--cta" onClick={() => onGo(p.id, null)}>
            Go to project
            <Icon name="chevronRight" size={13} />
          </button>
        </div>
      </>
    )
  }

  const { project, agent } = node
  const activity = stateOf(agent.paneId)
  const open = terminalHost.has(agent.paneId)
  const lines = open ? lastLines(agent.paneId, 2) : []
  const question = activity.state === 'attention' ? terminalHost.attentionPrompt(agent.paneId) : ''
  return (
    <>
      <div className="bmap-card__head" style={{ '--pane-accent': agent.profile.accent } as CSSProperties}>
        <AgentBadge profile={agent.profile} />
        <span className="bmap-card__title">{agent.name}</span>
        <StateChip activity={activity} />
      </div>
      <p className="bmap-card__sub">
        <span className="bmap-card__dot" style={{ background: project.color }} />
        {project.name}
        <span className="bmap-card__sep">·</span>
        {agent.profile.name}
      </p>
      {question ? <p className="bmap-card__ask">{question}</p> : null}
      {lines.length ? (
        <div className="bmap-card__screen" aria-label="Last lines on its screen">
          {lines.map((l, i) => (
            <div key={i} className="bmap-card__line">
              {l}
            </div>
          ))}
        </div>
      ) : !open ? (
        <p className="bmap-card__text bmap-card__text--dim">Not opened this session. Going to it starts it.</p>
      ) : null}
      {activity.state === 'attention' && open ? (
        <form
          className="bmap-card__reply"
          onSubmit={(e) => {
            e.preventDefault()
            const text = reply.trim()
            if (!text) return
            if (terminalHost.type(agent.paneId, text)) terminalHost.submit(agent.paneId)
            setReply('')
          }}
        >
          <input
            className="bmap-card__input"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Answer it… (typed in, then Enter)"
            aria-label={`Answer ${agent.name}`}
          />
          <button type="submit" className="bmap-btn" disabled={!reply.trim()}>
            <Icon name="send" size={13} />
          </button>
        </form>
      ) : null}
      <div className="bmap-card__actions">
        {open ? (
          <button type="button" className="bmap-btn bmap-btn--cta" onClick={() => onOpen(project, agent)}>
            <Icon name="terminal" size={13} />
            Open here
          </button>
        ) : null}
        <button type="button" className="bmap-btn" onClick={() => onGo(project.id, agent.paneId)}>
          Go to it
          <Icon name="chevronRight" size={13} />
        </button>
      </div>
    </>
  )
}
