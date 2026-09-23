import { getHubRuntime } from '@/lib/hubRuntime'
import { resolveNavTarget } from '@/lib/hubnav'

/**
 * Raw words into one pane, no brain — the bar's "→ Everest" target and
 * "type this into Everest: …" said inside a conversation (B11). One
 * implementation, so the two can never type differently.
 *
 * Moved here from VoiceHubController's `dictateTo`, unchanged: it reveals the
 * pane and retries while a background tab's pane mounts, never typing twice.
 */
export async function dictateToPane(
  paneId: string,
  text: string,
  opts?: { submit?: boolean }
): Promise<{ ok: boolean; summary: string }> {
  const rt = getHubRuntime()
  if (!rt) return { ok: false, summary: 'Forge is still starting up.' }
  const name = paneWords(paneId)
  if (!text && !opts?.submit) return { ok: false, summary: 'Nothing to type.' }
  rt.revealPane(paneId)
  // A background tab's pane mounts after the reveal; a few short retries
  // cover that without ever typing twice.
  for (let i = 0; i < 15; i++) {
    if (rt.typeIntoPane(paneId, text, opts?.submit === true)) {
      return { ok: true, summary: `Typed into ${name}${opts?.submit ? ' and sent it' : ''}.` }
    }
    await new Promise((r) => window.setTimeout(r, 200))
  }
  return { ok: false, summary: `${name} has no live terminal, so nothing was typed.` }
}

/** "Everest", "panel 2", or "that pane". */
export function paneWords(paneId: string): string {
  const pane = getHubRuntime()
    ?.panes()
    .find((p) => p.paneId === paneId)
  return pane ? (pane.callSign ?? `panel ${pane.number}`) : 'that pane'
}

/**
 * Spoken target words → one pane id: a call-sign, an agent type ("the Codex
 * pane"), "this pane", a number. Two equally good answers are no answer —
 * the resolver never guesses.
 */
export function resolveSpokenPane(spoken: string): string | null {
  const rt = getHubRuntime()
  if (!rt) return null
  const hit = resolveNavTarget(spoken, rt.panes(), rt.focusedPaneId())
  return hit.kind === 'pane' ? hit.pane.paneId : null
}
