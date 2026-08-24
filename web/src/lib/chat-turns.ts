import type { ChatTurn, ChatUpdate } from '@shared/chat'

/**
 * What a pane's chat view holds, and the one rule for growing it.
 *
 * shared/chat.ts describes the wire and this is the reading of it. Three
 * sentences, and the middle one is the one that is easy to get wrong:
 *
 *  - `reset` replaces everything. It is the first frame of every watch and the
 *    desktop's way of saying it has started over (the file truncated, the
 *    session resumed under a new id).
 *  - an append is an **upsert by id**, not a push. A turn re-arrives under the
 *    id it already had whenever the desktop learns more about it — a
 *    `tool_result` folding its `note` into a tool call that has already been
 *    sent — so a client that appended blindly would show the same turn twice,
 *    the second copy differing only in a line of tool output.
 *  - `truncated` says the reader began mid-file, so the view can draw the rule
 *    the terminal replay draws. It is sticky: once it is true of a transcript
 *    it stays true, because nothing later fills the gap in.
 *
 * A module of its own rather than a closure inside PaneView because it is the
 * one piece of this view with a rule that can be *stated* — and so the one
 * piece worth being able to exercise without a socket and a terminal.
 */

/**
 * How many turns a pane keeps.
 *
 * Not a protocol number: the desktop caps what it parses, and this is the
 * browser's own ceiling on what it will draw. Every turn is a React subtree
 * with markdown in it, and a session that has run all afternoon is thousands —
 * so past this the oldest are dropped and the transcript marks itself cut,
 * which is the same sentence the desktop's own `truncated` says.
 */
export const CHAT_TURN_CAP = 500

export interface ChatFeed {
  turns: ChatTurn[]
  truncated: boolean
}

export const EMPTY_CHAT: ChatFeed = { turns: [], truncated: false }

export function applyChatUpdate(feed: ChatFeed, update: ChatUpdate, cap = CHAT_TURN_CAP): ChatFeed {
  // An append carrying nothing changes nothing, and returning the same object
  // is what keeps it from costing a render.
  if (!update.reset && update.turns.length === 0) return feed

  const turns = update.reset ? [] : [...feed.turns]
  const at = new Map(turns.map((turn, index) => [turn.id, index]))
  for (const turn of update.turns) {
    const seen = at.get(turn.id)
    if (seen === undefined) {
      at.set(turn.id, turns.length)
      turns.push(turn)
    } else {
      // In place, so a turn that grew a tool result stays where it was said.
      turns[seen] = turn
    }
  }

  const dropped = Math.max(0, turns.length - cap)
  return {
    turns: dropped ? turns.slice(dropped) : turns,
    // A reset is a fresh statement of what is on disk, so it replaces the flag
    // rather than being or-ed into a stale one; anything dropped here is the
    // browser's own cut, and says so.
    truncated: (update.reset ? update.truncated : feed.truncated || update.truncated) || dropped > 0
  }
}
