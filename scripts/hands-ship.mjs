/**
 * Ship a revision of Forge Hands: bump, build, publish — in one command.
 *
 *   npm run hands:ship                     # patch: 0.1.0 → 0.1.1
 *   npm run hands:ship -- --bump minor     # feature: 0.1.1 → 0.2.0
 *   npm run hands:ship -- --notes "…"      # release notes
 *
 * Publishes dist-apk/forge-hands.apk as asset `forge-hands.apk` on a release
 * tagged hands-v<version> in github.com/stevenmcginty/forge-hands-releases —
 * its own repo, for the reason apk-lib.mjs gives for the TV feed: a shared
 * repo's `releases/latest` would flip between apps.
 *
 * Every door is checked BEFORE anything changes: gh signed in, the repo
 * present, the tag free. The repo is never created here (a human decision,
 * made once, elsewhere, and it must be public so the phone can download
 * without credentials). Only then is hands/version.json bumped and built.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST_APK, ROOT, capture, run } from './apk-lib.mjs'
import { HANDS_ASSET, HANDS_VERSION_FILE, readHandsVersion } from './hands-build.mjs'

export const HANDS_RELEASE_REPO = 'stevenmcginty/forge-hands-releases'

const args = process.argv.slice(2)
const bumpPart = (() => {
  const at = args.indexOf('--bump')
  if (at === -1) return 'patch'
  const next = args[at + 1] ?? ''
  if (next === '' || next.startsWith('--') || next === 'patch') return 'patch'
  if (next === 'minor') return 'minor'
  console.error(`--bump takes "patch" (default) or "minor", not "${next}".`)
  process.exit(1)
})()
const notes = (() => {
  const at = args.indexOf('--notes')
  return at !== -1 ? (args[at + 1] ?? '') : ''
})()

/* ------------------------------------------------- the doors must be open */

const gh = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore', shell: true })
if (gh.status !== 0) {
  console.error('gh is not installed or not signed in, so nothing could be published. Run `gh auth login` first.\nNothing was changed.')
  process.exit(1)
}

try {
  capture('gh', ['repo', 'view', HANDS_RELEASE_REPO, '--json', 'name'], { stdio: ['ignore', 'pipe', 'ignore'] })
} catch {
  console.error(
    `The releases repo github.com/${HANDS_RELEASE_REPO} does not exist (or gh cannot see it).\n` +
      'Create it by hand first — PUBLIC, because the phone downloads with no credentials.\n' +
      'Nothing was bumped, built or published.'
  )
  process.exit(1)
}

const current = readHandsVersion()
const parts = current.versionName.split('.')
if (bumpPart === 'minor' && parts.length >= 2) {
  parts[parts.length - 2] = String(Number(parts[parts.length - 2] ?? 0) + 1)
  parts[parts.length - 1] = '0'
} else {
  parts[parts.length - 1] = String(Number(parts[parts.length - 1] ?? 0) + 1)
}
const next = { versionCode: current.versionCode + 1, versionName: parts.join('.') }
const tag = `hands-v${next.versionName}`

let tagExists = false
try {
  capture('gh', ['release', 'view', tag, '-R', HANDS_RELEASE_REPO, '--json', 'tagName'], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  tagExists = true
} catch {
  /* no such release — the normal case */
}
if (tagExists) {
  console.error(`Release ${tag} already exists on ${HANDS_RELEASE_REPO}. Fix hands/version.json first.\nNothing was changed.`)
  process.exit(1)
}

/* ----------------------------------------------------- bump, then build */

writeFileSync(HANDS_VERSION_FILE, JSON.stringify(next, null, 2) + '\n')
console.log(`Bumped Forge Hands to v${next.versionName} (build ${next.versionCode}).`)

const built = spawnSync(process.execPath, [join(ROOT, 'scripts', 'hands-build.mjs')], { cwd: ROOT, stdio: 'inherit' })
if (built.status !== 0) {
  console.error('\nhands-build.mjs failed — nothing was published. hands/version.json keeps the bump.')
  process.exit(built.status ?? 1)
}
const apk = join(DIST_APK, HANDS_ASSET)
if (!existsSync(apk)) {
  console.error(`The build reported success but ${apk} is not there. Not publishing.`)
  process.exit(1)
}

/* ------------------------------------------------------------- publish */

console.log(`Publishing ${tag} to github.com/${HANDS_RELEASE_REPO} …`)
// No shell: gh resolves without one, and a shell would split the title (see apk-release.mjs).
run('gh', [
  'release', 'create', tag,
  '-R', HANDS_RELEASE_REPO,
  '--title', `Forge Hands v${next.versionName}`,
  '--notes', notes || `Forge Hands v${next.versionName}.`,
  apk
])

console.log(`
Shipped Forge Hands v${next.versionName} (build ${next.versionCode}).
Download: https://github.com/${HANDS_RELEASE_REPO}/releases/latest/download/${HANDS_ASSET}
`)
