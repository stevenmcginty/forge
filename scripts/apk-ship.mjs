/**
 * Ship a revision of Forge Mobile: bump, build, publish — in that order, in one
 * command.
 *
 *   npm run apk:ship                       # patch: 0.3.7 → 0.3.8
 *   npm run apk:ship -- --bump minor       # feature: 0.3.8 → 0.4.0
 *   npm run apk:ship -- --notes "…"        # release notes for the manifest
 *   npm run apk:ship -- --host x.ngrok.dev # bake a different desktop's address
 *
 * ## Why this exists as its own script
 *
 * The phone updates itself now (see startAutoUpdate in mobile/src/lib/update.ts):
 * it finds a new release, downloads it, verifies the hash and offers it to the
 * installer without being asked. That mechanism is only as good as the release
 * feed behind it, and the feed had two ways to be quietly wrong:
 *
 *  - **A build that is never published.** `apk:build` leaves an APK in
 *    dist-apk/ and nothing else happens. The phone polls a GitHub release it
 *    knows nothing about, and reports "up to date" — truthfully, and uselessly.
 *  - **A build that reuses a version.** `apk:release` refuses a tag that
 *    already exists (correctly — one version must mean one binary), so a
 *    revision built without `--bump` cannot be published at all, and the
 *    discovery of that comes after a five-minute Gradle build.
 *
 * Both are the same mistake: a revision is *three* steps and only one of them
 * was a command. So this is the command. `--bump` defaults to on here, which is
 * the difference between this and `apk:build`: shipping without a new version is
 * not a thing anyone wants, and `--no-bump` is there for the one case that is
 * (a publish of a build that already bumped and then failed to upload).
 *
 * Every argument is passed through to apk-build.mjs untouched, so there is one
 * place that understands them.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APK_ASSET, DIST_APK, RELEASE_REPO, ROOT } from './apk-lib.mjs'

const args = process.argv.slice(2)
const noBump = args.includes('--no-bump')
const passthrough = args.filter((a) => a !== '--no-bump')
// --bump is the default here, and adding it twice would make apk-build read
// the second one as the bump *part* and refuse.
const buildArgs = noBump || passthrough.includes('--bump') ? passthrough : ['--bump', ...passthrough]

/* ------------------------------------------------- the door must be open */

// Checked before the build rather than after it: a five-minute Gradle run that
// ends in "gh is not installed" is five minutes spent learning something that
// was knowable at the start.
const gh = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore', shell: true })
if (gh.status !== 0) {
  console.error(
    'gh is not installed or not signed in, so nothing could be published once built.\n' +
      'Run `gh auth login` first — or use `npm run apk:build` if you only want the file.'
  )
  process.exit(1)
}

/* ------------------------------------------------------------- 1. build */

const step = (script, scriptArgs) => {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...scriptArgs], {
    cwd: ROOT,
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    console.error(`\n${script} failed — nothing was published.`)
    process.exit(result.status ?? 1)
  }
}

step('apk-build.mjs', buildArgs)

const manifestPath = join(DIST_APK, 'latest.json')
if (!existsSync(manifestPath) || !existsSync(join(DIST_APK, APK_ASSET))) {
  console.error('The build reported success but dist-apk/ has no APK and manifest. Not publishing.')
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

/* ----------------------------------------------------------- 2. publish */

step('apk-release.mjs', [])

console.log(`
Shipped Forge Mobile v${manifest.versionName} (build ${manifest.versionCode}).

Every installed copy from build 10 onwards finds this by itself: it checks on
foreground (at most every 30 minutes), downloads and hash-verifies in the
background, and raises Android's install confirmation once while the app is in
front. Older builds still need the Update chip tapped once.

Feed: https://github.com/${RELEASE_REPO}/releases/latest/download/latest.json
`)
