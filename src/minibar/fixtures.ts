import type { MiniBarAgent, MiniBarCall, MiniBarEvent, MiniBarQuitInfo, MiniBarState, MiniBarViewApi } from '@shared/minibar'

/**
 * Fake mini bar states and a fake view API, for the preview
 * (src/minibar/preview.tsx) and for anyone wiring the view who wants to see
 * it without a host. Nothing here touches window.forge.
 */

const MIN = 60_000

const AGENTS: MiniBarAgent[] = [
  { projectId: 'forge', tabId: 't1', paneId: 'jonah', name: 'Jonah', brand: 'claude', status: 'done', line: 'Fixed the login redirect. Tests pass (42/42).' },
  { projectId: 'forge', tabId: 't1', paneId: 'ruth', name: 'Ruth', brand: 'claude', status: 'asking', line: 'Allow an edit to src/auth/login.ts?' },
  { projectId: 'forge', tabId: 't2', paneId: 'ivy', name: 'Ivy', brand: 'codex', status: 'working', line: 'Running the type checker over web/src…' },
  { projectId: 'forge', tabId: 't2', paneId: 'bram', name: 'Bram', brand: 'gemini', status: 'waiting', line: 'Waiting for the dev server on :5174' },
  { projectId: 'api', tabId: 't3', paneId: 'mira', name: 'Mira', brand: 'claude', status: 'working', line: 'Adding the rate limiter to /v2/upload.' },
  { projectId: 'api', tabId: 't3', paneId: 'otto', name: 'Otto', brand: 'pwsh', status: 'idle', line: 'PS C:\\code\\api>' },
  { projectId: 'car-harness', tabId: 't4', paneId: 'theo', name: 'Theo', brand: 'gemini', status: 'stopped', line: 'Process exited with code 1.' }
]

function events(now: number): MiniBarEvent[] {
  return [
    { id: 'e5', at: now - 20_000, kind: 'asking', projectId: 'forge', paneId: 'ruth', name: 'Ruth', brand: 'claude', workedMs: 3 * MIN, prompt: 'Allow an edit to src/auth/login.ts?', line: 'I need to change how the session cookie is read.' },
    { id: 'e4', at: now - 70_000, kind: 'done', projectId: 'forge', paneId: 'jonah', name: 'Jonah', brand: 'claude', workedMs: 4 * MIN, line: 'Fixed the login redirect. Tests pass (42/42).' },
    { id: 'e3', at: now - 9 * MIN, kind: 'stopped', projectId: 'car-harness', paneId: 'theo', name: 'Theo', brand: 'gemini', workedMs: 12 * MIN, line: 'Process exited with code 1.' },
    { id: 'e2', at: now - 26 * MIN, kind: 'done', projectId: 'api', paneId: 'mira', name: 'Mira', brand: 'claude', workedMs: 7 * MIN, line: 'Wrote the migration for upload_quota and ran it on the dev database.' },
    { id: 'e1', at: now - 48 * MIN, kind: 'done', projectId: 'forge', paneId: 'ivy', name: 'Ivy', brand: 'codex', workedMs: 2 * MIN, line: 'Renamed shotsOnDesktop across shared/ and electron/.' }
  ]
}

const LOOK_DARK = { theme: 'volt', appearance: 'dark' }
const LOOK_LIGHT = { theme: 'paper', appearance: 'light' }

export function baseState(now = Date.now()): MiniBarState {
  return {
    rev: 1,
    at: now,
    look: LOOK_DARK,
    project: { id: 'forge', name: 'forge' },
    projects: [
      { id: 'forge', name: 'forge', running: 4 },
      { id: 'api', name: 'api', running: 2 },
      { id: 'car-harness', name: 'car-harness', running: 0 },
      { id: 'self-build', name: 'self-build-land', running: 0 }
    ],
    agents: AGENTS,
    target: { kind: 'pane', paneId: 'ivy' },
    draft: '',
    dictation: { phase: 'off' },
    listen: { on: false, speaking: false, muted: false },
    keymap: [],
    talkKeys: { dictate: 'ShiftRight', listen: 'AltRight' },
    events: events(now),
    unseen: 2,
    toasts: [],
    peek: null,
    thread: [],
    speakUpdates: true,
    screen: true,
    tucked: false
  }
}

const JONAH_REPLY = `Fixed the **login redirect**. The bug was in \`resolveReturnTo()\`: it trusted the \`next\` query value without checking the origin, so a stale tab sent you to \`/\` instead of back to the page you came from.

### What changed
- \`src/auth/login.ts\`: only same-origin \`next\` values are kept
- \`src/auth/login.test.ts\`: three new cases (same origin, other origin, missing)
- Removed the old \`?r=\` fallback, nothing used it

\`\`\`ts
const next = new URL(raw, location.origin)
if (next.origin !== location.origin) return '/'
\`\`\`

Tests pass (**42/42**). Next I would look at the logout path, which has the same pattern.`

const RUTH_SCREEN = `  src/auth/login.ts
  ──────────────────────────────────────────────
  41   export function readSession(req: Request) {
  42 -   const raw = req.headers.get('cookie') ?? ''
  42 +   const raw = parseCookies(req).session ?? ''
  43     if (!raw) return null

 Do you want to make this edit to login.ts?
 ❯ 1. Yes
   2. Yes, and don't ask again this session
   3. No, and tell Claude what to do differently`

/** The named scenes the preview can show (preview.tsx ?scene=…). */
export function scene(name: string, light = false, now = Date.now()): MiniBarState | null {
  const s = baseState(now)
  if (light) s.look = LOOK_LIGHT
  switch (name) {
    case 'connecting':
      return null
    case 'idle':
      return s
    case 'toasts':
      return { ...s, toasts: ['e5', 'e4'], unseen: 2 }
    case 'peek':
      return {
        ...s,
        target: { kind: 'pane', paneId: 'jonah' },
        peek: { paneId: 'jonah', source: 'reply', text: JONAH_REPLY, at: now - 40_000 }
      }
    case 'asking':
      return {
        ...s,
        target: { kind: 'pane', paneId: 'ruth' },
        peek: {
          paneId: 'ruth',
          source: 'screen',
          text: RUTH_SCREEN,
          at: now - 6000,
          asking: {
            prompt: 'Allow an edit to src/auth/login.ts?',
            choices: [
              { id: '1', label: 'Yes' },
              { id: '2', label: "Yes, and don't ask again" },
              { id: '3', label: 'No, tell Ruth what to do' }
            ]
          }
        }
      }
    case 'chat':
      return {
        ...s,
        target: { kind: 'forge' },
        draft: 'and what is Ruth waiting for',
        dictation: { phase: 'sending', sendInMs: 1200 },
        thread: [
          { who: 'you', text: 'How are the agents getting on?', at: now - 50_000 },
          { who: 'forge', text: 'Jonah is done: the login redirect is fixed and 42 tests pass. Ivy is still type-checking web/src. Ruth is asking to edit login.ts.', at: now - 46_000 },
          { who: 'you', text: 'Tell Ivy to run the tests when she is done.', at: now - 20_000 },
          { who: 'forge', text: 'Sent to Ivy: "When the type check is clean, run npm test and tell me the result."', at: now - 17_000 }
        ]
      }
    case 'activity':
      return s
    case 'tucked':
      return { ...s, tucked: true }
    case 'quit':
      return s
    case 'stale':
      return { ...s, at: now - 9000 }
    case 'empty':
      return { ...s, project: null, projects: [], agents: [], events: [], unseen: 0 }
    case 'listening':
      return { ...s, draft: '', dictation: { phase: 'listening', level: 0.55 }, listen: { on: true, speaking: false, muted: false } }
    default:
      return s
  }
}

export const SCENES = ['connecting', 'idle', 'toasts', 'peek', 'asking', 'chat', 'activity', 'tucked', 'quit', 'stale', 'empty', 'listening']

/** A view API that only logs: every call lands in the console and in `log`. */
export function fakeApi(log: (line: string) => void = (l) => console.log(l)): MiniBarViewApi {
  const quitInfo: MiniBarQuitInfo = { confirm: true, running: 3, resume: 2, lost: 1 }
  return {
    isMiniBar: () => true,
    onState: () => () => undefined,
    call: (c: MiniBarCall) => log(`call ${JSON.stringify(c)}`),
    resize: (size) => log(`resize ${JSON.stringify(size)}`),
    openMain: async (maximised) => log(`openMain ${maximised ? 'maximised' : ''}`),
    quitInfo: async () => {
      log('quitInfo')
      return quitInfo
    },
    quit: async (opts) => log(`quit ${JSON.stringify(opts ?? {})}`),
    pickFiles: async () => {
      log('pickFiles')
      return ['C:\\Users\\steve\\Desktop\\shot.png']
    },
    setClickThrough: (on) => log(`setClickThrough ${on}`)
  }
}
