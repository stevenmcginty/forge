import { useEffect, useMemo, useState } from 'react'
import { BUILTIN_AGENT_PROFILES } from '@shared/agents'
import { MOBILE_PROTO, type MobileSession } from '@shared/mobile'
import type { PaneLeaf, Project, TerminalTab, Workspace } from '@shared/types'
import { TvConnect } from '../components/TvConnect'
import { TvDashboard } from '../components/TvDashboard'
import { paneListeners } from '../components/PaneView'
import type { Homing } from './homing'
import type { Link, LinkPicture, LinkState } from './link'

/**
 * DEV ONLY: the television's screens with no desktop in the room.
 *
 *   http://localhost:5175/?tv&demo            the wall, live
 *   …?tv&demo=stale                           the wall, link down
 *   …?tv&demo=connect                         the search screen, two desktops found
 *   …?tv&demo=waiting                         paired, desktop not home
 *   …?tv&demo=awaiting                        the pairing words, waiting for Allow
 *
 * App.tsx reaches this file only behind `import.meta.env.DEV`, through a lazy
 * import, so a production build never contains it. Nothing here talks to a
 * network: the "link" is a stand-in object that feeds `paneListeners` the same
 * (data, replay) pairs the real Link would, and swallows every op.
 */

const ESC = '\u001b'
const dim = (s: string): string => `${ESC}[2m${s}${ESC}[0m`
const bold = (s: string): string => `${ESC}[1m${s}${ESC}[0m`
const fg = (code: number, s: string): string => `${ESC}[38;5;${code}m${s}${ESC}[0m`

const CLAUDE_SCREEN = [
  `${fg(209, '✻')} ${bold('Welcome to Claude Code!')}`,
  '',
  dim('  /help for help, /status for your current setup'),
  dim('  cwd: C:\\Users\\steve\\Desktop\\forge-river'),
  '',
  `${fg(250, '>')} Make the TV screens look like River Hub`,
  '',
  `${fg(114, '●')} I'll start by reading the TV stylesheet and the dashboard component.`,
  '',
  `${fg(114, '●')} ${bold('Read')}(mobile/src/tv.css)`,
  `  ⎿  Read 1640 lines`,
  '',
  `${fg(114, '●')} ${bold('Read')}(mobile/src/components/TvDashboard.tsx)`,
  `  ⎿  Read 2536 lines`,
  '',
  `${fg(114, '●')} The wall is a grid of project cards. Each live pane shows a two-line`,
  '  tail of its output, and the D-pad walks a focus ring across them.',
  '',
  `${fg(114, '●')} ${bold('Update')}(mobile/src/tv.css)`,
  `  ⎿  Updated mobile/src/tv.css with 412 additions and 388 removals`,
  `     ${fg(108, '+ .tv-card { border-radius: calc(var(--u) * 34); }')}`,
  `     ${fg(174, '- .tv-card { border-radius: calc(var(--u) * 18); }')}`,
  '',
  `${fg(114, '●')} ${bold('Bash')}(npm run typecheck)`,
  `  ⎿  > forge@0.3.0 typecheck`,
  '     > tsc --noEmit -p tsconfig.mobile.json',
  '',
  `${fg(209, '✻')} Checking the wall at 960×540… ${dim('(esc to interrupt)')}`
]

/**
 * A wide pane (LONG_COLS) whose prose runs to the right-hand edge, the way an
 * agent's answer does once the desktop pane is wider than the television can
 * show at a readable size, ending in Claude Code's input box with the cursor
 * parked inside it and the hint line underneath.
 */
const LONG_COLS = 150
const LONG_ROWS = 40
const wrap = (text: string, indent: string, width = LONG_COLS - 2): string[] => {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && indent.length + line.length + 1 + word.length > width) {
      lines.push(indent + line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(indent + line)
  return lines
}
const answer = (text: string): string[] => {
  const [first = '', ...rest] = wrap(text, '  ')
  return [`${fg(114, '●')}${first.slice(1)}`, ...rest, '']
}
const LONG_SCREEN = [
  `${fg(250, '>')} Why does the TV wall say "quiet" for a pane that is clearly still building?`,
  '',
  ...answer(
    'The wall decides "working" from the age of the last byte it heard, not from what the process is doing: TvDashboard keeps a Feed per session with lastDataAt, and anything older than WORKING_MS (five seconds) reads as quiet. Gradle prints nothing for long stretches while it compiles Kotlin, so a build that is genuinely busy can sit silent for twenty seconds at a time and the wall honestly reports what it can see, which is silence.'
  ),
  ...answer(
    'There are two ways to make that truer. The cheap one is to widen the window for panes whose last line looks like a build tool (a "> Task" prefix, "Compiling", "BUILD RUNNING"), so a quiet compiler keeps its lamplight for a minute. The honest one is for the desktop to send a busy flag it already knows from the PTY (a foreground child process that is not the shell), which needs a new field in the session frame.'
  ),
  `${fg(114, '●')} ${bold('Read')}(electron/pty/grid-owner.ts)`,
  '  ⎿  Read 212 lines',
  '',
  ...answer(
    'I would start with the cheap one because it is TV-only and reversible, and keep the protocol change for when the phone wants the same signal; both screens would then read one source of truth instead of guessing from output timing, which is the root of the disagreement you are seeing tonight.'
  ),
  dim('─'.repeat(LONG_COLS)),
  `${fg(250, '>')} `,
  dim('─'.repeat(LONG_COLS)),
  dim('  ? for shortcuts                                                                                          ◯ IDE disconnected · auto-accept edits on'),
  // Back into the box, after the prompt: where Claude Code leaves its cursor.
  `${ESC}[3A${ESC}[5G`
]

const SHELL_SCREEN = [
  'PowerShell 7.5.2',
  '',
  'PS C:\\Users\\steve\\Desktop\\river-hub> git status --short',
  ' M app/src/main/java/com/steve/riverhub/HubRenderer.java',
  ' M HANDOFF.md',
  'PS C:\\Users\\steve\\Desktop\\river-hub> .\\gradlew assembleDebug',
  '',
  'BUILD SUCCESSFUL in 41s',
  '34 actionable tasks: 6 executed, 28 up-to-date',
  'PS C:\\Users\\steve\\Desktop\\river-hub> '
]

const CODEX_SCREEN = [
  `${bold('>_ Codex')}  ${dim('model: gpt-5 · approvals: on-request')}`,
  '',
  `${fg(117, 'user')}`,
  'Add an Open-Meteo fallback for the forecast when the cache is older than 6h',
  '',
  `${fg(183, 'codex')}`,
  'Plan: read Weather.java, add the age check, keep the last answer on disk.',
  '',
  `${fg(250, '▌')} Allow command? ${bold('./gradlew test')}  ${dim('[y/N]')}`
]

/** What each session says when somebody is watching it work. */
const TICKS: Record<string, string[]> = {
  s1: [
    `${fg(114, '●')} ${bold('Read')}(mobile/src/components/TvMenu.tsx)`,
    '  ⎿  Read 432 lines',
    `${fg(114, '●')} The menu keeps its step stack; only the surfaces change.`,
    `${fg(114, '●')} ${bold('Update')}(mobile/src/components/TvConnect.tsx)`,
    '  ⎿  Updated with 38 additions and 21 removals',
    `${fg(209, '✻')} Looking at the focus ring from three metres…`
  ],
  s4: [
    'Compiling 14 Kotlin files…',
    'Running :agents:testDebugUnitTest',
    'AgentsTest > statusReadsSignedIn PASSED',
    'AgentsTest > switchKeepsBothSignedIn PASSED',
    'BoxServiceTest > idleDrawsNothing PASSED'
  ],
  s6: [
    'GET /api/menu 200 18ms',
    'GET /api/opening-hours 200 4ms',
    'POST /api/orders 201 61ms',
    'GET /api/menu 304 2ms'
  ]
}

const screens: Record<string, string[]> = {
  s1: CLAUDE_SCREEN,
  s2: SHELL_SCREEN,
  s3: CLAUDE_SCREEN.slice(0, 16),
  s4: ['> Task :agents:compileDebugKotlin', 'BUILD RUNNING'],
  s5: CODEX_SCREEN,
  s6: ['  ▲ Next.js 15.2', '  - Local: http://localhost:3000', ' ✓ Ready in 1.9s'],
  s8: LONG_SCREEN,
  s7: [
    `${fg(209, '✻')} ${bold('Welcome to Claude Code!')}`,
    '',
    `${fg(114, '●')} Done. The VAT summary for Q3 is in vat/2026-Q3.md and the`,
    '  three unmatched card payments are listed at the bottom.',
    '',
    `${fg(250, '>')} `
  ]
}

const leaf = (id: string, profileId: string, title = ''): PaneLeaf => ({ type: 'leaf', id, profileId, title })
const tab = (id: string, title: string, ...leaves: PaneLeaf[]): TerminalTab => {
  let root: TerminalTab['root'] = leaves[0]!
  for (const next of leaves.slice(1)) {
    root = { type: 'split', id: `${id}-split-${next.id}`, direction: 'row', ratio: 0.5, a: root, b: next }
  }
  return { id, title, root, activePaneId: leaves[0]!.id }
}
const project = (id: string, name: string, color: string): Project => ({
  id,
  name,
  color,
  path: `C:\\Users\\steve\\Desktop\\${id}`,
  defaultProfileId: 'claude',
  createdAt: 0
})

function demoPicture(): LinkPicture {
  const projects = [
    project('forge', 'Forge', '#C6FF4A'),
    project('river-hub', 'River Hub', '#7FD1FF'),
    project('agent-box', 'Agent Box', '#D97757'),
    project('cafe-roma', 'Cafe Roma site', '#F2C14E'),
    project('accounts', 'Cafe Roma VAT', '#B48CFF'),
    project('night-filter', 'Night Filter', '#FF8FA3')
  ]
  const workspaces: Record<string, Workspace> = {
    forge: {
      tabs: [
        tab('t1', 'River look', leaf('s1', 'claude', 'TV redesign'), leaf('s2x', 'pwsh')),
        tab('t7', 'Wall', leaf('s8', 'claude', 'Long lines'))
      ],
      activeTabId: 't1'
    },
    'river-hub': {
      tabs: [tab('t2', 'Build', leaf('s2', 'pwsh')), tab('t3', 'Weather', leaf('s3', 'claude', 'Forecast pill'))],
      activeTabId: 't2'
    },
    'agent-box': { tabs: [tab('t4', 'Tests', leaf('s4', 'pwsh', 'Gradle'), leaf('s5', 'codex'))], activeTabId: 't4' },
    'cafe-roma': { tabs: [tab('t5', 'Dev', leaf('s6', 'pwsh', 'next dev'))], activeTabId: 't5' },
    accounts: { tabs: [tab('t6', 'Q3', leaf('s7', 'claude', 'VAT quarter'))], activeTabId: 't6' },
    'night-filter': { tabs: [], activeTabId: null }
  }
  const session = (id: string, cols = 118, rows = 32): MobileSession => ({
    id,
    cwd: 'C:\\Users\\steve\\Desktop',
    cols,
    rows,
    bootstrapCommand: '',
    startedAt: 0
  })
  return {
    appVersion: '0.3.0',
    deviceName: 'TV (Fire TV Stick 4K)',
    desktopName: 'STEVE-PC',
    projects,
    profiles: BUILTIN_AGENT_PROFILES,
    workspaces,
    // s2x is a leaf with no session: a terminal that has exited.
    // s1 is the 118×32 pane that fills every row; s8 is wider than the TV.
    sessions: [
      ...['s1', 's2', 's3', 's4', 's5', 's6', 's7'].map((id) => session(id)),
      session('s8', LONG_COLS, LONG_ROWS)
    ],
    canControl: true,
    foreman: {},
    handoff: {},
    desktop: '',
    remoteYes: { enabled: false, uac: false, address: '', port: 21118 },
    features: []
  }
}

/** The Link's surface as the TV screens use it, and nothing behind it. */
function demoLink(picture: LinkPicture): Link {
  const replay = (id: string): void => {
    const lines = screens[id] ?? ['']
    window.setTimeout(() => paneListeners.get(id)?.(lines.join('\r\n'), true), 60)
  }
  const fake = {
    get sessions(): MobileSession[] {
      return picture.sessions
    },
    subscribe: replay,
    unsubscribe: () => {},
    write: () => {},
    resize: () => {},
    op: () => {},
    startMirror: () => {},
    stopMirror: () => {},
    sendMirrorSignal: () => {},
    sendMirrorInput: () => {}
  }
  return fake as unknown as Link
}

/** Keeps the "working" sessions working: a new line every so often. */
function useTicks(): void {
  useEffect(() => {
    let n = 0
    const timer = window.setInterval(() => {
      n++
      for (const [id, lines] of Object.entries(TICKS)) {
        const line = lines[n % lines.length]!
        paneListeners.get(id)?.(`\r\n${line}`, false)
      }
    }, 1200)
    return () => clearInterval(timer)
  }, [])
}

const noSearch: Homing = { found: [], searching: false, searched: true, canSearch: true, search: () => {}, movedTo: '' }

export default function TvDemo(): React.JSX.Element {
  const mode = new URLSearchParams(window.location.search).get('demo') || 'wall'
  const picture = useMemo(demoPicture, [])
  const link = useMemo(() => demoLink(picture), [picture])
  const [notice] = useState('')
  useTicks()

  if (mode === 'connect' || mode === 'waiting' || mode === 'awaiting') {
    const known = mode === 'connect' ? null : { name: 'STEVE-PC', origin: 'ws://192.168.4.47:8420' }
    const homing: Homing =
      mode === 'connect'
        ? {
            ...noSearch,
            found: [
              { t: 'forge-desktop', name: 'STEVE-PC', origin: 'http://192.168.4.47:8420', app: '0.3.0', proto: MOBILE_PROTO },
              { t: 'forge-desktop', name: 'OFFICE-LAPTOP', origin: 'http://192.168.4.61:8420', app: '0.2.9', proto: MOBILE_PROTO }
            ]
          }
        : noSearch
    const state: LinkState = mode === 'awaiting' ? 'awaiting' : 'idle'
    return (
      <TvConnect
        state={state}
        detail={mode === 'awaiting' ? 'amber falcon' : ''}
        proto={MOBILE_PROTO}
        known={known}
        homing={homing}
        onPick={() => {}}
        onCancel={() => {}}
        onType={() => {}}
        onForget={() => {}}
      />
    )
  }

  const stale = mode === 'stale'
  return (
    <TvDashboard
      link={link}
      picture={picture}
      state={stale ? 'retrying' : 'live'}
      detail={stale ? 'Reconnecting in 15s…' : ''}
      notice={notice}
    />
  )
}
