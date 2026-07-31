/**
 * Publish the artefacts apk:build left in dist-apk/ as a GitHub release on
 * the releases repo — which is what the shipped app's update check watches:
 * `releases/latest/download/latest.json` always redirects to the newest
 * release's manifest, so publishing *is* flipping the switch.
 *
 *   npm run apk:release
 *
 * Deliberately does not create the repo (that is a human decision, made
 * once, elsewhere) and re-verifies the sha before uploading — a manifest
 * whose hash does not match the file beside it would make every phone's
 * update fail its integrity check, loudly, which is the mechanism working
 * but the release wasted.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { APK_ASSET, DIST_APK, RELEASE_REPO, capture, run, sha256File } from './apk-lib.mjs'

const apk = join(DIST_APK, APK_ASSET)
const manifestPath = join(DIST_APK, 'latest.json')

if (!existsSync(apk) || !existsSync(manifestPath)) {
  console.error('dist-apk/ is missing the APK or latest.json — run `npm run apk:build` first.')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const tag = `v${manifest.versionName}`

/* ------------------------------------------- the manifest must be honest */

const actualSha = sha256File(apk)
const actualSize = statSync(apk).size
if (actualSha !== manifest.sha256 || actualSize !== manifest.sizeBytes) {
  console.error(
    `latest.json does not describe the APK beside it (sha ${manifest.sha256} vs ${actualSha}, ` +
      `size ${manifest.sizeBytes} vs ${actualSize}). Rebuild — do not publish a manifest that lies.`
  )
  process.exit(1)
}
if (!manifest.apkUrl.includes(`/releases/download/${tag}/`)) {
  console.error(`latest.json's apkUrl does not point at tag ${tag} — rebuild before publishing.`)
  process.exit(1)
}

/* --------------------------------------------------- the repo must exist */

try {
  capture('gh', ['repo', 'view', RELEASE_REPO, '--json', 'name'], { stdio: ['ignore', 'pipe', 'ignore'] })
} catch {
  console.error(
    `The releases repo github.com/${RELEASE_REPO} does not exist (or gh cannot see it).\n` +
      'Create it first — private is fine for the APK download URLs used here only if made public;\n' +
      'the app fetches with no credentials, so the repo must be PUBLIC. Then re-run apk:release.\n' +
      'Nothing was uploaded.'
  )
  process.exit(1)
}

let tagExists = false
try {
  capture('gh', ['release', 'view', tag, '-R', RELEASE_REPO, '--json', 'tagName'], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  tagExists = true
} catch {
  /* no such release — the normal case */
}
if (tagExists) {
  console.error(
    `Release ${tag} already exists on ${RELEASE_REPO}. Versions are immutable here on purpose —\n` +
      'a re-used tag means two different binaries claiming one version. Bump and rebuild:\n' +
      '  npm run apk:build -- --bump && npm run apk:release'
  )
  process.exit(1)
}

/* ------------------------------------------------------------- publish */

console.log(`Publishing ${tag} to github.com/${RELEASE_REPO} …`)
run(
  'gh',
  [
    'release', 'create', tag,
    '-R', RELEASE_REPO,
    '--title', `Forge Mobile ${tag}`,
    '--notes', manifest.notes || `Forge Mobile ${tag}.`,
    apk,
    manifestPath
  ]
  // No `shell: true`. On Windows that hands the arguments to cmd.exe as one
  // unquoted string, so `--title Forge Mobile v0.1.0` arrives as three tokens
  // and gh treats the last two as asset paths — it fails with
  // "CreateFile v0.1.0: The system cannot find the file specified", which
  // names the tag and so reads like a tag problem rather than a quoting one.
  // `gh` resolves without a shell, so there is nothing to trade away.
)

console.log(`
Published. The app checks:
  https://github.com/${RELEASE_REPO}/releases/latest/download/latest.json
which now resolves to ${tag}. Phones will see it on their next check.
`)
