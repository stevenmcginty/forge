/**
 * Secrets gate — refuses to let Forge ship with a key in it.
 *
 *   node scripts/secrets-audit.mjs                scan the git tree
 *   node scripts/secrets-audit.mjs --dir <path>    ...and a packed directory
 *   node scripts/secrets-audit.mjs --packed        ...and everything in release/
 *   node scripts/secrets-audit.mjs --only-dir <p>  scan just that directory
 *
 * Non-zero exit means do not ship. Wired into `npm run dist` twice: once as
 * electron-builder's afterPack hook (so a leak stops the build *before* an
 * installer exists) and once over release/ afterwards.
 *
 * What it looks for
 * -----------------
 *  1. Key *shapes*: Google AI Studio (`AIza…`), OpenAI/Anthropic-style
 *     (`sk-…`), OpenRouter (`sk-or-`).
 *  2. Steve's *actual* keys. The shape rules would catch a pasted Gemini key,
 *     but not one that happens to be stored some other way — so the real values
 *     are read off this disk at scan time and searched for literally. They are
 *     never printed, never written anywhere, and if the files are absent this
 *     check simply does not run.
 *  3. Personal state in the artifact: settings.json (which holds keys), the
 *     project list, saved layouts, the screenshot shelf, notes, `.env`,
 *     `*.key` — none of which have any business inside a build.
 *
 * The scanner exempts itself: this file necessarily contains the patterns it
 * hunts for, and a gate that fails on its own source is a gate nobody keeps.
 *
 * Opting out
 * ----------
 * A source file that contains a *fake* key on purpose — a test asserting that
 * masking works needs something key-shaped to mask — can say so:
 *
 *     SECRETS-AUDIT: fixtures
 *
 * anywhere in it. That suppresses the shape rules for that file and nothing
 * else. Check (2), the one that matches Steve's actual keys byte for byte, is
 * never suppressible, and neither is check (3): no comment in a file can make
 * it acceptable for that file to be in a build artifact. The marker is also
 * ignored entirely when scanning a packed directory, where no test fixture has
 * any business being in the first place.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SELF = resolve(import.meta.filename)

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const val = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null
}

/* ------------------------------------------------------------------ rules */

const SHAPE_RULES = [
  { id: 'google-api-key', label: 'Google AI Studio / Gemini key', re: /AIza[0-9A-Za-z_-]{30,}/g },
  { id: 'openrouter-key', label: 'OpenRouter key', re: /sk-or-[A-Za-z0-9_-]{8,}/g },
  { id: 'sk-key', label: 'OpenAI / Anthropic style key', re: /sk-[A-Za-z0-9]{20,}/g },
  { id: 'anthropic-key', label: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g }
]

/**
 * Values that match a shape rule and are shipped on purpose, each one exact.
 *
 * There is exactly one today: `WEB_DEFAULT_API_KEY` in electron/store.ts, the
 * Firebase *web* API key of the deployment Forge ships as its default. It
 * shares the `AIza` prefix with a Gemini key and shares nothing else with one:
 * a Firebase web API key names a project and authorises nothing — the same
 * value is already served in the clear to every visitor of the hosting site as
 * `config.json`, so the artifact cannot leak what the deployment already
 * publishes. See docs/WEB-SETUP.md ("not secrets").
 *
 * Exact literals rather than a pattern or an import, on purpose: a pattern
 * would widen the door, and importing the constant would let a *new* key ride
 * in on the allowlist without anyone retyping it here and owning the decision.
 * The one real risk — Steve's personal Gemini key somehow equalling this
 * string — is impossible (they are different strings), and the LIVE_KEYS
 * cross-check below still runs on every file regardless of this list.
 */
const PUBLIC_VALUES = new Set(['AIzaSyC2CJR7UZMyNrpXYqIMpwIGUVFp-gZpcWM'])

/**
 * Files whose *presence* in a build artifact is the problem, whatever is in
 * them. Matched on the basename, so `resources/app.asar.unpacked/settings.json`
 * counts just as much as one at the root.
 */
const FORBIDDEN_NAMES = [
  'settings.json',
  'projects.json',
  'gemini.key',
  'gemini_key.txt',
  '.gemini-key',
  '.kimi-key',
  'kimi-key',
  '.env',
  '.env.local',
  'notes.json',
  'anthropic.key'
]

const FORBIDDEN_DIRS = ['shots', 'layouts', 'bridge-out', 'notes']

/** Read-only, best effort: the real values, so they can be searched for. */
function realKeys() {
  const files = [
    join(homedir(), 'Desktop', 'DictationMic', 'gemini.key'),
    join(homedir(), 'Desktop', 'DictationMic', 'gemini_key.txt'),
    join(homedir(), '.gemini-key'),
    join(homedir(), '.kimi-key'),
    join(homedir(), '.anthropic-key')
  ]
  const found = []
  for (const path of files) {
    if (!existsSync(path)) continue
    try {
      const value = readFileSync(path, 'utf8').trim()
      // Short strings would match half the binaries on the disk.
      if (value.length >= 16 && !/\s/.test(value)) found.push({ path, value })
    } catch {
      /* unreadable is the same as absent for our purposes */
    }
  }
  return found
}

const LIVE_KEYS = realKeys()

/* ---------------------------------------------------------------- scanning */

/** Compiled binaries cannot plausibly carry a pasted key, and are enormous. */
const BINARY_EXT = new Set([
  '.dll',
  '.exe',
  '.pyd',
  '.so',
  '.dylib',
  '.node',
  '.pdb',
  '.onnx',
  '.bin',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.icns',
  '.woff',
  '.woff2',
  '.ttf',
  '.zip',
  '.7z',
  '.wav',
  '.mp4',
  '.pak',
  '.lib',
  '.pyc'
])

/** app.asar is one big blob with all our JavaScript inline — always scan it. */
const ALWAYS_SCAN = new Set(['.asar'])

const MAX_BYTES = 96 * 1024 * 1024

const findings = []
let filesScanned = 0
let bytesScanned = 0

function report(where, rule, detail) {
  findings.push({ where, rule, detail })
}

/** Enough context to find it, never enough to leak it. */
function redact(match) {
  if (match.length <= 10) return `${match.slice(0, 4)}…`
  return `${match.slice(0, 6)}…${match.slice(-2)} (${match.length} chars)`
}

/**
 * The fixtures marker, spelled so that this line does not itself count as one.
 * (The scanner exempts its own file anyway, but the two halves make the intent
 * obvious to anyone reading a diff.)
 */
const FIXTURE_MARKER = 'SECRETS-AUDIT' + ': fixtures'

function scanFile(path, label, { allowFixtures = true } = {}) {
  const ext = extname(path).toLowerCase()
  if (BINARY_EXT.has(ext) && !ALWAYS_SCAN.has(ext)) return
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return
  }
  if (size > MAX_BYTES) return

  let text
  try {
    // latin1 rather than utf8: an ASCII key survives it byte for byte, and a
    // blob like app.asar does not come back full of replacement characters.
    text = readFileSync(path, 'latin1')
  } catch {
    return
  }
  filesScanned += 1
  bytesScanned += size

  // Declared fixtures are exempt from the *shape* rules only, and only in
  // source — a packed artifact is scanned with allowFixtures off.
  const fixtures = allowFixtures && text.includes(FIXTURE_MARKER)
  if (!fixtures) {
    for (const rule of SHAPE_RULES) {
      rule.re.lastIndex = 0
      const hits = (text.match(rule.re) ?? []).filter((hit) => !PUBLIC_VALUES.has(hit))
      if (hits.length) report(label, rule.label, `${hits.length}× e.g. ${redact(hits[0])}`)
    }
  }
  for (const key of LIVE_KEYS) {
    if (text.includes(key.value)) {
      report(label, 'a real key from this machine', `matches the value in ${key.path}`)
    }
  }
}

function checkName(path, label) {
  const name = basename(path).toLowerCase()
  if (FORBIDDEN_NAMES.includes(name)) {
    report(label, 'personal state in the artifact', `${name} does not belong in a build`)
  }
}

/**
 * Walk a *packed* directory. Fixture markers are ignored here: a build artifact
 * containing something key-shaped is a problem whatever the comment above it
 * claims, and none of the app's own test scripts are packed anyway.
 */
function walk(dir, label, seen = new Set()) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (seen.has(full)) continue
    seen.add(full)
    if (entry.isDirectory()) {
      if (FORBIDDEN_DIRS.includes(entry.name.toLowerCase())) {
        report(`${label}/${entry.name}`, 'personal state in the artifact', 'a data directory got packed')
      }
      walk(full, label, seen)
      continue
    }
    if (!entry.isFile()) continue
    if (resolve(full) === SELF) continue
    const rel = `${label}${sep}${relative(dir, full) === entry.name ? entry.name : relative(dir, full)}`
    checkName(full, rel)
    scanFile(full, rel, { allowFixtures: false })
  }
}

/* -------------------------------------------------------------- git tree */

function gitTree() {
  try {
    // Tracked *and* untracked-but-not-ignored: a key sitting in a new file that
    // has not been `git add`ed yet is one commit away from being published, and
    // is already in the build if the build reads it.
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    })
    return out.split('\0').filter(Boolean)
  } catch (err) {
    console.log(`  --   not a git checkout (${(err?.message ?? '').split('\n')[0]}) — scanning the working tree instead`)
    return null
  }
}

function scanGitTree() {
  const files = gitTree()
  if (files === null) {
    walk(ROOT, 'tree')
    return
  }
  for (const rel of files) {
    const full = join(ROOT, rel)
    if (!existsSync(full)) continue
    if (resolve(full) === SELF) continue
    checkName(full, rel)
    scanFile(full, rel)
  }
}

/* ------------------------------------------------------------------- run */

const onlyDir = val('--only-dir')
const extraDir = val('--dir')

console.log('\nsecrets audit')
if (LIVE_KEYS.length > 0) {
  console.log(`  ..   also searching for ${LIVE_KEYS.length} real key(s) found on this machine`)
} else {
  console.log('  ..   no personal key files on this machine to cross-check against')
}

if (onlyDir) {
  if (!existsSync(onlyDir)) {
    console.error(`  ✕    --only-dir ${onlyDir} is not there`)
    process.exit(2)
  }
  console.log(`  ..   scanning ${onlyDir}`)
  walk(resolve(onlyDir), basename(resolve(onlyDir)))
} else {
  console.log('  ..   scanning the git tree')
  scanGitTree()

  if (extraDir) {
    if (!existsSync(extraDir)) {
      console.error(`  ✕    --dir ${extraDir} is not there`)
      process.exit(2)
    }
    console.log(`  ..   scanning ${extraDir}`)
    walk(resolve(extraDir), basename(resolve(extraDir)))
  }

  if (has('--packed')) {
    const release = join(ROOT, 'release')
    if (!existsSync(release)) {
      console.error('  ✕    --packed asked for, but release/ does not exist — run electron-builder first')
      process.exit(2)
    }
    console.log(`  ..   scanning ${release}`)
    // The .zip and the NSIS .exe are compressed containers; their *contents*
    // are the unpacked win-unpacked/ tree that both were built from, which is
    // walked here, so there is nothing extra to find inside them.
    walk(release, 'release')
  }
}

console.log(`  ..   ${filesScanned} files, ${(bytesScanned / 1024 / 1024).toFixed(1)} MB read`)

if (findings.length === 0) {
  console.log('  ok   nothing that looks like a secret\n')
  process.exit(0)
}

console.error(`\n  ✕    ${findings.length} problem(s) — NOT shippable\n`)
for (const f of findings) {
  console.error(`       ${f.where}`)
  console.error(`         ${f.rule}: ${f.detail}`)
}
console.error('')
process.exit(1)
