import type { ChatTurn } from '@shared/chat'

/**
 * Fixture turns for `?preview=chat` — a plausible Claude session, hand-built
 * so every rendering path in ChatView is on screen at once: prompts of both
 * lengths, long markdown replies (headings, lists, fenced and inline code, a
 * table, a blockquote, links), tool chips with and without notes, one failed,
 * and a thinking fold. Dev-server only; main.tsx compiles the route out of
 * every build.
 */

const BASE = Date.now() - 40 * 60_000

let n = 0
function turn(role: ChatTurn['role'], blocks: ChatTurn['blocks']): ChatTurn {
  n += 1
  return { id: `mock-${n}`, role, at: BASE + n * 90_000, blocks }
}

export const MOCK_TURNS: ChatTurn[] = [
  turn('user', [
    {
      kind: 'text',
      text: 'The feed in the browser loses all the terminal colour. Can you build the real chat view instead — parsed from the session transcript, like the Claude app?'
    }
  ]),
  turn('assistant', [
    {
      kind: 'thinking',
      text: 'The cards feed scrapes the terminal, so styling is already gone by the time it renders. The session JSONL has the structured turns — text, thinking, tool_use — so the right move is a parser on the desktop and a dumb reading surface in the browser. The wire type should carry what a person reads, nothing else.'
    },
    {
      kind: 'text',
      text: `I'll read the transcript watcher and the shared contract first, then build the view.

## The plan

The desktop already tails the session JSONL, so the work splits cleanly:

1. **Parse** each record down to \`ChatTurn\` — the words, the tools by name, the thinking folded.
2. **Ship** it over the existing socket inside \`transcript\` frames.
3. **Render** it as a chat: prose is the page, tools are chips, thinking folds shut.

Some details that matter:

- Turns are immutable by \`id\`, so appends can dedupe and the view can memoize.
- A *reset* frame replaces everything — file truncated, session resumed.
- The view never sees the socket; it takes \`turns\`, \`truncated\`, \`busy\` and nothing else.`
    },
    { kind: 'tool', name: 'Read', gist: 'shared/chat.ts', note: 'Read 61 lines' },
    { kind: 'tool', name: 'Grep', gist: 'transcript', note: '14 matches in 6 files' },
    {
      kind: 'tool',
      name: 'Bash',
      gist: 'npm run typecheck',
      note: "web/src/components/ChatView.tsx(41,3): error TS2741: Property 'truncated' is missing in type '{ turns: ChatTurn[]; }'",
      failed: true
    },
    { kind: 'tool', name: 'Edit', gist: 'web/src/components/ChatView.tsx' },
    {
      kind: 'text',
      text: `Fixed the missing prop and the typecheck is green. Here's the shape the view consumes:

\`\`\`ts
export interface ChatTurn {
  /** The JSONL record's uuid: stable across re-reads, so appends can dedupe. */
  id: string
  role: 'user' | 'assistant'
  at: number
  blocks: ChatBlock[]
}

export type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; gist: string; note?: string; failed?: boolean }
\`\`\`

> The view is a reading surface, not an archive: a turn carries what a person reads and none of the bookkeeping the file exists to record.

The three block kinds cover everything the transcript holds:

| Kind | Rendered as | Default state |
| --- | --- | --- |
| \`text\` | markdown prose | open — it *is* the page |
| \`tool\` | a one-line chip | collapsed to the gist |
| \`thinking\` | an italic fold | folded shut |

More on the wire format in [docs/forge-web.md](https://github.com/anthropics/claude-code) if you want the protocol side.`
    }
  ]),
  turn('user', [
    {
      kind: 'text',
      text: 'Nice. What about really long code lines — do they wrap or scroll? And check the phone width.'
    }
  ]),
  turn('assistant', [
    {
      kind: 'text',
      text: `They scroll **inside their own container** — the page itself never scrolls sideways. Same for tables. A quick torture test:

\`\`\`tsx
const veryLongLine = turns.filter((t) => t.role === 'assistant').flatMap((t) => t.blocks).filter((b): b is Extract<ChatBlock, { kind: 'tool' }> => b.kind === 'tool').map((b) => \`\${b.name}(\${b.gist})\`).join(' → ')
\`\`\`

Inline code like \`overflow-x: auto\` wraps normally because it's part of the prose. The rules, tersely:

- Fenced code → horizontal scroll in its own well
- Tables → horizontal scroll in a bordered wrapper
- Prose, inline code, links → \`overflow-wrap: anywhere\`
  - which also covers pasted URLs and long file paths
  - and *nested* list items like this one

That covers a 390px phone without any layout forks.`
    }
  ]),
  turn('user', [{ kind: 'text', text: 'ship it' }]),
  turn('assistant', [
    { kind: 'tool', name: 'Bash', gist: 'git add -A && git commit -m "Forge Web: the chat transcript view"', note: '[master 4f2c9e1] 5 files changed, 612 insertions(+)' },
    {
      kind: 'text',
      text: 'Committed. The wiring job connects it to the transcript watcher next — this component stays socket-blind, so nothing here changes when it does.'
    }
  ])
]

/** Extra turns the preview appends on demand, to exercise stick-to-bottom and the jump pill. */
export const MOCK_APPENDS: ChatTurn[] = [
  turn('user', [{ kind: 'text', text: 'one more thing — does the jump pill show while I read history?' }]),
  turn('assistant', [
    {
      kind: 'text',
      text: 'It does: while you are scrolled up, new turns raise the pill instead of yanking the page. *This* turn arriving is the proof.'
    }
  ]),
  turn('assistant', [
    { kind: 'tool', name: 'Read', gist: 'web/src/components/ChatView.css', note: 'Read 480 lines' },
    { kind: 'text', text: 'And a late tool chip, so an appended turn with mixed blocks is covered too.' }
  ])
]
