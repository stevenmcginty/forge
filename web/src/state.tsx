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
  loadSnapshot,
  rememberPicture,
  rememberProjects,
  rememberSessions,
  rememberTranscript,
  rememberWorkspace,
  type Snapshot
} from './lib/cache'
import { deviceId, deviceName, forgetDevice } from './lib/device'
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

export interface ForgeState {
  stage: Stage
  connection: Connection
  session: Session | null
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
}

export interface ForgeActions {
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => void
  /** A human pressed "Try again" on a screen the client had stopped at. */
  retry: () => void
  /** Look for the desktop again — the offline screen's button, and its poll. */
  refind: () => void
  /** Forget this browser's device id, so the next connection asks to be let in again. */
  forgetThisBrowser: () => void
  selectProject: (projectId: string) => void
  /** One layout gesture. Resolves with the desktop's refusal sentence, or null. */
  layout: (op: Omit<WebLayoutOp, 'projectId'> & { projectId?: string }) => Promise<string | null>
  request: (body: WebRequest) => Promise<WebResult>
  attach: (sessionId: string, size: { cols: number; rows: number } | null) => void
  detach: (sessionId: string) => void
  write: (sessionId: string, data: string) => void
  resize: (sessionId: string, cols: number, rows: number) => void
  /** Subscribe to a pane's bytes. Returns the unsubscribe. */
  onData: (sessionId: string, listener: (data: string, replay: boolean, truncated: boolean) => void) => () => void
  setNotice: (message: string) => void
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
      },
      onPicture: (frame) => {
        setStage({ kind: 'connected' })
        setPicture({
          desktopName: frame.desktopName,
          appVersion: frame.appVersion,
          projects: frame.projects,
          profiles: frame.profiles,
          workspaces: frame.workspaces,
          sessions: frame.sessions
        })
        rememberPicture(frame)
        setCached(loadSnapshot())
        setProjectId((current) => current ?? frame.projects[0]?.id ?? null)
      },
      onData: (sessionId, data, replay, truncated) => {
        // The replay *replaces*, live data *appends*: a reconnect sends the
        // buffer again, and appending it would double the cached transcript the
        // frozen view later paints.
        const previous = replay ? '' : (transcripts.current.get(sessionId) ?? '')
        transcripts.current.set(sessionId, previous + data)
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
        setPicture((current) => (current ? { ...current, projects } : current))
        rememberProjects(projects)
        setProjectId((current) => (current && projects.some((p) => p.id === current) ? current : (projects[0]?.id ?? null)))
      },
      onWorkspace: (id, workspace) => {
        setPicture((current) =>
          current ? { ...current, workspaces: { ...current.workspaces, [id]: workspace } } : current
        )
        rememberWorkspace(id, workspace)
      },
      onGit: (snapshot) => setGit((current) => ({ ...current, [snapshot.projectId]: snapshot })),
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
      deviceName: deviceName()
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
      const auth = new Auth(result.config)
      authRef.current = auth
      const current = auth.current()
      setSession(current)
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
   * Write what the panes have said into the offline cache.
   *
   * On a timer, and again when the tab is being put away — `pagehide` is the one
   * event that fires for a reload, a navigation and a closed tab alike, and
   * without it everything said since the last tick is lost exactly when the
   * cache is about to be needed.
   */
  useEffect(() => {
    const flush = (): void => {
      if (dirtyTranscripts.current.size === 0) return
      for (const sessionId of dirtyTranscripts.current) {
        rememberTranscript(sessionId, transcripts.current.get(sessionId) ?? '')
      }
      dirtyTranscripts.current.clear()
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
        setSession(next)
        await find()
      },
      signOut: () => {
        client.disconnect()
        authRef.current?.signOut()
        setSession(null)
        setPicture(null)
        setStage({ kind: 'signed-out', error: '' })
      },
      retry: () => client.retry(),
      refind: () => void find(),
      forgetThisBrowser: () => {
        forgetDevice()
        client.retry()
      },
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
      setNotice
    }),
    [client, find, projectId]
  )

  const state = useMemo<ForgeState>(
    () => ({ stage, connection, session, picture, cached, projectId, git, asking, notice, warm }),
    [stage, connection, session, picture, cached, projectId, git, asking, notice, warm]
  )

  return <ForgeContext.Provider value={{ state, actions }}>{children}</ForgeContext.Provider>
}
