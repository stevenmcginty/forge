/**
 * Which face a Claude pane opens on, remembered for this browser.
 *
 * One key for every Claude pane rather than one per pane id, and that is the
 * whole of the design. The choice being made is "how do I read an agent" — a
 * conversation, the cards, or the raw terminal — and a person who has decided
 * that has decided it about their reading, not about pane `a3f2…`. Keying it
 * per pane would mean the preference silently reset every time a pane was
 * closed and re-opened, which is most of them, and would leave a growing pile
 * of dead ids in `localStorage` for panes nobody will see again.
 *
 * The default is the chat: a Claude session's own JSONL read as a conversation
 * is the thing this view exists to show, and the terminal is one tap away.
 *
 * Guarded like `deviceId` in lib/device.ts, and for the same reason — a private
 * window throws on the very first `localStorage` access, and a preference is
 * the last thing that should be allowed to take a page down with it.
 */

const VIEW_KEY = 'forge-web-claude-view'

export type ClaudeView = 'chat' | 'feed' | 'term'

export function getClaudeView(): ClaudeView {
  let held: string | null = null
  try {
    held = localStorage.getItem(VIEW_KEY)
  } catch {
    // Private mode: every pane opens on the default, which is the same answer
    // this returns for a browser that has never chosen.
    return 'chat'
  }
  return held === 'feed' || held === 'term' || held === 'chat' ? held : 'chat'
}

export function setClaudeView(view: ClaudeView): void {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    /* see above — the choice still stands for this page's lifetime */
  }
}
