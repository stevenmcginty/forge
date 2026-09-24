/**
 * A pane agent's open_agent_pane, routed to the caller's own project.
 *
 * The bridge tags every request with the calling pane (FORGE_PANE_ID, see
 * bridge/browser-tools.mjs). The renderer tool the voice agent runs has no
 * notion of a caller, so a pane in project A asking for a helper used to get
 * one in whatever project Steve was looking at — B's folder, A's brief. This
 * turns the call into an anchored app action instead, which the renderer runs
 * in the project that owns the anchor (src/state/Foreman.tsx, the same answer
 * Foreman's hires get). Pure, so scripts/agent-pane-check.mjs can hold it.
 */

/** The action for a pane caller, or null for any other caller (who then opens in the project on screen). */
export function anchoredOpenAction(args: Record<string, unknown>, callerId: string): Record<string, unknown> | null {
  if (!callerId.startsWith('pane:')) return null
  const anchorPaneId = callerId.slice('pane:'.length).trim()
  if (!anchorPaneId) return null
  return {
    kind: 'open_agent_pane',
    agent: String(args['agent'] ?? ''),
    ...(typeof args['prompt'] === 'string' ? { prompt: args['prompt'] } : {}),
    ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}),
    ...(args['submit'] === true ? { submit: true } : {}),
    anchorPaneId
  }
}

/** Every way the renderer round trip says nothing happened. */
const FAILED = /^(FAILED|That failed|Forge did not answer|Forge could not be reached)/

/** The renderer's sentence, as the bridge's reply. */
export function paneOpenReply(text: string): { ok: boolean; text: string } {
  const ok = !FAILED.test(text)
  return { ok, text: ok && !/^OK:/.test(text) ? `OK: ${text}` : text }
}
