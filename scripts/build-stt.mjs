/**
 * Freeze the dictation sidecar into a standalone folder with PyInstaller.
 *
 *   node scripts/build-stt.mjs            build if stt-dist/ is missing/stale
 *   node scripts/build-stt.mjs --force     rebuild regardless
 *   node scripts/build-stt.mjs --check     report only, exit 1 if not built
 *   node scripts/build-stt.mjs --optional  never fail the build; warn and skip
 *
 * Output: stt-dist/forge-stt/forge-stt.exe (+ its DLLs), which electron-builder
 * ships as resources/stt — see electron-builder.yml and electron/stt-sidecar.ts.
 *
 * PyInstaller has to run under an interpreter that already has the sidecar's
 * wheels (onnxruntime, onnx-asr, sounddevice, numpy). On this machine that is
 * DictationMic's venv; anywhere else, point FORGE_STT_PYTHON at a venv with
 * `pip install onnx-asr onnxruntime sounddevice numpy pyinstaller`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SPEC = join(ROOT, 'stt', 'forge-stt.spec')
const SOURCE = join(ROOT, 'stt', 'stt_service.py')
const DIST = join(ROOT, 'stt-dist')
const OUT_DIR = join(DIST, 'forge-stt')
const OUT_EXE = join(OUT_DIR, 'forge-stt.exe')
const WORK = join(ROOT, '.stt-build')

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const checkOnly = argv.includes('--check')
const optional = argv.includes('--optional')

/** Interpreters that might have the sidecar's wheels, best first. */
function pythonCandidates() {
  const env = process.env['FORGE_STT_PYTHON']
  const list = []
  if (env && env.trim()) list.push(env.trim())
  list.push(join(homedir(), 'Desktop', 'DictationMic', 'venv', 'Scripts', 'python.exe'))
  list.push(join(ROOT, '.venv', 'Scripts', 'python.exe'))
  list.push(join(ROOT, 'venv', 'Scripts', 'python.exe'))
  return list
}

function findPython() {
  for (const p of pythonCandidates()) {
    if (!existsSync(p)) continue
    const probe = spawnSync(p, ['-c', 'import PyInstaller, onnxruntime, onnx_asr, sounddevice'], {
      encoding: 'utf8'
    })
    if (probe.status === 0) return p
    const why = (probe.stderr || '').trim().split('\n').pop()
    console.log(`  --   ${p} is there but missing a dependency: ${why}`)
  }
  return null
}

function isFresh() {
  if (!existsSync(OUT_EXE)) return false
  const built = statSync(OUT_EXE).mtimeMs
  return built >= statSync(SOURCE).mtimeMs && built >= statSync(SPEC).mtimeMs
}

/**
 * electron-builder's extraResources refuses to package a `from:` that is not
 * there, so an --optional build still has to leave a folder behind. A note
 * rather than a stub exe: resolveFrozen() looks for forge-stt.exe specifically,
 * finds nothing, and falls through to the configured interpreter — which is
 * exactly what "packaged without the speech engine" should mean.
 */
function placeholderDist() {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(
    join(OUT_DIR, 'NOT-BUILT.txt'),
    [
      'The standalone speech engine was not built into this package.',
      '',
      'Dictation will fall back to running stt/stt_service.py under a Python',
      'interpreter configured in Settings, and will report a setup state if',
      'there is not one.',
      '',
      'To build it: node scripts/build-stt.mjs --force',
      ''
    ].join('\n'),
    'utf8'
  )
}

function bail(message) {
  if (optional) {
    console.log(`\n  !!   ${message}`)
    console.log('       Packaging without the standalone sidecar: dictation will need a')
    console.log('       Python interpreter configured on the target machine.\n')
    placeholderDist()
    process.exit(0)
  }
  console.error(`\n  ✕    ${message}\n`)
  process.exit(1)
}

/**
 * Start the frozen sidecar and wait for its port line. stdin is held open on
 * purpose: the sidecar leaves the moment its stdin closes (that is how it
 * avoids being orphaned), so a closed pipe would race the port announcement.
 */
function announcesPort(exe, timeoutMs = 90_000) {
  return new Promise((done) => {
    const child = spawn(exe, ['--model-dir', join(WORK, 'no-model-here'), '--stub-engine'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let out = ''
    let err = ''
    const finish = (ok) => {
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      done({ ok, out, err })
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (/FORGE_STT_PORT=\d+/.test(out)) finish(true)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (e) => {
      err += String(e)
      finish(false)
    })
    child.on('exit', () => finish(/FORGE_STT_PORT=\d+/.test(out)))
  })
}

/* ------------------------------------------------------------------- build */

if (isFresh() && !force) {
  console.log(`  ok   dictation sidecar already built — ${OUT_EXE}`)
  process.exit(0)
}
if (checkOnly) bail('stt-dist/forge-stt/forge-stt.exe is missing or stale')

const python = findPython()
if (!python) {
  bail(
    'no Python with PyInstaller + onnxruntime + onnx-asr + sounddevice found.\n' +
      '       Tried:\n         ' +
      pythonCandidates().join('\n         ') +
      '\n       Set FORGE_STT_PYTHON to one that works.'
  )
}

console.log(`  ..   freezing the dictation sidecar with ${python}`)
// A stale work folder is the usual cause of "it built, but imports nothing".
rmSync(WORK, { recursive: true, force: true })
rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })

const run = spawnSync(python, ['-m', 'PyInstaller', '--noconfirm', '--distpath', DIST, '--workpath', WORK, SPEC], {
  cwd: join(ROOT, 'stt'),
  stdio: 'inherit'
})

if (run.status !== 0) bail(`PyInstaller exited ${run.status}`)
if (!existsSync(OUT_EXE)) bail(`PyInstaller finished but ${OUT_EXE} is not there`)

/* ------------------------------------------------------------------ verify
 *
 * A frozen binary that cannot import onnxruntime still *builds* — the imports
 * only happen when a model is loaded. So the build is not done until the exe has
 * proved both halves: that its dependencies are inside it, and that it speaks
 * the protocol the parent expects.
 */

console.log('  ..   checking the frozen imports')
const imports = spawnSync(OUT_EXE, ['--import-check'], { encoding: 'utf8', timeout: 180_000, windowsHide: true })
if (imports.status !== 0) {
  bail(
    'the frozen sidecar cannot import its own dependencies.\n' +
      `       stdout: ${(imports.stdout ?? '').slice(0, 400)}\n` +
      `       stderr: ${(imports.stderr ?? '').slice(0, 900)}`
  )
}
console.log(`  ok   ${(imports.stdout ?? '').trim().split('\n').pop()}`)

console.log('  ..   checking it announces a port')
const port = await announcesPort(OUT_EXE)
if (!port.ok) {
  bail(
    'the frozen sidecar never announced a port.\n' +
      `       stdout: ${port.out.slice(0, 400)}\n` +
      `       stderr: ${port.err.slice(-900)}`
  )
}

console.log(`  ok   dictation sidecar frozen and answering — ${OUT_EXE}`)
