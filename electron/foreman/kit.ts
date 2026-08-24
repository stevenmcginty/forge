import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import {
  FOREMAN_KIT_MANIFEST,
  parseForemanKitManifest,
  readForemanMarker,
  withForemanMarker,
  type ForemanKitManifest,
  type ForemanKitSkill
} from '@shared/foreman-kit'
import { isSafePackPath } from '@shared/skillpack'
import { SKILL_FILE, isValidSkillName } from '@shared/skills'

/**
 * The Foreman kit, against a real filesystem.
 *
 * `shared/foreman-kit.ts` owns the format and the marker; this owns the writes.
 * Electron-free with both directories injected — the kit and the Claude home
 * are arguments, never `homedir()` — which is what lets
 * scripts/foreman-kit-check.mjs drive the real functions against a
 * `mkdtempSync()` home and prove the refusals against actual directories rather
 * than assert about them in the abstract. electron/foreman/kit-path.ts is the
 * one Electron-aware line that finds the kit in a packaged app.
 *
 * ## The rule that matters
 *
 * This writes into `~/.claude`, which belongs to the user and is read by every
 * `claude` session on their machine. `gaffer` is a perfectly ordinary name for
 * a skill somebody wrote themselves. So:
 *
 *   nothing there            → install it, marked
 *   our marker, older        → update it
 *   our marker, same version → leave it entirely alone
 *   no marker of ours        → **keep theirs**, report it, write nothing
 *
 * The last line is the whole point. Forge only ever replaces files it can prove
 * it wrote, and "prove" means the marker it appended, not the name matching.
 * Losing a skill somebody wrote to a name clash is not a bug you get to
 * apologise for afterwards — the same rule `installPack` holds, stated the same
 * way, because it is the same mistake.
 *
 * A kept name means Foreman will run against *their* `/gaffer` rather than
 * ours. That is the right trade: their file is not ours to take, and the report
 * says so plainly enough for the caller to tell them.
 */

export interface KitReport {
  /** Names that were not there before and are now. */
  installed: string[]
  /** Our own older copies, brought up to the bundled version. */
  updated: string[]
  /** Names already taken by a file we did not write. Untouched. */
  kept: string[]
  failed: { name: string; error: string }[]
}

export interface KitOptions {
  /** The bundled `assets/foreman-kit` — see kit-path.ts. */
  kitDir: string
  /** `~/.claude`, or wherever CLAUDE_CONFIG_DIR points. */
  claudeHome: string
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Write one file, atomically, and only ever inside `root`.
 *
 * The containment test is against the *resolved absolute* path, not the string
 * the manifest offered: `isSafePackPath` has already refused the traversal
 * shapes, and this is the check that does not depend on that function being
 * exhaustive — the only kind worth having at a boundary. `root + sep` rather
 * than `root`, or a sibling named `<root>-evil` would pass as being inside it.
 *
 * Temp-then-rename so a file is never half-written: a `claude` session reading
 * `~/.claude/skills` while this runs sees either the old file or the new one.
 */
function writeInside(root: string, target: string, bytes: Buffer): void {
  const full = resolve(target)
  if (!full.startsWith(resolve(root) + sep)) throw new Error(`${target} is outside ${root}`)
  mkdirSync(dirname(full), { recursive: true })
  const temp = `${full}.forge-kit-tmp`
  try {
    writeFileSync(temp, bytes)
    renameSync(temp, full)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

/** What the caller should do about a name already on disk. */
type Verdict = 'install' | 'update' | 'keep' | 'current'

/**
 * Read the marker off whatever is at `path` and decide.
 *
 * An unreadable file counts as somebody else's. It is not ours to guess about,
 * and a read that failed is not evidence that we wrote it.
 */
function verdictFor(path: string, version: number): Verdict {
  if (!existsSync(path)) return 'install'
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return 'keep'
  }
  const mark = readForemanMarker(text)
  if (!mark) return 'keep'
  return mark.version < version ? 'update' : 'current'
}

/**
 * The bundled bytes for one kit file.
 *
 * `rel` comes out of the manifest, which is a file on disk and therefore a file
 * that can be edited, so it is refused twice: once as a string, and once as the
 * absolute path it resolved to. `isSafePackPath` wants forward slashes, which
 * is what the manifest holds; the platform separator only appears after it.
 */
function readKitFile(root: string, rel: string): Buffer {
  if (!isSafePackPath(rel)) throw new Error(`${rel} is not a path the kit may name`)
  const source = resolve(join(root, rel))
  if (!source.startsWith(resolve(root) + sep)) throw new Error(`${rel} is outside the kit`)
  return readFileSync(source)
}

/* ------------------------------------------------------------------ skill */

/**
 * Install or update one skill folder.
 *
 * Fresh installs land through a staging folder renamed into place, so a run
 * that dies half way cannot leave a torn skill that Claude would read as real.
 *
 * An update writes in place, file by file — and **SKILL.md last**, deliberately.
 * SKILL.md carries the marker, so until it lands the folder still says it holds
 * the older version and the next run tries again. An update interrupted in the
 * middle is a folder that repairs itself rather than one that claims to be
 * current and is not.
 *
 * In-place also means a file the user added inside our folder survives. Nothing
 * here deletes; the manifest decides what is written, never what is removed.
 */
function syncSkill(kitDir: string, skillsRoot: string, skill: ForemanKitSkill, version: number, report: KitReport): void {
  const name = skill.name
  if (!isValidSkillName(name)) {
    report.failed.push({ name, error: 'not a name a skill folder can have' })
    return
  }
  const dir = resolve(join(skillsRoot, name))
  if (!dir.startsWith(resolve(skillsRoot) + sep)) {
    report.failed.push({ name, error: 'that name would write outside the skills folder' })
    return
  }
  if (!skill.files.some((f) => f.path === SKILL_FILE)) {
    report.failed.push({ name, error: `no ${SKILL_FILE} in the bundled kit` })
    return
  }

  // A folder already at that name with no SKILL.md in it is somebody else's
  // half-made skill, not a half-made one of ours — installs land through a
  // staging folder precisely so we can never produce that shape. Keep it.
  const verdict = existsSync(dir) && !existsSync(join(dir, SKILL_FILE)) ? 'keep' : verdictFor(join(dir, SKILL_FILE), version)
  if (verdict === 'current') return
  if (verdict === 'keep') {
    report.kept.push(name)
    return
  }

  // Read everything before writing anything: a missing resource should fail the
  // skill, not leave half of it on disk.
  let files: { path: string; bytes: Buffer }[]
  try {
    const source = join(kitDir, 'skills', name)
    files = skill.files.map((f) => ({ path: f.path, bytes: readKitFile(source, f.path) }))
  } catch (err) {
    report.failed.push({ name, error: (err as Error).message })
    return
  }
  const head = files.find((f) => f.path === SKILL_FILE)!
  const rest = files.filter((f) => f !== head)
  const marked = Buffer.from(withForemanMarker(head.bytes.toString('utf8'), version, sha256(head.bytes)), 'utf8')

  if (verdict === 'install') {
    const staging = `${dir}.forge-kit`
    try {
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true })
      for (const file of rest) writeInside(staging, join(staging, file.path), file.bytes)
      writeInside(staging, join(staging, SKILL_FILE), marked)
      renameSync(staging, dir)
      report.installed.push(name)
    } catch (err) {
      rmSync(staging, { recursive: true, force: true })
      report.failed.push({ name, error: (err as Error).message })
    }
    return
  }

  try {
    for (const file of rest) writeInside(dir, join(dir, file.path), file.bytes)
    writeInside(dir, join(dir, SKILL_FILE), marked)
    report.updated.push(name)
  } catch (err) {
    report.failed.push({ name, error: (err as Error).message })
  }
}

/* ------------------------------------------------------------------ agent */

/** Install or update one agent definition. One file, so one atomic write. */
function syncAgent(kitDir: string, agentsRoot: string, name: string, version: number, report: KitReport): void {
  if (!isValidSkillName(name)) {
    report.failed.push({ name, error: 'not a name an agent file can have' })
    return
  }
  const file = `${name}.md`
  const target = resolve(join(agentsRoot, file))
  if (!target.startsWith(resolve(agentsRoot) + sep)) {
    report.failed.push({ name, error: 'that name would write outside the agents folder' })
    return
  }

  const verdict = verdictFor(target, version)
  if (verdict === 'current') return
  if (verdict === 'keep') {
    report.kept.push(name)
    return
  }

  try {
    const bytes = readKitFile(join(kitDir, 'agents'), file)
    const marked = Buffer.from(withForemanMarker(bytes.toString('utf8'), version, sha256(bytes)), 'utf8')
    mkdirSync(agentsRoot, { recursive: true })
    writeInside(agentsRoot, target, marked)
    if (verdict === 'install') report.installed.push(name)
    else report.updated.push(name)
  } catch (err) {
    report.failed.push({ name, error: (err as Error).message })
  }
}

/* ------------------------------------------------------------------- run */

/** The bundled manifest, or a reason it is unusable. */
export function readForemanKit(kitDir: string): { ok: boolean; error?: string; manifest?: ForemanKitManifest } {
  let text: string
  try {
    text = readFileSync(join(kitDir, FOREMAN_KIT_MANIFEST), 'utf8')
  } catch {
    return { ok: false, error: `no ${FOREMAN_KIT_MANIFEST} in ${kitDir}` }
  }
  return parseForemanKitManifest(text)
}

/**
 * Put the kit into a Claude home, and say exactly what happened to each name.
 *
 * Never throws: a kit that cannot be read comes back as one `failed` entry, and
 * a skill that fails leaves the other seven alone. Foreman starting is not a
 * good moment to take the app down over a missing resource.
 */
export function installForemanKit({ kitDir, claudeHome }: KitOptions): KitReport {
  const report: KitReport = { installed: [], updated: [], kept: [], failed: [] }

  const read = readForemanKit(kitDir)
  if (!read.ok || !read.manifest) {
    report.failed.push({ name: FOREMAN_KIT_MANIFEST, error: read.error ?? 'the kit could not be read' })
    return report
  }
  const { version, skills, agents } = read.manifest

  const skillsRoot = join(claudeHome, 'skills')
  const agentsRoot = join(claudeHome, 'agents')
  try {
    mkdirSync(skillsRoot, { recursive: true })
    mkdirSync(agentsRoot, { recursive: true })
  } catch (err) {
    report.failed.push({ name: claudeHome, error: (err as Error).message })
    return report
  }

  // One name's bad day is not the other seven's. Each is wrapped so that an
  // unreadable folder or a locked file costs exactly one entry in `failed`.
  for (const skill of skills) {
    try {
      syncSkill(kitDir, skillsRoot, skill, version, report)
    } catch (err) {
      report.failed.push({ name: skill.name, error: (err as Error).message })
    }
  }
  for (const agent of agents) {
    try {
      syncAgent(kitDir, agentsRoot, agent.name, version, report)
    } catch (err) {
      report.failed.push({ name: agent.name, error: (err as Error).message })
    }
  }

  return report
}
