#!/usr/bin/env node
/**
 * run-checks — the one command that runs every check.
 *
 * Forge's checks live in ~40 standalone scripts, each runnable alone through
 * package.json (`npm run git:check`, `npm run web:check`, ...). This runner
 * sweeps them in one pass so `npm test` and CI cover the whole set without
 * anybody remembering the list by hand.
 *
 *   node scripts/run-checks.mjs          fast lane (default) — self-contained
 *                                        checks: no external CLIs, no build
 *                                        artifacts, no network beyond loopback
 *   node scripts/run-checks.mjs --all    everything, including the smokes that
 *                                        drive real shells, real WebSockets,
 *                                        Firebase emulators, the Gemini bridge,
 *                                        or a packaged exe
 *   node scripts/run-checks.mjs --verbose  stream each check's output as it runs
 *
 * Checks run sequentially and every one of them runs even when an earlier one
 * fails; the process exits non-zero if anything failed.
 *
 * Dependency-free on purpose: node:child_process and node:path only.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * lane: 'fast' — process-free or nearly so. Pure parsers, in-process module
 *        hooks, esbuild bundles, temp-dir filesystem work, loopback sockets.
 *        Runs anywhere node runs, including a fresh CI checkout.
 * lane: 'heavy' — spawns real shells/sessions, binds service ports, talks to
 *        emulators or live CLIs, or inspects local build output. Needs a
 *        developer machine (and sometimes a build) to mean anything.
 */
const CHECKS = [
  // Pure source parsers (node:module registerHooks, no builds, no children)
  { name: 'activity:check', lane: 'fast' },
  { name: 'agents:check', lane: 'fast' },
  { name: 'commands:check', lane: 'fast' },
  { name: 'draft:check', lane: 'fast' },
  { name: 'feed:check', lane: 'fast' },
  { name: 'gh:check', lane: 'fast' },
  { name: 'git:check', lane: 'fast' },
  { name: 'shelf:smoke', lane: 'fast', note: 'real git, scratch repo + bare origin in the temp dir' },
  { name: 'hub:check', lane: 'fast' },
  { name: 'mosaic:check', lane: 'fast' },
  { name: 'rail:check', lane: 'fast' },
  { name: 'share:check', lane: 'fast', note: 'its live CLI probes self-skip when the CLIs are absent' },
  { name: 'tail:check', lane: 'fast' },
  { name: 'theme:check', lane: 'fast' },
  { name: 'updates:check', lane: 'fast' },
  { name: 'voice:check', lane: 'fast', note: 'the live OpenRouter tier is opt-in via env' },
  { name: 'web:check', lane: 'fast', note: 'loopback sockets only; the heaviest fast check' },

  // esbuild-bundle-and-drive checks (one esbuild service process, temp dirs)
  { name: 'discovery:check', lane: 'fast', note: 'UDP on 127.0.0.1' },
  { name: 'input:check', lane: 'fast' },
  { name: 'memory:smoke', lane: 'fast' },
  { name: 'mirror:check', lane: 'fast' },
  { name: 'mobile:auth', lane: 'fast' },
  { name: 'pack:check', lane: 'fast', note: 'shells out to PowerShell Expand-Archive as the zip oracle' },
  { name: 'preview:check', lane: 'fast' },
  { name: 'pwa:check', lane: 'fast' },
  { name: 'shots:smoke', lane: 'fast' },
  { name: 'skills:smoke', lane: 'fast' },
  { name: 'tv-fetch:check', lane: 'fast' },
  { name: 'tunnel:check', lane: 'fast' },
  { name: 'web:auth', lane: 'fast' },
  { name: 'cf:tunnel', lane: 'fast' },

  // Local filesystem/git round-trips (a few git processes in temp repos)
  { name: 'gitwatch:smoke', lane: 'fast' },

  // Unit test for the secrets scanner (spawns only node on temp dirs)
  { name: 'secrets:test', lane: 'fast' },

  // Heavy: real sessions, service ports, emulators, live CLIs, build artifacts
  { name: 'apk:check', lane: 'heavy', note: 'inspects built dist-apk/ output' },
  { name: 'bridge:register', lane: 'heavy', note: 'spawns the claude CLI' },
  { name: 'bridge:smoke', lane: 'heavy', note: 'spawns the bridge server; live tier spends Gemini quota' },
  { name: 'companion:smoke', lane: 'heavy', note: 'needs Firebase emulators on :9000/:9099' },
  { name: 'mobile:smoke', lane: 'heavy', note: 'real pwsh session over a real WebSocket' },
  { name: 'packaged:check', lane: 'heavy', note: 'launches the packaged exe with CDP' },
  { name: 'pty:smoke', lane: 'heavy', note: 'real pwsh through node-pty' },
  { name: 'remote:check', lane: 'heavy', note: 'spawns a Claude RC pane through node-pty' },
  { name: 'session:check', lane: 'heavy', note: 'runs the claude CLI to check its error surface' },
  { name: 'voice:brain', lane: 'heavy', note: 'spawns a live claude session' },
  { name: 'voice:luna', lane: 'heavy', note: 'spawns the external codex CLI as the Luna brain' },
  { name: 'web:rendezvous', lane: 'heavy', note: 'needs Firebase emulators on :9000/:9099' },
  { name: 'web:smoke', lane: 'heavy', note: 'real pwsh session over a real WebSocket' }
]

/** package.json's script table — the source of truth for what each name runs. */
function scriptTargets() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  return pkg.scripts ?? {}
}

const argv = process.argv.slice(2)
const wantAll = argv.includes('--all')
const verbose = argv.includes('--verbose')
const lane = wantAll ? 'all' : 'fast'

const scripts = scriptTargets()

const missing = CHECKS.filter((c) => !scripts[c.name]).map((c) => c.name)
if (missing.length > 0) {
  console.error(`package.json has no script for: ${missing.join(', ')}`)
  console.error('(scripts/run-checks.mjs and package.json have drifted — prune or rename the entry.)')
  process.exit(1)
}

const selected = CHECKS.filter((c) => wantAll || c.lane === 'fast')

const OUTPUT_TAIL_ON_FAILURE = 60
const TIMEOUT_MS = wantAll ? 10 * 60_000 : 5 * 60_000

console.log(`run-checks: ${selected.length} check(s), lane: ${lane}${wantAll ? '' : ' (use --all for every check)'}\n`)

const results = []
for (const check of selected) {
  const command = scripts[check.name]
  // Every relevant script is plain node — run the file directly rather than
  // through npm, so a failure's exit code and output arrive unfiltered.
  const target = command.replace(/^node\s+/, '')
  const started = Date.now()
  const run = spawnSync(process.execPath, [join(ROOT, target)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  })
  const ms = Date.now() - started

  if (run.error && run.error.code === 'ENOENT') {
    results.push({ ...check, ok: false, ms, why: `script not found: ${target}` })
  } else if (run.signal) {
    results.push({ ...check, ok: false, ms, why: `killed by ${run.signal} (timeout is ${TIMEOUT_MS / 1000}s)` })
  } else {
    results.push({ ...check, ok: run.status === 0, ms, why: null, output: `${run.stdout ?? ''}${run.stderr ?? ''}` })
  }

  const last = results[results.length - 1]
  const verdict = last.ok ? 'PASS' : 'FAIL'
  console.log(`${verdict}  ${check.name}  (${(ms / 1000).toFixed(1)}s)${check.note ? `  — ${check.note}` : ''}`)
  if (verbose && last.output) {
    console.log(last.output.replace(/\n+$/, ''))
  } else if (!last.ok && last.output) {
    const lines = last.output.replace(/\r/g, '').split('\n').filter((l) => l !== '')
    const tail = lines.slice(-OUTPUT_TAIL_ON_FAILURE)
    for (const line of tail) console.log(`      ${line}`)
  } else if (!last.ok && last.why) {
    console.log(`      ${last.why}`)
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length} passed, ${failed.length} failed, lane: ${lane}`)
if (failed.length > 0) {
  console.log(`      failed: ${failed.map((f) => f.name).join(', ')}`)
}
process.exit(failed.length > 0 ? 1 : 0)
