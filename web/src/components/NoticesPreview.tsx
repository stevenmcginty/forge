import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { BUILTIN_AGENT_PROFILES } from '@shared/agents'
import type { BrainConfirmRequest } from '@shared/brain'
import type { PaneLeaf, Project, TerminalTab, Workspace as WorkspaceShape } from '@shared/types'
import { collectLeaves } from '@/lib/splitTree'
import { useDeckTheme } from '../deck/theme'
import type { WebUpdate } from '../lib/update'
import { ForgeContext, type ForgeActions, type ForgeState, type Picture } from '../state'
import { AnswerCard, registerAnswerScreen } from './AnswerCard'
import { AskBanner } from './AskBanner'
import { BrainConfirm } from './BrainConfirm'
import { MOCK_TURNS } from './chat-preview-data'
import { ChatView } from './ChatView'
import { Composer } from './Composer'
import { OfflineBanner } from './OfflineBanner'
import { PREVIEW_VOICE, PreviewFan, PreviewLine, PreviewListen } from './Preview'
import { SpeechKeyCardView } from './SpeechKeyCard'
import { TabStrip } from './TabStrip'
import { TopBar } from './TopBar'
import { UpdateBanner } from './UpdateBanner'
import { NoticeToast, ReconnectingBanner, RecoveringBanner, RemoteYesBanner } from './Workspace'

/**
 * `?preview=notices&phone` on the dev server: every notice the phone can show,
 * in its real place in the real shell (TopBar, TabStrip, a chat, the composer)
 * on a fixture `ForgeContext`, so the whole family can be looked at side by
 * side with no desktop. Compiled out of every `vite build` by the
 * `__DEV_SERVER__` gate in main.tsx. No harness bar: the page is the phone.
 *
 * URL params:
 *  `show=<id>`   one notice (default `stack`):
 *                needs an answer — `banner` `banner-short` `brain` `brain-high` `ask` `ask-danger` `ask-yesno` `ask-prose`
 *                tells you something — `toast` `toast-long`
 *                ambient — `offline` `offline-github` `reconnecting` `recovering` `remoteyes` `update`
 *                setup — `speechkey`
 *  `stack=1`     (or `show=stack`) every notice, one frame each, in priority order
 *  `theme=<id>`  one of the eight themes
 *  `key=bad`     the dictation card's Save answers with a refusal (default: kept)
 *  `refuse=1`    the Brain card's Yes / No answers "no longer waiting"
 *
 * Writes to `document.body.dataset`: `last` (open | dismiss | brain-yes | brain-no
 * | toast-dismiss) and `writes` (how many key writes the answer card made), for
 * the scripted checks.
 */

function param(name: string): string | null {
  return new URLSearchParams(location.search).get(name)
}

type NoticeId =
  | 'banner'
  | 'banner-short'
  | 'brain'
  | 'brain-high'
  | 'ask'
  | 'ask-danger'
  | 'ask-yesno'
  | 'ask-prose'
  | 'toast'
  | 'toast-long'
  | 'offline'
  | 'offline-github'
  | 'reconnecting'
  | 'recovering'
  | 'remoteyes'
  | 'update'
  | 'speechkey'

/** Highest first: the order the phone picks one of each kind. */
const STACK: { id: NoticeId; note: string }[] = [
  { id: 'brain', note: 'Needs an answer · top of the display, over everything there' },
  { id: 'brain-high', note: 'Needs an answer · high risk, two more waiting' },
  { id: 'banner', note: 'Needs an answer · another pane is asking (under the Brain card)' },
  { id: 'banner-short', note: 'Needs an answer · short question' },
  { id: 'ask', note: 'Needs an answer · the pane on screen, docked on the composer' },
  { id: 'ask-danger', note: 'Needs an answer · a destructive choice and an "always" choice' },
  { id: 'ask-yesno', note: 'Needs an answer · a plain yes / no' },
  { id: 'ask-prose', note: 'Needs an answer · words only' },
  { id: 'speechkey', note: 'Setup · under the banner and the Brain card' },
  { id: 'toast', note: 'Tells you · above the composer, 6 s' },
  { id: 'toast-long', note: 'Tells you · an error, 15 s or a tap' },
  { id: 'remoteyes', note: 'Ambient 1 · admin prompt (waits 2 min)' },
  { id: 'offline', note: 'Ambient 2 · desktop asleep' },
  { id: 'offline-github', note: 'Ambient 2 · asleep, GitHub mode' },
  { id: 'reconnecting', note: 'Ambient 3 · link dropped' },
  { id: 'recovering', note: 'Ambient 4 · desktop window restarting' },
  { id: 'update', note: 'Ambient 5 · new build' }
]

const leaf = (id: string, profileId: string, title = ''): PaneLeaf => ({ type: 'leaf', id, profileId, title })

const FORGE_TABS: TerminalTab[] = [
  { id: 't1', title: 'Zeb', root: leaf('p1', 'claude'), activePaneId: 'p1' },
  { id: 't2', title: 'Mara', root: leaf('p2', 'codex'), activePaneId: 'p2' }
]
const CAR_TABS: TerminalTab[] = [{ id: 't9', title: 'ECU mapping', root: leaf('p9', 'claude'), activePaneId: 'p9' }]

const LONG_ASK =
  'Do you want to make this edit to electron/web-host.ts? The change rewrites the push sender so each device is notified unless it is on screen. 1. Yes  2. Yes, and allow all edits this session  3. No'

/** A Claude Code edit prompt, long enough to fold. */
const EDIT_SCREEN = [
  '● Update(web/src/lib/notify.ts)',
  '',
  '╭──────────────────────────────────────────────╮',
  '│ Edit file                                    │',
  '│ ╭──────────────────────────────────────────╮ │',
  '│ │ web/src/lib/notify.ts                    │ │',
  '│ │                                          │ │',
  '│ │  64    export function noteWords(        │ │',
  '│ │  65 -    label: string,                  │ │',
  '│ │  65 +    label: string, state: NoteState,│ │',
  '│ │  66 +    prompt = ""                      │ │',
  '│ │  67    ) {                               │ │',
  '│ │  68 -    return { title: label }          │ │',
  '│ │  68 +    return { title: `${label}` }     │ │',
  '│ │  69    }                                  │ │',
  '│ │  70 +  // one wording, two copies         │ │',
  '│ │  71 +  export const QUIET = 60_000        │ │',
  '│ ╰──────────────────────────────────────────╯ │',
  '│ Do you want to make this edit to notify.ts?  │',
  '│ ❯ 1. Yes                                     │',
  "│   2. Yes, and don't ask again this session   │",
  '│   3. No, and tell Claude what to do          │',
  '│      differently (esc)                        │',
  '╰──────────────────────────────────────────────╯'
]

const DANGER_SCREEN = [
  '● Bash(git clean -fd && rm -rf web/dist)',
  '',
  '╭──────────────────────────────────────────────╮',
  '│ Bash command                                 │',
  '│                                              │',
  '│   git clean -fd && rm -rf web/dist           │',
  '│   Remove untracked files and the old build   │',
  '│                                              │',
  '│ Do you want to proceed?                      │',
  '│ ❯ 1. Yes                                     │',
  '│   2. Yes, and always allow git clean in      │',
  '│      this project                            │',
  '│   3. No, and tell Claude what to do          │',
  '│      differently (esc)                        │',
  '╰──────────────────────────────────────────────╯'
]

const ASK_PROMPTS: Partial<Record<NoticeId, { prompt: string; screen: string[] }>> = {
  ask: { prompt: 'Do you want to make this edit to notify.ts?', screen: EDIT_SCREEN },
  'ask-danger': { prompt: 'Do you want to proceed?', screen: DANGER_SCREEN },
  'ask-yesno': { prompt: 'Shall I commit this on the branch phone-polish?', screen: [] },
  'ask-prose': { prompt: 'What should I name the new preview route?', screen: [] }
}

const BRAIN: Record<string, BrainConfirmRequest[]> = {
  brain: [{ id: 'b1', tool: 'run_app_action', summary: 'Close the tab Zeb in forge', risk: 'medium', at: 0 }],
  'brain-high': [
    { id: 'b2', tool: 'run_app_action', summary: 'Restart Forge on STEVE-LAPTOP. Every pane reconnects.', risk: 'high', at: 0 },
    { id: 'b3', tool: 'type_into_pane', summary: 'Type “yes” into Mara', risk: 'low', at: 0 },
    { id: 'b4', tool: 'open_agent_pane', summary: 'Open a Codex tab in car-harness', risk: 'low', at: 0 }
  ]
}

function mark(key: string, value: string): void {
  document.body.dataset[key] = value
}

export function NoticesPreview(): ReactNode {
  const { themeId, setTheme } = useDeckTheme(true)
  const [seeded, setSeeded] = useState(false)
  if (!seeded) {
    setSeeded(true)
    const first = param('theme')
    if (first && first !== themeId) setTheme(first)
  }
  const show = (param('show') ?? (param('stack') ? 'stack' : 'stack')) as NoticeId | 'stack'

  if (show === 'stack') {
    return (
      <div style={{ height: '100%', overflowY: 'auto', background: '#111', padding: 8 }}>
        {STACK.map(({ id, note }, index) => (
          <section key={id} style={{ marginBottom: 12 }}>
            <p style={{ margin: '4px 4px 6px', font: '600 13px system-ui, sans-serif', color: '#ddd' }}>
              {index + 1}. {id} — {note}
            </p>
            <div style={{ height: 470, borderRadius: 12, overflow: 'hidden' }}>
              <Scene id={id} compact />
            </div>
          </section>
        ))}
      </div>
    )
  }
  return <Scene id={show} />
}

function Scene({ id, compact = false }: { id: NoticeId; compact?: boolean }): ReactNode {
  const longBanner = id === 'banner'
  const [askBanner, setAskBanner] = useState<{ sessionId: string; seq: number } | null>(
    id === 'banner' ? { sessionId: 'p9', seq: 1 } : id === 'banner-short' ? { sessionId: 'p2', seq: 1 } : null
  )
  const [notice, setNotice] = useState(
    id === 'toast' ? 'Sent to Claude Code' : id === 'toast-long' ? "Couldn't open the tab. STEVE-LAPTOP didn't answer in time. Try again." : ''
  )
  const refuse = param('refuse') === '1'

  const brainConfirm = useCallback(
    async (_id: string, allow: boolean): Promise<string | null> => {
      mark('last', allow ? 'brain-yes' : 'brain-no')
      await new Promise((r) => setTimeout(r, 300))
      return refuse ? 'It is no longer waiting.' : null
    },
    [refuse]
  )

  const actions = useMemo(
    () =>
      new Proxy({} as ForgeActions, {
        get: (_target, key) => {
          const name = String(key)
          if (name === 'openAskBanner')
            return () => {
              mark('last', 'open')
              setAskBanner(null)
            }
          if (name === 'dismissAskBanner')
            return () => {
              mark('last', 'dismiss')
              setAskBanner(null)
            }
          if (name === 'dismissNotice')
            return () => {
              mark('last', 'toast-dismiss')
              setNotice('')
            }
          if (name === 'brainConfirm') return brainConfirm
          if (name === 'request') return () => Promise.resolve({ kind: 'failed', message: 'This is the preview.' })
          if (name.startsWith('on')) return () => () => undefined
          if (['setNotice', 'signOut', 'nextWaiting', 'write', 'claim', 'refind', 'retry', 'setOfflineMode'].includes(name))
            return () => undefined
          return () => Promise.resolve(null)
        }
      }),
    [brainConfirm]
  )

  const state = useMemo(() => {
    const forge: Project = {
      id: 'forge',
      name: 'forge',
      path: 'C:\\Users\\steve\\Desktop\\forge',
      color: '#ff5f6d',
      defaultProfileId: 'claude',
      createdAt: 0
    }
    const car: Project = {
      id: 'car',
      name: longBanner ? 'mercedes-xentry-slk-ecu-dumps-and-notes' : 'car-harness',
      path: 'C:\\Users\\steve\\Desktop\\car-harness',
      color: '#5ab0ff',
      defaultProfileId: 'claude',
      createdAt: 0
    }
    const workspaces: Record<string, WorkspaceShape> = {
      forge: { activeTabId: 't1', tabs: FORGE_TABS },
      car: { activeTabId: 't9', tabs: CAR_TABS }
    }
    const allLeaves = [...FORGE_TABS, ...CAR_TABS].flatMap((t) => collectLeaves(t.root))
    const picture: Picture = {
      desktopName: 'STEVE-LAPTOP',
      appVersion: '0.0.0',
      projects: [forge, car],
      profiles: BUILTIN_AGENT_PROFILES,
      workspaces,
      sessions: allLeaves.map((l) => ({ id: l.id, cwd: forge.path, cols: 60, rows: 30, bootstrapCommand: '', startedAt: 0 })),
      projectsRoot: '',
      foreman: {},
      handoff: {},
      brain: null
    }
    const offline = id === 'offline' || id === 'offline-github'
    const asking = id.startsWith('ask') ? ['p1'] : askBanner ? [askBanner.sessionId] : []
    const fixture = {
      stage: offline ? { kind: 'offline', message: '', record: { name: 'STEVE-LAPTOP' } } : { kind: 'connected' },
      connection: id === 'reconnecting' ? { state: 'connecting', attempt: 2 } : { state: 'live' },
      session: { email: 'steve@example.com' },
      config: null,
      picture,
      cached: offline
        ? { ...picture, version: 1, uid: 'preview', at: Date.now() - 7 * 60_000, transcripts: [], slugs: { forge: 'stevenmcginty/forge' } }
        : null,
      projectId: 'forge',
      git: {},
      asking: new Set(asking),
      busy: new Set<string>(),
      prompts: {
        p9: LONG_ASK,
        p2: 'Run npm run typecheck?',
        p1: ASK_PROMPTS[id]?.prompt ?? ''
      },
      waiting: asking,
      notice,
      desktopRecovering: id === 'recovering' ? 'renderer-gone' : '',
      remoteYes: { enabled: id === 'remoteyes', uac: id === 'remoteyes', address: '100.64.0.9', port: 21118 },
      warm: true,
      offlineMode: id === 'offline-github' ? 'github' : 'frozen',
      notifyPermission: 'granted',
      pushActive: true,
      askBanner,
      brainConfirms: BRAIN[id] ?? []
    }
    return fixture as unknown as ForgeState
  }, [id, askBanner, notice, longBanner])
  const value = useMemo(() => ({ state, actions }), [state, actions])

  const ask = ASK_PROMPTS[id]
  useEffect(() => (ask ? registerAnswerScreen('p1', () => ask.screen) : undefined), [ask])
  const [writes, setWrites] = useState(0)
  useEffect(() => mark('writes', String(writes)), [writes])

  const update: WebUpdate = { available: id === 'update', version: '0.3.42', apply: () => mark('last', 'reload'), dismiss: () => mark('last', 'update-dismiss') }
  const strip = id === 'remoteyes' ? <RemoteYesBanner /> : id.startsWith('offline') ? <OfflineBanner /> : id === 'reconnecting' ? <ReconnectingBanner /> : id === 'recovering' ? <RecoveringBanner /> : id === 'update' ? <UpdateBanner update={update} /> : null
  const keyBad = param('key') === 'bad'
  const profile = BUILTIN_AGENT_PROFILES.find((p) => p.id === 'claude')!
  const [draft, setDraft] = useState('')

  return (
    <ForgeContext.Provider value={value}>
      <div className="app" data-mobile="true" data-ready="true" data-shell="app" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <TopBar collapsed onToggleRail={() => undefined} onWatchScreen={null} mobile />
        {strip}
        <div className="app__body" style={{ flex: 1, minHeight: 0 }}>
          <main className="app__main">
            <div className="grid">
              <TabStrip mobile />
              <div className="app__display grid__body" data-region="display">
                <div className="grid__tab" data-active="true">
                  <div className="mpanes">
                    <div className="mpanes__body">
                      <div className="pane" data-kind="agent" data-view="chat" style={{ position: 'absolute', inset: 0 }}>
                        <ChatView turns={compact ? MOCK_TURNS.slice(-4) : MOCK_TURNS} truncated={false} busy={false} agentName={profile.name} />
                      </div>
                    </div>
                  </div>
                </div>
                {notice ? <NoticeToast text={notice} onDismiss={actions.dismissNotice} /> : null}
                {id === 'speechkey' ? (
                  <SpeechKeyCardView
                    onSave={async () => {
                      await new Promise((r) => setTimeout(r, 400))
                      return keyBad ? 'Groq refused that key. Check you copied all of it, then try again.' : null
                    }}
                    onSaved={() => mark('last', 'saved')}
                    onClose={() => mark('last', 'close')}
                    onNeverAgain={() => mark('last', 'never')}
                  />
                ) : null}
                <AskBanner />
                <BrainConfirm face="phone" />
              </div>
              <div className="session-composer" data-view="chat">
                {ask ? (
                  <AnswerCard
                    key={id}
                    paneId="p1"
                    agentName={profile.name}
                    prompt={ask.prompt}
                    digits
                    live
                    onWrite={() => setWrites((n) => n + 1)}
                    onShowTerminal={() => mark('last', 'terminal')}
                  />
                ) : null}
                <Composer
                  draft={draft}
                  disabled={id === 'offline' || id === 'offline-github'}
                  to={`${profile.name} · forge`}
                  onDraft={setDraft}
                  onSend={() => setDraft('')}
                  onRaw={() => undefined}
                  models={[]}
                  currentModelId={null}
                  autoFocus={false}
                  voice={PREVIEW_VOICE}
                  listen={<PreviewListen />}
                  listenMenu={<PreviewFan />}
                  listenLine={<PreviewLine />}
                />
              </div>
            </div>
          </main>
        </div>
      </div>
    </ForgeContext.Provider>
  )
}
