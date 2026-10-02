/**
 * Which panes this page believes are asking — kept honest across a reconnect.
 *
 * The desktop says a pane started or stopped asking with one `attention` frame
 * per transition, and a frame sent to a socket that has just died is gone. On
 * every `hello-ok` the desktop re-states the panes *still* asking
 * (electron/web/server.ts, straight after the hello) — but it never mentions a
 * pane that stopped asking while the page was away. Holding on to what the
 * page knew before the drop therefore kept a question that had been answered
 * long ago: the "Claude Code is asking" card and the "1 waiting" pill stayed up
 * after the agent had moved on, and nothing would ever take them down
 * (2026-10-02; scripts/ask-ledger-check.mjs).
 *
 * So a hello opens a window: every pane re-stated in it, or newly asking in
 * it, stays; `settle`, called a beat later once the re-statements have landed,
 * hands back the rest to be put away. Not cleared on the hello itself — the
 * card would unmount and remount for every reconnect, losing its "Sent" state
 * and buzzing the phone again for a question it had already shown.
 */
export class AskLedger {
  /** Every pane this page currently treats as asking. */
  readonly now = new Set<string>()
  /** Panes said to be asking since the last hello; null when no hello is pending. */
  private restated: Set<string> | null = null

  /** One attention frame. Returns whether the pane was already asking. */
  attention(sessionId: string, isAsking: boolean): boolean {
    const was = this.now.has(sessionId)
    if (isAsking) {
      this.now.add(sessionId)
      this.restated?.add(sessionId)
    } else {
      this.now.delete(sessionId)
    }
    return was
  }

  /** A `hello-ok`: from here the desktop re-states every pane still asking. */
  hello(): void {
    this.restated = new Set()
  }

  /**
   * The re-statements have landed. Returns every pane held over from before
   * the hello that the desktop did not mention — it stopped asking while this
   * page could not hear it. Left in `now`: the caller puts each away through
   * the same path as an `idle` frame (which ends in `attention(id, false)`),
   * so the card, the pill and the notification all go together.
   */
  settle(): string[] {
    const kept = this.restated
    if (!kept) return []
    this.restated = null
    return [...this.now].filter((id) => !kept.has(id))
  }
}
