/**
 * Drafts that outlive the page.
 *
 * The box's words lived in React state only, so a reload for an update, a tab
 * the phone discarded, or a bounce through the PIN gate took the sentence with
 * it. They are kept here instead: one draft per pane id, in `localStorage`,
 * newest last. Dictated words that land in the box are a draft like any other.
 *
 * Bounded on purpose. Pane ids are never reused, so a store with no ceiling
 * would only grow: it holds DRAFT_PANES_MAX panes (the oldest goes first) and
 * DRAFT_CHARS_MAX characters of each.
 *
 * Storage is a courtesy, never a dependency: private browsing, a full quota
 * and a blocked store all throw, and every access here swallows that. The box
 * then works exactly as it did before, from memory.
 *
 * No DOM beyond the storage handed in, so scripts/web-phone-six-check.mjs can
 * hold the rules to account with a Map.
 */

export const DRAFTS_KEY = 'forge.web.drafts.v1'
export const DRAFT_PANES_MAX = 20
export const DRAFT_CHARS_MAX = 8000

export interface StoredDraft {
  pane: string
  text: string
  /** When it was last written: the order the oldest is dropped in. */
  at: number
}

/** The part of `Storage` this needs. */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function browserStorage(): DraftStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** A stored draft is at most DRAFT_CHARS_MAX long, and never ends on half an emoji. */
export function clampDraft(text: string): string {
  if (text.length <= DRAFT_CHARS_MAX) return text
  const cut = text.slice(0, DRAFT_CHARS_MAX)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** What the store holds, oldest first. Anything it cannot read is no drafts, not an error. */
export function parseDrafts(raw: string | null): StoredDraft[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: StoredDraft[] = []
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue
      const { pane, text, at } = entry as Record<string, unknown>
      if (typeof pane !== 'string' || !pane || typeof text !== 'string' || !text.trim()) continue
      out.push({ pane, text: clampDraft(text), at: typeof at === 'number' && Number.isFinite(at) ? at : 0 })
    }
    return out.sort((a, b) => a.at - b.at).slice(-DRAFT_PANES_MAX)
  } catch {
    return []
  }
}

/**
 * The list with one pane's draft set — or, when the text is empty, forgotten.
 * The pane written last is the newest; past DRAFT_PANES_MAX the oldest go.
 */
export function putDraft(list: readonly StoredDraft[], pane: string, text: string, at: number): StoredDraft[] {
  const rest = list.filter((d) => d.pane !== pane)
  if (!pane || !text.trim()) return rest
  return [...rest, { pane, text: clampDraft(text), at }].slice(-DRAFT_PANES_MAX)
}

/** Every stored draft, by pane id — read once, when the box mounts. */
export function readDrafts(storage: DraftStorage | null = browserStorage()): Record<string, string> {
  const out: Record<string, string> = {}
  if (!storage) return out
  try {
    for (const draft of parseDrafts(storage.getItem(DRAFTS_KEY))) out[draft.pane] = draft.text
  } catch {
    /* a store that will not be read holds no drafts */
  }
  return out
}

/** Keep one pane's draft, or forget it when it is empty (sent, or cleared). */
export function writeDraft(
  pane: string,
  text: string,
  storage: DraftStorage | null = browserStorage(),
  at: number = Date.now()
): void {
  if (!storage || !pane) return
  try {
    const next = putDraft(parseDrafts(storage.getItem(DRAFTS_KEY)), pane, text, at)
    if (next.length) storage.setItem(DRAFTS_KEY, JSON.stringify(next))
    else storage.removeItem(DRAFTS_KEY)
  } catch {
    /* no room, or no store: the draft is still in the box */
  }
}
