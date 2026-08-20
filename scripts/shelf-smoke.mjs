/**
 * The shelf against a real git: a scratch repository, a bare "origin", and
 * electron/git/git-shelf.ts doing what it does after a pane goes idle.
 *
 *   npm run shelf:smoke
 *
 * Phase A's gate in docs/GITHUB-FALLBACK-PLAN.md. Asserts, with real git on a
 * real filesystem:
 *
 *  - an uncommitted edit lands on origin under forge-wip/<machine>/<branch>,
 *    with HEAD as its parent and the edit in its tree;
 *  - the real branch, the real index and the working tree are untouched;
 *  - a local commit that is ahead of its upstream is pushed, and a clean tree
 *    retracts the shelf rather than leaving a stale one for a browser to prefer;
 *  - an unchanged tree is quiet — no second push;
 *  - a merge in progress, a detached HEAD and a folder with no origin are all
 *    skipped, not failed.
 *
 * Self-skips when git is absent, like gitwatch-smoke.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
      return { format: 'module', shortCircuit: true, source: 'export const app = { getPath: () => "" }' }
    }
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const { whichCommand } = await import('../electron/which.ts')
if (whichCommand('git') === null) {
  console.log('shelf:smoke — git is not installed here, skipping')
  process.exit(0)
}

const shelf = await import('../electron/git/git-shelf.ts')

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

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Smoke',
  GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
  GIT_COMMITTER_NAME: 'Smoke',
  GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
  GIT_CONFIG_GLOBAL: join(tmpdir(), 'forge-shelf-smoke-no-gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0'
}
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()

const root = mkdtempSync(join(tmpdir(), 'forge-shelf-'))
const origin = join(root, 'origin.git')
const work = join(root, 'work')
const MACHINE = 'smoke-box'

try {
  git(root, 'init', '--bare', '-b', 'main', origin)
  git(root, 'init', '-b', 'main', work)
  writeFileSync(join(work, 'README.md'), '# scratch\n')
  writeFileSync(join(work, '.gitignore'), 'secret.txt\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'first')
  git(work, 'remote', 'add', 'origin', origin)
  git(work, 'push', '-q', '-u', 'origin', 'main')

  const headBefore = git(work, 'rev-parse', 'HEAD')
  const ref = shelf.shelfRef('main', MACHINE)
  const shelfBranch = ref.replace('refs/heads/', '')
  const onOrigin = (r) => {
    try {
      return git(origin, 'rev-parse', '--verify', '--quiet', r)
    } catch {
      return null
    }
  }

  /* --------------------------------------------------- names and guards */

  console.log('\nnaming')
  ok(shelf.machineRefName('Steve PC') === 'Steve-PC', 'a space in a hostname becomes a hyphen')
  ok(shelf.machineRefName('  ') === 'forge', 'an empty hostname falls back to a constant')
  ok(shelf.machineRefName('box.lock') === 'box', 'a name git would refuse (.lock) is trimmed')
  ok(ref === `refs/heads/forge-wip/${MACHINE}/main`, 'the shelf ref is forge-wip/<machine>/<branch>', ref)

  /* ----------------------------------------------------- the first shelf */

  console.log('\nan uncommitted edit')
  writeFileSync(join(work, 'README.md'), '# scratch\n\nedited, not committed\n')
  writeFileSync(join(work, 'new.txt'), 'brand new file\n')
  writeFileSync(join(work, 'secret.txt'), 'ignored\n')

  const first = await shelf.shelfFolder(work, { force: true, machine: MACHINE })
  ok(first.kind === 'shelved', 'is shelved', `${first.kind}: ${first.detail}`)
  const shelfSha = onOrigin(ref)
  ok(Boolean(shelfSha), 'and the shelf ref exists on origin')
  if (shelfSha) {
    ok(git(origin, 'rev-parse', `${shelfSha}^`) === headBefore, 'its parent is HEAD')
    ok(git(origin, 'show', `${shelfSha}:README.md`).includes('edited, not committed'), 'its tree holds the edit')
    ok(git(origin, 'show', `${shelfSha}:new.txt`).includes('brand new'), 'and the untracked file')
    let ignored = true
    try {
      git(origin, 'show', `${shelfSha}:secret.txt`)
      ignored = false
    } catch {
      /* expected */
    }
    ok(ignored, 'but not the ignored one')
  }
  ok(git(work, 'rev-parse', 'HEAD') === headBefore, 'the real HEAD has not moved')
  ok(git(work, 'status', '--porcelain').split('\n').filter(Boolean).length === 2, 'the working tree is still dirty in exactly the same two files')
  ok(git(work, 'diff', '--cached', '--name-only') === '', 'and nothing has been staged in the real index')
  ok(!existsSync(join(work, '.git', 'index.lock')), 'no index.lock left behind')
  ok(onOrigin('refs/heads/main') === headBefore, 'origin/main is where it was')

  /* ------------------------------------------------------------- quiet */

  console.log('\nthe same tree again')
  const again = await shelf.shelfFolder(work, { force: true, machine: MACHINE })
  ok(again.kind === 'quiet', 'is quiet', `${again.kind}: ${again.detail}`)
  ok(onOrigin(ref) === shelfSha, 'and the shelf on origin is the same commit')

  console.log('\nwithout force, inside the minimum gap')
  const gap = await shelf.shelfFolder(work, { machine: MACHINE })
  ok(gap.kind === 'skipped', 'is skipped', `${gap.kind}: ${gap.detail}`)

  /* ---------------------------------------------------- ahead, then clean */

  console.log('\na local commit ahead of upstream, tree clean')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'second')
  const headAfter = git(work, 'rev-parse', 'HEAD')
  const pushed = await shelf.shelfFolder(work, { force: true, machine: MACHINE })
  ok(pushed.kind === 'pushed', 'is pushed', `${pushed.kind}: ${pushed.detail}`)
  ok(onOrigin('refs/heads/main') === headAfter, 'origin/main now has the commit')
  ok(onOrigin(ref) === null, 'and the stale shelf was retracted')

  /* -------------------------------------------------------------- skips */

  console.log('\nstates that are skipped rather than mirrored')
  writeFileSync(join(work, '.git', 'MERGE_HEAD'), `${headBefore}\n`)
  writeFileSync(join(work, 'README.md'), 'mid-merge\n')
  const merging = await shelf.shelfFolder(work, { force: true, machine: MACHINE })
  ok(merging.kind === 'skipped' && /merge/i.test(merging.detail), 'a merge in progress', `${merging.kind}: ${merging.detail}`)
  rmSync(join(work, '.git', 'MERGE_HEAD'))
  git(work, 'checkout', '-q', '--', 'README.md')

  git(work, 'checkout', '-q', '--detach')
  const detached = await shelf.shelfFolder(work, { force: true, machine: MACHINE })
  ok(detached.kind === 'skipped' && /detached/.test(detached.detail), 'a detached HEAD', `${detached.kind}: ${detached.detail}`)
  git(work, 'checkout', '-q', 'main')

  const lonely = join(root, 'lonely')
  git(root, 'init', '-q', '-b', 'main', lonely)
  writeFileSync(join(lonely, 'a.txt'), 'a\n')
  git(lonely, 'add', '-A')
  git(lonely, 'commit', '-q', '-m', 'only')
  writeFileSync(join(lonely, 'a.txt'), 'b\n')
  const noOrigin = await shelf.shelfFolder(lonely, { force: true, machine: MACHINE })
  ok(noOrigin.kind === 'skipped' && /origin/.test(noOrigin.detail), 'a folder with no origin', `${noOrigin.kind}: ${noOrigin.detail}`)

  const plain = join(root, 'plain')
  writeFileSync(join(root, 'not-a-repo.txt'), 'x')
  const notRepo = await shelf.shelfFolder(root, { force: true, machine: MACHINE })
  ok(notRepo.kind === 'skipped', 'a folder that is not a repository', `${notRepo.kind}: ${notRepo.detail}`)
  void plain

  /* ------------------------------------------------- the wip parent rule */

  console.log('\na shelf carries unpublished commits too')
  git(work, 'checkout', '-q', '-b', 'feature/thing')
  writeFileSync(join(work, 'feat.txt'), 'feature\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'feature commit, never pushed')
  writeFileSync(join(work, 'feat.txt'), 'feature, and more\n')
  const feature = await shelf.shelfFolder(work, { force: true, machine: MACHINE })
  const featureRef = shelf.shelfRef('feature/thing', MACHINE)
  ok(feature.kind === 'shelved', 'an unpublished branch with a dirty tree is shelved', `${feature.kind}: ${feature.detail}`)
  ok(onOrigin('refs/heads/feature/thing') === null, 'without publishing the branch itself')
  const fsha = onOrigin(featureRef)
  ok(Boolean(fsha) && git(origin, 'log', '--format=%s', fsha).includes('feature commit, never pushed'), 'but the shelf commit has the unpublished commit as an ancestor')
  ok(readFileSync(join(work, 'feat.txt'), 'utf8') === 'feature, and more\n', 'and the working tree is untouched')
} finally {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* Windows can hold a handle for a moment; the temp dir is disposable */
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
