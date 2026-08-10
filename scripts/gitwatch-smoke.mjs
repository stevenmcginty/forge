/**
 * A real repository, built from nothing and read once.
 *
 *   node scripts/gitwatch-smoke.mjs
 *
 * `git-check.mjs` holds the arithmetic and never spawns anything; this is the
 * one that proves the arithmetic is being fed what it thinks it is being fed.
 * The gap between them is where this feature could most easily be wrong for
 * months: the parsers can be perfect while the flags handed to git, the order of
 * the three processes, or the shape of `--path-format=absolute` on Windows are
 * quietly not what the fixtures assumed.
 *
 * So it makes a repository in a temporary folder — an initial commit, a second
 * branch, a modified file, an untracked file with a space in its name — drives
 * `readStatus` against it, asserts what came back, and removes the folder again.
 * It also reads the two states that cost no repository at all: a plain folder,
 * and a path that is not there.
 *
 * **Exits 0 silently when git is not installed.** This is a check of Forge's
 * reading of git, not a check that the machine has git: on a machine without it
 * the honest result is that there is nothing to test, and a red X there would
 * teach people to ignore the red X.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `electron`, stubbed — the same trick git-check.mjs plays, for the same reason.
 *
 * git-watcher.ts is imported here so the sink seam can be proved against a real
 * repository, and it names three things out of electron: `ipcMain`, which only
 * `registerGitWatcherHandlers` touches and which is never called here;
 * `BrowserWindow.fromWebContents`, which a watch asks once and which honestly
 * answers "no window" for a caller that is not one; and `app`, by way of
 * store.ts. None of the three has anything to do with reading a repository, so
 * the module is answered with a shape and this stays a plain node script.
 */
const ELECTRON_STUB = 'forge-smoke:electron'

registerHooks({
  resolve(spec, context, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url === ELECTRON_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: [
          'export const app = { getPath: () => "" }',
          'export const ipcMain = { handle: () => {}, on: () => {} }',
          'export const BrowserWindow = { fromWebContents: () => null }'
        ].join('\n')
      }
    }
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const { whichCommand } = await import('../electron/which.ts')

if (whichCommand('git') === null) process.exit(0)

const { readStatus } = await import('../electron/git/git-status.ts')
const watcher = await import('../electron/git-watcher.ts')

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

/**
 * git, with the machine's own configuration kept out of it.
 *
 * An identity is passed per command rather than written into the repository so
 * nothing here depends on the user having one, and templates and hooks are shut
 * off so a global `init.templateDir` cannot put a commit hook in the way of a
 * test that is about parsing output.
 */
const IDENTITY = [
  '-c',
  'user.name=Forge Check',
  '-c',
  'user.email=check@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=',
  '-c',
  'init.defaultBranch=main'
]

const git = (cwd, ...args) =>
  execFileSync('git', [...IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }
  })

const root = mkdtempSync(join(tmpdir(), 'forge-gitwatch-'))
const repo = join(root, 'repo')
const plain = join(root, 'plain')

try {
  /* ------------------------------------------------------------- build it */

  mkdirSync(repo)
  mkdirSync(plain)

  git(repo, 'init')
  writeFileSync(join(repo, 'README.md'), '# a repository\n')
  writeFileSync(join(repo, 'kept.txt'), 'one\n')
  git(repo, 'add', '--all')
  git(repo, 'commit', '-m', 'the first commit')
  // A slash in the name, because that is what a real branch list is full of and
  // it is the character `for-each-ref`'s tab-separated format has to survive. A
  // space is not tested here: git refuses to create such a ref at all.
  git(repo, 'branch', 'feat/git-tree')

  // Dirty one tracked file, and add one untracked file whose name has a space
  // in it — the case that would be C-quoted without `-z` and is the reason the
  // status read asks for `-z` at all.
  writeFileSync(join(repo, 'kept.txt'), 'one\ntwo\n')
  writeFileSync(join(repo, 'a new file.txt'), 'untracked\n')

  /* --------------------------------------------------------------- read it */

  console.log('\na real repository')
  const snap = await readStatus('p1', repo, null, 1)

  ok(snap.presence === 'ok', 'the folder reads as a repository', snap.presence)
  ok(snap.repoRoot !== null, 'and has a root')
  ok(
    (snap.repoRoot ?? '').toLowerCase().endsWith('repo'),
    'which is the folder we made, in native form',
    String(snap.repoRoot)
  )
  ok(typeof snap.branch === 'string' && snap.branch.length > 0, 'it is on a branch', String(snap.branch))
  ok(snap.detached === false, 'not detached')
  ok(snap.unborn === false, 'and past its first commit')
  ok(typeof snap.head === 'string' && (snap.head ?? '').length === 7, 'with a short sha', String(snap.head))

  ok(snap.changed === 2, 'two files have changed', String(snap.changed))
  ok(
    snap.files.some((f) => f.path === 'kept.txt' && f.unstaged),
    'the modified file is listed as unstaged',
    snap.files.map((f) => `${f.xy} ${f.path}`).join(', ')
  )
  const spaced = snap.files.find((f) => f.path === 'a new file.txt')
  ok(Boolean(spaced), 'a filename with spaces in it survives whole')
  ok(spaced?.untracked === true, 'and is untracked')
  ok(
    (spaced?.absPath ?? '').endsWith('a new file.txt'),
    'with an absolute path a drag onto a pane could use',
    String(spaced?.absPath)
  )
  ok(snap.conflicted === 0, 'nothing is conflicted')
  ok(snap.filesTruncated === false, 'and nothing was cut off a two-file list')

  ok(snap.branches.length === 2, 'two branches', String(snap.branches.length))
  ok(
    snap.branches.some((b) => b.name === 'feat/git-tree'),
    'including one whose name has a slash in it',
    snap.branches.map((b) => b.name).join(', ')
  )
  ok(
    snap.branches.filter((b) => b.current).length === 1,
    'exactly one of them is the current branch',
    String(snap.branches.filter((b) => b.current).length)
  )
  ok(
    snap.branches.every((b) => b.state === 'unpublished'),
    'and both are unpublished, because there is no remote — never "synced"'
  )
  ok(snap.state === 'unpublished', 'so is HEAD')
  ok(snap.remoteUrl === null, 'there is no origin')
  ok(snap.slug === null, 'and therefore no GitHub slug to spend a gh process on')
  ok(snap.fetchedAt === null, 'a repository that has never fetched says never rather than the epoch')

  /* --------------------------------------------------------- the other two */

  console.log('\nthe states that cost nothing')
  const notRepo = await readStatus('p2', plain, null, 2)
  ok(notRepo.presence === 'no-repo', 'a folder with no repository is a state, not an error', notRepo.presence)
  ok(notRepo.error === undefined, 'and carries no error message')

  const gone = await readStatus('p3', join(root, 'never-existed'), null, 3)
  ok(gone.presence === 'no-folder', 'a folder that is not there is its own answer', gone.presence)
  ok(
    gone.presence !== 'no-git',
    'and specifically not "git is not installed" — the ENOENT that reads like a missing binary'
  )

  /* ------------------------------------------------------------- unborn */

  console.log('\nbefore the first commit')
  const fresh = join(root, 'fresh')
  mkdirSync(fresh)
  git(fresh, 'init')
  writeFileSync(join(fresh, 'notes.md'), 'nothing committed yet\n')
  const unborn = await readStatus('p4', fresh, null, 4)
  ok(unborn.presence === 'ok', 'a repository before its first commit is fine', unborn.presence)
  ok(unborn.unborn === true, 'and knows it')
  ok(typeof unborn.branch === 'string' && unborn.branch.length > 0, 'while still having a real branch name', String(unborn.branch))
  ok(
    unborn.branches.length === 0,
    'even though for-each-ref lists nothing at all — the case the branch list has to render around',
    String(unborn.branches.length)
  )
  ok(unborn.head === null, 'with no sha to show')
  ok(unborn.state === 'unknown', 'and nothing to be ahead or behind of')

  /* --------------------------------------------------------------- the sink */

  /*
   * A second consumer of the snapshots, against the same real repository.
   *
   * The seam exists so the browser client can be told what the window is told
   * without asking git a second time, and the three things worth proving are
   * the three that would silently not be true: that a sink is told at all, that
   * a consumer which throws cannot take the next one down with it, and that
   * unsubscribing actually stops the delivery rather than merely intending to.
   *
   * The push target is a stand-in for a WebContents — the two methods
   * pushSnapshot uses and nothing else — so what is recorded here is the exact
   * object the window would have been sent.
   *
   * The two `[git] sink failed` lines this prints are the proof, not a fault:
   * they are the deliberate thrower being caught.
   */
  console.log('\na second consumer of the same snapshots')

  const sent = []
  const target = { isDestroyed: () => false, send: (_channel, payload) => sent.push(payload) }

  // Registered first, so the sink after it is delivered to *after* this one has
  // already thrown. Registration order is the delivery order.
  let threw = 0
  const offThrower = watcher.addGitSink({
    onSnapshot: () => {
      threw++
      throw new Error('a consumer that cannot cope')
    }
  })
  const heard = []
  const offHeard = watcher.addGitSink({ onSnapshot: (s) => heard.push(s) })

  const started = watcher.startWatch('sink', repo, target)
  ok(started.ok === true, 'a watch starts for a caller that is not a window', JSON.stringify(started))

  const first = await watcher.gitRefresh('sink')
  ok(first?.presence === 'ok', 'and an on-demand read answers from it', String(first?.presence))
  ok(sent.length === 1, 'the window is sent one snapshot', String(sent.length))
  ok(threw === 1, 'the sink that throws is offered it')
  ok(heard.length === 1, 'and the sink after it is told anyway — one bad consumer is isolated', String(heard.length))
  ok(heard[0] === sent[0], 'both halves get the same object, because the sink rides the same push')
  ok(heard[0]?.projectId === 'sink', 'which is this project', String(heard[0]?.projectId))

  // A genuinely different repository, because an identical snapshot is
  // suppressed by design and would prove nothing about unsubscribing.
  offHeard()
  writeFileSync(join(repo, 'a third file.txt'), 'more\n')
  const second = await watcher.gitRefresh('sink')
  ok(second?.changed === 3, 'a second read sees a repository that has actually moved', String(second?.changed))
  ok(threw === 2, 'the sink still registered is told again', String(threw))
  ok(heard.length === 1, 'and the unsubscribed one hears nothing more', String(heard.length))

  offThrower()
} finally {
  watcher.disposeGitWatchers()
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
