/**
 * Skill packs — the file you hand somebody so they end up with your skills.
 *
 * Shared by the main process (electron/skill-pack.ts), the preload contract,
 * the renderer and scripts/pack-check.mjs, so it is free of `node:`, `electron`
 * and the DOM. Everything here is pure and nothing throws.
 *
 * ## Two halves, because they are two different problems
 *
 * A pack carries **skills** and **plugin recipes**, and the split is the whole
 * design:
 *
 *  - **Skills you wrote** travel as content. They are files in your library and
 *    yours to give away, so the pack contains them outright.
 *  - **Plugins you installed** travel as a *recipe* — marketplace, name,
 *    version, and the two `/plugin` commands that reproduce the install. Not as
 *    content. Copying somebody else's plugin out of `~/.claude/plugins` and
 *    posting it to a colleague is republishing their work under your name, and
 *    it also strips them of the update path the marketplace exists to provide.
 *    A recipe is both the honest thing and the more useful one: the recipient
 *    gets the current version and every version after it.
 *
 * The same reasoning applies to a skill sitting in `~/.claude/skills` that you
 * did not write — Forge cannot know who wrote what, so `buildPack` packs only
 * the library, which is the folder Forge itself owns, and the flyout says so.
 *
 * ## Plain JSON on purpose
 *
 * Not a zip, and not compressed. A skill is *instructions an agent will follow*,
 * so a pack is a thing you should be able to open in Notepad and read before you
 * trust it. An opaque binary that installs agent instructions is exactly the
 * habit not to build. Text files stay text in the pack for the same reason;
 * base64 is used only for the genuinely binary ones, and is flagged as such.
 *
 * The cost is size — base64 is +33%, and JSON string escaping is not free. The
 * caps below are set where a pack stops being a document and starts being a
 * payload.
 */

/** Bumped only for a change old Forges could not read. Readers refuse anything else. */
export const FORGEPACK_VERSION = 1

/** What the save dialog offers, and what import filters on. */
export const PACK_EXTENSION = 'forgepack'

/* --------------------------------------------------------------- the caps */

/** Whole-pack ceiling. Past this it is not a document any more. */
export const PACK_MAX_BYTES = 8 * 1024 * 1024
/** Per file. A SKILL.md is a few KB; this leaves room for a diagram. */
export const PACK_MAX_FILE_BYTES = 2 * 1024 * 1024
/** Files in one skill. A skill with more than this is a repository. */
export const PACK_MAX_FILES = 200
/** Skills in one pack. */
export const PACK_MAX_SKILLS = 100
/** Nesting inside a skill folder. */
export const PACK_MAX_DEPTH = 8
/** Characters in one relative path. */
export const PACK_MAX_PATH = 200

/* ------------------------------------------------------------- the shapes */

/**
 * One file inside a packed skill. Exactly one of `text` / `base64` is set —
 * a file claiming both is malformed and is refused rather than guessed at.
 */
export interface PackFile {
  /** Relative to the skill folder, forward slashes, validated by isSafePackPath. */
  path: string
  /** UTF-8 content, verbatim. The normal case. */
  text?: string
  /** Base64, for a file that is not valid UTF-8 text. */
  base64?: string
}

export interface PackSkill {
  /** The folder name it will be installed as. Must pass isValidSkillName. */
  name: string
  /** Frontmatter title, for the import preview. Cosmetic. */
  title: string
  /** Frontmatter description, for the import preview. Cosmetic. */
  description: string
  files: PackFile[]
}

/** Where a marketplace comes from, and therefore whether it can be shared. */
export type PackPluginSource =
  | { kind: 'github'; repo: string }
  | { kind: 'git'; url: string }
  /** A folder on the sender's machine. Nothing the recipient can act on. */
  | { kind: 'local' }

/**
 * A plugin the sender has installed, as instructions rather than as files.
 *
 * `version` is what the sender had, recorded so a mismatch is visible — it is
 * deliberately *not* pinned in the recipe, because `/plugin install` fetching
 * the current version is the point of using a marketplace at all.
 */
export interface PackPlugin {
  /** The plugin's own name — the half before the `@`, and the command namespace. */
  plugin: string
  /** The marketplace it came through — the half after the `@`. */
  marketplace: string
  version: string
  source: PackPluginSource
  /** The skills it brought, so the preview can say what it is for. */
  skills: string[]
}

export interface SkillPack {
  forgepack: number
  /** ISO 8601, stamped by the sender. Informational only; never trusted. */
  created: string
  /** e.g. "Forge 0.3.0". Informational only. */
  from: string
  /** Whatever the sender wanted to say. Shown in the import preview. */
  note: string
  skills: PackSkill[]
  plugins: PackPlugin[]
}

/* ------------------------------------------------------------ path safety */

/**
 * Windows device names. Writing to one of these does not create a file — it
 * opens the device — and the name is reserved with *any* extension, so
 * `nul.txt` counts.
 */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/**
 * Extensions refused on import.
 *
 * Deliberately short, and deliberately not a list of "things that can run
 * code". A skill's whole job is to tell an agent what to do, so a pack that
 * wanted to cause harm would do it in the SKILL.md prose — refusing `.py` or
 * `.sh` would break real skills (this repo's own ship helper scripts) while
 * stopping nothing. The line drawn here is narrower and defensible: files that
 * execute **on a double-click in Explorer**, because "Open folder" is a button
 * in the skills flyout and a stranger's pack must not be able to put a
 * booby-trapped icon under that button.
 */
const REFUSED_EXTENSIONS = new Set([
  'exe',
  'com',
  'scr',
  'pif',
  'msi',
  'msp',
  'cpl',
  'dll',
  'sys',
  'lnk',
  'url',
  'hta',
  'vbs',
  'vbe',
  'jse',
  'wsf',
  'wsh',
  'reg'
])

/**
 * Is this a relative path we are willing to create inside a skill folder?
 *
 * The security boundary of the whole feature: everything else in an imported
 * pack is content, but a path is a *destination*, and a path that escapes is a
 * stranger writing wherever they like on the machine. The rules are all
 * refusals, and containment is checked again against the resolved absolute path
 * at write time (see electron/skill-pack.ts) — this function being correct is
 * not the only thing standing between a pack and `~/.claude/settings.json`.
 *
 * Refused, in order: empty or over-long; backslashes (ambiguous — packs are
 * written with forward slashes); a drive letter or a leading slash (absolute);
 * `.` or `..` anywhere (traversal, including the `a/../../b` form that looks
 * relative); an empty segment (`a//b`, which some resolvers collapse and others
 * do not); a trailing space or dot on a segment (Windows silently strips them,
 * so `foo. ` and `foo` are the same file — a way to smuggle a second write onto
 * one name); characters Windows cannot store, of which `:` is the interesting
 * one because it opens an alternate data stream rather than failing; control
 * characters; a reserved device name; and too many levels deep.
 */
export function isSafePackPath(path: unknown): boolean {
  if (typeof path !== 'string') return false
  const value = path.trim()
  if (!value || value.length > PACK_MAX_PATH) return false
  if (value !== path) return false
  if (value.includes('\\')) return false
  if (value.startsWith('/')) return false
  if (/^[a-z]:/i.test(value)) return false

  const segments = value.split('/')
  if (segments.length > PACK_MAX_DEPTH) return false

  for (const segment of segments) {
    if (!segment) return false
    if (segment === '.' || segment === '..') return false
    if (segment.endsWith(' ') || segment.endsWith('.')) return false
    if (/[<>:"|?*]/.test(segment)) return false
    // Control characters, tested by codepoint so this file holds none itself.
    for (const ch of segment) if (ch.codePointAt(0)! < 0x20) return false
    if (RESERVED.test(segment)) return false
  }

  const last = segments[segments.length - 1]!
  const dot = last.lastIndexOf('.')
  if (dot > 0 && REFUSED_EXTENSIONS.has(last.slice(dot + 1).toLowerCase())) return false

  return true
}

/** Why a path was refused, for the sentence shown to the user. */
export function packPathProblem(path: unknown): string {
  if (typeof path !== 'string' || !path.trim()) return 'a file with no name'
  const last = path.split('/').pop() ?? ''
  const dot = last.lastIndexOf('.')
  if (dot > 0 && REFUSED_EXTENSIONS.has(last.slice(dot + 1).toLowerCase())) {
    return `${path} — packs cannot carry ${last.slice(dot).toLowerCase()} files`
  }
  return `${path} — not a path a skill folder can contain`
}

/* ---------------------------------------------------------------- recipes */

/**
 * The commands that reproduce one plugin install, in order.
 *
 * Typed into a Claude pane rather than run for the user: `/plugin` is Claude
 * Code's own command and Forge has no business reaching into
 * `~/.claude/plugins` to do it by hand — that tree belongs to the plugin
 * manager, which rewrites it on every update.
 *
 * A `local` marketplace yields nothing. It points at a folder on the sender's
 * machine, so there is no honest command to offer; the import preview says so
 * instead of printing something that will fail.
 */
export function pluginRecipe(plugin: PackPlugin): string[] {
  const source = plugin.source
  const add =
    source.kind === 'github'
      ? `/plugin marketplace add ${source.repo}`
      : source.kind === 'git'
        ? `/plugin marketplace add ${source.url}`
        : ''
  if (!add) return []
  return [add, `/plugin install ${plugin.plugin}@${plugin.marketplace}`]
}

/** True when this entry gives the recipient something they can actually run. */
export function pluginIsShareable(plugin: PackPlugin): boolean {
  return pluginRecipe(plugin).length > 0
}

/* ---------------------------------------------------------------- parsing */

export interface PackParse {
  ok: boolean
  pack?: SkillPack
  error?: string
  /**
   * Things dropped on the way in — a file with an unsafe path, a skill with an
   * unusable name. Never silent: the import preview lists these, because a pack
   * that quietly installs less than it claimed is worse than one that refuses.
   */
  dropped: string[]
}

function str(value: unknown, max = 400): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/**
 * Read a `.forgepack` into a pack, or say why not.
 *
 * Written as a validator, not a parser: every field is checked against the
 * shape above and anything unrecognised is dropped rather than carried. The
 * input is a file from someone else, so nothing in it is trusted — not the
 * counts, not the paths, not the encoding flags, and not `forgepack` itself.
 *
 * Requires `isValidSkillName` to be passed in rather than importing it, purely
 * so this module stays the one place the *format* is defined and shared/skills.ts
 * stays the one place a *name* is defined. Circular imports between two files
 * this widely included are not worth the tidiness.
 */
export function parsePack(text: string, isValidSkillName: (name: string) => boolean): PackParse {
  const dropped: string[] = []

  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'That file is empty', dropped }
  if (text.length > PACK_MAX_BYTES) {
    return { ok: false, error: `That pack is larger than ${Math.round(PACK_MAX_BYTES / 1024 / 1024)}MB`, dropped }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'That is not a Forge pack — it is not even JSON', dropped }
  }

  const root = raw as Partial<SkillPack> | null
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return { ok: false, error: 'That is not a Forge pack', dropped }
  }
  if (root.forgepack !== FORGEPACK_VERSION) {
    return {
      ok: false,
      error:
        typeof root.forgepack === 'number'
          ? `That pack is version ${root.forgepack}; this Forge reads version ${FORGEPACK_VERSION}`
          : 'That is not a Forge pack',
      dropped
    }
  }

  const skills: PackSkill[] = []
  for (const entry of Array.isArray(root.skills) ? root.skills.slice(0, PACK_MAX_SKILLS) : []) {
    const item = entry as Partial<PackSkill> | null
    if (!item || typeof item !== 'object') continue
    const name = str(item.name, 64)
    if (!isValidSkillName(name)) {
      dropped.push(`${name || 'a skill with no name'} — not a name a skill folder can have`)
      continue
    }

    const files: PackFile[] = []
    for (const rawFile of Array.isArray(item.files) ? item.files.slice(0, PACK_MAX_FILES) : []) {
      const file = rawFile as Partial<PackFile> | null
      if (!file || typeof file !== 'object') continue
      if (!isSafePackPath(file.path)) {
        dropped.push(`${name}: ${packPathProblem(file.path)}`)
        continue
      }
      const hasText = typeof file.text === 'string'
      const hasBase64 = typeof file.base64 === 'string'
      // Exactly one. Both set is malformed, and picking a winner would mean
      // the file written depends on which branch a reader checks first.
      if (hasText === hasBase64) {
        dropped.push(`${name}: ${file.path} — neither text nor binary, or both`)
        continue
      }
      const size = hasText ? file.text!.length : Math.floor(file.base64!.length * 0.75)
      if (size > PACK_MAX_FILE_BYTES) {
        dropped.push(`${name}: ${file.path} — larger than ${Math.round(PACK_MAX_FILE_BYTES / 1024 / 1024)}MB`)
        continue
      }
      if (hasBase64 && !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64!)) {
        dropped.push(`${name}: ${file.path} — corrupt binary content`)
        continue
      }
      files.push(hasText ? { path: file.path!, text: file.text! } : { path: file.path!, base64: file.base64! })
    }

    // The one file that makes a folder a skill. Without it Claude Code will not
    // read the folder at all, so installing it would be installing nothing.
    if (!files.some((f) => f.path === 'SKILL.md')) {
      dropped.push(`${name} — no SKILL.md, so it is not a skill`)
      continue
    }

    skills.push({
      name,
      title: str(item.title, 120) || name,
      description: str(item.description, 2000),
      files
    })
  }

  const plugins: PackPlugin[] = []
  for (const entry of Array.isArray(root.plugins) ? root.plugins.slice(0, PACK_MAX_SKILLS) : []) {
    const item = entry as Partial<PackPlugin> | null
    if (!item || typeof item !== 'object') continue
    const plugin = str(item.plugin, 64)
    const marketplace = str(item.marketplace, 64)
    // Both halves become part of a command the user is invited to run, so
    // anything that is not a plain package-ish token is refused outright rather
    // than escaped — there is no legitimate plugin name with a space in it.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(plugin) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(marketplace)) {
      dropped.push(`${plugin || 'a plugin'} — not a plugin name`)
      continue
    }
    plugins.push({
      plugin,
      marketplace,
      version: str(item.version, 40) || 'unknown',
      source: parseSource(item.source),
      skills: (Array.isArray(item.skills) ? item.skills : []).map((s) => str(s, 64)).filter(Boolean).slice(0, 64)
    })
  }

  if (skills.length === 0 && plugins.length === 0) {
    return { ok: false, error: 'That pack has nothing in it that could be installed', dropped }
  }

  return {
    ok: true,
    pack: {
      forgepack: FORGEPACK_VERSION,
      created: str(root.created, 40),
      from: str(root.from, 80),
      note: str(root.note, 2000),
      skills,
      plugins
    },
    dropped
  }
}

/**
 * A marketplace source, validated into the closed set.
 *
 * Both forms end up inside a command the user is shown and invited to run, so
 * they are pattern-matched rather than passed through: a `repo` is `owner/name`
 * and a `url` is https or ssh git, and anything else becomes `local`, which
 * yields no command at all.
 */
function parseSource(raw: unknown): PackPluginSource {
  const source = raw as { kind?: unknown; repo?: unknown; url?: unknown } | null
  if (!source || typeof source !== 'object') return { kind: 'local' }
  if (source.kind === 'github') {
    const repo = str(source.repo, 140)
    if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return { kind: 'github', repo }
    return { kind: 'local' }
  }
  if (source.kind === 'git') {
    const url = str(source.url, 400)
    if (/^(https:\/\/|git@)[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/.test(url) && !/\s/.test(url)) {
      return { kind: 'git', url }
    }
    return { kind: 'local' }
  }
  return { kind: 'local' }
}

/* ---------------------------------------------------------------- writing */

/** The suggested filename in the save dialog. */
export function packFileName(pack: Pick<SkillPack, 'skills'>): string {
  const one = pack.skills.length === 1 ? pack.skills[0]!.name : ''
  return `${one || 'forge-skills'}.${PACK_EXTENSION}`
}

/** Bytes as a sentence, for the export confirmation and the import preview. */
export function packSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
