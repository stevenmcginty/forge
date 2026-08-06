/**
 * Skills — the vocabulary shared by the main process, the preload contract, the
 * renderer and scripts/skills-smoke.mjs.
 *
 * A skill is a folder with a `SKILL.md` in it, exactly as Claude Code and Kimi
 * read them:
 *
 *   <library>/<skill-name>/SKILL.md      + whatever support files it likes
 *
 * `SKILL.md` opens with YAML frontmatter carrying `name` and `description`. That
 * is the whole format — everything below is about reading it without ever
 * throwing, because a hand-written skill folder is exactly the kind of thing
 * that turns up half-finished.
 *
 * Kept free of `node:`, `electron` and the DOM so all four callers can import it.
 */

/* -------------------------------------------------------------- link state */

/**
 * How an enabled skill is actually present in `~/.claude/skills`.
 *
 * `junction`  a directory junction pointing at the library copy — the good case
 *             on Windows, needs no admin rights and never goes stale
 * `copy`      a real copy carrying our `.forge-managed` marker, used when the
 *             filesystem refuses a junction
 * `conflict`  something we did not put there is already using the name. Forge
 *             never touches it: Steve has real skills in that folder and losing
 *             one to a name clash would be unforgivable
 * `absent`    nothing there (the normal state for a disabled skill)
 * `error`     enabled, but the sync failed — the reason is on `SkillInfo.problem`
 */
export type SkillLinkState = 'absent' | 'junction' | 'copy' | 'conflict' | 'error'

/** The marker file that says "Forge made this copy and may replace it". */
export const FORGE_MANAGED_MARKER = '.forge-managed'

export const SKILL_FILE = 'SKILL.md'

/**
 * Which of the two folders a skill was read out of.
 *
 * `library`  %APPDATA%\Forge\skills — Forge's own, writable
 * `machine`  ~\.claude\skills — Steve's, read-only to Forge for ever
 */
export type SkillSource = 'library' | 'machine'

/** What every skill has, wherever it was read from. */
export interface SkillBase {
  /** The folder name. This is the id, and what `/<name>` types into a pane. */
  name: string
  /** Frontmatter `name:`, falling back to the folder name. */
  title: string
  /** Frontmatter `description:`. Empty when the file does not say. */
  description: string
  /** Absolute path of the skill folder. */
  path: string
  /** Why this skill is unhappy — malformed frontmatter, failed sync, no SKILL.md. */
  problem?: string
}

/**
 * A skill that is already in `~/.claude/skills` and was NOT put there by Forge.
 *
 * These are Steve's — hand-written, or junctioned in from another agent's folder
 * — and every claude and kimi session on the machine has them loaded already.
 * There is nothing to enable, so there is no toggle; Forge lists them, types
 * them into panes, tells the voice agent they exist, and never writes a byte
 * inside that folder.
 */
export interface MachineSkillInfo extends SkillBase {
  /**
   * A library skill of the same name exists. The library row is the one that
   * counts — same rule as the `conflict` link state, seen from the other side.
   */
  shadowed: boolean
}

/** Both halves of the list, as one IPC round trip hands them back. */
export interface SkillsList {
  skills: SkillInfo[]
  machineSkills: MachineSkillInfo[]
}

/** One skill as the rail draws it. */
export interface SkillInfo extends SkillBase {
  /** In `settings.skillsEnabled`. */
  enabled: boolean
  /** How the enabled copy is present in ~/.claude/skills. */
  link: SkillLinkState
  /** How the enabled copy is present in ~/.codex/skills. */
  codexLink: SkillLinkState
  /** How the enabled copy is present in ~/.gemini/antigravity-cli/skills. */
  antigravityLink: SkillLinkState
  /**
   * Other agents' skill folders (~/.agents/skills, ~/.gemini/skills, …) that
   * already have a folder of this name. Purely a hint: a duplicate-skill warning
   * from some other tool is not Forge's to fix, but it should not be a mystery.
   */
  alsoIn: string[]
}

/**
 * Library first, machine second, one entry per name.
 *
 * A name that is in both is a library skill that Forge either synced into
 * `~/.claude/skills` itself or is refusing to sync over the top of one of
 * Steve's. Either way the library row is the one with the toggle and the one
 * `use_skill` should reach for, so it wins and the machine copy is dropped.
 * Used by the manifest catalogue and by the rail's shadow hint, so the two can
 * never disagree about which row is real.
 */
export function dedupeSkills<M extends { name: string }>(
  library: ReadonlyArray<{ name: string }>,
  machine: readonly M[]
): M[] {
  const taken = new Set(library.map((s) => s.name))
  return machine.filter((s) => !taken.has(s.name))
}

/* ---------------------------------------------------------------- naming */

/** Longest folder name we will write. Well past anything sane. */
export const SKILL_NAME_MAX = 64

/**
 * A folder name we are willing to create, and to hand to `/<name>` in a shell.
 *
 * Lower case, ASCII, no separators, no leading dot — which rules out `..`,
 * absolute paths, alternate data streams and every other way a name off a
 * text field could turn into a write somewhere else.
 */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(name) && name.length <= SKILL_NAME_MAX && !name.includes('..')
}

/**
 * Best-effort folder name from whatever the user typed or dropped: lower case,
 * spaces and punctuation folded to hyphens. Returns '' when nothing usable is
 * left, which every caller treats as a refusal rather than a default.
 */
export function slugSkillName(raw: string): string {
  const slug = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, SKILL_NAME_MAX)
  return isValidSkillName(slug) ? slug : ''
}

/* ---------------------------------------------------------- frontmatter */

export interface SkillFrontmatter {
  name: string
  description: string
  /** False when the file had no `---` block at all, or it never closed. */
  ok: boolean
}

/**
 * Read `name` and `description` out of a SKILL.md.
 *
 * Deliberately not a YAML parser. It handles the shapes real skills are written
 * in — a plain scalar, a quoted scalar, and a `>-`/`|` block folded over several
 * indented lines — and it *never throws*. A file it cannot make sense of comes
 * back with `ok: false` and empty strings, and the caller falls back to the
 * folder name. A skill with a broken header is still a skill.
 */
export function parseFrontmatter(text: string): SkillFrontmatter {
  const empty: SkillFrontmatter = { name: '', description: '', ok: false }
  if (typeof text !== 'string' || !text) return empty

  // Strip a UTF-8 BOM and normalise line endings before anything looks at them:
  // a file saved by Notepad otherwise fails the very first `---` test.
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  while (i < lines.length && lines[i]!.trim() === '') i++
  if (lines[i]?.trim() !== '---') return empty

  const body: string[] = []
  let closed = false
  for (i++; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      closed = true
      break
    }
    body.push(lines[i]!)
  }
  if (!closed) return empty

  const out: SkillFrontmatter = { name: '', description: '', ok: true }
  for (let j = 0; j < body.length; j++) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(body[j]!)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    if (key !== 'name' && key !== 'description') continue

    let value = m[2]!.trim()
    // A block scalar (`>-`, `|`) puts the value on the following indented lines.
    if (value === '' || value === '>' || value === '>-' || value === '|' || value === '|-') {
      const parts: string[] = []
      while (j + 1 < body.length && /^\s+\S/.test(body[j + 1]!)) {
        parts.push(body[++j]!.trim())
      }
      value = parts.join(' ')
    }
    out[key] = unquote(value)
  }
  return out
}

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).trim()
  }
  return v
}

/**
 * Everything after the frontmatter — what gets pasted as a preamble into an
 * agent that has no `/skill` command of its own. Returns the whole file when
 * there is no frontmatter to strip.
 */
export function skillBody(text: string): string {
  const normalised = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = /^\s*---\n[\s\S]*?\n---\n?/.exec(normalised)
  return (m ? normalised.slice(m[0].length) : normalised).trim()
}

/* ------------------------------------------------------------- template */

/** The starter SKILL.md behind "New skill". Real frontmatter, real headings. */
export function skillTemplate(name: string, description: string): string {
  const title = name
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
  return [
    '---',
    `name: ${name}`,
    `description: ${description.replace(/\r?\n/g, ' ').trim()}`,
    '---',
    '',
    `# ${title || name}`,
    '',
    description.trim() || 'What this skill is for, in one line.',
    '',
    '## When to use this',
    '',
    '- The situations that should trigger it.',
    '- Say when NOT to use it too — that is what stops it firing on everything.',
    '',
    '## How to do it',
    '',
    '1. First step.',
    '2. Second step.',
    '3. What "done" looks like.',
    '',
    '## Notes',
    '',
    'Anything the agent would otherwise have to guess.',
    ''
  ].join('\n')
}

/* --------------------------------------------------------------- typing */

/**
 * What gets typed into a pane when a skill is dropped on it, or when the voice
 * agent asks for one.
 *
 * Claude Code and Kimi both read `~/.claude/skills` and both expose what they
 * find as a `/name` slash command, so for those the answer is the command
 * itself — typed, never submitted, so Steve sees it land and presses Enter.
 * Anything else gets the skill's prose as a preamble instead, on one line,
 * because a newline in a terminal *is* Enter.
 */
export function skillCommandFor(name: string): string {
  return `/${name} `
}

export function skillPreambleFor(info: Pick<SkillInfo, 'title' | 'name'>, body: string): string {
  const heading = `Follow this skill — "${info.title || info.name}":`
  const flat = body.replace(/\s+/g, ' ').trim()
  return `${heading} ${flat} `
}

/* -------------------------------------------------------------- blurbs */

/** How much of a skill's description the voice manifest is willing to carry. */
export const SKILL_BLURB_MAX = 120

/**
 * One line of a skill's description, for the SKILLS roster in the manifest.
 *
 * Real descriptions are written for a coding agent that is about to *read the
 * skill*, and they run to a paragraph — Steve's `huashu-design` alone is 1.3k
 * characters. The voice model is doing something much smaller: deciding which
 * name to put in `use_skill`. A sentence is enough for that, and the manifest
 * goes up the wire on every single thing he says, so the rest is cost with no
 * return. Cuts at the first sentence where there is one, otherwise on a word.
 */
export function skillBlurb(description: string): string {
  const flat = String(description ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= SKILL_BLURB_MAX) return flat
  const stop = flat.slice(0, SKILL_BLURB_MAX).search(/[.!?](\s|$)/)
  if (stop > 40) return flat.slice(0, stop + 1)
  const cut = flat.lastIndexOf(' ', SKILL_BLURB_MAX)
  return `${flat.slice(0, cut > 40 ? cut : SKILL_BLURB_MAX).trimEnd()}…`
}

/** Agents that read ~/.claude/skills and expose each one as a slash command. */
export function usesSlashSkills(command: string): boolean {
  const exe = (command.trim().split(/\s+/)[0] ?? '')
    .replace(/^["']|["']$/g, '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(cmd|bat|exe|ps1)$/i, '')
    .toLowerCase()
  return exe === 'claude' || exe === 'kimi' || exe === 'agy'
}

/** Agents that discover skills from their own native skill directory. */
export function usesNativeSkills(command: string): boolean {
  const exe = (command.trim().split(/\s+/)[0] ?? '')
    .replace(/^['"]|['"]$/g, '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(cmd|bat|exe|ps1)$/i, '')
    .toLowerCase()
  return exe === 'claude' || exe === 'kimi' || exe === 'codex' || exe === 'agy'
}

/** Explicit skill invocation for agents with native skill discovery. */
export function skillCommandForAgent(name: string, command: string): string {
  const exe = (command.trim().split(/\s+/)[0] ?? '')
    .replace(/^['"]|['"]$/g, '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(cmd|bat|exe|ps1)$/i, '')
    .toLowerCase()
  return exe === 'codex' ? `$${name} ` : skillCommandFor(name)
}

