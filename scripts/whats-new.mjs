/**
 * Work out what changed in this release, and write it down twice.
 *
 *   node scripts/whats-new.mjs
 *
 * Outputs, both under src/generated/ and both gitignored:
 *
 *   whats-new.json     imported by the renderer, so the app carries its own
 *                      release notes and the popup needs no network
 *   release-notes.md   read by scripts/release.mjs for the GitHub release body
 *
 * Generated once and used twice, which is the point: the page somebody lands on
 * after clicking "release notes" and the card that pops up after the update
 * cannot describe different releases, because they are the same text.
 *
 * Runs in `predev` and in `pretypecheck`, so the file always exists — including on
 * a fresh clone, where `npm run typecheck` would otherwise fail on an import of a
 * gitignored file. `build` runs typecheck first, so the release path is covered by
 * the same hook. In a checkout the notes describe the unreleased work since the
 * last tag, which is exactly what you want to see while writing it.
 *
 * The rules for turning commits into notes are in shared/whatsnew.ts, which is
 * pure and checked by scripts/share-check.mjs. This file is only git and disk.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'

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

const { notesFrom, parseCommits, renderNotes, WHATS_NEW_LOG_FORMAT } = await import('../shared/whatsnew.ts')

const ROOT = resolve(import.meta.dirname, '..')
const OUT_DIR = join(ROOT, 'src', 'generated')
const REPO = 'stevenmcginty/forge'

/** How far back to look when there is no previous tag at all. */
const FIRST_RELEASE_LIMIT = 60

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  } catch {
    return ''
  }
}

/** Released versions, highest first. */
function releasedVersions() {
  return git(['tag', '--list', 'v*'])
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .map((t) => t.slice(1).split('.').map(Number))
    .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])
}

/**
 * The version these notes are for.
 *
 * CI puts it in the environment (`FORGE_RELEASE_VERSION`) because CI is what
 * decides it: one higher than the highest tag, and not in package.json until
 * `npm version` has run in the workflow. Nothing is ever committed back, so a
 * checkout's package.json sits at whatever it was last committed as — 0.3.0 while
 * v0.3.4 is out.
 *
 * So a checkout works the number out the same way the workflow does rather than
 * trusting package.json. Otherwise every "release notes" link opened from a dev
 * build would point at a release that does not exist.
 */
function version() {
  const fromEnv = String(process.env['FORGE_RELEASE_VERSION'] ?? '').trim()
  if (/^\d+\.\d+\.\d+$/.test(fromEnv)) return fromEnv

  let base = [0, 0, 0]
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? ''
    if (/^\d+\.\d+\.\d+$/.test(raw)) base = raw.split('.').map(Number)
  } catch {
    /* fall through to the tags */
  }

  const top = releasedVersions()[0]
  if (!top) return base.join('.')
  const behind = base[0] < top[0] || (base[0] === top[0] && (base[1] < top[1] || (base[1] === top[1] && base[2] <= top[2])))
  return behind ? [top[0], top[1], top[2] + 1].join('.') : base.join('.')
}

/** The highest released tag, which is where this release's changes start. */
function previousTag() {
  const top = releasedVersions()[0]
  return top ? `v${top.join('.')}` : null
}

const ver = version()
const prev = previousTag()
const range = prev ? [`${prev}..HEAD`] : [`-n`, String(FIRST_RELEASE_LIMIT)]

const raw = git(['log', ...range, `--format=${WHATS_NEW_LOG_FORMAT}`, '--no-merges'])
const notes = notesFrom(parseCommits(raw), {
  version: ver,
  date: new Date().toISOString().slice(0, 10),
  url: ver ? `https://github.com/${REPO}/releases/tag/v${ver}` : `https://github.com/${REPO}/releases`
})

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'whats-new.json'), `${JSON.stringify(notes, null, 2)}\n`, 'utf8')
writeFileSync(join(OUT_DIR, 'release-notes.md'), `${renderNotes(notes)}\n`, 'utf8')

console.log(
  `  ok   what's new — ${ver || 'unversioned'}, ` +
    `${notes.highlights.length} highlight${notes.highlights.length === 1 ? '' : 's'}, ` +
    `${notes.changes.length} other change${notes.changes.length === 1 ? '' : 's'}` +
    `${prev ? ` since ${prev}` : ' (no previous tag)'}`
)
if (notes.highlights.length === 0) {
  console.log("  --   no `Highlight:` lines in the range — the popup will show commit subjects only")
}
