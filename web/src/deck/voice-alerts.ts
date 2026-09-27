/**
 * Pane alerts for the browser's voice agent: when a terminal finishes its turn
 * or starts asking a question, the agent says so without being asked.
 *
 * Pure: no DOM, no clocks. voiceAgent.ts polls `voice-context` while it is
 * live, hands each answer to `parsePaneStates`, feeds the snapshot to a
 * `PaneAlertTracker`, and speaks what comes out through `alertNote`.
 *
 * The context is buildAppContext's text (src/lib/realtime/context.ts), one
 * line per pane of the open project:
 *
 *   terminals (name · agent · state) — call each by its name, never by a number:
 *   - Zeb · Claude Code · working · focused
 *   - Zeb 2 · PowerShell (plain shell) · ready
 *
 * or `terminals: none — open one with open_agent_pane`.
 */

export type PaneState = 'working' | 'ready' | 'asking' | 'starting' | 'idle' | 'exited'

export interface PaneSeen {
  state: PaneState
  /** The agent's name as the context gives it ("Claude Code", "PowerShell (plain shell)"). */
  agent: string
}

/** One poll's panes, by name. */
export type PaneSnapshot = Map<string, PaneSeen>

export interface PaneAlert {
  kind: 'done' | 'asking'
  pane: string
  agent: string
}

const STATES: ReadonlySet<string> = new Set<PaneState>(['working', 'ready', 'asking', 'starting', 'idle', 'exited'])
const SEP = ' · '
/** Polls a pane must stay settled after working before it counts as done: one flicker does not speak. */
const DONE_POLLS = 2

/**
 * The panes in a voice-context answer, or null for text that is not one (empty,
 * an error, a desktop that words it differently). Never throws.
 */
export function parsePaneStates(text: unknown): PaneSnapshot | null {
  if (typeof text !== 'string' || !text.trim()) return null
  const lines = text.split(/\r?\n/)
  if (lines.some((l) => /^terminals: none\b/.test(l.trim()))) return new Map()
  const head = lines.findIndex((l) => /^terminals \(/.test(l.trim()))
  if (head < 0) return null
  const panes: PaneSnapshot = new Map()
  for (const raw of lines.slice(head + 1)) {
    const line = raw.trim()
    if (!line.startsWith('- ')) break
    const parts = line.slice(2).split(SEP)
    if (parts[parts.length - 1] === 'focused') parts.pop()
    // Name first, then agent, then state — read from the right, so a name with a dot in it survives.
    if (parts.length < 3) continue
    const state = parts.pop()!
    const agent = parts.pop()!
    const name = parts.join(SEP).trim()
    if (!name || !STATES.has(state)) continue
    panes.set(name, { state: state as PaneState, agent: agent.trim() })
  }
  return panes
}

/**
 * What changed that the user should hear, one snapshot per poll.
 *
 *   done     a pane seen working, then ready or idle on DONE_POLLS polls in a
 *            row; once per working stretch
 *   asking   a pane moves into asking; at once, and instead of done
 *
 * The first snapshot only primes: whatever was already true when the
 * conversation opened is not news. A pane that closes, exits or restarts says
 * nothing.
 */
export class PaneAlertTracker {
  private primed = false
  private last = new Map<string, PaneState>()
  /** Panes in a working stretch not yet told, and how many polls in a row they have looked settled. */
  private stretch = new Map<string, number>()
  private busy = false

  reset(): void {
    this.primed = false
    this.last = new Map()
    this.stretch = new Map()
    this.busy = false
  }

  /** Some pane was working at the last good snapshot. */
  anyWorking(): boolean {
    return this.busy
  }

  /** One poll. A snapshot that could not be read changes nothing. */
  feed(snap: PaneSnapshot | null): PaneAlert[] {
    if (!snap) return []
    const out: PaneAlert[] = []
    const primed = this.primed
    for (const [name, seen] of snap) {
      const before = this.last.get(name)
      switch (seen.state) {
        case 'working':
          this.stretch.set(name, 0)
          break
        case 'asking':
          // A question ends the stretch: what he hears is the question, not "done".
          this.stretch.delete(name)
          if (primed && before !== 'asking') out.push({ kind: 'asking', pane: name, agent: seen.agent })
          break
        case 'ready':
        case 'idle': {
          const settled = this.stretch.get(name)
          if (settled === undefined) break
          if (settled + 1 >= DONE_POLLS) {
            this.stretch.delete(name)
            out.push({ kind: 'done', pane: name, agent: seen.agent })
          } else {
            this.stretch.set(name, settled + 1)
          }
          break
        }
        case 'starting':
          // Not settled: the count starts again.
          if (this.stretch.has(name)) this.stretch.set(name, 0)
          break
        case 'exited':
          this.stretch.delete(name)
          break
      }
    }
    for (const name of [...this.stretch.keys()]) if (!snap.has(name)) this.stretch.delete(name)
    this.last = new Map([...snap].map(([name, seen]) => [name, seen.state]))
    this.busy = [...snap.values()].some((s) => s.state === 'working')
    this.primed = true
    return out
  }
}

const NOTE_HEAD = '[Forge alert — not the user speaking]'

/** "Zeb (Claude Code)", "Zeb 2 (PowerShell shell)". */
function paneWords(a: PaneAlert): string {
  const agent = a.agent.replace(/\s*\(plain shell\)$/, ' shell').trim()
  return agent ? `${a.pane} (${agent})` : a.pane
}

/** One note for everything that happened at once, or null for nothing. */
export function alertNote(alerts: readonly PaneAlert[]): string | null {
  if (!alerts.length) return null
  if (alerts.length === 1) {
    const a = alerts[0]!
    return a.kind === 'asking'
      ? `${NOTE_HEAD} ${paneWords(a)} is asking the user a question. Read it with read_pane ${a.pane}, then put the question to the user in one or two sentences and wait for the answer.`
      : `${NOTE_HEAD} ${paneWords(a)} just finished its turn. Tell the user in one short spoken sentence. If it helps, read_pane ${a.pane} first and say what it did or what it needs next.`
  }
  // Questions first: they are the ones waiting on him.
  const asking = alerts.filter((a) => a.kind === 'asking')
  const done = alerts.filter((a) => a.kind === 'done')
  const facts = [
    ...asking.map((a) => `${paneWords(a)} is asking the user a question.`),
    ...done.map((a) => `${paneWords(a)} just finished its turn.`)
  ]
  const how = asking.length
    ? 'Tell the user in a few short spoken sentences, questions first: read each question with read_pane, put it to the user and wait for the answer. For a pane that finished, read_pane it first if that helps say what it did.'
    : 'Tell the user in one or two short spoken sentences. If it helps, read_pane each one first and say what it did or what it needs next.'
  return `${NOTE_HEAD} ${facts.join(' ')} ${how}`
}
