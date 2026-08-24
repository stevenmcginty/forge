/**
 * The Foreman kit — the skills and agents Foreman cannot work without.
 *
 * Foreman drives a Claude pane end to end, and inside that pane it types
 * `/gaffer`, `/fable-method`, `/fable-judge` and the rest. Those are *user*
 * skills: Claude Code reads them from `<claude home>/skills/<name>/SKILL.md`
 * and `<claude home>/agents/<name>.md`, and on a machine that has never had
 * them the pane answers "unknown command" and Foreman is a button that does
 * nothing. So Forge ships copies and installs them.
 *
 * This file owns the *format* and every rule that can be decided by looking at
 * a string — the same split as shared/skillpack.ts against electron/skill-pack.ts.
 * electron/foreman/kit.ts owns the half that touches disk.
 *
 * ## The marker, and why it exists
 *
 * `~/.claude/skills` is the user's folder, shared with every `claude` session
 * on the machine, and `gaffer` is a name somebody else may already have used
 * for something of their own. Forge therefore never writes a name it cannot
 * prove it owns: every file it installs ends with
 *
 *     <!-- forge-foreman-kit v3 sha:… -->
 *
 * and a file without that line is somebody else's, full stop — it is kept and
 * reported, never overwritten. The version in the marker is what makes an
 * update distinguishable from a re-install, and the sha is what makes "the same
 * version, but the bytes moved" visible rather than silent.
 *
 * The marker rides on SKILL.md and on the agent `.md` only. Those are the two
 * files whose presence *is* the skill, so they are the only two worth asking a
 * question about; a `references/*.md` beside them is content, not identity.
 */

/** The skills Foreman invokes by name inside the pane. */
export const FOREMAN_KIT_SKILLS = ['gaffer', 'fable-method', 'fable-judge', 'fable-5', 'supabase-data-layer'] as const

/** The subagents the gaffer skill spawns. Without these, `/gaffer` cannot delegate. */
export const FOREMAN_KIT_AGENTS = ['gaffer-designer', 'gaffer-builder', 'gaffer-apprentice'] as const

/** The manifest's own filename, inside the kit directory. */
export const FOREMAN_KIT_MANIFEST = 'manifest.json'

/**
 * The tag inside the HTML comment Forge appends to everything it installs.
 *
 * A string rather than a regex so a person grepping their own `~/.claude` for
 * "what put this here" finds the same literal the code writes.
 */
export const FOREMAN_MARKER = 'forge-foreman-kit'

/* ------------------------------------------------------------- the shapes */

/** One file inside a kit skill, relative to the skill folder, forward slashes. */
export interface ForemanKitFile {
  path: string
  /** sha256 of the bundled bytes, lower-case hex — *before* any marker is appended. */
  sha256: string
}

export interface ForemanKitSkill {
  name: string
  files: ForemanKitFile[]
}

export interface ForemanKitAgent {
  name: string
  sha256: string
}

/**
 * What `assets/foreman-kit/manifest.json` holds.
 *
 * `version` is a plain integer bumped by scripts/foreman-kit-sync.mjs only when
 * the content actually changed. It is the number the installer compares against
 * a marker, so it must never move for a no-op sync — a version that ticked on
 * every run would rewrite every user's copy on every release.
 */
export interface ForemanKitManifest {
  version: number
  skills: ForemanKitSkill[]
  agents: ForemanKitAgent[]
}

/** What one installed file's marker claims about itself. */
export interface ForemanMark {
  version: number
  sha256: string
}

/* ------------------------------------------------------------ the marker */

/** The trailing comment Forge stamps on a SKILL.md or an agent `.md` it wrote. */
export function foremanMarker(version: number, sha256: string): string {
  return `<!-- ${FOREMAN_MARKER} v${version} sha:${sha256} -->`
}

/**
 * The bytes to write for a marked file: the kit copy, then the marker on its
 * own last line.
 *
 * A blank line before it, because these are markdown files a person will open
 * and the comment should not look like part of the last paragraph.
 */
export function withForemanMarker(body: string, version: number, sha256: string): string {
  return `${body.replace(/\s*$/, '')}\n\n${foremanMarker(version, sha256)}\n`
}

const MARKER = new RegExp(`<!--\\s*${FOREMAN_MARKER}\\s+v(\\d+)\\s+sha:([0-9a-f]{64})\\s*-->\\s*$`)

/**
 * Read the marker off a file already on disk, or null when there is not one.
 *
 * Anchored at the end, so a marker quoted *inside* a document — this file's own
 * doc comment, for one — cannot make a hand-written skill look like ours.
 */
export function readForemanMarker(text: unknown): ForemanMark | null {
  if (typeof text !== 'string' || !text) return null
  const match = MARKER.exec(text)
  if (!match) return null
  const version = Number(match[1])
  if (!Number.isSafeInteger(version) || version < 1) return null
  return { version, sha256: match[2]! }
}

/**
 * The body without its marker, trailing whitespace folded to one newline.
 *
 * The exact inverse of `withForemanMarker` for a file that already ended in a
 * single newline, which is every file the sync script writes — so an installed
 * copy can be compared against the bundled one without the marker getting in
 * the way.
 */
export function stripForemanMarker(text: string): string {
  return text.replace(MARKER, '').replace(/\s*$/, '\n')
}

/* ---------------------------------------------------------- the manifest */

const isHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

/**
 * Validate a parsed manifest, without deciding anything about paths.
 *
 * Whether a path is safe to write is `isSafePackPath`'s question and is asked
 * again at write time in electron/foreman/kit.ts; this only rejects a manifest
 * that is not the right *shape*, so the installer can fail with one sentence
 * instead of throwing on a missing field halfway through a directory.
 */
export function parseForemanKitManifest(text: unknown): { ok: boolean; error?: string; manifest?: ForemanKitManifest } {
  let raw: unknown
  try {
    raw = JSON.parse(String(text ?? ''))
  } catch {
    return { ok: false, error: 'the kit manifest is not readable JSON' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'the kit manifest is not an object' }

  const value = raw as Record<string, unknown>
  const version = value['version']
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    return { ok: false, error: 'the kit manifest has no usable version' }
  }
  if (!Array.isArray(value['skills']) || !Array.isArray(value['agents'])) {
    return { ok: false, error: 'the kit manifest is missing its skills or agents' }
  }

  const skills: ForemanKitSkill[] = []
  for (const entry of value['skills'] as unknown[]) {
    const skill = entry as Record<string, unknown> | null
    if (!skill || typeof skill['name'] !== 'string' || !Array.isArray(skill['files'])) {
      return { ok: false, error: 'a skill in the kit manifest is malformed' }
    }
    const files: ForemanKitFile[] = []
    for (const item of skill['files'] as unknown[]) {
      const file = item as Record<string, unknown> | null
      if (!file || typeof file['path'] !== 'string' || !isHash(file['sha256'])) {
        return { ok: false, error: `a file of ${skill['name']} in the kit manifest is malformed` }
      }
      files.push({ path: file['path'], sha256: file['sha256'] })
    }
    skills.push({ name: skill['name'], files })
  }

  const agents: ForemanKitAgent[] = []
  for (const entry of value['agents'] as unknown[]) {
    const agent = entry as Record<string, unknown> | null
    if (!agent || typeof agent['name'] !== 'string' || !isHash(agent['sha256'])) {
      return { ok: false, error: 'an agent in the kit manifest is malformed' }
    }
    agents.push({ name: agent['name'], sha256: agent['sha256'] })
  }

  return { ok: true, manifest: { version: version as number, skills, agents } }
}
