import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import {
  FORGE_MANAGED_MARKER,
  SKILL_FILE,
  isValidSkillName,
  parseFrontmatter,
  pluginSkillCommand,
  skillCommandFor,
  skillTemplate,
  slugSkillName,
  type ExternalSkillInfo,
  type ExternalSkillSource,
  type MachineSkillInfo,
  type SkillInfo,
  type SkillLinkState,
  type SkillsList
} from '@shared/skills'

/**
 * The skills library, and the machine-wide bridge to every agent session.
 *
 *   %APPDATA%\Forge\skills\<name>\SKILL.md      the library — Forge owns this
 *   ~\.claude\skills\<name>                     Claude projection
 *   ~\.codex\skills\<name>                      Codex projection
 *
 * …and two more that are read and never written, added because a skill Steve
 * had installed was simply missing from the rail with no way to tell why:
 *
 *   ~\.claude\plugins\cache\<market>\<plugin>\<ver>\skills\<name>\SKILL.md
 *   <project>\.claude\skills\<name>\SKILL.md
 *
 * Everything `/plugin install` puts on the machine lands in the first, and it
 * is invoked as `/<plugin>:<skill>` rather than `/<skill>` — which is why the
 * command travels with the row instead of being derived from the name. See
 * listPlugins and ExternalSkillInfo.
 *
 * Two writable directories, and the whole design is about the difference
 * between them.
 * The library is ours: Forge creates, imports, edits and deletes inside it
 * freely. `~/.claude/skills` is *Steve's*, shared with every `claude` and `kimi`
 * process on the machine and already full of skills he wrote by hand. So Forge
 * only ever adds names it can prove it owns, and the moment a name is already
 * taken by something it did not create, it stops and reports a conflict rather
 * than winning the argument. Losing a hand-written skill to a name clash is not
 * a bug you get to apologise for afterwards.
 *
 * Enabling a skill prefers a directory junction (`symlinkSync(…, 'junction')`),
 * which needs no admin rights on Windows and can never go stale — edit the file
 * in the library and every future session sees the edit. Where the filesystem
 * refuses one (a network home, an odd volume) it falls back to a real copy
 * carrying a `.forge-managed` marker, re-copied on every sync so it catches up
 * eventually. `enabled` is a fact about the library, not about the link, so a
 * copy that fell behind is fixed by the next sync rather than by the user.
 *
 * Deliberately free of any `electron` import: it is handed its directories and
 * an `ipcMain` rather than reaching for them, which is what lets
 * scripts/skills-smoke.mjs drive the real module against a temporary HOME
 * instead of a copy — and, more to the point, without ever touching the real
 * ~/.claude/skills.
 */

export interface SkillsDirs {
  /** %APPDATA%\Forge\skills — the library Forge owns. */
  libraryDir: string
  /** ~\.claude\skills — read by Claude and Kimi sessions on this machine. */
  claudeSkillsDir: string
  /** ~/.codex/skills — read by Codex sessions on this machine. */
  codexSkillsDir?: string
  /** ~/.gemini/antigravity-cli/skills — read by Antigravity CLI sessions. */
  antigravitySkillsDir?: string
  /**
   * Other agents' skill folders (~/.agents/skills, ~/.gemini/skills). Read-only,
   * and only ever to say "that name also exists over there" — a duplicate-skill
   * warning from another tool is not Forge's to fix, but it should not be a
   * mystery either.
   */
  peerDirs?: string[]
  /**
   * ~/.claude/plugins — where `/plugin install` puts things.
   *
   * Read-only in the same strong sense as claudeSkillsDir, and for a blunter
   * reason: the whole tree belongs to Claude Code's plugin manager, which
   * rewrites it on every update. Forge lists what is in there and touches
   * nothing.
   */
  pluginsDir?: string
  /**
   * The project folders to look for `<repo>/.claude/skills` in.
   *
   * A thunk, not an array, because projects are added and removed while Forge
   * is running and the list has to be right at read time — and because taking a
   * function keeps this module free of any import from store.ts.
   */
  projectDirs?: () => Array<{ name: string; path: string }>
}

export interface SkillResult {
  ok: boolean
  /** The folder name that was created/affected, when there is one. */
  name?: string
  error?: string
}

/** Never throw at the caller: a broken library must not take the rail down. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function isDir(path: string): boolean {
  return safe(() => statSync(path).isDirectory(), false)
}

/** Directory entries, sorted, or nothing at all. */
function entries(dir: string): string[] {
  return safe(
    () =>
      readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b)),
    []
  )
}

/** Windows hands junction targets back with a `\\?\` prefix. Strip it. */
function normalisePath(path: string): string {
  return resolve(path.replace(/^\\\\\?\\/, '')).toLowerCase()
}

export class SkillsStore {
  readonly libraryDir: string
  readonly claudeSkillsDir: string
  readonly codexSkillsDir: string | null
  readonly antigravitySkillsDir: string | null
  readonly pluginsDir: string | null
  private readonly peerDirs: string[]
  private readonly projectDirs: () => Array<{ name: string; path: string }>

  constructor(dirs: SkillsDirs) {
    this.libraryDir = dirs.libraryDir
    this.claudeSkillsDir = dirs.claudeSkillsDir
    this.codexSkillsDir = dirs.codexSkillsDir ? resolve(dirs.codexSkillsDir) : null
    this.antigravitySkillsDir = dirs.antigravitySkillsDir ? resolve(dirs.antigravitySkillsDir) : null
    this.pluginsDir = dirs.pluginsDir ? resolve(dirs.pluginsDir) : null
    this.peerDirs = dirs.peerDirs ?? []
    this.projectDirs = dirs.projectDirs ?? (() => [])
  }

  /* --------------------------------------------------------------- paths */

  /**
   * The library folder for `name`, or null when the name is not one we would
   * ever have written. Every path in this module goes through here, so a name
   * arriving over IPC cannot address anything outside the library.
   */
  pathFor(name: string): string | null {
    const clean = String(name ?? '').trim()
    if (!isValidSkillName(clean)) return null
    const path = resolve(join(this.libraryDir, clean))
    const root = resolve(this.libraryDir)
    return path.startsWith(root + sep) ? path : null
  }

  /** Where an enabled skill appears for every agent on the machine. */
  linkPathFor(name: string): string | null {
    return this.linkPathIn(name, this.claudeSkillsDir)
  }

  /** Where an enabled skill appears in Codex's native skill directory. */
  codexLinkPathFor(name: string): string | null {
    return this.codexSkillsDir ? this.linkPathIn(name, this.codexSkillsDir) : null
  }

  /** Where an enabled skill appears in Antigravity's native skill directory. */
  antigravityLinkPathFor(name: string): string | null {
    return this.antigravitySkillsDir ? this.linkPathIn(name, this.antigravitySkillsDir) : null
  }

  private linkPathIn(name: string, rootDir: string): string | null {
    const clean = String(name ?? '').trim()
    if (!isValidSkillName(clean)) return null
    const path = resolve(join(rootDir, clean))
    const root = resolve(rootDir)
    return path.startsWith(root + sep) ? path : null
  }

  ensureLibrary(): string {
    safe(() => mkdirSync(this.libraryDir, { recursive: true }), undefined)
    return this.libraryDir
  }

  /* ---------------------------------------------------------------- read */

  /** The raw SKILL.md, or '' when there is not one. */
  readSkillFile(name: string): string {
    const dir = this.pathFor(name)
    if (!dir) return ''
    return safe(() => readFileSync(join(dir, SKILL_FILE), 'utf8'), '')
  }

  /**
   * Every skill in the library, in name order.
   *
   * `enabled` is the settings list; it is passed in rather than read because
   * settings live in store.ts and this module deliberately knows nothing about
   * them. A folder with no SKILL.md, or with frontmatter nobody could parse,
   * still comes back — with `problem` set and the folder name standing in for
   * the title. Half-written skills are the normal state of a skills folder.
   */
  list(enabled: string[] = []): SkillInfo[] {
    this.ensureLibrary()
    const on = new Set(enabled.map((n) => String(n ?? '').trim()))
    const out: SkillInfo[] = []

    for (const name of entries(this.libraryDir)) {
      const dir = this.pathFor(name)
      if (!dir) continue

      const file = join(dir, SKILL_FILE)
      const isEnabled = on.has(name)
      const info: SkillInfo = {
        name,
        title: name,
        description: '',
        path: dir,
        enabled: isEnabled,
        link: 'absent',
        codexLink: 'absent',
        antigravityLink: 'absent',
        alsoIn: this.peersWith(name)
      }

      if (!existsSync(file)) {
        info.problem = `No ${SKILL_FILE} in this folder — agents will ignore it`
      } else {
        const parsed = parseFrontmatter(safe(() => readFileSync(file, 'utf8'), ''))
        if (parsed.name) info.title = parsed.name
        info.description = parsed.description
        if (!parsed.ok) {
          info.problem = 'No YAML frontmatter — add a --- name/description block'
        } else if (!parsed.name && !parsed.description) {
          info.problem = 'Frontmatter has no name or description'
        }
      }

      const link = this.linkState(name)
      info.link = isEnabled ? link.state : link.state === 'conflict' ? 'conflict' : 'absent'
      const codex = this.codexLinkState(name)
      info.codexLink = isEnabled ? codex.state : codex.state === 'conflict' ? 'conflict' : 'absent'
      const antigravity = this.antigravityLinkState(name)
      info.antigravityLink = isEnabled ? antigravity.state : antigravity.state === 'conflict' ? 'conflict' : 'absent'
      if (info.link === 'conflict') {
        info.problem = `A different “${name}” already exists in ~/.claude/skills — Forge will not overwrite it`
      } else if (info.codexLink === 'conflict') {
        info.problem = `A different “${name}” already exists in ~/.codex/skills — Forge will not overwrite it`
      } else if (info.antigravityLink === 'conflict') {
        info.problem = `A different “${name}” already exists in ~/.gemini/antigravity-cli/skills — Forge will not overwrite it`
      } else if (isEnabled && info.link === 'absent') {
        // Enabled but nothing on the far end: the sync has not run, or failed.
        info.link = 'error'
        info.problem = info.problem ?? 'Enabled, but not synced into ~/.claude/skills yet'
      } else if (isEnabled && info.codexLink === 'absent') {
        info.codexLink = 'error'
        info.problem = info.problem ?? 'Enabled, but not synced into ~/.codex/skills yet'
      } else if (isEnabled && info.antigravityLink === 'absent') {
        info.antigravityLink = 'error'
        info.problem = info.problem ?? 'Enabled, but not synced into Antigravity yet'
      }
      out.push(info)
    }
    return out
  }

  /**
   * The skills that were already in `~/.claude/skills` before Forge got here.
   *
   * This is the *other* half of the rail, and it is read-only in the strongest
   * sense the module can manage: nothing in this method, or in anything it
   * calls, opens a handle for writing, creates the directory, or removes a
   * thing. Steve has ten skills in there — some hand-written, one a junction
   * into ~/.agents/skills — and every Claude and Kimi session on the machine
   * already has all of them loaded. Forge's job is to *show* them, not to own
   * them, so there is no toggle and no delete: the only way one of these ever
   * changes is Steve editing it himself.
   *
   * Anything Forge put there is skipped — a junction into our library or a
   * folder carrying our marker is a *library* skill wearing a different hat,
   * and listing it twice would be a lie about how many skills exist. A name the
   * library also has (enabled or not) comes back `shadowed`, which is the
   * `conflict` link state read from the other side.
   */
  listMachine(): MachineSkillInfo[] {
    const out: MachineSkillInfo[] = []
    for (const name of entries(this.claudeSkillsDir)) {
      const dir = this.linkPathFor(name)
      // A name we would never write is also a name `/name` could not type, and
      // a folder we could not address safely. Skipped rather than guessed at.
      if (!dir) continue
      // Ours, therefore already on the Library side of the rail.
      if (this.linkState(name).owned) continue

      const info: MachineSkillInfo = {
        name,
        title: name,
        description: '',
        path: dir,
        // A junction whose target has gone, or a folder with no SKILL.md, still
        // gets a row: a half-written skill is the normal state of that folder.
        shadowed: safe(() => isDir(join(this.libraryDir, name)), false)
      }

      const file = join(dir, SKILL_FILE)
      if (!safe(() => existsSync(file), false)) {
        info.problem = `No ${SKILL_FILE} in this folder — agents will ignore it`
      } else {
        const parsed = parseFrontmatter(safe(() => readFileSync(file, 'utf8'), ''))
        if (parsed.name) info.title = parsed.name
        info.description = parsed.description
        if (!parsed.ok) info.problem = 'No YAML frontmatter — agents may ignore it'
      }
      out.push(info)
    }
    return out
  }

  /* --------------------------------------------------- plugins and projects */

  /**
   * Every skill that arrived with an installed plugin.
   *
   *   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
   *
   * `installed_plugins.json` is read first and believed: it names the exact
   * `installPath` of the version actually in use, which is the only way to tell
   * the live 0.4.1 from a 0.4.0 the updater has not swept up yet. It is Claude
   * Code's file, so a missing or unparsable one is not an error — the cache is
   * walked instead and the highest-sorting version of each plugin is taken.
   *
   * The command is the part worth getting right. A plugin skill is invoked as
   * `/<plugin>:<skill>`, never `/<skill>` — the namespace comes from the plugin
   * key (`design-council@sjsyrek` → `design-council`), not from the marketplace
   * and not from the folder the skill sits in.
   */
  listPlugins(): ExternalSkillInfo[] {
    if (!this.pluginsDir) return []
    const out: ExternalSkillInfo[] = []
    for (const { plugin, marketplace, version, dir } of this.pluginRoots()) {
      const skillsDir = join(dir, 'skills')
      for (const name of entries(skillsDir)) {
        const info = this.readExternal(join(skillsDir, name), name, 'plugin', `${marketplace} · ${version}`)
        if (!info) continue
        info.command = pluginSkillCommand(plugin, name)
        out.push(info)
      }
    }
    return out.sort((a, b) => a.command.localeCompare(b.command))
  }

  /**
   * The installed plugins, newest version of each, however we can find them.
   *
   * Returns the plugin's own name separately from the marketplace it came
   * through, because only the first goes in the command.
   */
  private pluginRoots(): Array<{ plugin: string; marketplace: string; version: string; dir: string }> {
    const roots: Array<{ plugin: string; marketplace: string; version: string; dir: string }> = []
    const seen = new Set<string>()
    const cacheDir = join(this.pluginsDir!, 'cache')

    const manifest = safe(
      () => JSON.parse(readFileSync(join(this.pluginsDir!, 'installed_plugins.json'), 'utf8')) as unknown,
      null
    )
    const plugins = (manifest as { plugins?: Record<string, unknown> } | null)?.plugins
    if (plugins && typeof plugins === 'object') {
      for (const [key, value] of Object.entries(plugins)) {
        const at = key.lastIndexOf('@')
        const plugin = at > 0 ? key.slice(0, at) : key
        const marketplace = at > 0 ? key.slice(at + 1) : ''
        // The array is one entry per install scope; any of them that still has
        // a folder is a real install, so the first that resolves wins.
        for (const entry of Array.isArray(value) ? value : []) {
          const path = (entry as { installPath?: unknown })?.installPath
          const version = String((entry as { version?: unknown })?.version ?? '') || 'unknown'
          if (typeof path !== 'string' || !isDir(path)) continue
          roots.push({ plugin, marketplace, version, dir: resolve(path) })
          seen.add(plugin)
          break
        }
      }
    }

    // Anything the manifest did not account for — a hand-dropped plugin, or a
    // manifest that would not parse — picked up off the cache directly.
    for (const marketplace of entries(cacheDir)) {
      for (const plugin of entries(join(cacheDir, marketplace))) {
        if (seen.has(plugin)) continue
        const versions = entries(join(cacheDir, marketplace, plugin))
        const version = versions[versions.length - 1]
        if (!version) continue
        roots.push({ plugin, marketplace, version, dir: resolve(join(cacheDir, marketplace, plugin, version)) })
      }
    }
    return roots
  }

  /**
   * Every skill checked into a project Forge knows about.
   *
   * A project skill is real only inside its own repo — Claude Code reads
   * `.claude/skills` relative to where it was started — so the row carries the
   * project name and the list spans every project rather than the open one.
   * Seeing a skill you installed in another repo, tagged with that repo, is the
   * whole point; pretending it is global would be the lie.
   */
  listProjectSkills(): ExternalSkillInfo[] {
    const out: ExternalSkillInfo[] = []
    const seen = new Set<string>()
    for (const project of safe(() => this.projectDirs(), [])) {
      const root = String(project?.path ?? '').trim()
      if (!root) continue
      const skillsDir = join(resolve(root), '.claude', 'skills')
      // Two projects pointed at the same folder would otherwise list twice.
      if (seen.has(normalisePath(skillsDir))) continue
      seen.add(normalisePath(skillsDir))
      for (const name of entries(skillsDir)) {
        const info = this.readExternal(join(skillsDir, name), name, 'project', project.name || basename(root))
        if (info) out.push(info)
      }
    }
    return out.sort((a, b) => a.origin.localeCompare(b.origin) || a.name.localeCompare(b.name))
  }

  /**
   * One external skill folder read into a row, or null when there is nothing
   * there at all. A folder with no SKILL.md is not a half-written skill here —
   * unlike the library, nobody is going to finish it in Forge — so it is
   * skipped rather than listed with a problem.
   */
  private readExternal(
    dir: string,
    name: string,
    source: ExternalSkillSource,
    origin: string
  ): ExternalSkillInfo | null {
    const path = resolve(dir)
    const file = join(path, SKILL_FILE)
    if (!safe(() => existsSync(file), false)) return null

    const parsed = parseFrontmatter(safe(() => readFileSync(file, 'utf8'), ''))
    const info: ExternalSkillInfo = {
      name,
      title: parsed.name || name,
      description: parsed.description,
      path,
      id: path,
      source,
      origin,
      command: skillCommandFor(name),
      shadowed: false
    }
    if (!parsed.ok) info.problem = 'No YAML frontmatter — agents may ignore it'
    return info
  }

  /** Every half in one read, which is what the list IPC hands the renderer. */
  listAll(enabled: string[] = []): SkillsList {
    const skills = this.list(enabled)
    const machineSkills = this.listMachine()
    const externalSkills = [...this.listPlugins(), ...this.listProjectSkills()]
    // `shadowed` is a hint on the row, not a filter: a plugin skill whose name
    // clashes with a library one is still a different skill with a different
    // command, and hiding it would be the same bug this whole change is fixing.
    const taken = new Set([...skills.map((s) => s.name), ...machineSkills.map((s) => s.name)])
    for (const skill of externalSkills) skill.shadowed = taken.has(skill.name)
    return { skills, machineSkills, externalSkills }
  }

  /**
   * The folder an external id addresses, or null.
   *
   * Externals are addressed by absolute path rather than by name, so this is
   * the containment check that stands in for `pathFor`'s name validation: a
   * path arriving over IPC is only ever honoured when it sits inside the plugin
   * tree or inside a known project's `.claude/skills`, which is exactly the set
   * of folders the list came out of.
   */
  externalPathFor(id: string): string | null {
    const path = safe(() => resolve(String(id ?? '').trim()), '')
    if (!path || !isDir(path)) return null
    const target = normalisePath(path)
    const roots: string[] = []
    if (this.pluginsDir) roots.push(this.pluginsDir)
    for (const project of safe(() => this.projectDirs(), [])) {
      const root = String(project?.path ?? '').trim()
      if (root) roots.push(join(resolve(root), '.claude', 'skills'))
    }
    for (const root of roots) {
      const base = normalisePath(root)
      if (target.startsWith(base + sep) || target === base) return path
    }
    return null
  }

  /** The raw SKILL.md of a plugin or project skill, addressed by path. */
  readExternalSkillFile(id: string): string {
    const dir = this.externalPathFor(id)
    if (!dir) return ''
    return safe(() => readFileSync(join(dir, SKILL_FILE), 'utf8'), '')
  }

  /**
   * The raw SKILL.md of a machine skill. Reads through the junction, and can
   * only ever address a folder directly inside `~/.claude/skills` — same
   * name-validating path builder the sync uses.
   */
  readMachineSkillFile(name: string): string {
    const dir = this.linkPathFor(name)
    if (!dir) return ''
    return safe(() => readFileSync(join(dir, SKILL_FILE), 'utf8'), '')
  }

  /**
   * Take a copy of a machine skill into the library. A copy — never a move.
   *
   * `importFolder` only ever reads its source (a recursive `cpSync` out of it),
   * so the original is untouched, and the new library copy is a separate skill
   * from that moment on. Enabling it afterwards would hit the conflict interlock
   * against the original, which is correct: the machine already has that name.
   */
  copyMachineToLibrary(name: string): SkillResult {
    const dir = this.linkPathFor(name)
    if (!dir || !isDir(dir)) return { ok: false, error: 'That skill is not in ~/.claude/skills' }
    return this.importFolder(dir)
  }

  /** Which peer agents already have a folder of this name. */
  private peersWith(name: string): string[] {
    const hits: string[] = []
    for (const dir of this.peerDirs) {
      if (safe(() => existsSync(join(dir, name)), false)) hits.push(dir)
    }
    return hits
  }

  /* --------------------------------------------------------------- write */

  /**
   * A brand-new skill from name + description. Refuses to overwrite: a name
   * that is taken is a question for the user, not something to silently merge.
   */
  createFromTemplate(rawName: string, description: string): SkillResult {
    const name = slugSkillName(rawName)
    if (!name) return { ok: false, error: 'Give the skill a name — letters, digits and hyphens' }
    const dir = this.pathFor(name)
    if (!dir) return { ok: false, error: 'That name cannot be used for a folder' }
    if (existsSync(dir)) return { ok: false, error: `“${name}” is already in your library` }

    const text = String(description ?? '').trim()
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, SKILL_FILE), skillTemplate(name, text), 'utf8')
    } catch (err) {
      return { ok: false, error: `Could not create the skill: ${(err as Error).message}` }
    }
    return { ok: true, name }
  }

  /**
   * Copy an existing skill folder into the library.
   *
   * The source must actually be a skill — a folder with a SKILL.md in it — so
   * that pointing the picker at a project by mistake fails immediately instead
   * of copying a node_modules tree into %APPDATA%. The frontmatter `name:` wins
   * over the folder name where the two disagree, because that is the name the
   * agent will show.
   */
  importFolder(sourceDir: string): SkillResult {
    const source = resolve(String(sourceDir ?? '').trim())
    if (!source || !isDir(source)) return { ok: false, error: 'That is not a folder' }

    const file = join(source, SKILL_FILE)
    if (!existsSync(file)) return { ok: false, error: `No ${SKILL_FILE} in that folder — that is what makes it a skill` }

    const parsed = parseFrontmatter(safe(() => readFileSync(file, 'utf8'), ''))
    const name = slugSkillName(parsed.name) || slugSkillName(basename(source))
    if (!name) return { ok: false, error: 'Could not work out a usable name for that skill' }

    const dir = this.pathFor(name)
    if (!dir) return { ok: false, error: 'That name cannot be used for a folder' }
    if (existsSync(dir)) return { ok: false, error: `“${name}” is already in your library` }
    if (normalisePath(source) === normalisePath(dir)) return { ok: false, error: 'That skill is already the library copy' }

    try {
      this.ensureLibrary()
      // Copy to a scratch name first and rename into place, so an import that
      // dies half way through never leaves a torn skill in the list.
      const staging = `${dir}.importing`
      rmSync(staging, { recursive: true, force: true })
      cpSync(source, staging, { recursive: true, dereference: true, errorOnExist: false, force: true })
      // A source that was itself a managed copy must not carry the marker in.
      rmSync(join(staging, FORGE_MANAGED_MARKER), { force: true })
      renameSync(staging, dir)
    } catch (err) {
      rmSync(`${dir}.importing`, { recursive: true, force: true })
      return { ok: false, error: `Could not import that folder: ${(err as Error).message}` }
    }
    return { ok: true, name }
  }

  /**
   * Delete a skill from the library, unlinking it first so an enabled skill
   * cannot leave a junction pointing at nothing.
   */
  remove(name: string): SkillResult {
    const dir = this.pathFor(name)
    if (!dir) return { ok: false, error: 'Unknown skill' }
    if (!existsSync(dir)) return { ok: true, name }
    this.disable(name)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      return { ok: false, error: `Could not delete that skill: ${(err as Error).message}` }
    }
    return { ok: true, name }
  }

  /* ---------------------------------------------------------------- sync */

  /**
   * What is sitting at `~/.claude/skills/<name>` right now, and whether it is
   * ours to touch.
   *
   * This is the safety interlock the whole feature rests on. `owned` is only
   * ever true for a junction that resolves back into our library, or a directory
   * carrying our marker file — everything else, including a folder with the same
   * name that happens to contain an identical skill, is somebody else's.
   */
  private linkState(name: string): { state: SkillLinkState; owned: boolean } {
    return this.linkStateIn(name, this.claudeSkillsDir)
  }

  private codexLinkState(name: string): { state: SkillLinkState; owned: boolean } {
    return this.codexSkillsDir ? this.linkStateIn(name, this.codexSkillsDir) : { state: 'absent', owned: false }
  }

  private antigravityLinkState(name: string): { state: SkillLinkState; owned: boolean } {
    return this.antigravitySkillsDir ? this.linkStateIn(name, this.antigravitySkillsDir) : { state: 'absent', owned: false }
  }

  private linkStateIn(name: string, rootDir: string): { state: SkillLinkState; owned: boolean } {
    const target = this.linkPathIn(name, rootDir)
    const source = this.pathFor(name)
    if (!target || !source) return { state: 'absent', owned: false }

    const stat = safe(() => lstatSync(target), null)
    if (!stat) return { state: 'absent', owned: false }

    if (stat.isSymbolicLink()) {
      const dest = safe(() => readlinkSync(target), '')
      // A junction that points into our library is ours. One pointing anywhere
      // else was made by something else and is left strictly alone.
      if (dest && normalisePath(dest) === normalisePath(source)) return { state: 'junction', owned: true }
      return { state: 'conflict', owned: false }
    }

    if (stat.isDirectory() && existsSync(join(target, FORGE_MANAGED_MARKER))) {
      return { state: 'copy', owned: true }
    }
    return { state: 'conflict', owned: false }
  }

  /** Public read of the same question, for the smoke test and the UI. */
  linkStateFor(name: string): SkillLinkState {
    return this.linkState(name).state
  }

  codexLinkStateFor(name: string): SkillLinkState {
    return this.codexLinkState(name).state
  }

  antigravityLinkStateFor(name: string): SkillLinkState {
    return this.antigravityLinkState(name).state
  }

  /**
   * Make `name` visible to every Claude and Codex session on this machine.
   *
   * Junction first, copy second. Returns a conflict rather than replacing
   * anything Forge did not put there.
   */
  enable(name: string): SkillResult {
    const source = this.pathFor(name)
    if (!source || !this.linkPathFor(name)) return { ok: false, error: 'Unknown skill' }
    if (!isDir(source)) return { ok: false, error: 'That skill is not in your library any more' }
    const targets = [this.claudeSkillsDir, ...(this.codexSkillsDir ? [this.codexSkillsDir] : []), ...(this.antigravitySkillsDir ? [this.antigravitySkillsDir] : [])]
    const states = targets.map((root) => ({ root, state: this.linkStateIn(name, root) }))
    const conflict = states.find((s) => s.state.state === 'conflict')
    if (conflict) return { ok: false, name, error: `~/${basename(conflict.root)}/skills/${name} already exists and was not created by Forge — rename it first` }
    for (const { root, state } of states) {
      if (state.state !== 'junction') {
        const result = this.enableIn(name, root)
        if (!result.ok) return result
      }
    }
    return { ok: true, name }
  }

  private enableIn(name: string, rootDir: string): SkillResult {
    const source = this.pathFor(name)
    const target = this.linkPathIn(name, rootDir)
    if (!source || !target) return { ok: false, error: 'Unknown skill' }
    const current = this.linkStateIn(name, rootDir)
    safe(() => mkdirSync(rootDir, { recursive: true }), undefined)
    if (current.state === 'copy') this.removeOwned(target)
    try { symlinkSync(source, target, 'junction'); return { ok: true, name } } catch { /* fall through */ }
    try {
      cpSync(source, target, { recursive: true, dereference: true, force: true })
      writeFileSync(join(target, FORGE_MANAGED_MARKER), `${JSON.stringify({ source, syncedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
      return { ok: true, name }
    } catch (err) {
      return { ok: false, name, error: `Could not sync ${name} into ${rootDir}: ${(err as Error).message}` }
    }
  }

  /** Take it back out. Anything Forge does not own is left exactly where it is. */
  disable(name: string): SkillResult {
    if (!this.linkPathFor(name)) return { ok: false, error: 'Unknown skill' }
    const roots = [this.claudeSkillsDir, ...(this.codexSkillsDir ? [this.codexSkillsDir] : []), ...(this.antigravitySkillsDir ? [this.antigravitySkillsDir] : [])]
    const states = roots.map((root) => ({ root, state: this.linkStateIn(name, root) }))
    const foreign = states.find((s) => s.state.state !== 'absent' && !s.state.owned)
    if (foreign) return { ok: false, name, error: `~/${basename(foreign.root)}/skills/${name} was not created by Forge — leaving it alone` }
    for (const { root, state } of states) if (state.state !== 'absent' && !this.removeOwned(this.linkPathIn(name, root)!)) return { ok: false, name, error: `Could not remove ${name} from ${root}` }
    return { ok: true, name }
  }

  /**
   * Remove a junction or a managed copy. Only ever called once linkState() has
   * said we own it — and a junction is unlinked, never recursed into, so there
   * is no path by which this reaches the library it points at.
   */
  private removeOwned(target: string): boolean {
    const stat = safe(() => lstatSync(target), null)
    if (!stat) return true
    if (stat.isSymbolicLink()) {
      if (safe(() => (unlinkSync(target), true), false)) return true
      return safe(() => (rmdirSync(target), true), false)
    }
    return safe(() => (rmSync(target, { recursive: true, force: true }), true), false)
  }

  /**
   * Reconcile `~/.claude/skills` with the enabled list.
   *
   * Called at startup and after every toggle, and it is what makes a copy-mode
   * install self-healing: an edit to the library lands in the copy on the next
   * launch without anybody noticing there was a fallback. Junctions are already
   * live, so they cost a stat and nothing more.
   *
   * Returns the names it could not satisfy, so the UI can say why.
   */
  syncEnabled(enabled: string[]): { synced: string[]; conflicts: string[]; failed: string[] } {
    const synced: string[] = []
    const conflicts: string[] = []
    const failed: string[] = []
    const wanted = new Set<string>()

    for (const raw of enabled ?? []) {
      const name = String(raw ?? '').trim()
      const dir = this.pathFor(name)
      if (!dir || !isDir(dir)) continue
      wanted.add(name)

      const claudeState = this.linkState(name)
      const codexState = this.codexLinkState(name)
      const antigravityState = this.antigravityLinkState(name)
      if (claudeState.state === 'junction' && codexState.state !== 'conflict' && antigravityState.state !== 'conflict' && (codexState.state === 'junction' || !this.codexSkillsDir) && (antigravityState.state === 'junction' || !this.antigravitySkillsDir)) {
        synced.push(name)
        continue
      }
      const result = this.enable(name)
      if (result.ok) synced.push(name)
      else if (claudeState.state === 'conflict' || codexState.state === 'conflict' || antigravityState.state === 'conflict') conflicts.push(name)
      else failed.push(name)
    }

    // Anything of ours still linked that is no longer enabled (or no longer in
    // the library at all) is taken back out. Only ever our own junctions and
    // marked copies — see removeOwned.
    for (const name of entries(this.claudeSkillsDir)) {
      if (wanted.has(name)) continue
      const state = this.linkState(name)
      if (state.owned) this.removeOwned(join(this.claudeSkillsDir, name))
    }
    if (this.codexSkillsDir) for (const name of entries(this.codexSkillsDir)) {
      if (wanted.has(name)) continue
      const state = this.codexLinkState(name)
      if (state.owned) this.removeOwned(join(this.codexSkillsDir, name))
    }
    if (this.antigravitySkillsDir) for (const name of entries(this.antigravitySkillsDir)) {
      if (wanted.has(name)) continue
      const state = this.antigravityLinkState(name)
      if (state.owned) this.removeOwned(join(this.antigravitySkillsDir, name))
    }

    return { synced, conflicts, failed }
  }
}

/* ------------------------------------------------------- process singleton */

let store: SkillsStore | null = null

/** Called once at startup with the real directories. */
export function setSkillsDirs(dirs: SkillsDirs): SkillsStore {
  store = new SkillsStore(dirs)
  store.ensureLibrary()
  return store
}

export function getSkillsStore(): SkillsStore | null {
  return store
}

export interface SkillsChannels {
  list: string
  read: string
  create: string
  import: string
  remove: string
  setEnabled: string
  openFolder: string
  /** Copy one of Steve's ~/.claude/skills into the library. Never a move. */
  copyToLibrary: string
}

/**
 * Wire the channels onto an `ipcMain`.
 *
 * `ipcMain`, the channel names, the enabled list and the folder-opening and
 * folder-picking side effects all arrive as parameters rather than imports —
 * same trick as memory-store.ts, and the reason skills-smoke.mjs can drive the
 * real handlers with no Electron in the process.
 */
export function registerSkillsHandlers(
  ipc: Electron.IpcMain,
  channels: SkillsChannels,
  deps: {
    /** The current `settings.skillsEnabled`. */
    enabled(): string[]
    /** Persist a new enabled list. */
    setEnabled(names: string[]): void
    /** shell.openPath, injected. */
    openPath(path: string): void
    /** The native folder picker, for "Import…". */
    pickFolder(): Promise<string | null>
  }
): void {
  const listNow = (): SkillsList =>
    store?.listAll(deps.enabled()) ?? { skills: [], machineSkills: [], externalSkills: [] }

  ipc.handle(channels.list, () => listNow())

  // Plugin and project skills arrive as a path rather than a name; the store's
  // containment check is what makes that safe, so the path goes straight there.
  ipc.handle(channels.read, (_e, name: string, source?: string) => {
    const key = String(name ?? '')
    if (source === 'plugin' || source === 'project') return store?.readExternalSkillFile(key) ?? ''
    if (source === 'machine') return store?.readMachineSkillFile(key) ?? ''
    return store?.readSkillFile(key) ?? ''
  })

  ipc.handle(channels.create, (_e, name: string, description: string) => {
    const result = store?.createFromTemplate(String(name ?? ''), String(description ?? '')) ?? {
      ok: false,
      error: 'Skills are not available'
    }
    return { ...result, ...listNow() }
  })

  ipc.handle(channels.import, async (_e, sourceDir?: string) => {
    const source = typeof sourceDir === 'string' && sourceDir.trim() ? sourceDir : await deps.pickFolder()
    if (!source) return { ok: false, cancelled: true, ...listNow() }
    const result = store?.importFolder(source) ?? { ok: false, error: 'Skills are not available' }
    return { ...result, ...listNow() }
  })

  ipc.handle(channels.remove, (_e, name: string) => {
    const clean = String(name ?? '')
    const result = store?.remove(clean) ?? { ok: false, error: 'Skills are not available' }
    if (result.ok) deps.setEnabled(deps.enabled().filter((n) => n !== clean))
    return { ...result, ...listNow() }
  })

  ipc.handle(channels.setEnabled, (_e, name: string, on: unknown) => {
    const clean = String(name ?? '')
    if (!store) return { ok: false, error: 'Skills are not available', skills: [], machineSkills: [], externalSkills: [] }
    const result = on === true ? store.enable(clean) : store.disable(clean)
    // The setting only moves when the filesystem agreed — a toggle that says
    // "on" while ~/.claude/skills says otherwise is the worst of both.
    if (result.ok) {
      const next = deps.enabled().filter((n) => n !== clean)
      if (on === true) next.push(clean)
      deps.setEnabled(next)
    }
    return { ...result, ...listNow() }
  })

  /**
   * Copy, never move: the folder in ~/.claude/skills is left exactly as it was,
   * and Steve ends up with two of them — one he owns, one Forge can edit.
   */
  ipc.handle(channels.copyToLibrary, (_e, name: string) => {
    const result = store?.copyMachineToLibrary(String(name ?? '')) ?? {
      ok: false,
      error: 'Skills are not available'
    }
    return { ...result, ...listNow() }
  })

  ipc.handle(channels.openFolder, (_e, name?: string, source?: string) => {
    const dir =
      (name
        ? source === 'plugin' || source === 'project'
          ? store?.externalPathFor(String(name))
          : source === 'machine'
            ? store?.linkPathFor(String(name))
            : store?.pathFor(String(name))
        : null) ??
      store?.ensureLibrary() ??
      ''
    if (dir) deps.openPath(dir)
    return dir
  })
}
