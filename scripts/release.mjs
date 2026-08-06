/**
 * Publish the desktop Forge as a GitHub release — the thing a packaged Forge
 * actually watches.
 *
 *   npm run release             build, verify, tag, publish
 *   npm run release -- --dry-run   everything except the three writes
 *
 * ## Why this exists
 *
 * `npm run dist` builds into release/ and stops. Publishing was a hand-typed
 * `gh release create`, and every step of it is quietly load-bearing:
 *
 *  - **latest.yml is the entire feed.** electron-updater reads it and nothing
 *    else. Forget it in the asset list and installed copies report "up to
 *    date" forever, with no error anywhere to notice.
 *  - **A tag that already exists makes `--target` illegal.** GitHub answers
 *    `HTTP 422 Release.target_commitish is invalid`, which names neither the
 *    tag nor the flag.
 *  - **A build can fail and still leave the previous run's artifacts on disk.**
 *    Publishing then ships the old binary under the new version number.
 *
 * So this script does not trust the build: it re-hashes the artifact and
 * checks that latest.yml describes *that file*, at *this* version, before it
 * writes anything anywhere. Same rule as apk-release.mjs — never publish a
 * manifest that lies.
 *
 * ## What it will not do
 *
 * Bump the version. package.json is the source of truth and changing it is a
 * commit, made deliberately, reviewed like any other. If its version is
 * already released this script stops and says so, because two binaries
 * claiming one version is the one mistake a release cannot walk back.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, capture, run } from './apk-lib.mjs'

const REPO = 'stevenmcginty/forge'
const RELEASE_DIR = join(ROOT, 'release')
const FEED = 'latest.yml'
const dryRun = process.argv.slice(2).includes('--dry-run')
const ci = process.argv.slice(2).includes('--ci')
const buildScript = process.env['FORGE_RELEASE_BUILD_SCRIPT'] ?? 'dist'

const die = (msg) => {
  console.error(`\n${msg}\n`)
  process.exit(1)
}
const step = (msg) => console.log(`\n── ${msg}`)

/* ------------------------------------------------------ the tree must be sane */

step('Checking the working tree')

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) die(`package.json has no usable version: ${version}`)
const tag = `v${version}`

// Parallel sessions edit this checkout. A release built from a dirty tree is a
// binary whose source cannot be pointed at afterwards.
const dirty = capture('git', ['status', '--porcelain'])
/*
 * Strip the status columns with a pattern rather than by counting characters.
 *
 * `capture` trims the whole blob, which means the *first* line — and only the
 * first — arrives with its leading space already gone: ` M package-lock.json`
 * comes back as `M package-lock.json`. A fixed `slice(3)` then eats a character
 * of the filename and returns `ackage-lock.json`, which matches nothing in the
 * allow-list below, and CI refuses to release with a message naming the two
 * files it was supposed to be forgiving about.
 *
 * That is exactly what happened to v0.3.0 and v0.3.1: both builds bumped the
 * version, both were told the tree was dirty because of the bump they had just
 * made, and both died — so two pushes produced no release at all and the app
 * quietly stayed where it was. The alignment only breaks on the first line,
 * which is why it looked intermittent rather than broken.
 */
const dirtyPaths = dirty
  .split('\n')
  .map((line) => line.replace(/^[ MADRCU?!]{1,2}\s+/, '').trim())
  .filter(Boolean)
const ciOnlyVersionFiles = new Set(['package.json', 'package-lock.json'])
if (dirty && !(ci && dirtyPaths.every((path) => ciOnlyVersionFiles.has(path)))) {
  die(
    `The working tree has uncommitted changes:\n${dirty}\n\n` +
      'Commit or stash them — a release must be reproducible from a commit.'
  )
}

const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'master') die(`On branch ${branch}, not master. Releases come from master.`)

capture('git', ['fetch', 'origin', '--tags', '--quiet'])
const [behind, ahead] = capture('git', ['rev-list', '--left-right', '--count', 'origin/master...master'])
  .split(/\s+/)
  .map(Number)
if (behind || ahead) {
  die(
    `master is ${ahead} ahead / ${behind} behind origin. Push or pull first — the tag must ` +
      'point at a commit that exists on GitHub.'
  )
}

console.log(`  ok   clean, on master, in sync — releasing ${tag}`)

/* ---------------------------------------------- the version must be unreleased */

step('Checking the version is not already out')

let released = false
try {
  capture('gh', ['release', 'view', tag, '-R', REPO, '--json', 'tagName'], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  released = true
} catch {
  /* no such release — the normal case */
}
if (released) {
  die(
    `Release ${tag} already exists on ${REPO}. Versions are immutable here on purpose:\n` +
      'a re-used tag means two different binaries claiming one version, and every\n' +
      'installed copy that already fetched the old one would never see the new.\n\n' +
      'Bump the version in package.json, commit, then re-run.'
  )
}

console.log(`  ok   ${tag} is unpublished`)

/* ----------------------------------------------------------------- the build */

step(dryRun ? 'Building (dry run — nothing will be published)' : `Building (${buildScript})`)

// shell: true because npm is a .cmd on Windows and Node has refused to spawn
// those directly since the CVE-2024-27980 fix. run() throws on a non-zero
// exit, which is the point: a failed build must never fall through to a
// publish that ships whatever the last successful run left in release/.
run('npm', ['run', buildScript], { shell: true, cwd: ROOT })

/* -------------------------------------------- the feed must describe the build */

step('Verifying the update feed')

const feedPath = join(RELEASE_DIR, FEED)
if (!existsSync(feedPath)) {
  die(
    `${FEED} is not in release/. Without it a packaged Forge has no feed at all and\n` +
      'will report "up to date" forever. Check the `publish:` block in electron-builder.yml —\n' +
      'it is what makes electron-builder emit this file.'
  )
}
const feed = readFileSync(feedPath, 'utf8')

// Top-level keys sit at column 0; the entries under `files:` are indented, so
// anchoring is enough to tell the two sha512s apart without a YAML parser.
const field = (name) => feed.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim()
const feedVersion = field('version')
const feedPathName = field('path')
const feedSha = field('sha512')
const feedSize = Number(feed.match(/^\s+size:\s*(\d+)/m)?.[1])

if (feedVersion !== version) {
  die(
    `${FEED} says version ${feedVersion}, package.json says ${version}. The build did not\n` +
      'produce this feed — stale artifacts in release/. Delete release/ and re-run.'
  )
}

const artifact = join(RELEASE_DIR, feedPathName ?? '')
if (!feedPathName || !existsSync(artifact)) {
  die(`${FEED} points at "${feedPathName}", which is not in release/.`)
}

const actualSha = createHash('sha512').update(readFileSync(artifact)).digest('base64')
const actualSize = statSync(artifact).size
if (actualSha !== feedSha || actualSize !== feedSize) {
  die(
    `${FEED} does not describe the artifact beside it:\n` +
      `  sha512  feed ${feedSha}\n          file ${actualSha}\n` +
      `  size    feed ${feedSize}\n          file ${actualSize}\n\n` +
      'Every update would fail its integrity check. Delete release/ and re-run.'
  )
}

console.log(`  ok   ${feedPathName} — ${(actualSize / 1e6).toFixed(0)} MB, sha512 matches ${FEED}`)

// The blockmap is optional: it only makes updates differential. Its absence
// costs bandwidth, not correctness, so it is uploaded when present and not
// mourned when missing.
const assets = [artifact, feedPath]
const blockmap = `${artifact}.blockmap`
if (existsSync(blockmap)) assets.splice(1, 0, blockmap)
else console.log('  note no .blockmap — updates will download in full')

if (dryRun) {
  console.log(`\nDry run. Would have tagged ${tag} and published:\n` + assets.map((a) => `  ${a}`).join('\n') + '\n')
  process.exit(0)
}

/* --------------------------------------------------------------- tag, publish */

step(`Tagging ${tag}`)

const tagExists = capture('git', ['tag', '-l', tag])
if (!tagExists) run('git', ['tag', '-a', tag, '-m', `Forge ${version}`], { cwd: ROOT })
run('git', ['push', 'origin', tag], { cwd: ROOT })

step(`Publishing ${tag} to github.com/${REPO}`)

// No --target. The tag was just pushed, and GitHub rejects target_commitish on
// a tag that already exists with a 422 that mentions neither.
run(
  'gh',
  [
    'release', 'create', tag,
    '-R', REPO,
    '--title', `Forge ${version}`,
    '--notes',
    `Forge ${version}.\n\n` +
      `Download **${feedPathName}** and run it. Forge updates itself from here: ` +
      'it checks shortly after launch and every six hours, and offers the new ' +
      'version in a banner.\n\n' +
      'Unsigned, so SmartScreen will warn once — More info → Run anyway.',
    ...assets
  ],
  { cwd: ROOT }
)

/* ------------------------------------------------------------------- confirm */

step('Confirming the published feed')

const published = JSON.parse(
  capture('gh', ['release', 'view', tag, '-R', REPO, '--json', 'isDraft,assets'])
)
const names = published.assets.map((a) => a.name)
if (published.isDraft) die(`${tag} published as a draft — a draft is invisible to the updater.`)
if (!names.includes(FEED)) die(`${tag} has no ${FEED} asset. The updater has no feed. Upload it.`)

console.log(`
Published ${tag} — ${names.join(', ')}

Installed copies check:
  https://github.com/${REPO}/releases/latest/download/${FEED}
which now resolves to ${tag}. They will offer it within six hours, or eight
seconds after their next launch.
`)
