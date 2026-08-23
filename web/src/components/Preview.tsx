import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { AgentProfile, ClaudePermissionMode } from '@shared/types'
import { agentModels, BUILTIN_AGENT_PROFILES, effortLevels, matchAgentModel, permissionModes } from '@shared/agents'
import { Icon } from '@/components/Icon'
import { mergeBlocks, richFromText, transcriptFromLines } from '@/lib/feed'
import { useMobile } from '../lib/mobile'
import type { FeedBlock, PaneStatus, PermissionMode, RichLine, Run } from '@/lib/rich'
import { AgentStatus } from './AgentStatus'
import { Composer } from './Composer'
import { Feed } from './Feed'

function liveRung(mode: PermissionMode | undefined): ClaudePermissionMode | null {
  if (mode === 'default' || mode === 'plan' || mode === 'bypass') return mode
  if (mode === 'accept-edits') return 'acceptEdits'
  return null
}

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

/**
 * Grok's pane is not hand-built.
 *
 * It is ten redraws of one streaming turn, each put through the real parser
 * and folded together by the real merge — because the bug this pane exists to
 * show only happens *between* frames. Grok's composer is unlike anybody
 * else's: an ASCII spinner rather than braille, a bare `2.2s` counter, a bar
 * over each turn carrying a context figure that moves, and a quota footer
 * under the box. A ticking line that survives the cut cannot match the frame
 * before it, so the entry stacked down the feed once per second. A hand-written
 * block list can never catch that; ten frames through `mergeBlocks` can.
 */
const GROK_REPLY = [
  'New content only ever appears at the bottom of a frame, so everything above the',
  'aligned region is history the log already holds. Prepending it was the ten copies.',
  '',
  'Grok draws none of its chrome the way the others do:',
  '',
  '  • an ASCII spinner, |/-\\, rather than a braille one',
  '  • a bare 2.2s counter rather than a bracketed (2s)',
  '  • a bar over each turn whose context figure moves',
  '  • a quota footer under the box, which nothing else prints',
  '',
  'All four now come off the screen before the cut, so a redraw is the same cards.'
]

function grokFrame(n: number): string {
  return [
    'Grok 4.6',
    '',
    '≡ master ~\\Desktop\\forge                                        7.8K / 500K',
    '  The entry is replicating ten times while you answer.            12:40 PM',
    '',
    'A frame is a window onto the log, not a replacement for it.',
    '',
    // The reply *grows*, the way a streamed one does: frame n holds every
    // sentence frame n-1 held, plus one more.
    ...GROK_REPLY.slice(0, n),
    '',
    `| Waiting for response… ${n}.2s  ${n}.2s ↓7.84k [stop]`,
    '',
    '> ',
    'Weekly limit left: 3% · Grok 4.6 (high)'
  ].join('\n')
}

const grokFrames = Array.from({ length: GROK_REPLY.length }, (_, i) =>
  transcriptFromLines(richFromText(grokFrame(i + 1)))
)
const grokBlocks: FeedBlock[] = grokFrames.reduce<FeedBlock[]>((log, frame) => mergeBlocks(log, frame.blocks), [])
const grokStatus: PaneStatus = grokFrames[grokFrames.length - 1]!.status

const openCodeBlocks: FeedBlock[] = [
  block('o0', 'system', [line(run('opencode · build', { fg: T.dim }))]),
  block('o1', 'user', [line('fix the feed duplications')]),
  block('o2', 'agent', [
    line('The merge was prepending the top of each OpenCode frame. A slice cut by the window edge is not a new turn.')
  ]),
  block('o3', 'tool', [
    line(run('# Read', { bold: true }), run('  src/lib/feed.ts', { fg: T.dim })),
    line(run('  Read 214 lines', { fg: T.dim }))
  ]),
  block('o4', 'agent', [
    line('One command, one bubble — even while the reply is still streaming.')
  ])
]

const openCodeStatus: PaneStatus = {
  model: 'grok-4.6',
  mode: 'default',
  context: '58%',
  cwd: '~/Desktop/forge',
  busy: false,
  footer: ['build  grok-4.6  58%  ~/Desktop/forge']
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
    cut: false,
    prompt: ''
  },
  {
    key: 'grok',
    profile: profileOf('grok'),
    blocks: grokBlocks,
    status: grokStatus,
    asking: false,
    // The trim seam: Grok's fixture is a windowed log, which is exactly the
    // transcript shape a clipped catch-up buffer produces.
    cut: true,
    prompt: ''
  },
  {
    key: 'opencode',
    profile: profileOf('opencode'),
    blocks: openCodeBlocks,
    status: openCodeStatus,
    asking: true,
    cut: false,
    prompt: 'Allow OpenCode to edit src/lib/feed.ts?'
  }
] as const

export function Preview(): ReactNode {
  // `?phone` lives in useMobile now, so the page and every component inside it
  // read one answer. This used to be a local override, which dressed the CSS as
  // a phone while the components below were still told desktop.
  const mobile = useMobile()
  const [which, setWhich] = useState(0)
  const shown = mobile ? [PANES[which]!] : PANES.filter((p) => p.key !== 'claude')

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
        {shown.map(({ key, cut, ...p }) => (
          // The chip leaves the phone chrome, so the seam is the phone's story.
          <PreviewPane key={key} {...p} cut={cut && mobile} />
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
  cut,
  prompt
}: {
  profile: AgentProfile
  blocks: FeedBlock[]
  status: PaneStatus
  asking: boolean
  cut: boolean
  prompt: string
}): ReactNode {
  const [draft, setDraft] = useState('')
  const [live, setLive] = useState(true)
  const [view, setView] = useState<'feed' | 'term'>('feed')
  const [blocks, setBlocks] = useState(initial)
  const roster = agentModels(profile.command)
  const levels = effortLevels(profile.command)
  const ladder = permissionModes(profile.command)
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
      <section className="pane" data-view={view} data-focused="true" data-kind="agent">
        <header className="pane__header">
          <span className="pane__title truncate">{profile.name}</span>
          <div className="pane__trailing">
            <button type="button" className="pane__perm mono" onClick={() => setLive((v) => !v)}>
              {live ? 'live' : 'offline'}
            </button>
            <div className="pane__actions">
              <button
                type="button"
                className="ghost-btn pane__action"
                title={view === 'feed' ? 'Show the terminal' : 'Show as cards'}
                aria-pressed={view === 'feed'}
                onClick={() => setView((current) => (current === 'feed' ? 'term' : 'feed'))}
              >
                <Icon name={view === 'feed' ? 'terminal' : 'note'} size={13} />
              </button>
              <button type="button" className="ghost-btn pane__action" data-danger="true" title="Close pane" disabled>
                <Icon name="close" size={13} />
              </button>
            </div>
          </div>
        </header>
        <div className="pane__stage">
          {view === 'feed' ? (
            <Feed blocks={blocks} status={status} asking={asking} prompt={prompt} cut={cut} empty="Waiting for the desktop…" />
          ) : (
            <pre className="pane__terminal preview__term">{blocks.map((b) => b.text).join('\n\n')}</pre>
          )}
        </div>
      </section>
      <div className="session-composer" data-view={view}>
        <AgentStatus profile={profile} status={status} live={live} />
        <Composer
          draft={draft}
          disabled={!live}
          to={`${profile.name} · forge`}
          onDraft={setDraft}
          onSend={() => setDraft('')}
          onRaw={() => undefined}
          models={roster}
          currentModelId={matchAgentModel(roster, status.model)?.id ?? null}
          onModel={roster.length ? () => undefined : undefined}
          effortLevels={levels}
          onEffort={levels.length ? () => undefined : undefined}
          modes={ladder}
          currentModeId={liveRung(status.mode)}
          onMode={ladder.length ? () => undefined : undefined}
          autoFocus={false}
        />
      </div>
    </div>
  )
}
