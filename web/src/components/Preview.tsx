import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { AgentProfile } from '@shared/types'
import { BUILTIN_AGENT_PROFILES } from '@shared/agents'
import { useMobile } from '../lib/mobile'
import type { FeedBlock, PaneStatus, RichLine, Run } from '../lib/rich'
import { AgentStatus } from './AgentStatus'
import { Composer } from './Composer'
import { Feed } from './Feed'

/**
 * `?preview=feed` on the dev server: the conversation display, the status
 * strip and the box, fed hand-built rich lines so they can be looked at
 * without a desktop on the other end. Compiled out of every `vite build` by
 * the `__DEV_SERVER__` gate in main.tsx.
 */

/* ------------------------------------------------------------------ fixtures */

const T = {
  fg: '#e8eaed',
  dim: '#828992',
  red: '#ff6e6e',
  green: '#b8f04a',
  yellow: '#f2e56b',
  blue: '#7fb6ff',
  magenta: '#c08bff',
  cyan: '#6fe3d2'
}

function run(text: string, style: Omit<Run, 'text'> = {}): Run {
  return { text, ...style }
}

function line(...runs: (Run | string)[]): RichLine {
  const rs = runs.map((r) => (typeof r === 'string' ? run(r) : r))
  return { runs: rs, text: rs.map((r) => r.text).join('') }
}

function block(id: string, role: FeedBlock['role'], lines: RichLine[]): FeedBlock {
  return { id, role, lines, text: lines.map((l) => l.text).join('\n') }
}

const claudeBlocks: FeedBlock[] = [
  block('s1', 'system', [line(run('Claude Code v2.1.0 · Opus 4.1 · ~/Desktop/forge', { fg: T.dim }))]),
  block('u1', 'user', [
    line(
      'The feed in the browser loses all the terminal colour. Can you make the runs keep their fg/bg and wrap long lines on the phone?'
    )
  ]),
  block('a1', 'agent', [
    line(
      run('⏺ ', { fg: T.green }),
      'I’ll look at how ',
      run('term.ts', { bold: true }),
      ' reads cells and what ',
      run('Feed.tsx', { bold: true }),
      ' does with them.'
    ),
    line(''),
    line('The capture is plain text today, so the colour is gone before the feed sees it. The fix is in three parts:'),
    line(''),
    line(
      run('  1. ', { fg: T.dim }),
      run('RichLine', { fg: T.cyan }),
      ' carries one ',
      run('Run', { fg: T.cyan }),
      ' per styled span, with the resolved CSS colour.'
    ),
    line(
      run('  2. ', { fg: T.dim }),
      'The feed paints each run with an inline style and ',
      run('pre-wrap', { fg: T.yellow }),
      '.'
    ),
    line(
      run('  3. ', { fg: T.dim }),
      'Tool output folds into a card so a 400-line ',
      run('Read', { fg: T.magenta }),
      ' stops being the page.'
    )
  ]),
  block('t1', 'tool', [
    line(run('⏺ ', { fg: T.green }), run('Read', { bold: true }), run('(web/src/lib/term.ts)', { fg: T.dim })),
    line(run('  ⎿  ', { fg: T.dim }), run('Read 214 lines', { fg: T.dim })),
    ...Array.from({ length: 18 }, (_, i) =>
      line(
        run(`  ${String(i + 40).padStart(4)} `, { fg: T.dim }),
        run(i % 5 === 0 ? 'export ' : '', { fg: T.magenta }),
        run(i % 3 === 0 ? 'function ' : i % 3 === 1 ? 'const ' : '  ', {
          fg: T.blue
        }),
        run(['readCells', 'styleOf', 'joinWrapped', 'cssColour', 'lines', 'runsFor'][i % 6]!, { fg: T.fg }),
        run(i % 3 === 1 ? ' = (row: number) => {' : '(buffer: IBuffer): RichLine[] {', { fg: T.dim })
      )
    )
  ]),
  block('t2', 'tool', [
    line(
      run('⏺ ', { fg: T.green }),
      run('Update', { bold: true }),
      run('(web/src/components/Feed.tsx)', { fg: T.dim })
    ),
    line(run('  ⎿  ', { fg: T.dim }), run('Updated Feed.tsx with 6 additions and 2 removals', { fg: T.dim })),
    line(
      run('       41 ', { fg: T.dim }),
      run('-  <pre className="feed__text">{block.text}</pre>', {
        fg: T.red,
        bg: 'rgba(255,110,110,0.12)'
      })
    ),
    line(
      run('       41 ', { fg: T.dim }),
      run('+  <pre className="feed__text">', {
        fg: T.green,
        bg: 'rgba(184,240,74,0.10)'
      })
    ),
    line(
      run('       42 ', { fg: T.dim }),
      run('+    {block.lines.map((l) => <Line line={l} />)}', {
        fg: T.green,
        bg: 'rgba(184,240,74,0.10)'
      })
    ),
    line(run('       43 ', { fg: T.dim }), run('+  </pre>', { fg: T.green, bg: 'rgba(184,240,74,0.10)' }))
  ]),
  block('a2', 'agent', [
    line(
      run('⏺ ', { fg: T.green }),
      'Done. Colour survives end to end now, and the ',
      run('Read', { fg: T.magenta }),
      ' above folds to eight lines until you open it.'
    ),
    line(''),
    line(
      run('Typecheck: ', { dim: true }),
      run('clean', { fg: T.green, bold: true }),
      run(' · ', { dim: true }),
      run('feed:check', { dim: true }),
      run(' 31/31', { fg: T.green })
    )
  ])
]

const claudeStatus: PaneStatus = {
  model: 'Opus 4.1',
  mode: 'bypass',
  modeLabel: 'bypass permissions on',
  context: '23%',
  cwd: 'C:/Users/steve/Desktop/forge',
  branch: 'master',
  busy: true,
  activity: 'Thinking',
  footer: ['⏵⏵ bypass permissions on (shift+tab to cycle)', 'Opus 4.1 · 23% context · ~/Desktop/forge (master)']
}

const geminiBlocks: FeedBlock[] = [
  block('g0', 'system', [line(run('Gemini CLI 0.9 · gemini-2.5-pro', { fg: T.dim }))]),
  block('g1', 'user', [line('Summarise what changed in the last three commits.')]),
  block('g2', 'agent', [
    line(run('✦ ', { fg: T.blue }), 'Three commits, one theme: Forge Web grew a phone face.'),
    line(''),
    line(run('  84ed33a', { fg: T.yellow }), '  the conversation scrolls like a page on a phone'),
    line(run('  de78a0b', { fg: T.yellow }), '  a spacious desktop face and a compact phone face'),
    line(run('  e421501', { fg: T.yellow }), '  an app around the session, not a terminal in a tab')
  ]),
  block('g3', 'tool', [
    line(run('⏺ ', { fg: T.blue }), run('Shell', { bold: true }), run('(git log --oneline -3)', { fg: T.dim })),
    line(
      run('  ⎿  ', { fg: T.dim }),
      run('84ed33a Forge Web: on a phone, the conversation scrolls like a page.', { fg: T.fg })
    ),
    line(
      run('     ', { fg: T.dim }),
      run('de78a0b Forge Web: a spacious desktop face and a compact phone face.', { fg: T.fg })
    ),
    line(
      run('     ', { fg: T.dim }),
      run('e421501 Forge Web: an app around the session, not a terminal in a tab.', { fg: T.fg })
    )
  ])
]

const geminiStatus: PaneStatus = {
  model: 'gemini-2.5-pro',
  mode: 'plan',
  context: '61%',
  cwd: '~/Desktop/forge',
  busy: false,
  footer: ['~/Desktop/forge  no sandbox  gemini-2.5-pro (61% context left)']
}

/* ------------------------------------------------------------------ the page */

function profileOf(id: string): AgentProfile {
  return BUILTIN_AGENT_PROFILES.find((p) => p.id === id)!
}

const PANES = [
  {
    key: 'claude',
    profile: profileOf('claude'),
    blocks: claudeBlocks,
    status: claudeStatus,
    asking: false,
    prompt: ''
  },
  {
    key: 'gemini',
    profile: profileOf('gemini') ?? profileOf('antigravity'),
    blocks: geminiBlocks,
    status: geminiStatus,
    asking: true,
    prompt: 'Allow Gemini to run `git push origin master`?'
  }
] as const

export function Preview(): ReactNode {
  const mobile = useMobile()
  const [which, setWhich] = useState(0)
  const shown = mobile ? [PANES[which]!] : PANES

  return (
    <div className="preview" data-mobile={mobile ? 'true' : undefined}>
      {mobile ? (
        <div className="preview__switch">
          {PANES.map((p, i) => (
            <button key={p.key} type="button" data-active={i === which} onClick={() => setWhich(i)}>
              {p.profile.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="preview__row">
        {shown.map(({ key, ...p }) => (
          <PreviewPane key={key} {...p} />
        ))}
      </div>
    </div>
  )
}

function PreviewPane({
  profile,
  blocks: initial,
  status,
  asking,
  prompt
}: {
  profile: AgentProfile
  blocks: FeedBlock[]
  status: PaneStatus
  asking: boolean
  prompt: string
}): ReactNode {
  const [draft, setDraft] = useState('')
  const [live, setLive] = useState(true)
  const [blocks, setBlocks] = useState(initial)
  // A late turn, so stick-to-bottom and the "jump to latest" pill can be seen.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setBlocks((current) => [
        ...current,
        block(`late-${profile.id}`, 'agent', [
          line(run('⏺ ', { fg: profile.accent }), 'One more thing arrived while you were reading — ', run('3.4s', { fg: T.yellow }), ' after load.')
        ])
      ])
    }, 3400)
    return () => window.clearTimeout(id)
  }, [profile])
  return (
    <div className="preview__pane" style={{ '--pane-accent': profile.accent } as CSSProperties}>
      <section className="pane" data-view="feed" data-focused="true" data-kind="agent">
        <header className="pane__header">
          <span className="pane__title truncate">{profile.name}</span>
          <button type="button" className="pane__perm mono" onClick={() => setLive((v) => !v)}>
            {live ? 'live' : 'offline'}
          </button>
        </header>
        <div className="pane__stage">
          <Feed blocks={blocks} status={status} asking={asking} prompt={prompt} empty="Waiting for the desktop…" />
        </div>
      </section>
      <div className="session-composer">
        <AgentStatus profile={profile} status={status} live={live} onCycleMode={() => undefined} />
        <Composer
          draft={draft}
          disabled={!live}
          to={`${profile.name} · forge`}
          onDraft={setDraft}
          onSend={() => setDraft('')}
          onRaw={() => undefined}
          onPasteClick={() => undefined}
          autoFocus={false}
        />
      </div>
    </div>
  )
}
