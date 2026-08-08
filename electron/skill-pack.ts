import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseFrontmatter, SKILL_FILE, isValidSkillName } from '@shared/skills'
import {
  FORGEPACK_VERSION,
  PACK_MAX_BYTES,
  PACK_MAX_FILES,
  PACK_MAX_FILE_BYTES,
  PACK_MAX_SKILLS,
  isSafePackPath,
  packPathProblem,
  parsePack,
  pluginIsShareable,
  pluginRecipe,
  type PackFile,
  type PackPlugin,
  type PackPluginSource,
  type PackSkill,
  type SkillPack
} from '@shared/skillpack'
import { writeZip, type ZipEntry } from './zip'
import type { SkillsStore } from './skills-store'

/**
 * Skill packs, against a real filesystem.
 *
 * `shared/skillpack.ts` owns the *format* and every rule that can be decided by
 * looking at a string. This file owns the two things that touch disk — reading
 * the library into a pack, and writing a pack into the library — plus reading
 * the plugin recipes out of Claude Code's own manifest.
 *
 * Electron-free with the store injected, the same shape as skills-store.ts and
 * for the same reason: scripts/pack-check.mjs drives these functions against a
 * `mkdtempSync()` library, so the traversal refusals are tested against a real
 * directory rather than asserted about in the abstract.
 *
 * ## What import is, honestly
 *
 * Importing a pack takes files from someone else and puts them where every
 * `claude` session on the machine can read them. The technical defences below —
 * path containment, size caps, the extension refusal, no overwriting — stop a
 * pack from writing outside a new folder it owns. **None of them can tell you
 * whether the instructions inside are a good idea**, because a skill's whole
 * purpose is to instruct an agent, and prose is not something a validator can
 * clear.
 *
 * Two decisions follow from that, and they are the important ones:
 *
 *  1. **An imported skill lands disabled.** `installPack` never touches the
 *     enabled list. Nothing an imported skill says reaches an agent until
 *     somebody has turned it on in the flyout, which is a deliberate act on a
 *     row that names it.
 *  2. **The pack is readable.** It is plain JSON, so "open it and read the
 *     SKILL.md before you turn it on" is advice a person can actually follow.
 */

export interface PackBuildResult {
  ok: boolean
  error?: string
  pack?: SkillPack
  /** Serialised, ready to write. Present whenever `pack` is. */
  json?: string
  /** Skills asked for that could not be packed, with a reason each. */
  skipped: string[]
}

export interface PackInstallResult {
  ok: boolean
  error?: string
  /** Names now in the library. */
  installed: string[]
  /** Names refused, with a reason each — a name already taken, a bad file. */
  skipped: string[]
}

/** Never throw at the caller: a broken folder must not take the flyout down. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/* ------------------------------------------------------------------ build */

/**
 * Walk a skill folder into `PackFile`s.
 *
 * Text where the bytes round-trip through UTF-8 and base64 where they do not,
 * decided by re-encoding rather than by extension: a `.md` written in UTF-16 is
 * not text as far as this pack is concerned, and a `.dat` full of ASCII is.
 * Getting that backwards would either corrupt a file or make a readable pack
 * unreadable, and the extension is only ever a guess about content.
 *
 * Symlinks and junctions are skipped outright. A skill folder can legitimately
 * contain one — Forge's own `enable` writes junctions elsewhere — but following
 * it would pack whatever it points at, which is how a pack ends up carrying a
 * home directory. Its absence is reported, not silent.
 */
function collectFiles(root: string, dir: string, out: PackFile[], skipped: string[]): void {
  const listing = safe(() => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)), [])
  for (const entry of listing) {
    if (out.length >= PACK_MAX_FILES) {
      skipped.push(`more than ${PACK_MAX_FILES} files — the rest were left out`)
      return
    }
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      skipped.push(`${entry.name} is a link — packs carry files, not links`)
      continue
    }
    if (entry.isDirectory()) {
      collectFiles(root, full, out, skipped)
      continue
    }
    if (!entry.isFile()) continue

    const rel = relative(root, full).split(sep).join('/')
    if (!isSafePackPath(rel)) {
      skipped.push(packPathProblem(rel))
      continue
    }
    const bytes = safe(() => readFileSync(full), null)
    if (!bytes) {
      skipped.push(`${rel} could not be read`)
      continue
    }
    if (bytes.length > PACK_MAX_FILE_BYTES) {
      skipped.push(`${rel} is too big to pack`)
      continue
    }

    const text = bytes.toString('utf8')
    // The round-trip test. A lone surrogate or an invalid sequence comes back
    // from `toString('utf8')` as U+FFFD, so the re-encoded buffer differs.
    if (Buffer.from(text, 'utf8').equals(bytes)) out.push({ path: rel, text })
    else out.push({ path: rel, base64: bytes.toString('base64') })
  }
}

/**
 * Read the installed plugins as recipes.
 *
 * Two files, both Claude Code's: `installed_plugins.json` says what is
 * installed and `known_marketplaces.json` says where each marketplace came
 * from. Neither is written here — that tree belongs to the plugin manager.
 *
 * A marketplace installed from a local directory yields `{ kind: 'local' }` and
 * therefore no commands. It is still listed, because "you have this and your
 * recipient cannot get it this way" is worth saying; the flyout greys it out
 * rather than hiding it.
 */
export function readPluginRecipes(store: SkillsStore): PackPlugin[] {
  const pluginsDir = store.pluginsDir
  if (!pluginsDir) return []

  const marketplaces = safe(
    () => JSON.parse(readFileSync(join(pluginsDir, 'known_marketplaces.json'), 'utf8')) as Record<string, unknown>,
    {} as Record<string, unknown>
  )

  const sourceFor = (name: string): PackPluginSource => {
    const entry = marketplaces[name] as { source?: { source?: unknown; repo?: unknown; url?: unknown } } | undefined
    const source = entry?.source
    if (source?.source === 'github' && typeof source.repo === 'string') return { kind: 'github', repo: source.repo }
    if (source?.source === 'git' && typeof source.url === 'string') return { kind: 'git', url: source.url }
    return { kind: 'local' }
  }

  // Group the flat skill list back onto the plugin each row came from. The
  // store already did the work of finding them; re-walking the cache here would
  // be a second opinion about where a plugin lives.
  const byPlugin = new Map<string, { marketplace: string; version: string; skills: string[] }>()
  for (const skill of store.listPlugins()) {
    // `command` is `/<plugin>:<skill> ` — the plugin namespace, built by
    // pluginSkillCommand, and the only place the row records which plugin it
    // belongs to.
    const plugin = skill.command.replace(/^\//, '').split(':')[0] ?? ''
    if (!plugin) continue
    // `origin` is `<marketplace> · <version>`, assembled in listPlugins.
    const [marketplace = '', version = ''] = skill.origin.split(' · ')
    const key = `${plugin}@${marketplace}`
    const found = byPlugin.get(key) ?? { marketplace, version, skills: [] }
    found.skills.push(skill.name)
    byPlugin.set(key, found)
  }

  const out: PackPlugin[] = []
  for (const [key, value] of byPlugin) {
    const plugin = key.slice(0, key.lastIndexOf('@'))
    out.push({
      plugin,
      marketplace: value.marketplace,
      version: value.version || 'unknown',
      source: sourceFor(value.marketplace),
      skills: value.skills.sort((a, b) => a.localeCompare(b))
    })
  }
  return out.sort((a, b) => a.plugin.localeCompare(b.plugin))
}

/**
 * Build a pack from library skills and, optionally, the plugin recipes.
 *
 * Only the library. `~/.claude/skills` is deliberately not offered: those are
 * folders Forge never wrote and cannot attribute, and a "share everything"
 * button that quietly redistributes someone else's work is the failure mode
 * this whole feature is shaped to avoid. Copy one into the library first — the
 * flyout already has that action — which is a moment to think about whether it
 * is yours to send.
 */
export function buildPack(
  store: SkillsStore,
  options: { skills: string[]; includePlugins: boolean; note?: string; from?: string; now?: () => number }
): PackBuildResult {
  const skipped: string[] = []
  const names = [...new Set((options.skills ?? []).map((n) => String(n ?? '').trim()))].slice(0, PACK_MAX_SKILLS)
  const packed: PackSkill[] = []

  for (const name of names) {
    const dir = store.pathFor(name)
    if (!dir || !safe(() => statSync(dir).isDirectory(), false)) {
      skipped.push(`${name} — not in your library`)
      continue
    }
    const files: PackFile[] = []
    collectFiles(dir, dir, files, skipped)
    if (!files.some((f) => f.path === SKILL_FILE)) {
      skipped.push(`${name} — no ${SKILL_FILE}, so there is nothing to send`)
      continue
    }
    // SKILL.md first, the rest in walk order. Cosmetic to a parser and the
    // point of the format to a person: the pack is plain JSON precisely so a
    // recipient can read the instructions before trusting them, and burying the
    // one file that matters under a base64 blob would waste that.
    files.sort((a, b) => (a.path === SKILL_FILE ? -1 : b.path === SKILL_FILE ? 1 : 0))

    const head = files.find((f) => f.path === SKILL_FILE)
    const parsed = parseFrontmatter(head?.text ?? '')
    packed.push({ name, title: parsed.name || name, description: parsed.description, files })
  }

  const plugins = options.includePlugins ? readPluginRecipes(store) : []

  if (packed.length === 0 && plugins.length === 0) {
    return { ok: false, error: 'Nothing to pack', skipped }
  }

  const pack: SkillPack = {
    forgepack: FORGEPACK_VERSION,
    created: new Date(options.now ? options.now() : Date.now()).toISOString(),
    from: options.from ?? 'Forge',
    note: String(options.note ?? '').slice(0, 2000),
    skills: packed,
    plugins
  }

  // Two-space indent, not minified: the point of JSON here is that a recipient
  // can read it before trusting it, and a single 400KB line is not readable.
  const json = safe(() => JSON.stringify(pack, null, 2), '')
  if (!json) return { ok: false, error: 'Could not build that pack', skipped }
  if (json.length > PACK_MAX_BYTES) {
    return { ok: false, error: `That pack would be over ${Math.round(PACK_MAX_BYTES / 1024 / 1024)}MB`, skipped }
  }

  return { ok: true, pack, json, skipped }
}

/* -------------------------------------------------------------------- zip */

/**
 * The same skills, as a plain zip of folders.
 *
 * The `.forgepack` is the Forge-to-Forge route: it previews, it validates, it
 * installs with one button. It is also **useless to somebody who does not run
 * Forge**, and most people a skill gets sent to do not. A zip of folders is the
 * lowest common denominator and needs no software at all: unzip into
 * `~/.claude/skills` and every `claude` session on that machine has them.
 *
 * So this is not a second export format for its own sake — it is the one that
 * works for the larger audience, and the pack is the richer one for the smaller.
 *
 * Two things ride along that the pack carries structurally and a folder tree
 * cannot:
 *
 *  - **README.md** — where to put these, on all three platforms. Somebody who
 *    was sent a zip has no interface telling them what to do with it.
 *  - **PLUGINS.md** — the `/plugin` recipes, when asked for. Same rule as the
 *    pack: recipes, never copied plugin files.
 */
export function buildZip(
  store: SkillsStore,
  options: { skills: string[]; includePlugins: boolean; note?: string; from?: string; now?: () => number }
): { ok: boolean; error?: string; bytes?: Buffer; skills: number; skipped: string[] } {
  const skipped: string[] = []
  const names = [...new Set((options.skills ?? []).map((n) => String(n ?? '').trim()))].slice(0, PACK_MAX_SKILLS)
  const entries: ZipEntry[] = []
  const included: string[] = []

  for (const name of names) {
    const dir = store.pathFor(name)
    if (!dir || !safe(() => statSync(dir).isDirectory(), false)) {
      skipped.push(`${name} — not in your library`)
      continue
    }
    const files: PackFile[] = []
    collectFiles(dir, dir, files, skipped)
    if (!files.some((f) => f.path === SKILL_FILE)) {
      skipped.push(`${name} — no ${SKILL_FILE}, so there is nothing to send`)
      continue
    }
    for (const file of files) {
      entries.push({
        path: `${name}/${file.path}`,
        bytes: file.text !== undefined ? Buffer.from(file.text, 'utf8') : Buffer.from(file.base64 ?? '', 'base64'),
        // The file's own mtime, so an unzipped skill does not claim to have
        // been written the moment it was sent.
        mtime: safe(() => statSync(join(dir, file.path)).mtime, undefined)
      })
    }
    included.push(name)
  }

  const plugins = options.includePlugins ? readPluginRecipes(store) : []
  if (included.length === 0 && plugins.length === 0) return { ok: false, error: 'Nothing to zip', skills: 0, skipped }

  const stamp = new Date(options.now ? options.now() : Date.now())
  entries.unshift({
    path: 'README.md',
    bytes: Buffer.from(zipReadme(included, plugins, options.note ?? '', options.from ?? 'Forge', stamp), 'utf8'),
    mtime: stamp
  })
  if (plugins.length > 0) {
    entries.push({ path: 'PLUGINS.md', bytes: Buffer.from(pluginsDoc(plugins), 'utf8'), mtime: stamp })
  }

  const zip = writeZip(entries, options.now)
  if (!zip.ok || !zip.bytes) return { ok: false, error: zip.error, skills: included.length, skipped }
  return { ok: true, bytes: zip.bytes, skills: included.length, skipped }
}

/**
 * The note the recipient reads first.
 *
 * Written for somebody who has never heard of Forge — the whole point of the
 * zip route — so it names the destination folder on each platform rather than
 * assuming `~` means anything to them, and it says the skills do nothing until
 * they are in that folder.
 */
function zipReadme(skills: string[], plugins: PackPlugin[], note: string, from: string, stamp: Date): string {
  const lines = [
    '# Skills',
    '',
    `${skills.length} skill${skills.length === 1 ? '' : 's'}, sent from ${from} on ${stamp.toISOString().slice(0, 10)}.`,
    ''
  ]
  if (note.trim()) lines.push('> ' + note.trim().replace(/\n/g, '\n> '), '')

  lines.push(
    '## What these are',
    '',
    'A skill is a folder with a `SKILL.md` in it. Claude Code reads them from one',
    'folder on your machine and offers each one as a `/name` command.',
    '',
    '## Where to put them',
    '',
    'Copy the folders in this zip — not this README — into:',
    '',
    '| | |',
    '| --- | --- |',
    '| Windows | `%USERPROFILE%\\.claude\\skills\\` |',
    '| macOS / Linux | `~/.claude/skills/` |',
    '',
    'Create the folder if it is not there. Restart any running `claude` session',
    'and `/<skill-name>` will be available.',
    '',
    '## Read them first',
    '',
    'A skill is instructions an agent will follow on your machine, and these came',
    'from someone else.',
    '',
    'Open each `SKILL.md` and read it before you copy it in.',
    '',
    'That is the only check there is — nothing scans a skill, and nothing could,',
    'because being instructions is the whole point of the file.',
    ''
  )

  if (skills.length > 0) lines.push('## In this zip', '', ...skills.map((name) => `- \`${name}/\``), '')
  if (plugins.length > 0) {
    lines.push(
      '## Plugins',
      '',
      'The sender also had the plugins listed in `PLUGINS.md`. Those are not in',
      'this zip — they install from their own marketplaces, which is how their',
      'authors keep shipping updates to you.',
      ''
    )
  }
  return lines.join('\n')
}

/** The recipes, as something a person can paste. */
function pluginsDoc(plugins: PackPlugin[]): string {
  const lines = [
    '# Plugins',
    '',
    'Not included as files — on purpose. A plugin belongs to whoever wrote it,',
    'and installing it from its own marketplace is what keeps you on their',
    'updates instead of a frozen copy.',
    '',
    'Run these in a Claude Code session:',
    ''
  ]
  for (const plugin of plugins) {
    const recipe = pluginRecipe(plugin)
    lines.push(`## ${plugin.plugin}`, '')
    if (plugin.skills.length > 0) lines.push(`Skills: ${plugin.skills.map((s) => `\`${s}\``).join(', ')}`, '')
    if (recipe.length === 0) {
      lines.push(
        `The sender installed this from a folder on their own machine, so there is`,
        `no command that would work here. Ask them where they got it.`,
        ''
      )
      continue
    }
    lines.push('```', ...recipe, '```', '', `The sender had version ${plugin.version}; this installs the current one.`, '')
  }
  return lines.join('\n')
}

/* ---------------------------------------------------------------- install */

/**
 * Read a `.forgepack` off disk and validate it, without installing anything.
 *
 * Separate from `installPack` so the flyout can show what is in a pack — the
 * skills, the descriptions, the plugin recipes, and everything that was dropped
 * on the way in — and let somebody decide before a byte is written.
 */
export function readPackFile(path: string): { ok: boolean; error?: string; pack?: SkillPack; dropped: string[] } {
  const text = safe(() => readFileSync(path, 'utf8'), null)
  if (text === null) return { ok: false, error: 'That file could not be read', dropped: [] }
  return parsePack(text, isValidSkillName)
}

/**
 * Write chosen skills from a pack into the library.
 *
 * Three rules, and they are all refusals:
 *
 *  1. **A name already in the library is never touched.** Same rule as
 *     `importFolder`, and for the same reason: losing a skill you wrote to an
 *     incoming name clash is not a bug you get to apologise for afterwards.
 *  2. **Every write is checked against the resolved absolute path**, not only
 *     against the string. `isSafePackPath` already refused the traversal
 *     shapes; this is the check that does not depend on that function being
 *     exhaustive, which is the only kind of check worth having at a boundary.
 *  3. **A skill that fails half way leaves nothing behind.** Files land in a
 *     `.importing` folder that is renamed into place at the end, so a pack that
 *     dies mid-write cannot leave a torn skill the rail would list as real.
 *
 * The enabled list is not touched. See the note at the top of this file.
 */
export function installPack(
  store: SkillsStore,
  pack: SkillPack,
  options: { skills?: string[] } = {}
): PackInstallResult {
  const wanted = options.skills ? new Set(options.skills.map((n) => String(n ?? '').trim())) : null
  const installed: string[] = []
  const skipped: string[] = []

  store.ensureLibrary()

  for (const skill of pack.skills) {
    if (wanted && !wanted.has(skill.name)) continue

    const dir = store.pathFor(skill.name)
    if (!dir) {
      skipped.push(`${skill.name} — not a name a skill folder can have`)
      continue
    }
    if (existsSync(dir)) {
      skipped.push(`${skill.name} — already in your library`)
      continue
    }

    const staging = `${dir}.importing`
    const root = resolve(staging)
    let failure = ''
    try {
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true })

      for (const file of skill.files) {
        const target = resolve(join(staging, file.path))
        // Rule 2. `startsWith(root + sep)` and not `startsWith(root)`, or
        // `<staging>-evil` would pass as being inside `<staging>`.
        if (!target.startsWith(root + sep)) {
          failure = `${skill.name} — ${file.path} tried to write outside its own folder`
          break
        }
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.text !== undefined ? Buffer.from(file.text, 'utf8') : Buffer.from(file.base64 ?? '', 'base64'))
      }

      if (failure) {
        rmSync(staging, { recursive: true, force: true })
        skipped.push(failure)
        continue
      }
      renameSync(staging, dir)
      installed.push(skill.name)
    } catch (err) {
      rmSync(staging, { recursive: true, force: true })
      skipped.push(`${skill.name} — ${(err as Error).message}`)
    }
  }

  return { ok: installed.length > 0 || skipped.length === 0, installed, skipped }
}

/**
 * The plugin half of an imported pack, as commands to type.
 *
 * Forge does not run these. `/plugin` is Claude Code's own command, the tree it
 * writes belongs to its plugin manager, and installing a stranger's plugin is a
 * decision that should cost a deliberate keystroke in a pane somebody is
 * looking at. The flyout offers them for copying, and says which ones came from
 * a local folder and are therefore not reproducible at all.
 */
export function packPluginSummary(pack: SkillPack): { shareable: PackPlugin[]; local: PackPlugin[] } {
  return {
    shareable: pack.plugins.filter(pluginIsShareable),
    local: pack.plugins.filter((p) => !pluginIsShareable(p))
  }
}
