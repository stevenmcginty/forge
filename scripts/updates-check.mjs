/**
 * The updates system, tested without a network, a winget or a packaged build.
 *
 *   node scripts/updates-check.mjs
 *
 * Everything the Updates & Tools section and the self-update banner *decide* is
 * a pure function in shared/tools.ts, which is what makes this file possible:
 * the registry reply, the winget stdout and the packaged flag are all just
 * values here, so the four things that would be genuinely expensive to get
 * wrong can be asserted in a second.
 *
 * The four:
 *
 *  1. Version comparison. "7.6.10 is newer than 7.6.4" is not string order, and
 *     getting it backwards means either nagging about an update that does not
 *     exist or never mentioning one that does.
 *  2. Parsing what winget and the npm registry actually print — captured from
 *     the real commands, not invented.
 *  3. Banner dismissal. Per version, or the first "not now" is the last update
 *     anybody installs.
 *  4. THE GUARD. `updaterMode()` must answer 'off' for an unpackaged build, or
 *     `npm run dev` can replace its own checkout. This is the assertion that
 *     matters most in the file.
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'

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

const {
  TOOL_SPECS,
  compareVersions,
  formatRate,
  isNewer,
  isNoFeedError,
  npmLatestUrl,
  parseNpmLatest,
  parseVersion,
  parseWingetList,
  relativeTime,
  shouldShowBanner,
  toolSpec,
  updaterMode
} = await import('../shared/tools.ts')

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✕ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ------------------------------------------------------------- catalogue */

console.log('\ncatalogue')
ok(TOOL_SPECS.length === 5, 'five tools', `${TOOL_SPECS.length}`)
ok(
  new Set(TOOL_SPECS.map((t) => t.id)).size === TOOL_SPECS.length,
  'every tool id is unique'
)
ok(toolSpec('claude')?.latest.npmPackage === '@anthropic-ai/claude-code', 'Claude Code is the right npm package')
ok(toolSpec('gemini')?.latest.npmPackage === '@google/gemini-cli', 'Gemini CLI is the right npm package')
ok(toolSpec('pwsh')?.latest.wingetIds?.[0] === 'Microsoft.PowerShell', 'PowerShell is a winget package')
// Kimi is a .cmd shim wrapping Claude Code. Probing it for a version would
// start Claude and report Claude's number, which is a wrong answer that looks
// right — so it must have neither a version probe nor an update command.
ok(toolSpec('kimi')?.versionArgs === null, 'Kimi is never spawned for a version')
ok(toolSpec('kimi')?.updateCommand === null, 'Kimi has no update command')
ok(toolSpec('kimi')?.latest.source === 'local', 'Kimi is managed locally')
ok(toolSpec('node')?.updateCommand === null, 'Node has no update command — nvm and winget disagree about how')
ok(
  TOOL_SPECS.every((t) => !t.updateCommand || !/\b(-y|--silent|--force|--accept-package-agreements)\b/.test(t.updateCommand)),
  'no update command silences its own prompts'
)

/* ------------------------------------------------------- version parsing */

console.log('\nversion parsing')
ok(parseVersion('PowerShell 7.6.4') === '7.6.4', 'pwsh --version')
ok(parseVersion('2.1.220 (Claude Code)') === '2.1.220', 'claude --version')
ok(parseVersion('v24.13.0') === '24.13.0', 'node --version drops its v', String(parseVersion('v24.13.0')))
ok(parseVersion('0.53.0') === '0.53.0', 'gemini --version')
ok(parseVersion('8.0.0-preview.2') === '8.0.0-preview.2', 'a prerelease survives intact')
ok(parseVersion('no numbers here') === null, 'junk is null')
ok(parseVersion('') === null, 'empty is null')

/* ---------------------------------------------------- version comparison */

console.log('\nversion comparison')
ok(compareVersions('7.6.4', '7.6.4') === 0, 'equal')
// The one that a string comparison gets wrong: '7.6.10' < '7.6.4' as text.
ok(compareVersions('7.6.10', '7.6.4') === 1, 'double digits beat single digits', 'the string-order trap')
ok(compareVersions('7.6.4', '7.6.10') === -1, '…and the other way round')
ok(compareVersions('7.6', '7.6.0') === 0, 'a shorter version is padded, not smaller')
ok(compareVersions('2.1.220', '2.2.0') === -1, 'the minor wins over the patch')
ok(compareVersions('v24.18.0', '24.13.0') === 1, 'a leading v is ignored')
ok(compareVersions('8.0.0-rc.1', '8.0.0') === -1, 'a prerelease is older than its release')
ok(compareVersions('8.0.0-rc.2', '8.0.0-rc.1') === 1, 'prereleases order among themselves')

console.log('\nis-newer')
ok(isNewer('24.18.0', '24.13.0') === true, 'a real upgrade')
ok(isNewer('24.13.0', '24.13.0') === false, 'up to date is not an upgrade')
ok(isNewer('1.0.0', '2.0.0') === false, 'a downgrade is not an upgrade')
// Half an answer must never light the "update" chip.
ok(isNewer(null, '2.0.0') === false, 'no latest is not an upgrade')
ok(isNewer('2.0.0', null) === false, 'no installed version is not an upgrade')
ok(isNewer(undefined, undefined) === false, 'nothing at all is not an upgrade')

/* ----------------------------------------------------------- npm registry */

console.log('\nnpm registry')
ok(
  npmLatestUrl('@anthropic-ai/claude-code') === 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest',
  'a scoped name keeps its slash',
  npmLatestUrl('@anthropic-ai/claude-code')
)
ok(npmLatestUrl('typescript') === 'https://registry.npmjs.org/typescript/latest', 'an unscoped name')
// Trimmed from a real reply — the endpoint returns the whole packument for the
// dist-tag and we want exactly one field out of it.
const REGISTRY_REPLY = JSON.stringify({
  name: '@anthropic-ai/claude-code',
  version: '2.1.220',
  description: 'Use Claude, Anthropic’s AI assistant, right from your terminal.',
  bin: { claude: 'cli.js' },
  dist: { tarball: 'https://registry.npmjs.org/…' }
})
ok(parseNpmLatest(REGISTRY_REPLY) === '2.1.220', 'the version comes out of a real-shaped reply')
ok(parseNpmLatest('{"error":"Not found"}') === null, 'a 404 body has no version')
ok(parseNpmLatest('<html>gateway timeout</html>') === null, 'html instead of json is null, not a crash')
ok(parseNpmLatest('') === null, 'an empty body is null')
ok(parseNpmLatest('{"version":"   "}') === null, 'a blank version is null')

/* ---------------------------------------------------------------- winget */

console.log('\nwinget parsing')
// Captured verbatim from `winget list --id OpenJS.NodeJS.LTS --exact` on the
// machine this was written on, piped rather than shown in a console — which is
// why there is no spinner in it.
const WINGET_UPGRADE =
  'Name    Id                Version Available Source\r\n' +
  '--------------------------------------------------\r\n' +
  'Node.js OpenJS.NodeJS.LTS 24.13.0 24.18.0   winget\r\n'
{
  const row = parseWingetList(WINGET_UPGRADE, 'OpenJS.NodeJS.LTS')
  ok(row.present === true, 'an installed package is present')
  ok(row.installed === '24.13.0', 'installed version', String(row.installed))
  ok(row.available === '24.18.0', 'available version', String(row.available))
  ok(isNewer(row.available, row.installed) === true, 'and that reads as an upgrade')
}

// The up-to-date case: winget simply omits the Available column entirely, which
// is why "up to date" is the absence of a value rather than a comparison.
const WINGET_CURRENT =
  'Name       Id                   Version Source\r\n' +
  '-----------------------------------------------\r\n' +
  'PowerShell Microsoft.PowerShell 7.6.4.0 winget\r\n'
{
  const row = parseWingetList(WINGET_CURRENT, 'Microsoft.PowerShell')
  ok(row.present === true, 'up-to-date package is still present')
  ok(row.installed === '7.6.4.0', 'installed version with no Available column', String(row.installed))
  ok(row.available === null, 'no Available column means nothing newer')
}

// A package name with a space in it is why the parser uses the header's column
// offsets rather than splitting on whitespace.
const WINGET_SPACED =
  'Name             Id                       Version Available Source\r\n' +
  '------------------------------------------------------------------\r\n' +
  'Windows Terminal Microsoft.WindowsTerminal 1.22.1  1.23.0    winget\r\n'
{
  const row = parseWingetList(WINGET_SPACED, 'Microsoft.WindowsTerminal')
  ok(row.installed === '1.22.1', 'a name with a space does not shift the columns', String(row.installed))
  ok(row.available === '1.23.0', '…and Available is still read correctly', String(row.available))
}

{
  const row = parseWingetList('No installed package found matching input criteria.\r\n', 'OpenJS.NodeJS')
  ok(row.present === false, 'not installed is reported as absent')
  ok(row.installed === null && row.available === null, 'and carries no versions')
}
ok(parseWingetList('', 'anything').present === false, 'empty stdout is absent')
ok(parseWingetList(WINGET_CURRENT, 'Some.Other.Package').present === false, 'a different id does not match')

// A localised winget has no `Id`/`Version` header for the column parser to
// measure against. It must not lose the answer to "is there an upgrade".
{
  const german =
    'Name    Kennung           Vers.   Verfügbar Quelle\r\n' +
    '--------------------------------------------------\r\n' +
    'Node.js OpenJS.NodeJS.LTS 24.13.0 24.18.0   winget\r\n'
  const row = parseWingetList(german, 'OpenJS.NodeJS.LTS')
  ok(row.present === true, 'a header we cannot read still yields a row')
  ok(
    row.installed === '24.13.0' && row.available === '24.18.0',
    'the fallback finds both versions',
    `${row.installed} / ${row.available}`
  )
}

/* ------------------------------------------------------ THE UPDATER GUARD */

console.log('\nself-update guard')
// The most important assertions here. A dev run is a git checkout with
// uncommitted work in it; an updater that fires there would overwrite it.
ok(updaterMode({}, false) === 'off', 'unpackaged, no env → OFF')
ok(updaterMode({}, true) === 'real', 'packaged → real')
ok(updaterMode({ FORGE_FAKE_UPDATE: '' }, false) === 'off', 'an empty FORGE_FAKE_UPDATE is not a trigger')
ok(updaterMode({ FORGE_FAKE_UPDATE: '   ' }, false) === 'off', 'nor is whitespace')
ok(updaterMode({ FORGE_FAKE_UPDATE: 'yes' }, false) === 'off', 'nor a value that is not a version')
ok(updaterMode({ FORGE_FAKE_UPDATE: '9.9.9' }, false) === 'simulated', 'a real version turns the simulation on')
ok(
  updaterMode({ FORGE_FAKE_UPDATE: '9.9.9' }, true) === 'simulated',
  'the simulation wins even in a packaged build — it can never install anything'
)
ok(updaterMode({ SOMETHING_ELSE: '1.2.3' }, false) === 'off', 'an unrelated variable changes nothing')

// Structural: the guard has to actually be wired to app.isPackaged, and the
// one function that can replace files on disk has to be behind it. A passing
// unit test for updaterMode() means nothing if updater.ts stopped calling it.
{
  const source = readFileSync(join(ROOT, 'electron', 'updater.ts'), 'utf8')
  ok(
    /updaterMode\(process\.env,\s*app\.isPackaged\)/.test(source),
    'updater.ts derives its mode from app.isPackaged'
  )
  ok(source.includes('autoDownload = false'), 'auto-download is off — a banner comes first')
  ok(source.includes('autoInstallOnAppQuit = false'), 'auto-install on quit is off')
  ok(
    /mode !== 'real'[\s\S]{0,600}quitAndInstall/.test(source),
    'quitAndInstall is behind a real-mode check'
  )
}

/* ------------------------------------------------------- no-feed handling */

console.log('\nno-feed handling')
// Steve has not created the GitHub repo yet, so this IS the normal state of a
// packaged build. It must be silent, not a red banner.
ok(isNoFeedError('HttpError: 404 Not Found'), 'a 404 from the releases API is "no feed"')
ok(isNoFeedError('Cannot find channel "latest-win.yml" update info'), 'a missing channel file is "no feed"')
ok(isNoFeedError('Unable to find latest version on GitHub'), 'no releases yet is "no feed"')
ok(isNoFeedError('getaddrinfo ENOTFOUND github.com'), 'offline is "no feed"')
ok(!isNoFeedError('ENOSPC: no space left on device'), 'a real failure is still a failure')
ok(!isNoFeedError('sha512 checksum mismatch'), 'a corrupt download is still a failure')

/* ------------------------------------------------------ banner dismissal */

console.log('\nbanner dismissal')
ok(shouldShowBanner('0.2.0', '') === true, 'a new version with nothing dismissed shows')
ok(shouldShowBanner('0.2.0', '0.2.0') === false, 'the dismissed version stays hidden')
// The whole reason dismissal is per-version.
ok(shouldShowBanner('0.3.0', '0.2.0') === true, 'dismissing 0.2.0 does not silence 0.3.0')
ok(shouldShowBanner('', '0.2.0') === false, 'no version, no banner')
ok(shouldShowBanner(null, null) === false, 'nulls do not show a banner')
ok(shouldShowBanner('0.2.0', null) === true, 'a never-dismissed banner shows')
ok(shouldShowBanner(' 0.2.0 ', '0.2.0') === false, 'whitespace does not defeat a dismissal')

/* ------------------------------------------------------------ formatting */

console.log('\nformatting')
ok(formatRate(3.5 * 1024 * 1024) === '3.5 MB/s', 'megabytes', formatRate(3.5 * 1024 * 1024))
ok(formatRate(200 * 1024) === '200 KB/s', 'kilobytes', formatRate(200 * 1024))
ok(formatRate(0) === '', 'zero is nothing to say')
ok(formatRate(Number.NaN) === '', 'NaN is nothing to say')

const NOW = 1_700_000_000_000
ok(relativeTime(0) === 'never', 'never checked')
ok(relativeTime(NOW - 5_000, NOW) === 'just now', 'just now')
ok(relativeTime(NOW - 5 * 60_000, NOW) === '5 minutes ago', 'minutes', relativeTime(NOW - 5 * 60_000, NOW))
ok(relativeTime(NOW - 60_000, NOW) === '1 minute ago', 'one minute is singular')
ok(relativeTime(NOW - 3 * 3_600_000, NOW) === '3 hours ago', 'hours')
ok(relativeTime(NOW - 2 * 86_400_000, NOW) === '2 days ago', 'days')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
