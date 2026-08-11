/**
 * Negative controls for the secrets gate.
 *
 *   node scripts/secrets-audit-test.mjs
 *
 * scripts/secrets-audit.mjs passing means nothing on its own — a gate that
 * always says yes passes every build it ever sees. So this plants each kind of
 * leak in a throwaway folder and checks the audit says no to all of them, and
 * that a clean folder still passes.
 *
 * Nothing here touches release/ or the working tree; everything happens in a
 * temp directory that is deleted afterwards.
 *
 * The key-shaped strings below are invented — declared to the gate as such by
 * the marker in the last case, which covers this whole file. That is the point
 * of that case: the marker must NOT rescue a *packed artifact*, only source.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const AUDIT = join(ROOT, 'scripts', 'secrets-audit.mjs')

const run = (dir) => spawnSync(process.execPath, [AUDIT, '--only-dir', dir], { encoding: 'utf8' })

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'forge-audit-'))

/** A stand-in for a packed app directory: innocent files, no secrets. */
function fresh(name) {
  const dir = join(scratch, name)
  mkdirSync(join(dir, 'resources'), { recursive: true })
  writeFileSync(join(dir, 'Forge.txt'), 'pretend this is an executable\n')
  writeFileSync(
    join(dir, 'resources', 'app.js'),
    "export const greet = () => 'hello'\n// a perfectly ordinary file with no keys in it\n"
  )
  return dir
}

console.log('\nsecrets gate — negative controls')

/* ------------------------------------------------------------- the control */

{
  const r = run(fresh('clean'))
  ok(r.status === 0, 'a clean directory passes', r.stdout)
}

/* -------------------------------------------------------------- key shapes */

{
  const dir = fresh('google')
  writeFileSync(join(dir, 'resources', 'leak.js'), "const key = 'AIzaSyB0RtHzQ9vKmNpLwXcVfGh2JdErTyUiOp'\n")
  const r = run(dir)
  ok(r.status === 1, 'a planted Google key fails the build')
  ok(/Google AI Studio/.test(r.stderr), 'and is named as one', r.stderr.slice(0, 200))
  ok(!r.stderr.includes('B0RtHzQ9vKmNpLwXcVfGh2JdEr'), 'without the audit printing the key itself')
}

/* ------------------------------------------------- the one deliberate value */

{
  // The shipped Firebase web API key (WEB_DEFAULT_API_KEY in electron/store.ts)
  // is AIza-shaped and public by design — the deployment already serves it to
  // every visitor. It must pass…
  const dir = fresh('public-value')
  writeFileSync(
    join(dir, 'resources', 'defaults.js'),
    "export const key = 'AIzaSyC2CJR7UZMyNrpXYqIMpwIGUVFp-gZpcWM'\n"
  )
  const r = run(dir)
  ok(r.status === 0, 'the shipped Firebase web API key is allowed through', r.stderr.slice(0, 200))
}

{
  // …without the allowlist widening into "AIza keys are fine now": the same
  // artifact with one *other* AIza-shaped string beside it still fails.
  const dir = fresh('public-plus-leak')
  writeFileSync(
    join(dir, 'resources', 'defaults.js'),
    "export const key = 'AIzaSyC2CJR7UZMyNrpXYqIMpwIGUVFp-gZpcWM'\nconst oops = 'AIzaSyB0RtHzQ9vKmNpLwXcVfGh2JdErTyUiOp'\n"
  )
  const r = run(dir)
  ok(r.status === 1, 'a different Google key beside the shipped one still fails the build')
  ok(/1×/.test(r.stderr), 'and only the leak is counted, not the shipped value', r.stderr.slice(0, 200))
}

{
  const dir = fresh('sk')
  writeFileSync(
    join(dir, 'resources', 'leak.json'),
    JSON.stringify({ a: 'sk-or-v1-abcdef0123456789abcdef', b: 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' })
  )
  const r = run(dir)
  ok(r.status === 1, 'planted sk- and sk-or- keys fail the build')
  ok(/OpenRouter/.test(r.stderr), 'and both shapes are reported', r.stderr.slice(0, 300))
}

/* --------------------------------------------------- this machine's own keys */

{
  const keyFile = [
    join(homedir(), 'Desktop', 'DictationMic', 'gemini.key'),
    join(homedir(), 'Desktop', 'DictationMic', 'gemini_key.txt'),
    join(homedir(), '.gemini-key'),
    join(homedir(), '.kimi-key')
  ].find((p) => existsSync(p))

  if (!keyFile) {
    console.log('  --   no personal key file on this machine; skipping the literal-value control')
  } else {
    const value = readFileSync(keyFile, 'utf8').trim()
    const dir = fresh('real')
    // Buried in a field the shape rules have no opinion about, so only the
    // literal check can catch it. This is the case that exists because a key
    // does not have to arrive in a recognisable format to be leaked.
    writeFileSync(join(dir, 'resources', 'config.json'), JSON.stringify({ note: 'harmless', blob: `x${value}x` }))
    const r = run(dir)
    ok(r.status === 1, "a real key from this machine fails even when its shape is disguised")
    ok(/a real key from this machine/.test(r.stderr), 'and is reported as such')
    ok(!r.stderr.includes(value), 'without the audit echoing the key')
  }
}

/* ------------------------------------------------------------ personal state */

{
  const dir = fresh('state')
  writeFileSync(join(dir, 'resources', 'settings.json'), JSON.stringify({ geminiKey: '' }))
  const r = run(dir)
  ok(r.status === 1, 'a settings.json inside the artifact fails the build')
  ok(/personal state/.test(r.stderr), 'and says why', r.stderr.slice(0, 200))
}

{
  const dir = fresh('shelf')
  mkdirSync(join(dir, 'resources', 'shots'), { recursive: true })
  writeFileSync(join(dir, 'resources', 'shots', 'readme.txt'), 'screenshots')
  const r = run(dir)
  ok(r.status === 1, 'a packed screenshot shelf fails the build')
}

/* ---------------------------------------------------- the opt-out has limits */

{
  const dir = fresh('fixture-marker')
  writeFileSync(
    join(dir, 'resources', 'sneaky.js'),
    "// SECRETS-AUDIT: fixtures\nconst k = 'AIzaSyB0RtHzQ9vKmNpLwXcVfGh2JdErTyUiOp'\n"
  )
  const r = run(dir)
  ok(r.status === 1, 'the fixtures opt-out does not rescue a packed artifact')
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
