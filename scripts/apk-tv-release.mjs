/**
 * Publish the shared Fire TV app — the one anybody can install.
 *
 *   npm run apk:tv:release            # build --shared, then publish it
 *   npm run apk:tv:release -- --no-build   # publish what is already in dist-apk
 *
 * ## What makes this different from apk:tv
 *
 * `apk:tv` builds a television app for *this house*: the desktop's LAN address
 * is baked into it, and it is downloaded from that desktop over that wifi. It
 * is the right answer here and no answer at all anywhere else.
 *
 * This publishes the other one. Built with `--shared`, so there is no address
 * inside it: on first run it asks the network which Forge is there (see the
 * discovery block in shared/mobile.ts) and lists what answers. Any Forge, in
 * any house, can hand this file to any Fire Stick — which is what makes Forge
 * something you can give somebody rather than something you set up for them.
 *
 * ## Its own repo, on purpose
 *
 * `releases/latest/download/<asset>` resolves to whichever release in a repo is
 * newest. Sharing one repo with the phone feed would mean each app's release
 * hides the other's manifest until the next one follows it — a 404 that appears
 * a week later on somebody else's machine. See TV_RELEASE_REPO in apk-lib.mjs.
 *
 * ## What is published
 *
 *   forge-tv.apk    the signed binary, under the name the desktop serves it as
 *   tv-latest.json  version, size, SHA-256 and the pinned download URL
 *
 * The hash is not decoration. The desktop verifies the bytes against it before
 * putting the file anywhere a television could reach (electron/mobile-tv-fetch.ts),
 * because a television installs whatever it is handed and can check nothing
 * itself.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DIST_APK,
  ROOT,
  TV_APK_ASSET,
  TV_MANIFEST_ASSET,
  TV_RELEASE_REPO,
  capture,
  readVersion,
  run,
  sha256File
} from './apk-lib.mjs'

const args = process.argv.slice(2)
const skipBuild = args.includes('--no-build')
const notes = args.includes('--notes') ? (args[args.indexOf('--notes') + 1] ?? '') : ''

/* ------------------------------------------------------------- 1. build */

const shared = join(DIST_APK, 'forge-tv-shared.apk')

if (!skipBuild) {
  const built = spawnSync(process.execPath, [join(ROOT, 'scripts', 'apk-tv-build.mjs'), '--shared'], {
    cwd: ROOT,
    stdio: 'inherit'
  })
  if (built.status !== 0) {
    console.error('The shared TV build failed — nothing was published.')
    process.exit(built.status ?? 1)
  }
}

if (!existsSync(shared)) {
  console.error(
    `${shared} is not there. Run \`node scripts/apk-tv-build.mjs --shared\` first, or drop --no-build.`
  )
  process.exit(1)
}

/* ---------------------------------------------------------- 2. manifest */

const version = readVersion()
const tag = `tv-v${version.versionName}`
const sizeBytes = statSync(shared).size
const sha256 = sha256File(shared)

// Pinned to the tag rather than to `latest`: the manifest and the binary it
// describes must move together, or a desktop could verify one release's hash
// against another release's bytes and refuse a perfectly good download.
const url = `https://github.com/${TV_RELEASE_REPO}/releases/download/${tag}/${TV_APK_ASSET}`
const manifest = {
  versionName: version.versionName,
  versionCode: version.versionCode,
  url,
  sizeBytes,
  sha256,
  notes: notes || `Forge TV ${version.versionName}.`
}
const manifestPath = join(DIST_APK, TV_MANIFEST_ASSET)
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Wrote ${manifestPath} — ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…`)

/* ------------------------------------------------- 3. the repo must exist */

try {
  capture('gh', ['repo', 'view', TV_RELEASE_REPO, '--json', 'name'], { stdio: ['ignore', 'pipe', 'ignore'] })
} catch {
  console.error(
    `The releases repo github.com/${TV_RELEASE_REPO} does not exist (or gh cannot see it).\n\n` +
      'Create it once, and it must be PUBLIC — the desktops that download from it send no\n' +
      'credentials:\n' +
      `  gh repo create ${TV_RELEASE_REPO} --public -d "Forge TV releases"\n\n` +
      'Nothing was uploaded.'
  )
  process.exit(1)
}

/* A brand-new repo has no commits, and GitHub will not hang a release tag on
 * nothing — it answers "Repository is empty" after the upload has been
 * attempted, which reads like a broken script rather than a first run. Seeding
 * one README is the whole fix, and it is also the page anybody who follows the
 * download URL back to its source will land on. */
let empty = false
try {
  capture('gh', ['api', `repos/${TV_RELEASE_REPO}/commits`, '--jq', 'length'], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
} catch {
  empty = true
}
if (empty) {
  console.log(`${TV_RELEASE_REPO} has no commits yet — writing a README so releases have something to tag.`)
  const readme = [
    '# Forge TV releases',
    '',
    'Signed builds of the Forge Fire TV app, and nothing else. The source lives in',
    '[stevenmcginty/forge](https://github.com/stevenmcginty/forge).',
    '',
    'This app has **no desktop address inside it**: on first run it asks the local',
    'network which Forge is there and lists what answers. Nothing here is meant to',
    'be downloaded by hand — Forge on the desktop fetches it, checks it against the',
    'SHA-256 published beside it, and serves it to the television.',
    ''
  ].join('\n')
  run('gh', [
    'api',
    `repos/${TV_RELEASE_REPO}/contents/README.md`,
    '-X', 'PUT',
    '-f', 'message=Forge TV releases',
    '-f', `content=${Buffer.from(readme, 'utf8').toString('base64')}`
  ])
}

let tagExists = false
try {
  capture('gh', ['release', 'view', tag, '-R', TV_RELEASE_REPO, '--json', 'tagName'], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  tagExists = true
} catch {
  /* no such release — the normal case */
}
if (tagExists) {
  console.error(
    `Release ${tag} already exists on ${TV_RELEASE_REPO}. Versions are immutable here on purpose —\n` +
      'a re-used tag means two different binaries claiming one version. Bump mobile/version.json\n' +
      '(npm run apk:build -- --bump does it) and publish again.'
  )
  process.exit(1)
}

/* -------------------------------------------------------------- 4. publish
 *
 * The asset has to *be* called forge-tv.apk, because that is the name the
 * manifest's pinned URL asks for. GitHub takes the uploaded file's own name and
 * `gh`'s `path#label` sets only the display label — verified the hard way, with
 * a release whose one asset was called forge-tv-shared.apk and a manifest
 * pointing at a 404. So the file is copied under the published name first,
 * into a directory of its own: dist-apk/forge-tv.apk is this machine's *local*
 * TV app, addressed to this desktop, and must not be overwritten by the shared
 * one on its way out of the door.
 */

const outbox = join(DIST_APK, 'publish')
mkdirSync(outbox, { recursive: true })
const asset = join(outbox, TV_APK_ASSET)
copyFileSync(shared, asset)

console.log(`Publishing ${tag} to github.com/${TV_RELEASE_REPO} …`)
run('gh', [
  'release', 'create', tag,
  '-R', TV_RELEASE_REPO,
  '--title', `Forge TV ${version.versionName}`,
  '--notes', manifest.notes,
  asset,
  manifestPath
])

console.log(`
Published. Every Forge now finds it at
  https://github.com/${TV_RELEASE_REPO}/releases/latest/download/${TV_MANIFEST_ASSET}

On any desktop: Settings › Forge Mobile › Forge TV › Download the TV app, then
type the address it shows into Downloader on the television.
`)
