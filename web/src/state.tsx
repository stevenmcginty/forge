import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  HOST_HEARTBEAT_MS,
  MAX_REPLAY_BYTES,
  webSocketUrl,
  type WebHostRecord,
  type WebLayoutOp,
  type WebRequest,
  type WebResult,
  type WebSession
} from '@shared/web'
import type { AgentProfile, GitSnapshot, Project, Workspace } from '@shared/types'
import { ALLOW_LOOPBACK, devLoopbackHost, loadConfig, type WebClientConfig } from './config'
import { Auth, isSignedOutError, type Session } from './lib/auth'
import { ForgeClient, type Connection } from './lib/client'
import {
  clearSnapshot,
  loadSnapshot,
  rememberGit,
  rememberPicture,
  rememberProjects,
  rememberSessions,
  rememberTranscripts,
  rememberWorkspace,
  sameProjects,
  type Snapshot
} from './lib/cache'
import { deviceId, deviceName } from './lib/device'
import { readHost } from './lib/rendezvous'

/**
 * Everything the page knows, in one place, and the one seam every screen reads
 * through.
 *
 * The shape of this file is the shape of the product: a *connection state* that
 * is first-class rather than a spinner, a *picture* that only ever arrives from
 * the desktop, and a *cached* copy of that picture for when the desktop is off.
 * There is deliberately no setter for a tab, a pane or a split — decision 5 in
 * docs/forge-web.md is that the browser mirrors, so every layout gesture is a
 * `layout` request and what redraws this page is the `workspace` push that comes
 * back. The only local selection is which project this browser is *looking at*,
 * and that is local because the protocol has no field for it (see `selectProject`).
 */

/** The opening picture, kept current by the push frames. */
export interface Picture {
  desktopName: string
  appVersion: string
  projects: Project[]
  profiles: AgentProfile[]
  workspaces: Record<string, Workspace>
  sessions: WebSession[]
  /** The desk's nominated projects folder, or '' when none is set. Display only. */
  projectsRoot: string
}

/** What the whole page is doing, before any of the connection detail. */
export type Stage =
  /** Reading /config.json. */
  | { kind: 'loading' }
  /** No configuration, so nothing else can happen. One sentence, no retry. */
  | { kind: 'unconfigured'; error: string }
  | { kind: 'signed-out'; error: string }
  /** Signed in; looking up where the desktop is. */
  | { kind: 'finding' }
  /** The rendezvous record could not be read at all — not the same as "off". */
  | { kind: 'unreachable'; error: string }
  /** A desktop was found and the socket is doing whatever `connection` says. */
  | { kind: 'connected' }
  /**
   * No desktop to talk to. The frozen, badged picture — `record` names the
   * desktop when there was a stale record to name it from.
   */
  | { kind: 'offline'; message: string; record: WebHostRecord | null }

/**
 * Which half of offline mode this browser is looking at.
 *
 * Decision 10 is the frozen picture and decision 9 is GitHub; they are two
 * halves of the same "the desktop is off" screen rather than two apps, so this
 * is one flag on the offline stage rather than a second stage. `OfflineBanner`
 * owns the switch, because the banner is already the sentence that says the
 * picture is frozen — the place somebody is standing when they decide they want
 * the files instead.
 */
export type OfflineMode = 'frozen' | 'github'

export interface ForgeState {
  stage: Stage
  connection: Connection
  session: Session | null
  /** The deployment facts, once `/config.json` has been read. */
  config: WebClientConfig | null
  picture: Picture | null
  /** The last picture this browser was handed, for the offline view. */
  cached: Snapshot | null
  /** Which project this browser is showing. See `selectProject`. */
  projectId: string | null
  /** projectId → the latest snapshot the desktop sent or answered with. */
  git: Record<string, GitSnapshot>
  /** Panes that have settled on a question, so a tab you are not looking at can say so. */
  asking: Set<string>
  /** One transient sentence — a refused write, a pane that vanished. */
  notice: string
  /** Is the link answering right now? Only the badge reads this. */
  warm: boolean
  /** Frozen terminals, or the repository from GitHub. Only read while offline. */
  offlineMode: OfflineMode
}

export interface ForgeActions {
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => void
  /** A human pressed "Try again" on a screen the client had stopped at. */
  retry: () => void
  /**
   * A human typed the desktop's unlock PIN. Reconnects carrying it; the PIN is
   * spent on that one attempt whatever the desktop makes of it.
   */
  submitPin: (pin: string) => void
  /** Look for the desktop again — the offline screen's button, and its poll. */
  refind: () => void
  selectProject: (projectId: string) => void
  /** One layout gesture. Resolves with the desktop's refusal sentence, or null. */
  layout: (op: Omit<WebLayoutOp, 'projectId'> & { projectId?: string }) => Promise<string | null>
  request: (body: WebRequest) => Promise<WebResult>
  attach: (sessionId: string, size: { cols: number; rows: number } | null) => void
  detach: (sessionId: string) => void
  write: (sessionId: string, data: string) => void
  resize: (sessionId: string, cols: number, rows: number) => void
  /** Take a pane's grid for this browser without typing. The phone layout's. */
  claim: (sessionId: string) => void
  /** Subscribe to a pane's bytes. Returns the unsubscribe. */
  onData: (sessionId: string, listener: (data: string, replay: boolean, truncated: boolean) => void) => () => void
  setNotice: (message: string) => void
  /** Switch between the frozen picture and GitHub mode. Offline only. */
  setOfflineMode: (mode: OfflineMode) => void
}

interface ForgeContextValue {
  state: ForgeState
  actions: ForgeActions
}

const ForgeContext = createContext<ForgeContextValue | null>(null)

export function useForge(): ForgeContextValue {
  const value = useContext(ForgeContext)
  if (!value) throw new Error('useForge outside <ForgeProvider>')
  return value
}

/** The active project's workspace, or an empty one so callers need no null branch. */
export function useWorkspace(): Workspace {
  const { state } = useForge()
  const id = state.projectId
  const workspaces = state.picture?.workspaces ?? state.cached?.workspaces ?? {}
  return (id ? workspaces[id] : undefined) ?? { tabs: [], activeTabId: null }
}

export function useActiveProject(): Project | null {
  const { state } = useForge()
  const projects = state.picture?.projects ?? state.cached?.projects ?? []
  return projects.find((p) => p.id === state.projectId) ?? null
}

/**
 * The launchable agent profiles, live or cached.
 *
 * One accessor rather than `state.picture?.profiles ?? []` at each call site,
 * because that expression has a wrong answer: with the desktop off the picture
 * is null, an empty list makes `resolveProfile` fall back to a built-in, and
 * every frozen pane draws the wrong badge and the wrong accent. The cache keeps
 * them for exactly that reason — see SNAPSHOT_VERSION 2 in lib/cache.ts.
 */
export function useProfiles(): AgentProfile[] {
  const { state } = useForge()
  return state.picture?.profiles ?? state.cached?.profiles ?? []
}

/* -------------------------------------------------------------- ceilings */

/**
 * How far an in-memory transcript may run past MAX_REPLAY_BYTES before it is cut
 * back to it.
 *
 * The ceiling itself is not a number invented here — it is the same
 * MAX_REPLAY_BYTES the desktop sends on attach and the cache holds each
 * transcript to, so a live pane and a frozen one describe the same amount of
 * scrollback. What the slack buys is the *cost* of holding it. Appending is a
 * cheap join, but slicing the result forces the engine to flatten the whole
 * string first, so cutting to an exact ceiling on every frame would copy the
 * best part of 200KB per pane at the eighty frames a second a redrawing TUI
 * produces — the cure costing more than the disease. Overshooting by one slab
 * and cutting back in one go makes that copy a rare event and costs nothing on
 * disk, because `rememberTranscripts` trims to the ceiling exactly on the way
 * into the cache.
 */
const TRANSCRIPT_SLACK_BYTES = 32 * 1024

/**
 * How many failed dials in a row mean the rendezvous record was not true.
 *
 * The record is a *claim* about a desktop rather than a connection to one, and
 * HOST_STALE_MS gives that claim three minutes of credibility — so for up to
 * three minutes after a machine sleeps without saying so, the browser is dialling
 * an address nothing is listening on. That much is unavoidable and by design.
 * What is not is where it leaves the page: the `Connecting` screen has no button
 * on it, and the poll that would look at the record again only runs while the
 * stage is `offline`, so the tab is stranded until somebody reloads it.
 *
 * Six, because lib/client.ts's own back-off is six steps from 500ms to its 15s
 * cap: long enough that a wifi blink or a tunnel restarting mid-dial is ridden
 * out by the retry loop rather than by the page, and about half a minute in all
 * — comfortably inside the three minutes the record stays credible for, which is
 * far too long for a browser to spend on a screen it cannot act on.
 */
const STRANDED_ATTEMPTS = 6

/** A transcript, held to the ceiling above. See TRANSCRIPT_SLACK_BYTES. */
function capTranscript(text: string): string {
  return text.length > MAX_REPLAY_BYTES + TRANSCRIPT_SLACK_BYTES ? text.slice(text.length - MAX_REPLAY_BYTES) : text
}

/* -------------------------------------------------------------- provider */

export function ForgeProvider({ children }: { children: ReactNode }): ReactNode {
  const [stage, setStage] = useState<Stage>({ kind: 'loading' })
  const [connection, setConnection] = useState<Connection>({ state: 'connecting', attempt: 0 })
  const [session, setSession] = useState<Session | null>(null)
  const [picture, setPicture] = useState<Picture | null>(null)
  const [cached, setCached] = useState<Snapshot | null>(() => loadSnapshot())
  const [projectId, setProjectId] = useState<string | null>(null)
  const [git, setGit] = useState<Record<string, GitSnapshot>>({})
  const [asking, setAsking] = useState<Set<string>>(() => new Set())
  const [notice, setNotice] = useState('')
  const [warm, setWarm] = useState(false)
  const [config, setConfig] = useState<WebClientConfig | null>(null)
  const [offlineMode, setOfflineMode] = useState<OfflineMode>('frozen')

  const configRef = useRef<WebClientConfig | null>(null)
  const authRef = useRef<Auth | null>(null)
  /**
   * Per-pane byte listeners, held outside React state on purpose: PTY output
   * arrives up to eighty frames a second per pane, and a re-render per frame,
   * times sixteen panes, is the thing that would make this feel like a web app
   * rather than like Forge. xterm is written to be fed directly.
   */
  const dataListeners = useRef(new Map<string, Set<(data: string, replay: boolean, truncated: boolean) => void>>())
  /**
   * What each attached pane has said, so the frozen view has something to show.
   *
   * Held in memory and flushed on a timer rather than written per frame: PTY
   * output arrives up to eighty frames a second per pane, and `localStorage` is
   * synchronous — a write per frame would block the main thread on disk while a
   * TUI redraws. See `flushTranscripts`.
   *
   * Bounded, and it has to be: an agent left working for an afternoon is tens of
   * megabytes of output, all of which was being carried here for the sake of the
   * last MAX_REPLAY_BYTES of it — and every flush then handed the whole thing to
   * the cache to be sliced. See `capTranscript`.
   */
  const transcripts = useRef(new Map<string, string>())
  const dirtyTranscripts = useRef(new Set<string>())

  const clientRef = useRef<ForgeClient | null>(null)
  if (!clientRef.current) {
    clientRef.current = new ForgeClient({
      onConnection: (next) => {
        setConnection(next)
        // A shutdown frame is the one route from a live socket into the frozen
        // view without another rendezvous read: the desktop said, in as many
        // words, that it is going away.
        if (next.state === 'offline') setStage({ kind: 'offline', message: next.message, record: null })
        // And this is the route back out of a record that was not true. `find`
        // moves the stage to `connected` on the strength of a live record, which
        // is what that stage means — a desktop was found, and `connection` says
        // the rest — but nothing was ever going to move it back if the socket
        // then could not be opened: this loop only ever announces another
        // attempt, and the poll that re-reads the record runs only while the
        // stage is `offline`. So the loop is given STRANDED_ATTEMPTS to make
        // good on the record, and then the page goes back to the frozen picture,
        // where there is both a poll and a button. The link is deliberately left
        // dialling underneath it: whichever of the two gets through first,
        // `hello-ok` is what puts the workspace back.
        if (next.state === 'connecting' && next.attempt >= STRANDED_ATTEMPTS) {
          setStage((current) =>
            current.kind === 'connected'
              ? {
                  kind: 'offline',
                  message: 'It published an address a moment ago, but nothing is answering there.',
                  record: null
                }
              : current
          )
        }
      },
      onPicture: (frame) => {
        setStage({ kind: 'connected' })
        setPicture({
          desktopName: frame.desktopName,
          appVersion: frame.appVersion,
          projects: frame.projects,
          profiles: frame.profiles,
          workspaces: frame.workspaces,
          sessions: frame.sessions,
          projectsRoot: frame.projectsRoot ?? ''
        })
        // Written down and held, from the one object rather than by reading back
        // what was just written: `rememberPicture` hands over what it stored.
        // Stamped with whose picture it is, so a later sign-in as somebody else
        // cannot inherit it — see SNAPSHOT_VERSION 4 in lib/cache.ts.
        setCached(rememberPicture(frame, authRef.current?.current()?.uid ?? ''))
        setProjectId((current) => current ?? frame.projects[0]?.id ?? null)
      },
      onData: (sessionId, data, replay, truncated) => {
        // The replay *replaces*, live data *appends*: a reconnect sends the
        // buffer again, and appending it would double the cached transcript the
        // frozen view later paints.
        const previous = replay ? '' : (transcripts.current.get(sessionId) ?? '')
        transcripts.current.set(sessionId, capTranscript(previous + data))
        dirtyTranscripts.current.add(sessionId)
        const listeners = dataListeners.current.get(sessionId)
        if (!listeners) return
        for (const listener of listeners) listener(data, replay, truncated)
      },
      onExit: (sessionId) => {
        setPicture((current) =>
          current ? { ...current, sessions: current.sessions.filter((s) => s.id !== sessionId) } : current
        )
      },
      onSessions: (sessions) => {
        setPicture((current) => (current ? { ...current, sessions } : current))
        rememberSessions(sessions)
      },
      onSessionStarted: (started) => {
        setPicture((current) =>
          current && !current.sessions.some((s) => s.id === started.id)
            ? { ...current, sessions: [...current.sessions, started] }
            : current
        )
      },
      onAttention: (sessionId, isAsking) => {
        setAsking((current) => {
          const next = new Set(current)
          if (isAsking) next.add(sessionId)
          else next.delete(sessionId)
          return next
        })
      },
      onProjects: (projects) => {
        // Only when it is actually a different list. The desktop answers a great
        // many things with a `projects` push whether or not anything changed —
        // clicking into a pane is a `focus-pane`, and one of these comes back
        // from it — and a fresh `Picture` object is a fresh `state` object, which
        // is every component in the app re-rendering, every pane included, for a
        // list that reads identically. `rememberProjects` declines the same push
        // for the same reason, on the same comparison.
        setPicture((current) =>
          current && !sameProjects(current.projects, projects) ? { ...current, projects } : current
        )
        rememberProjects(projects)
        setProjectId((current) => (current && projects.some((p) => p.id === current) ? current : (projects[0]?.id ?? null)))
      },
      onWorkspace: (id, workspace) => {
        setPicture((current) =>
          current ? { ...current, workspaces: { ...current.workspaces, [id]: workspace } } : current
        )
        rememberWorkspace(id, workspace)
      },
      onGit: (snapshot) => {
        setGit((current) => ({ ...current, [snapshot.projectId]: snapshot }))
        // The one field of it that outlives the connection. GitHub mode cannot
        // ask a desktop that is off which repository a project is, so the answer
        // is written down while there is somebody to answer.
        //
        // And only re-held when it was actually written: the git watcher fires
        // on every file save, so an unconditional `setCached` was a new snapshot
        // object — and with it a re-render of every pane in the workspace —
        // several times a minute for a remote that changes about once a year.
        const written = rememberGit(snapshot)
        if (written) setCached(written)
      },
      onNotice: setNotice,
      onTokenRejected: () => {
        authRef.current?.signOut()
        setSession(null)
        setStage({ kind: 'signed-out', error: 'That sign-in is no longer valid. Sign in again.' })
      }
    })
  }
  const client = clientRef.current

  /* --------------------------------------------------- finding the desktop */

  /**
   * Read the rendezvous record and either dial or drop to the frozen view.
   *
   * `isHostLive` is the whole of the decision and it lives in shared/web.ts, so
   * "the desktop is available" means the same thing to the browser as it does to
   * the desktop that publishes the record. Not live means offline; nothing is
   * dialled, exactly as the brief for this phase requires.
   */
  const find = useCallback(async (): Promise<void> => {
    const config = configRef.current
    const auth = authRef.current
    if (!config || !auth) return
    setStage({ kind: 'finding' })

    let idToken: string
    try {
      idToken = await auth.idToken()
    } catch (err) {
      if (isSignedOutError(err)) {
        setSession(null)
        setStage({ kind: 'signed-out', error: 'That sign-in expired. Sign in again.' })
        return
      }
      setStage({ kind: 'unreachable', error: 'Could not reach Firebase to refresh the sign-in.' })
      return
    }

    // The dev loop's escape hatch, and the only one: a Forge on this very
    // machine has no tunnel and no certificate, so `wss://localhost` cannot be
    // honoured by anything. `devLoopbackHost` is compiled out of a production
    // build — see its comment — so this branch cannot exist in one.
    const dev = devLoopbackHost(config)
    if (dev) {
      const url = webSocketUrl(dev, ALLOW_LOOPBACK)
      if (!url) {
        setStage({ kind: 'unreachable', error: `devHost "${dev}" is not an address this page can dial.` })
        return
      }
      setStage({ kind: 'connected' })
      client.connect({
        url,
        getToken: (force) => (force ? auth.idToken() : Promise.resolve(idToken)),
        deviceId: deviceId(),
        deviceName: deviceName()
      })
      return
    }

    const lookup = await readHost(config, auth.current()?.uid ?? '', idToken)
    if (lookup.state === 'unreadable') {
      setStage({ kind: 'unreachable', error: lookup.error })
      return
    }
    if (lookup.state === 'absent') {
      setStage({
        kind: 'offline',
        message: lookup.record
          ? `${lookup.record.name || 'The desktop'} is not answering — Forge is not running there right now.`
          : 'No desktop has published itself for this account yet.',
        record: lookup.record
      })
      return
    }

    const url = webSocketUrl(lookup.record.host)
    if (!url) {
      setStage({ kind: 'unreachable', error: 'The desktop published an address this page cannot dial.' })
      return
    }
    setStage({ kind: 'connected' })
    client.connect({
      url,
      getToken: (force) => (force ? auth.idToken() : Promise.resolve(idToken)),
      deviceId: deviceId(),
      deviceName: deviceName(),
      // Where the desktop is *now*, asked afresh before every re-dial. See
      // `refindUrl` in lib/client.ts: a tunnel that restarts comes back on a
      // different hostname, and the record here is refreshed within seconds of
      // that happening. '' where there is nothing better to say — an absent or
      // unreadable record is not grounds for the loop to abandon the address it
      // already has.
      refindUrl: async () => {
        const token = await auth.idToken()
        const again = await readHost(config, auth.current()?.uid ?? '', token)
        return again.state === 'live' ? webSocketUrl(again.record.host) : ''
      }
    })
  }, [client])

  /* --------------------------------------------------------------- startup */

  useEffect(() => {
    let cancelled = false
    void loadConfig().then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setStage({ kind: 'unconfigured', error: result.error })
        return
      }
      configRef.current = result.config
      setConfig(result.config)
      const auth = new Auth(result.config)
      authRef.current = auth
      const current = auth.current()
      setSession(current)
      // The snapshot loaded at mount was read before anybody knew whose browser
      // this is. If it belongs to a different account than the stored session —
      // or there is no session at all — it is somebody else's picture, not a
      // cache, and it goes.
      const held = loadSnapshot()
      if (held && held.uid !== (current?.uid ?? '')) {
        clearSnapshot()
        setCached(null)
      }
      if (auth.signedIn()) void find()
      else setStage({ kind: 'signed-out', error: '' })
    })
    return () => {
      cancelled = true
    }
  }, [find])

  /**
   * Look again while the desktop is off.
   *
   * On the desktop's own heartbeat rather than a number invented here: the
   * record is refreshed every HOST_HEARTBEAT_MS, so asking more often than that
   * cannot learn anything new, and asking less often is a browser that sits on
   * "asleep" for minutes after Forge came back.
   */
  useEffect(() => {
    if (stage.kind !== 'offline') return
    const timer = window.setInterval(() => void find(), HOST_HEARTBEAT_MS)
    return () => clearInterval(timer)
  }, [stage.kind, find])

  /**
   * The frozen view needs a project selected too, and it has no `hello-ok` to
   * take one from — so it takes it from the cache, which is the only picture
   * there is while the desktop is off.
   */
  useEffect(() => {
    if (stage.kind !== 'offline') return
    setProjectId((current) => current ?? cached?.projects[0]?.id ?? null)
  }, [stage.kind, cached])

  /**
   * A desktop that came back takes the page with it.
   *
   * The poll above is what notices, and `client.connect` is what dials — no
   * reload anywhere. All this does is put the offline switch back where it
   * started, so the *next* time the machine goes away the browser opens on the
   * frozen picture rather than on a repository somebody looked at yesterday.
   */
  useEffect(() => {
    if (stage.kind !== 'offline') setOfflineMode('frozen')
  }, [stage.kind])

  /**
   * Write what the panes have said into the offline cache.
   *
   * On a timer, and again when the tab is being put away — `pagehide` is the one
   * event that fires for a reload, a navigation and a closed tab alike, and
   * without it everything said since the last tick is lost exactly when the
   * cache is about to be needed.
   *
   * Every dirty pane in one write, because the snapshot is read and written
   * whole: a call per pane was a parse and a synchronous `setItem` of the entire
   * cache *per pane*, on a three-second timer, which is precisely the rhythm
   * somebody working in three panes could feel under their typing.
   */
  useEffect(() => {
    const flush = (): void => {
      if (dirtyTranscripts.current.size === 0) return
      const said = [...dirtyTranscripts.current].map((sessionId) => ({
        sessionId,
        data: transcripts.current.get(sessionId) ?? ''
      }))
      dirtyTranscripts.current.clear()
      rememberTranscripts(said)
    }
    const timer = window.setInterval(flush, 3000)
    window.addEventListener('pagehide', flush)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  /** The badge's own clock. Cheap, and the only thing that reads `warm`. */
  useEffect(() => {
    const timer = window.setInterval(() => setWarm(client.warm), 2000)
    return () => clearInterval(timer)
  }, [client])

  /** A notice is a sentence, not a state. It clears itself. */
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  /* --------------------------------------------------------------- actions */

  const actions = useMemo<ForgeActions>(
    () => ({
      signIn: async (email, password) => {
        const auth = authRef.current
        if (!auth) throw new Error('This page is not configured yet.')
        const next = await auth.signIn(email, password)
        // A different account than the one whose picture is cached starts from
        // nothing: the frozen view, the selected project and the git panel all
        // describe the previous account's desktop, not this one's.
        const held = loadSnapshot()
        if (held && held.uid !== next.uid) {
          clearSnapshot()
          setCached(null)
          setPicture(null)
          setProjectId(null)
          setGit({})
        }
        setSession(next)
        await find()
      },
      signOut: () => {
        client.disconnect()
        authRef.current?.signOut()
        // The frozen picture is the signed-in account's workspace — projects,
        // transcripts, desktop name. On a page whose whole point is "any
        // browser, one URL", sign-out must leave nothing for the next person.
        clearSnapshot()
        transcripts.current.clear()
        dirtyTranscripts.current.clear()
        setCached(null)
        setSession(null)
        setPicture(null)
        setProjectId(null)
        setGit({})
        setStage({ kind: 'signed-out', error: '' })
      },
      retry: () => client.retry(),
      submitPin: (pin) => client.submitPin(pin),
      refind: () => void find(),
      selectProject: (id) => {
        // Local *and* mirrored. Which project this browser is looking at is not
        // in `hello-ok` and not in any push — the protocol has no field for it —
        // so the selection has to live here. `select-project` is still sent,
        // because it is a layout op and the desk follows: opening a project in
        // the browser brings it up on the desktop too, which is decision 5.
        setProjectId(id)
        void client.layout({ op: 'select-project', projectId: id })
      },
      layout: async (op) => {
        const id = op.projectId ?? projectId
        if (!id) return 'There is no project to do that in.'
        const error = await client.layout({ ...op, projectId: id } as WebLayoutOp)
        if (error) setNotice(error)
        return error
      },
      request: (body) => client.request(body),
      attach: (sessionId, size) => client.attach(sessionId, size),
      detach: (sessionId) => client.detach(sessionId),
      write: (sessionId, data) => client.write(sessionId, data),
      resize: (sessionId, cols, rows) => client.resize(sessionId, cols, rows),
      claim: (sessionId) => void client.request({ kind: 'claim', sessionId }),
      onData: (sessionId, listener) => {
        const map = dataListeners.current
        const set = map.get(sessionId) ?? new Set()
        set.add(listener)
        map.set(sessionId, set)
        return () => {
          set.delete(listener)
          if (set.size === 0) map.delete(sessionId)
        }
      },
      setNotice,
      setOfflineMode
    }),
    [client, find, projectId]
  )

  const state = useMemo<ForgeState>(
    () => ({
      stage,
      connection,
      session,
      config,
      picture,
      cached,
      projectId,
      git,
      asking,
      notice,
      warm,
      offlineMode
    }),
    [stage, connection, session, config, picture, cached, projectId, git, asking, notice, warm, offlineMode]
  )

  return <ForgeContext.Provider value={{ state, actions }}>{children}</ForgeContext.Provider>
}
