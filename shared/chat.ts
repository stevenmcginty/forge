/**
 * The chat transcript, as a wire type.
 *
 * The contract between the desktop's transcript reader (electron/web/
 * transcript-watcher.ts, which tails the Claude session's JSONL and parses it
 * down to this) and Forge Web's chat view (web/src/components/ChatView.tsx,
 * which renders it). Deliberately much smaller than the JSONL it is distilled
 * from: the view is a reading surface, not an archive, so a turn carries what
 * a person reads — the words, the tools by name, the thinking folded — and
 * none of the bookkeeping (uuids beyond identity, usage, git state, sidechain
 * plumbing) that the file exists to record.
 *
 * Everything here crosses the WebSocket inside `transcript` frames (see
 * shared/web.ts), so growth is a wire cost on a phone: add fields for a
 * reader's sake, not a debugger's.
 */

/** One piece of a turn, in the order it was said. */
export type ChatBlock =
  /** Words for the person, as markdown source — the view renders it. */
  | { kind: 'text'; text: string }
  /**
   * Reasoning the model showed its work in. Folded shut by the view; carried
   * so the reader can open it, capped by the desktop so a long think is a
   * summary rather than a payload.
   */
  | { kind: 'thinking'; text: string }
  /**
   * One tool call, collapsed to what a reader skims: the tool's name and a
   * one-line gist of what it was asked (a path, a command, a pattern — the
   * desktop picks the most telling input field). `note` is the result's own
   * one-liner when it is short enough to be worth carrying; `failed` marks a
   * tool_result that reported an error.
   */
  | { kind: 'tool'; name: string; gist: string; note?: string; failed?: boolean }

/** One conversational turn — a person's prompt or the assistant's reply. */
export interface ChatTurn {
  /** The JSONL record's uuid: stable across re-reads, so appends can dedupe. */
  id: string
  role: 'user' | 'assistant'
  /** Milliseconds since epoch, from the record's own timestamp. */
  at: number
  blocks: ChatBlock[]
  /**
   * The clock as the CLI printed it (`12:40 PM`), for a turn read off a
   * screen rather than a file: such a turn has no epoch (`at` is 0), and the
   * view shows this instead. Absent on transcript turns, which carry `at`.
   */
  clock?: string
}

/**
 * The transcript as one message: everything on a fresh watch, appends after.
 *
 * `reset` on the first frame of a watch and again whenever the desktop has to
 * start over (the file truncated, the session resumed under a new id): the
 * view replaces what it holds rather than appending. `truncated` says the
 * desktop began mid-file — the turns before `turns[0]` exist on disk but were
 * not parsed — so the view can draw the same rule the terminal replay draws.
 */
export interface ChatUpdate {
  reset: boolean
  truncated: boolean
  turns: ChatTurn[]
}
