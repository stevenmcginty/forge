/**
 * What changed in this release, in words a person who did not write it can read.
 *
 * The constraint this is shaped by: **CI cuts a release on every push to
 * master**, auto-incrementing the patch number (.github/workflows/release.yml).
 * So the version does not exist when the work is committed, which rules out a
 * hand-maintained file keyed by version — the day somebody forgets to update it,
 * a release ships the previous one's notes with nothing to catch it.
 *
 * What is always true at release time is the commit range. So the notes come from
 * it, in two tiers:
 *
 *   • **Highlights** — any commit-body line beginning `Highlight:`. This is the
 *     customer-facing sentence, written at commit time by whoever knows what the
 *     change is for, and it can say "here is how to use it" because a commit body
 *     has room to.
 *   • **Also changed** — the remaining commit subjects. Forge's subjects are
 *     already written as sentences ("A branch row could rewind the folder with one
 *     unasked-for click"), which is the whole reason this tier is worth showing
 *     rather than hiding behind a link.
 *
 * Pure — no git, no filesystem — so scripts/share-check.mjs can hold it to the
 * cases below, and so the same functions serve both consumers: the generated JSON
 * the app carries for its offline popup, and the GitHub release body.
 */

export interface WhatsNew {
  /** The version these notes are for. Empty in a dev checkout with no tag yet. */
  version: string
  /** ISO date, for the popup's subtitle. */
  date: string
  /** The customer-facing lines, newest commit first. */
  highlights: string[]
  /** Everything else, as commit subjects. */
  changes: string[]
  /** The GitHub release page, for the "full notes" link. */
  url: string
}

export interface Commit {
  subject: string
  body: string
}

/** How many "also changed" lines are worth showing before it is just a log. */
export const WHATS_NEW_MAX_CHANGES = 40
/** A highlight is a sentence or two, not an essay. */
export const WHATS_NEW_MAX_HIGHLIGHT = 400

/**
 * ASCII record and unit separators, written as escapes rather than pasted in.
 *
 * They are the right separators because a commit subject or body cannot contain
 * them — the same reasoning behind git's own `-z` output. But a source file
 * holding raw control characters is a *binary* file as far as git is concerned,
 * with no diff and nothing to review; electron/git-watcher.ts carries the scar.
 * The escapes build byte-identical strings and leave this file readable.
 */
const RECORD = '\x1e'
const FIELD = '\x1f'

/** The `git log` format this parses. Kept here so the two cannot disagree. */
export const WHATS_NEW_LOG_FORMAT = `%s${FIELD}%b${RECORD}`

/**
 * Parse `git log --format=WHATS_NEW_LOG_FORMAT`.
 *
 * Unit-separated rather than line-based, because a commit body is multi-line by
 * definition and every line-based scheme eventually meets a body containing
 * whatever was chosen as the separator.
 */
export function parseCommits(raw: string): Commit[] {
  return String(raw ?? '')
    .split(RECORD)
    .map((record) => record.replace(/^\s+/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const cut = record.indexOf(FIELD)
      const subject = (cut === -1 ? record : record.slice(0, cut)).trim()
      const body = cut === -1 ? '' : record.slice(cut + 1)
      return { subject, body }
    })
    .filter((commit) => commit.subject.length > 0)
}

/**
 * The `Highlight:` lines in one commit body.
 *
 * A highlight may wrap: the lines after it are folded in until a blank line or
 * the next trailer, because 72-column commit bodies are the norm and a highlight
 * cut off at "Turn it on in Settings →" would be worse than no highlight.
 */
export function highlightsIn(body: string): string[] {
  const out: string[] = []
  let current: string[] | null = null

  const flush = (): void => {
    if (!current) return
    const text = current.join(' ').replace(/\s+/g, ' ').trim()
    if (text) out.push(text.length > WHATS_NEW_MAX_HIGHLIGHT ? `${text.slice(0, WHATS_NEW_MAX_HIGHLIGHT - 1).trim()}…` : text)
    current = null
  }

  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    const start = /^highlight:\s*(.*)$/i.exec(line)
    if (start) {
      flush()
      current = [start[1] ?? '']
      continue
    }
    if (!current) continue
    // A blank line ends it, and so does another trailer (`Co-Authored-By:`,
    // `Claude-Session:`), which is what stops a highlight swallowing the footer
    // every commit in this repo carries.
    if (!line || /^[A-Za-z][A-Za-z-]{1,40}:\s/.test(line)) {
      flush()
      continue
    }
    current.push(line)
  }
  flush()
  return out
}

/** True for a commit nobody wants to read about. */
function boring(subject: string): boolean {
  if (/^merge\b/i.test(subject)) return true
  // The version bump CI makes on its own, if it ever starts committing one.
  if (/^v?\d+\.\d+\.\d+$/.test(subject)) return true
  return false
}

/**
 * Build the notes for one release.
 *
 * A commit that carries a highlight is deliberately still listed under "also
 * changed" only if its subject says something the highlight does not — otherwise
 * the same change would be announced twice, once in each tier.
 */
export function notesFrom(commits: Commit[], about: { version: string; date: string; url: string }): WhatsNew {
  const highlights: string[] = []
  const changes: string[] = []

  for (const commit of commits) {
    if (boring(commit.subject)) continue
    const mine = highlightsIn(commit.body)
    for (const line of mine) if (!highlights.includes(line)) highlights.push(line)
    if (mine.length > 0) continue
    if (!changes.includes(commit.subject)) changes.push(commit.subject)
  }

  return {
    version: String(about.version ?? ''),
    date: String(about.date ?? ''),
    highlights,
    changes: changes.slice(0, WHATS_NEW_MAX_CHANGES),
    url: String(about.url ?? '')
  }
}

/** Nothing to say. The popup does not open for one of these. */
export function isEmptyNotes(notes: WhatsNew | null | undefined): boolean {
  if (!notes) return true
  return notes.highlights.length === 0 && notes.changes.length === 0
}

/**
 * The notes as markdown, for the GitHub release body.
 *
 * The same notes the app carries in its own JSON, rendered once by
 * scripts/whats-new.mjs and read by scripts/release.mjs — so the release page and
 * the popup can never describe different releases.
 *
 * Deliberately stops before the download and SmartScreen paragraphs. Those name
 * the artifact file, which is not known until after the build, so they stay in
 * release.mjs where that name lives rather than being threaded through here.
 */
export function renderNotes(notes: WhatsNew): string {
  const blocks: string[] = [`Forge ${notes.version}.`]

  if (notes.highlights.length > 0) {
    blocks.push(['## What’s new', '', ...notes.highlights.map((h) => `- ${h}`)].join('\n'))
  }
  if (notes.changes.length > 0) {
    blocks.push(['## Also changed', '', ...notes.changes.map((c) => `- ${c}`)].join('\n'))
  }
  if (isEmptyNotes(notes)) {
    blocks.push('Housekeeping only — nothing in this one changes how Forge behaves.')
  }

  return blocks.join('\n\n')
}
