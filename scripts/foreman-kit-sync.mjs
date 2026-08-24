#!/usr/bin/env node
/**
 * foreman-kit:sync — refill assets/foreman-kit from the machine's own ~/.claude.
 *
 *   npm run foreman-kit:sync
 *
 * Foreman types `/gaffer` and `/fable-method` into a Claude pane, so those
 * skills — and the three agents `/gaffer` spawns — have to exist on whatever
 * machine Forge was installed on. They live in one person's home directory and
 * nowhere else, which makes them a dependency the repo cannot build and cannot
 * fetch. So it carries them: this script copies the current versions into
 * `assets/foreman-kit/`, where electron-builder picks them up as a resource and
 * electron/foreman/kit.ts installs them into the user's Claude home.
 *
 * The source of truth is always the author's `~/.claude`. Editing a skill in
 * `assets/` and expecting it to stick is the one mistake this script makes
 * cheap to notice: it wipes and rewrites the tree every run.
 *
 * ## Two properties worth protecting
 *
 *  1. **Idempotent.** A run that finds nothing changed leaves `version` alone.
 *     The installer compares that number against the marker in the user's copy,
 *     so a version that ticked on every sync would rewrite every installed kit
 *     on every release, silently reverting anything anybody had adjusted.
 *  2. **Line endings normalised to LF.** `.gitattributes` says `eol=lf`, so a
 *     CRLF file committed here comes back out of a fresh clone as LF and its
 *     sha256 no longer matches the manifest. (fable-5's catalog.md is CRLF on
 *     this machine, so this is not hypothetical.) Text is written LF; bytes
 *     that are not valid UTF-8 are copied verbatim and left to .gitattributes.
 *
 * SAFETY: reads `~/.claude`, writes only inside `assets/foreman-kit/`.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const { FOREMAN_KIT_AGENTS, FOREMAN_KIT_SKILLS, FOREMAN_KIT_MANIFEST } = await import('../shared/foreman-kit.ts')
const { isSafePackPath, packPathProblem } = await import('../shared/skillpack.ts')

const ROOT = resolve(import.meta.dirname, '..')
const KIT = join(ROOT, 'assets', 'foreman-kit')

/** One file per skill is generous; anything larger is a mistake, not a reference. */
const MAX_FILE_BYTES = 1024 * 1024

const claudeHome = () => {
  const override = process.env['CLAUDE_CONFIG_DIR']
  return override && override.trim() ? override.trim() : join(homedir(), '.claude')
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const skipped = []
const copied = []

/**
 * The bytes to write, normalised.
 *
 * Text round-trips through UTF-8; anything that does not is carried verbatim,
 * decided by re-encoding rather than by extension — the same test skill-pack
 * uses, and for the same reason.
 */
function normalise(bytes) {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) return bytes
  return Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')
}

/** Walk a skill folder into `{ path, bytes }`, refusing what should not travel. */
function collect(root, dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    const rel = relative(root, full).split(sep).join('/')

    if (entry.name === 'node_modules') {
      skipped.push(`${rel} — node_modules never travels`)
      continue
    }
    // A link inside a skill folder would pack whatever it points at, which is
    // how a kit ends up carrying a home directory. Only the *top* of a skill is
    // followed, and that happens in syncSkill.
    if (entry.isSymbolicLink()) {
      skipped.push(`${rel} — a link, and the kit carries files`)
      continue
    }
    if (entry.isDirectory()) {
      collect(root, full, out)
      continue
    }
    if (!entry.isFile()) continue

    if (!isSafePackPath(rel)) {
      skipped.push(packPathProblem(rel))
      continue
    }
    const size = statSync(full).size
    if (size > MAX_FILE_BYTES) {
      skipped.push(`${rel} — ${Math.round(size / 1024)} KB, over the ${MAX_FILE_BYTES / 1024} KB limit`)
      continue
    }
    out.push({ path: rel, bytes: normalise(readFileSync(full)) })
  }
}

/** Copy one skill folder into the kit; returns its manifest entry, or null. */
function syncSkill(name) {
  let source = join(claudeHome(), 'skills', name)
  if (!existsSync(source)) {
    skipped.push(`${name} — no such skill in ${claudeHome()}`)
    return null
  }
  // The top of a skill *is* followed: `remotion-best-practices` is a symlink on
  // this machine, so a kit skill could plausibly be one too, and a kit that
  // silently dropped it would be a Foreman that silently could not run.
  if (lstatSync(source).isSymbolicLink()) {
    source = realpathSync(source)
    console.log(`  ${name} is a link → ${source}`)
  }

  const files = []
  collect(source, source, files)
  if (!files.some((f) => f.path === 'SKILL.md')) {
    skipped.push(`${name} — no SKILL.md, so there is nothing Claude would read`)
    return null
  }
  // SKILL.md first, so the file that matters is the first thing in the manifest
  // and the first thing in a diff.
  files.sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)))

  const dest = join(KIT, 'skills', name)
  for (const file of files) {
    const target = join(dest, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.bytes)
  }
  copied.push(`skills/${name} — ${files.length} file${files.length === 1 ? '' : 's'}`)
  return { name, files: files.map((f) => ({ path: f.path, sha256: sha256(f.bytes) })) }
}

/** Copy one agent definition into the kit; returns its manifest entry, or null. */
function syncAgent(name) {
  const source = join(claudeHome(), 'agents', `${name}.md`)
  if (!existsSync(source)) {
    skipped.push(`${name} — no such agent in ${claudeHome()}`)
    return null
  }
  const bytes = normalise(readFileSync(source))
  if (bytes.length > MAX_FILE_BYTES) {
    skipped.push(`${name}.md — over the ${MAX_FILE_BYTES / 1024} KB limit`)
    return null
  }
  mkdirSync(join(KIT, 'agents'), { recursive: true })
  writeFileSync(join(KIT, 'agents', `${name}.md`), bytes)
  copied.push(`agents/${name}.md`)
  return { name, sha256: sha256(bytes) }
}

/* ------------------------------------------------------------------- run */

console.log(`\nForeman kit — from ${claudeHome()}\n`)

// Wiped rather than merged: a skill file deleted upstream has to disappear here
// too, or the kit installs a reference that no longer exists anywhere else.
rmSync(join(KIT, 'skills'), { recursive: true, force: true })
rmSync(join(KIT, 'agents'), { recursive: true, force: true })
mkdirSync(KIT, { recursive: true })

const skills = FOREMAN_KIT_SKILLS.map(syncSkill).filter(Boolean)
const agents = FOREMAN_KIT_AGENTS.map(syncAgent).filter(Boolean)

const manifestPath = join(KIT, FOREMAN_KIT_MANIFEST)
let previous = null
try {
  previous = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch {
  previous = null
}

const content = { skills, agents }
const unchanged =
  previous && JSON.stringify({ skills: previous.skills, agents: previous.agents }) === JSON.stringify(content)
const version = unchanged ? previous.version : Number.isSafeInteger(previous?.version) ? previous.version + 1 : 1

writeFileSync(manifestPath, `${JSON.stringify({ version, ...content }, null, 2)}\n`, 'utf8')

for (const line of copied) console.log(`  copied  ${line}`)
for (const line of skipped) console.log(`  skipped ${line}`)

const fileCount = skills.reduce((n, s) => n + s.files.length, 0) + agents.length
console.log(
  `\n${unchanged ? 'unchanged' : previous ? 'changed' : 'created'} — v${version}, ` +
    `${skills.length} skill${skills.length === 1 ? '' : 's'} and ${agents.length} agent${agents.length === 1 ? '' : 's'}, ` +
    `${fileCount} files.\n`
)

const missing =
  skills.length !== FOREMAN_KIT_SKILLS.length || agents.length !== FOREMAN_KIT_AGENTS.length
if (missing) {
  console.error('Some of the kit is missing from this machine — see the skipped lines above.\n')
  process.exit(1)
}
