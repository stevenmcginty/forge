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
  skillTemplate,
  slugSkillName,
  type SkillInfo,
  type SkillLinkState
} from '@shared/skills'

/**
 * The skills library, and the machine-wide bridge to every agent session.
 *
 *   %APPDATA%\Forge\skills\<name>\SKILL.md      the library — Forge owns this
 *   ~\.claude\skills\<name>                     the bridge — Forge borrows this
 *
 * Two directories, and the whole design is about the difference between them.
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
  /** ~\.claude\skills — read by every claude and kimi session on this machine. */
  claudeSkillsDir: string
  /**
   * Other agents' skill folders (~/.agents/skills, ~/.gemini/skills). Read-only,
   * and only ever to say "that name also exists over there" — a duplicate-skill
   * warning from another tool is not Forge's to fix, but it should not be a
   * mystery either.
   */
  peerDirs?: string[]
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
  private readonly peerDirs: string[]

  constructor(dirs: SkillsDirs) {
    this.libraryDir = dirs.libraryDir
    this.claudeSkillsDir = dirs.claudeSkillsDir
    this.peerDirs = dirs.peerDirs ?? []
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
    const clean = String(name ?? '').trim()
    if (!isValidSkillName(clean)) return null
    const path = resolve(join(this.claudeSkillsDir, clean))
    const root = resolve(this.claudeSkillsDir)
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
      if (info.link === 'conflict') {
        info.problem = `A different “${name}” already exists in ~/.claude/skills — Forge will not overwrite it`
      } else if (isEnabled && info.link === 'absent') {
        // Enabled but nothing on the far end: the sync has not run, or failed.
        info.link = 'error'
        info.problem = info.problem ?? 'Enabled, but not synced into ~/.claude/skills yet'
      }
      out.push(info)
    }
    return out
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
    const target = this.linkPathFor(name)
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

  /**
   * Make `name` visible to every claude and kimi session on this machine.
   *
   * Junction first, copy second. Returns a conflict rather than replacing
   * anything Forge did not put there.
   */
  enable(name: string): SkillResult {
    const source = this.pathFor(name)
    const target = this.linkPathFor(name)
    if (!source || !target) return { ok: false, error: 'Unknown skill' }
    if (!isDir(source)) return { ok: false, error: 'That skill is not in your library any more' }

    const current = this.linkState(name)
    if (current.state === 'conflict') {
      return {
        ok: false,
        name,
        error: `~/.claude/skills/${name} already exists and was not created by Forge — rename one of them`
      }
    }
    if (current.state === 'junction') return { ok: true, name }

    safe(() => mkdirSync(this.claudeSkillsDir, { recursive: true }), undefined)

    // An existing managed copy is refreshed rather than trusted: the library
    // copy is the truth, and a copy is only ever a cache of it.
    if (current.state === 'copy') {
      this.removeOwned(target)
    }

    try {
      symlinkSync(source, target, 'junction')
      return { ok: true, name }
    } catch {
      /* no junctions here — fall through to a real copy */
    }

    try {
      cpSync(source, target, { recursive: true, dereference: true, force: true })
      writeFileSync(
        join(target, FORGE_MANAGED_MARKER),
        `${JSON.stringify({ source, syncedAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8'
      )
      return { ok: true, name }
    } catch (err) {
      return { ok: false, name, error: `Could not sync into ~/.claude/skills: ${(err as Error).message}` }
    }
  }

  /** Take it back out. Anything Forge does not own is left exactly where it is. */
  disable(name: string): SkillResult {
    const target = this.linkPathFor(name)
    if (!target) return { ok: false, error: 'Unknown skill' }
    const current = this.linkState(name)
    if (current.state === 'absent') return { ok: true, name }
    if (!current.owned) {
      return { ok: false, name, error: `~/.claude/skills/${name} was not created by Forge — leaving it alone` }
    }
    return this.removeOwned(target)
      ? { ok: true, name }
      : { ok: false, name, error: 'Could not remove the link from ~/.claude/skills' }
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

      const state = this.linkState(name)
      if (state.state === 'junction') {
        synced.push(name)
        continue
      }
      const result = this.enable(name)
      if (result.ok) synced.push(name)
      else if (state.state === 'conflict') conflicts.push(name)
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
  const listNow = (): SkillInfo[] => store?.list(deps.enabled()) ?? []

  ipc.handle(channels.list, () => listNow())

  ipc.handle(channels.read, (_e, name: string) => store?.readSkillFile(String(name ?? '')) ?? '')

  ipc.handle(channels.create, (_e, name: string, description: string) => {
    const result = store?.createFromTemplate(String(name ?? ''), String(description ?? '')) ?? {
      ok: false,
      error: 'Skills are not available'
    }
    return { ...result, skills: listNow() }
  })

  ipc.handle(channels.import, async (_e, sourceDir?: string) => {
    const source = typeof sourceDir === 'string' && sourceDir.trim() ? sourceDir : await deps.pickFolder()
    if (!source) return { ok: false, cancelled: true, skills: listNow() }
    const result = store?.importFolder(source) ?? { ok: false, error: 'Skills are not available' }
    return { ...result, skills: listNow() }
  })

  ipc.handle(channels.remove, (_e, name: string) => {
    const clean = String(name ?? '')
    const result = store?.remove(clean) ?? { ok: false, error: 'Skills are not available' }
    if (result.ok) deps.setEnabled(deps.enabled().filter((n) => n !== clean))
    return { ...result, skills: listNow() }
  })

  ipc.handle(channels.setEnabled, (_e, name: string, on: unknown) => {
    const clean = String(name ?? '')
    if (!store) return { ok: false, error: 'Skills are not available', skills: [] }
    const result = on === true ? store.enable(clean) : store.disable(clean)
    // The setting only moves when the filesystem agreed — a toggle that says
    // "on" while ~/.claude/skills says otherwise is the worst of both.
    if (result.ok) {
      const next = deps.enabled().filter((n) => n !== clean)
      if (on === true) next.push(clean)
      deps.setEnabled(next)
    }
    return { ...result, skills: listNow() }
  })

  ipc.handle(channels.openFolder, (_e, name?: string) => {
    const dir = (name ? store?.pathFor(String(name)) : null) ?? store?.ensureLibrary() ?? ''
    if (dir) deps.openPath(dir)
    return dir
  })
}
