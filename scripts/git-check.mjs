/**
 * Parser check for the rail's git section.
 *
 *   node scripts/git-check.mjs
 *
 * Everything git tells Forge arrives as text, and text parsing is the part of
 * this feature most able to be quietly wrong for months before anyone notices —
 * usually on somebody else's repository, in a state the author never had. So the
 * parsers in electron/git/porcelain.ts have no I/O in them at all, and this file
 * feeds them recorded output: a clean tree, a dirty one, a rename with a space
 * in the filename, an unmerged file, a submodule, a repository before its first
 * commit, a detached HEAD, an upstream that has been deleted, a UTF-8 filename.
 *
 * Zero processes, zero temp folders, milliseconds to run — which is the only
 * reason it will actually be run. `gitwatch-smoke.mjs` is the one that builds a
 * real repository; this one holds the arithmetic.
 *
 * The rename fixture earns its name. Under `-z` a rename record is TWO
 * NUL-separated fields for one record, and a parser that treats every field as a
 * record reads the original path as a mangled record of its own — after which
 * every subsequent file in the list is wrong. It is the single most likely bug
 * in this file, so it is the one with a fixture built to catch it.
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * `electron`, stubbed.
 *
 * electron/git/git-actions.ts reaches electron/store.ts for the project list —
 * that is the whole of its "a request carries a project id, never a path"
 * guarantee — and store.ts imports `app` from electron. Nothing on any path this
 * file exercises calls it: `argvFor` and `refusalFor` are pure, and
 * `runGitAction` (the only function that would touch the store) is never called
 * here. So the module is answered with a shape rather than the real thing, and
 * the check stays a millisecond-long parser test with no Electron in sight.
 */
const ELECTRON_STUB = 'forge-check:electron'

registerHooks({
  resolve(spec, context, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('@/')) {
      return next(new URL(`../src/${spec.slice('@/'.length)}.ts`, import.meta.url).href, context)
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

const P = await import('../electron/git/porcelain.ts')
const A = await import('../electron/git/git-actions.ts')
const V = await import('../src/lib/gitview.ts')

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))
const source = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

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

const ROOT = 'C:\\repo'
/** A join that matches node:path on Windows, so absPath is checkable here. */
const join = (root, rel) => `${root.replace(/[\\/]+$/, '')}\\${rel.replace(/\//g, '\\')}`

/** Build porcelain v2 -z output: every record is NUL-terminated. */
const z = (...records) => records.map((r) => `${r}\0`).join('')

const parse = (text) => P.parsePorcelainV2(text, ROOT, join)
const byPath = (s, p) => s.files.find((f) => f.path === p)

/* ------------------------------------------------------------------ clean */

console.log('\nclean tree')
{
  const s = parse(
    z('# branch.oid 3f1c2a9b', '# branch.head master', '# branch.upstream origin/master', '# branch.ab +0 -0')
  )
  ok(s.branch === 'master', 'reads the branch name', String(s.branch))
  ok(s.head === '3f1c2a9', 'shortens the head sha to seven', String(s.head))
  ok(s.upstream === 'origin/master', 'reads the upstream')
  ok(s.ahead === 0 && s.behind === 0, 'no drift')
  ok(s.hasAheadBehind === true, 'notes that git did emit an ahead/behind header')
  ok(s.files.length === 0, 'no files')
  ok(!s.detached && !s.unborn, 'neither detached nor unborn')
  ok(P.upstreamState(true, 0, 0, false) === 'synced', 'and that reads as synced')
}

/* ------------------------------------------------------------------ dirty */

console.log('\ndirty tree')
{
  const s = parse(
    z(
      '# branch.oid 3f1c2a9b',
      '# branch.head master',
      '# branch.upstream origin/master',
      '# branch.ab +2 -0',
      '1 .M N... 100644 100644 100644 aaaa bbbb src/App.tsx',
      '1 M. N... 100644 100644 100644 cccc dddd electron/git/git-run.ts',
      '1 MM N... 100644 100644 100644 eeee ffff shared/types.ts',
      '? scripts/git-check.mjs',
      '1 D. N... 100644 000000 000000 1111 0000 old/gone.ts'
    )
  )
  ok(s.files.length === 5, 'five records', String(s.files.length))
  ok(s.ahead === 2 && s.behind === 0, 'two ahead of origin')

  const unstaged = byPath(s, 'src/App.tsx')
  ok(unstaged.unstaged && !unstaged.staged, '.M is unstaged only')
  const staged = byPath(s, 'electron/git/git-run.ts')
  ok(staged.staged && !staged.unstaged, 'M. is staged only')
  const both = byPath(s, 'shared/types.ts')
  ok(both.staged && both.unstaged, 'MM is both')
  const untracked = byPath(s, 'scripts/git-check.mjs')
  ok(untracked.untracked && !untracked.staged && !untracked.unstaged, '?? is untracked and neither')
  ok(!s.files.some((f) => f.conflicted), 'nothing is conflicted')

  ok(unstaged.absPath === 'C:\\repo\\src\\App.tsx', 'absPath is native and absolute', unstaged.absPath)
  ok(unstaged.path === 'src/App.tsx', 'path stays forward-slashed, as git printed it')

  ok(P.statusLetter('.M') === 'M', 'letter for a modification')
  ok(P.statusLetter('??') === '?', 'letter for untracked')
  ok(P.statusLetter('D.') === 'D', 'letter for a deletion')
  ok(P.statusLetter('A.') === 'A', 'letter for an addition')
  ok(P.statusLetter('UU') === 'U', 'letter for a conflict')
  ok(P.statusLetter('MM') === 'M', 'both columns set picks the staged one')
}

/* --------------------------------------------------- renames, and the trap */

console.log('\nrenames (the -z two-field record)')
{
  const s = parse(
    z(
      '# branch.oid 3f1c2a9b',
      '# branch.head master',
      '2 R. N... 100644 100644 100644 aaaa bbbb R100 src/new name.tsx',
      'src/old name.tsx',
      '1 .M N... 100644 100644 100644 cccc dddd src/After.tsx'
    )
  )
  ok(s.files.length === 2, 'a rename plus a following file is TWO records, not three', String(s.files.length))
  const renamed = byPath(s, 'src/new name.tsx')
  ok(Boolean(renamed), 'the new path survives the space in it')
  ok(renamed?.from === 'src/old name.tsx', 'the original path is picked up from the second field', String(renamed?.from))
  ok(
    Boolean(byPath(s, 'src/After.tsx')),
    'and the record AFTER the rename is still read correctly — the off-by-one this fixture exists for'
  )
  ok(byPath(s, 'src/After.tsx')?.unstaged === true, 'with its own flags intact')
}

/* -------------------------------------------------------------- conflicted */

console.log('\nunmerged')
{
  const s = parse(
    z(
      '# branch.oid 3f1c2a9b',
      '# branch.head master',
      'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc src/Conflicted File.tsx',
      '1 .M N... 100644 100644 100644 dddd eeee src/Fine.tsx'
    )
  )
  const c = byPath(s, 'src/Conflicted File.tsx')
  ok(Boolean(c), 'an unmerged path with a space in it is read whole')
  ok(c?.conflicted === true, 'and is marked conflicted')
  ok(c?.staged === false && c?.unstaged === false, 'a conflict is neither staged nor unstaged — it is its own state')
  ok(byPath(s, 'src/Fine.tsx')?.conflicted === false, 'its neighbour is not dragged into it')
}

/* --------------------------------------------------------------- submodule */

console.log('\nsubmodules')
{
  const s = parse(z('# branch.oid 3f1c2a9b', '# branch.head master', '1 .M SC.. 160000 160000 160000 aaaa bbbb vendor/thing'))
  ok(s.files.length === 1, 'a submodule is one row')
  ok(byPath(s, 'vendor/thing')?.submodule === true, 'and is flagged as one, never recursed into')
}

/* ------------------------------------------------------------------ unborn */

console.log('\nno commits yet')
{
  const s = parse(z('# branch.oid (initial)', '# branch.head main', '? README.md'))
  ok(s.unborn === true, '(initial) is read as unborn, not as an error')
  ok(s.head === null, 'and there is no sha to show')
  ok(s.branch === 'main', 'while the branch name is still perfectly real')
  ok(s.files.length === 1, 'untracked files still list')
}

/* ---------------------------------------------------------------- detached */

console.log('\ndetached HEAD')
{
  const s = parse(z('# branch.oid 3f1c2a9b', '# branch.head (detached)'))
  ok(s.detached === true, '(detached) is read as detached')
  ok(s.branch === null, 'and there is no branch name')
}
{
  // A branch may legitimately be called this. The caller cross-checks with
  // symbolic-ref; the parser's job is only to report what git printed.
  const s = parse(z('# branch.oid 3f1c2a9b', '# branch.head (detached)'))
  ok(s.detached === true, 'the parser reports the literal and leaves the cross-check to git-status.ts')
}

/* --------------------------------------------------------- upstream states */

console.log('\nupstream')
{
  const gone = parse(z('# branch.oid 3f1c2a9b', '# branch.head feat', '# branch.upstream origin/feat'))
  ok(gone.upstream === 'origin/feat', 'an upstream with no ahead/behind header is still read')
  ok(
    gone.hasAheadBehind === false,
    'and the missing header is recorded — this is how "the remote branch was deleted" is detected'
  )
}
ok(P.upstreamState(false, 0, 0, false) === 'unpublished', 'no upstream is unpublished, never synced')
ok(P.upstreamState(true, 2, 0, false) === 'ahead', 'ahead')
ok(P.upstreamState(true, 0, 3, false) === 'behind', 'behind')
ok(P.upstreamState(true, 2, 3, false) === 'diverged', 'diverged')
ok(P.upstreamState(true, 0, 0, true) === 'gone', 'gone beats every count')

const track = P.parseUpstreamTrack
ok(track('').ahead === 0 && track('').behind === 0 && !track('').gone, 'empty track is level')
ok(track('[ahead 2]').ahead === 2, 'ahead only')
ok(track('[behind 1]').behind === 1, 'behind only')
ok(track('[ahead 2, behind 1]').ahead === 2 && track('[ahead 2, behind 1]').behind === 1, 'both')
ok(track('[gone]').gone === true, 'gone')
ok(track('  [ahead 40]  ').ahead === 40, 'whitespace either side is tolerated')

/* ---------------------------------------------------------------- branches */

console.log('\nbranch list')
{
  const rows = [
    ['master', 'origin/master', '', '1754400000', '*', 'Every pane knows where it pushes'].join('\t'),
    ['feat/git-tree', 'origin/feat/git-tree', '[ahead 7, behind 1]', '1754300000', ' ', 'wip: rail'].join('\t'),
    ['scratch', '', '', '1754200000', ' ', 'local only'].join('\t'),
    ['stale', 'origin/stale', '[gone]', '1754100000', ' ', 'merged and tidied'].join('\t')
  ].join('\n')
  const bs = P.parseForEachRef(rows)
  ok(bs.length === 4, 'four branches', String(bs.length))
  ok(bs[0].current === true, 'the HEAD marker picks out the current branch')
  ok(bs[1].current === false, 'and only that one')
  ok(bs[0].state === 'synced', 'an empty track with an upstream is synced')
  ok(bs[1].ahead === 7 && bs[1].behind === 1 && bs[1].state === 'diverged', 'ahead and behind is diverged')
  ok(bs[2].upstream === null && bs[2].state === 'unpublished', 'a branch with no upstream is unpublished')
  ok(bs[3].state === 'gone', 'a deleted upstream is gone')
  ok(bs[0].lastCommitAt === 1754400000000, 'the unix date becomes ms')
  ok(bs[0].lastSubject === 'Every pane knows where it pushes', 'the subject survives its spaces')
  ok(bs.every((b) => b.remote === false), 'refs/heads are local branches')
  ok(P.parseForEachRef(rows, true).every((b) => b.remote === true), 'the remote flag is the caller’s to set')
  ok(
    P.parseForEachRef(['origin/x', '', '', '0', ' ', ''].join('\t'), true)[0].state === 'unknown',
    'a remote-tracking ref says nothing about upstream rather than claiming to be unpublished'
  )
  ok(P.parseForEachRef('').length === 0, 'an unborn repo’s empty ref list is zero branches, not a crash')
  ok(
    P.parseForEachRef(['a', '', '', '1', ' ', 'has\ttab'].join('\t'))[0].lastSubject === 'has\ttab',
    'a tab inside the subject is put back, because the subject is last'
  )
}

/* -------------------------------------------------------------------- slug */

console.log('\ngithub slug')
const slug = P.parseGithubSlug
ok(slug('git@github.com:steve/forge.git') === 'steve/forge', 'scp-style with .git')
ok(slug('git@github.com:steve/forge') === 'steve/forge', 'scp-style without')
ok(slug('https://github.com/steve/forge.git') === 'steve/forge', 'https with .git')
ok(slug('https://github.com/steve/forge') === 'steve/forge', 'https without')
ok(slug('https://github.com/steve/forge/') === 'steve/forge', 'a trailing slash')
ok(slug('ssh://git@github.com/steve/forge.git') === 'steve/forge', 'ssh://')
ok(slug('https://user:token@github.com/steve/forge.git') === 'steve/forge', 'credentials in the URL')
ok(slug('https://GitHub.com/Steve/Forge') === 'Steve/Forge', 'the host is case-insensitive, the slug is not')
ok(slug('https://gitlab.com/steve/forge.git') === null, 'GitLab gets no gh process and no message')
ok(slug('https://github.example.com/steve/forge.git') === null, 'an enterprise host is out — see the comment')
ok(slug('C:\\repos\\bare.git') === null, 'a bare local path is not a GitHub repo')
ok(slug('') === null && slug('   ') === null, 'nothing is not a GitHub repo')

/* --------------------------------------------------------------- unicode */

console.log('\nawkward filenames')
{
  const s = parse(
    z(
      '# branch.oid 3f1c2a9b',
      '# branch.head master',
      '1 .M N... 100644 100644 100644 aaaa bbbb src/café/naïve.tsx',
      '1 .M N... 100644 100644 100644 cccc dddd "quoted".txt',
      '1 .M N... 100644 100644 100644 eeee ffff a b  c.txt'
    )
  )
  ok(Boolean(byPath(s, 'src/café/naïve.tsx')), 'a UTF-8 path survives intact')
  ok(Boolean(byPath(s, '"quoted".txt')), 'a literal quote is not un-escaped — -z means no C-quoting')
  ok(Boolean(byPath(s, 'a b  c.txt')), 'a double space inside a filename is preserved')
}

/* ------------------------------------------------------------------ junk */

console.log('\nmalformed input')
ok(parse('').files.length === 0, 'empty output is an empty tree, not a crash')
ok(parse(z('')).files.length === 0, 'a lone NUL is nothing')
ok(parse(z('1 .M')).files.length === 0, 'a truncated record is dropped rather than half-read')
ok(parse(z('# branch.ab nonsense')).ahead === 0, 'an unparseable ab header leaves the counts alone')
ok(parse(z('# branch.ab nonsense')).hasAheadBehind === false, 'and does not claim the header was present')
ok(parse(z('x who knows')).files.length === 0, 'an unknown record type is ignored')
ok(parse(z('! ignored/thing')).files.length === 0, 'an ignored file is not news')

/* =========================================================== the rendering
 *
 * src/lib/gitview.ts is the section's whole vocabulary — the glyph for each
 * state, the colour for each state, the folding of files into folders. It is
 * pure for the same reason porcelain.ts is: a symbol that quietly means the
 * wrong thing is a bug nobody reports, they just stop trusting the panel.
 */

console.log('\nupstream symbols')
ok(V.upstreamSymbol('synced') === '✓', 'up to date is a tick')
ok(V.upstreamSymbol('ahead', 3, 0) === '▲3', 'ahead carries its count', V.upstreamSymbol('ahead', 3, 0))
ok(V.upstreamSymbol('behind', 0, 2) === '▼2', 'behind carries its count', V.upstreamSymbol('behind', 0, 2))
ok(V.upstreamSymbol('diverged', 3, 2) === '▼▲', 'diverged is both arrows and no number')
ok(V.upstreamSymbol('unpublished') === '▲+', 'never pushed is the plus')
ok(V.upstreamSymbol('gone') === '!', 'a deleted upstream shouts')
ok(V.upstreamSymbol('unknown') === '', 'detached or unborn claims nothing at all')
ok(
  ['synced', 'ahead', 'behind', 'diverged', 'unpublished', 'gone'].every((s) => V.upstreamSymbol(s, 1, 1).length > 0),
  'every real state has a mark — no row is ever blank where its neighbours are marked'
)

console.log('\nupstream tones')
ok(V.upstreamTone('ahead') === 'ok', 'ahead is the go colour')
ok(V.upstreamTone('behind') === 'danger', 'behind is the one that needs doing something about')
ok(V.upstreamTone('diverged') === 'warn', 'diverged warns')
ok(V.upstreamTone('gone') === 'warn', 'a deleted upstream warns')
ok(V.upstreamTone('synced') === 'dim', 'up to date is the quietest row in the list')
ok(
  V.upstreamTone('unpublished') === 'none',
  'a local-only branch gets no colour — local work is not the degraded path'
)
ok(V.upstreamTone('unknown') === 'none', 'and neither does a detached HEAD')

console.log('\ngrouping changes')
{
  const file = (path, xy = '.M') => ({
    path,
    absPath: `C:\\repo\\${path.replace(/\//g, '\\')}`,
    xy,
    staged: false,
    unstaged: true,
    untracked: xy === '??',
    conflicted: false,
    submodule: false
  })
  const groups = V.groupChanges([
    file('README.md'),
    file('src/App.tsx'),
    file('src/components/rail/GitSection.tsx'),
    file('src/App.css')
  ])
  ok(groups.length === 3, 'three folders', String(groups.length))
  ok(groups[0].dir === '', 'a file at the root gets the empty folder, not the word "root"')
  ok(groups[1].dir === 'src' && groups[1].files.length === 2, 'a folder collects its own files', String(groups[1].files.length))
  ok(groups[2].dir === 'src/components/rail', 'and a deeper path keeps its whole folder as one label')
  ok(V.groupChanges([]).length === 0, 'nothing changed is no groups, not one empty one')
  ok(V.fileName('src/components/rail/GitSection.tsx') === 'GitSection.tsx', 'the filename is the part worth the width')
  ok(V.fileName('README.md') === 'README.md', 'a root file is its own name')
}

/*
 * The status letter exists on both sides of the main/renderer line, because the
 * renderer cannot import a main module and the porcelain columns arrive on the
 * snapshot precisely so it does not have to. Two copies of a rule is exactly
 * what the house convention says needs a check asserting they agree.
 */
console.log('\nthe letter, on both sides of the preload boundary')
for (const xy of ['.M', 'M.', 'MM', 'A.', '.A', 'D.', '.D', 'R.', '??', 'UU', 'AA', 'DD', 'AU', 'UD', 'UA', 'DU', '..']) {
  ok(V.changeLetter(xy) === P.statusLetter(xy), `${xy} reads the same in main and in the renderer`, V.changeLetter(xy))
}
ok(V.changeTone('?') === 'dim', 'an untracked file is the quietest row — a stray build output must not shout')
ok(V.changeTone('D') === 'danger', 'a deletion is the loudest')
ok(V.changeTone('A') === 'ok', 'an addition is the go colour')

console.log('\nlabels')
{
  const base = snapshot()
  ok(V.branchLabel({ ...base, branch: 'master' }) === 'master', 'a branch is its own name')
  ok(
    V.branchLabel({ ...base, branch: null, detached: true, head: '3f1c2a9' }) === 'HEAD @ 3f1c2a9',
    'a detached HEAD is a place you can recognise, not a blank',
    V.branchLabel({ ...base, branch: null, detached: true, head: '3f1c2a9' })
  )
  ok(
    V.branchLabel({ ...base, branch: 'main', unborn: true }) === 'main',
    'a repository before its first commit still shows the branch it is on'
  )
  ok(V.branchLabel({ ...base, presence: 'no-repo' }) === '', 'a folder with no repository says nothing')
  ok(V.branchLabel(null) === '', 'and neither does no project at all')

  const now = 1_700_000_000_000
  ok(V.sinceLabel(null, now) === 'never', 'a repository that has never fetched says so')
  ok(V.sinceLabel(now - 30_000, now) === 'just now', 'under a minute is just now')
  ok(V.sinceLabel(now - 6 * 60_000, now) === '6m ago', 'six minutes', V.sinceLabel(now - 6 * 60_000, now))
  ok(V.sinceLabel(now - 3 * 3_600_000, now) === '3h ago', 'three hours')
  ok(V.sinceLabel(now - 2 * 86_400_000, now) === '2d ago', 'two days')
}

/* ============================================================= the actions
 *
 * Five commands, and the check that keeps them five. Every argv is asserted
 * element by element in every precondition it can be built under, because a
 * table in a comment is a table that drifts and a table in a test is not.
 */

/** A snapshot with every field, so a case can change exactly one thing. */
function snapshot(patch = {}) {
  return {
    projectId: 'p1',
    seq: 1,
    at: 0,
    presence: 'ok',
    repoRoot: 'C:\\repo',
    branch: 'main',
    detached: false,
    unborn: false,
    head: '3f1c2a9',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    state: 'synced',
    remoteUrl: 'https://github.com/steve/forge.git',
    slug: 'steve/forge',
    files: [],
    filesTruncated: false,
    changed: 0,
    staged: 0,
    conflicted: 0,
    branches: [],
    fetchedAt: null,
    slow: false,
    gh: { status: 'absent', login: null, currentPr: null, checkedAt: null },
    ...patch
  }
}

const branch = (name) => ({
  name,
  current: false,
  remote: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  state: 'unpublished',
  lastCommitAt: 0,
  lastSubject: ''
})

const argvIs = (got, want, label) => ok(JSON.stringify(got) === JSON.stringify(want), label, JSON.stringify(got))

console.log('\nargv, per action, per precondition')
argvIs(A.argvFor('fetch', { branch: 'main', state: 'synced' }), ['fetch', '--prune', 'origin'], 'fetch prunes')
argvIs(A.argvFor('pull', { branch: 'main', state: 'behind' }), ['pull', '--ff-only'], 'pull fast-forwards or does nothing')
argvIs(A.argvFor('push', { branch: 'main', state: 'ahead' }), ['push'], 'a published branch pushes plainly')
argvIs(A.argvFor('push', { branch: 'main', state: 'synced' }), ['push'], 'so does one with nothing to push')
argvIs(
  A.argvFor('push', { branch: 'feat/git tree', state: 'unpublished' }),
  ['push', '--set-upstream', 'origin', 'feat/git tree'],
  'an unpublished branch sets its upstream in the same breath — and a space in the name is one argv element'
)
argvIs(
  A.argvFor('push', { branch: null, state: 'unpublished' }),
  ['push'],
  'with no branch to name, push never invents one'
)
argvIs(
  A.argvFor('switch', { branch: 'main', state: 'synced', target: 'feat/x' }),
  ['switch', '--no-guess', 'feat/x'],
  'switch refuses to guess a remote branch into existence'
)
argvIs(
  A.argvFor('commit', { branch: 'main', state: 'ahead', message: 'fix: `rm -rf /` in the docs; see #4' }),
  ['commit', '-m', 'fix: `rm -rf /` in the docs; see #4'],
  'the message is one argv element — no shell, no quoting surface, nothing to inject'
)
argvIs(A.STAGE_ALL_ARGV, ['add', '--all'], 'a commit stages everything first, as its own command')
ok(A.argvFor('nonsense', {}).length === 0, 'an action the module does not know spawns nothing')

console.log('\nnothing destructive can be built')
{
  /*
   * The blanket assertion. Every action crossed with every upstream state and
   * with awkward branch names and messages, so this walks the whole space
   * `argvFor` can produce rather than the five happy lines above.
   */
  const banned = (arg) =>
    arg === '-f' || arg === '-y' || arg === 'clean' || arg.includes('--force') || arg.includes('--hard')
  const states = ['unpublished', 'synced', 'ahead', 'behind', 'diverged', 'gone', 'unknown']
  // Including the hostile ones on purpose: a branch name or a commit message is
  // somebody else's text, and the guarantee is that it can never become a flag.
  const names = ['main', 'feat/x', null, '--force', '-f', 'clean', 'rm -rf /']
  let checked = 0
  let bad = null
  for (const action of ['fetch', 'pull', 'push', 'switch', 'commit']) {
    for (const state of states) {
      for (const name of names) {
        const argv = A.argvFor(action, { branch: name, state, target: name ?? '', message: name ?? '' })
        checked++
        /*
         * The caller's own text is allowed to be anything — it lands in an argv
         * slot, never in a flag slot, and the assertions below prove it stays
         * there. What must never carry one of these is an element the *module*
         * contributed, which is everything else in the array.
         */
        const supplied = new Set([name ?? ''])
        if (argv.filter((arg) => !supplied.has(arg)).some(banned)) {
          bad = `${action}/${state}/${name}: ${JSON.stringify(argv)}`
        }
      }
    }
  }
  ok(bad === null, `no argv out of ${checked} contributes --force, -f, --hard, clean or -y`, bad ?? '')
  ok([...A.STAGE_ALL_ARGV].every((arg) => !banned(arg)), 'nor does the staging command')

  // And the text stays where it was put: a hostile message is the argument to
  // -m and the last element, not something git could read as an option.
  const hostile = A.argvFor('commit', { branch: 'main', state: 'ahead', message: '--force' })
  argvIs(hostile, ['commit', '-m', '--force'], 'a message that looks like a flag is still only the message')
  ok(hostile.indexOf('--force') === hostile.length - 1, 'and it is the last element, consumed by -m')

  // A branch name that could be read as an option never reaches argv at all,
  // because the precondition refuses it first. git will not create such a ref
  // either, so this is the belt to that pair of braces.
  ok(
    A.refusalFor('switch', snapshot({ branches: [branch('--force')] }), { projectId: 'p1', action: 'switch', branch: '--force' }) !== null,
    'a branch whose name begins with a hyphen is refused before anything is spawned'
  )
}

console.log('\nand the strings are not even in the file')
{
  // Not "guarded against" — absent. A flag that is not written cannot be reached
  // by a refactor that gets one condition backwards.
  const src = source('../electron/git/git-actions.ts')
  const token = (flag) => new RegExp(`(^|[\\s'"[(])${flag}([\\s'",\\])]|$)`, 'm')
  ok(!/--force/.test(src), 'no --force anywhere in git-actions.ts')
  ok(!/--hard/.test(src), 'no --hard')
  ok(!/\bclean\b/i.test(src), 'no clean — not the command, not even the word')
  ok(!token('-f').test(src), 'no bare -f (and --ff-only is not one)')
  ok(!token('-y').test(src), 'no bare -y')
  ok(src.includes("'--ff-only'"), 'while the fast-forward-only pull really is there', 'sanity check on the scan above')
}

console.log('\npreconditions')
{
  const req = (patch = {}) => ({ projectId: 'p1', action: 'push', ...patch })
  const no = (label, value) => ok(value !== null, label, String(value))
  const yes = (label, value) => ok(value === null, label, String(value))

  yes('a plain push on a published branch is allowed', A.refusalFor('push', snapshot({ state: 'ahead' }), req()))
  no('push on a detached HEAD is refused', A.refusalFor('push', snapshot({ detached: true }), req()))
  no('push before the first commit is refused', A.refusalFor('push', snapshot({ unborn: true }), req()))
  no('push with no origin is refused', A.refusalFor('push', snapshot({ remoteUrl: null }), req()))

  yes('pull on a branch that is behind is allowed', A.refusalFor('pull', snapshot({ state: 'behind' }), req()))
  no('pull on a detached HEAD is refused', A.refusalFor('pull', snapshot({ detached: true }), req()))
  no('pull before the first commit is refused', A.refusalFor('pull', snapshot({ unborn: true }), req()))
  no(
    'pull on a branch with no upstream is refused rather than left to fail in git',
    A.refusalFor('pull', snapshot({ state: 'unpublished' }), req())
  )

  yes('fetch with an origin is allowed', A.refusalFor('fetch', snapshot(), req()))
  no('fetch with no origin is refused', A.refusalFor('fetch', snapshot({ remoteUrl: null }), req()))

  const withBranches = snapshot({ branches: [branch('main'), branch('feat/x')] })
  yes('switching to a branch in the live list is allowed', A.refusalFor('switch', withBranches, req({ branch: 'feat/x' })))
  no(
    'switching to a branch that is not in the live snapshot is refused — a branch deleted a moment ago is gone',
    A.refusalFor('switch', withBranches, req({ branch: 'deleted' }))
  )
  no('switching with no branch named is refused', A.refusalFor('switch', withBranches, req({ branch: '' })))
  no(
    'switching with files conflicted is refused',
    A.refusalFor('switch', snapshot({ conflicted: 2, branches: [branch('feat/x')] }), req({ branch: 'feat/x' }))
  )

  const dirty = snapshot({ changed: 3 })
  yes('committing with a message and something to commit is allowed', A.refusalFor('commit', dirty, req({ message: 'a real message' })))
  no('committing with no message is refused', A.refusalFor('commit', dirty, req({ message: '   ' })))
  no(
    `a message over ${A.COMMIT_MESSAGE_MAX} characters is refused`,
    A.refusalFor('commit', dirty, req({ message: 'x'.repeat(A.COMMIT_MESSAGE_MAX + 1) }))
  )
  yes(
    'and one exactly at the limit is not',
    A.refusalFor('commit', dirty, req({ message: 'x'.repeat(A.COMMIT_MESSAGE_MAX) }))
  )
  no('committing an unchanged tree is refused', A.refusalFor('commit', snapshot(), req({ message: 'nothing to say' })))
  no(
    'committing with files conflicted is refused',
    A.refusalFor('commit', snapshot({ changed: 3, conflicted: 1 }), req({ message: 'half a merge' }))
  )

  ok(
    A.COMMIT_MESSAGE_MAX === V.COMMIT_MESSAGE_MAX,
    'main and the renderer agree on the longest commit message',
    `${A.COMMIT_MESSAGE_MAX} vs ${V.COMMIT_MESSAGE_MAX}`
  )
}

/* ============================================================ the handoffs
 *
 * These are the only text Forge puts into an agent's prompt on Steve's behalf,
 * which makes them the one place in this feature where a wrong sentence has
 * consequences past a repaint. Four rules, every kind, every time.
 */

console.log('\nhandoff prompts')
{
  const KINDS = ['init', 'publish', 'diverged', 'conflicts', 'tidy', 'pr', 'explain']
  const BANNED = ['--force', 'push -f', 'reset --hard', 'clean -fd', '-y']
  const busy = snapshot({ ahead: 3, behind: 2, conflicted: 4, changed: 9 })

  for (const kind of KINDS) {
    const prompt = V.handoffPrompt(kind, busy)
    ok(prompt.length > 0, `${kind}: says something`)
    ok(prompt.length < 700, `${kind}: under 700 characters`, String(prompt.length))
    ok(!prompt.endsWith('\n'), `${kind}: no trailing newline — a newline would submit it`)
    const found = BANNED.filter((b) => prompt.includes(b))
    ok(found.length === 0, `${kind}: asks for nothing destructive`, found.join(', '))
    ok(V.handoffLabel(kind).length > 0, `${kind}: has a label for its row`)
  }

  ok(V.handoffPrompt('diverged', busy).includes('3 commit(s)'), 'the divergence prompt carries the real counts')
  ok(V.handoffPrompt('diverged', busy).includes('2 there'), 'both of them')
  ok(V.handoffPrompt('conflicts', busy).includes('4 conflicted'), 'and the conflict prompt carries the real count')
  ok(V.handoffPrompt('explain', null).length > 0, 'a prompt with no snapshot at all still reads')
  ok(V.handoffPrompt('nonsense', busy) === '', 'a kind that does not exist produces no prompt to paste')
  ok(
    KINDS.every((k) => V.handoffPrompt(k, busy).endsWith(' ')),
    'every prompt ends in a space, so a person can add a sentence before pressing Enter'
  )
}

console.log('\nwhich handoffs are offered')
{
  ok(JSON.stringify(V.handoffKinds(snapshot({ presence: 'no-repo' }))) === '["init"]', 'a folder with no repository is offered exactly one thing')
  ok(V.handoffKinds(snapshot({ presence: 'no-git' })).length === 0, 'with no git installed there is nothing to hand over')
  ok(V.handoffKinds(null).length === 0, 'and nothing at all with no project')
  ok(V.handoffKinds(snapshot()).includes('explain'), 'explaining the changes is always available')
  ok(!V.handoffKinds(snapshot()).includes('conflicts'), 'resolving conflicts is not offered when there are none')
  ok(V.handoffKinds(snapshot({ conflicted: 2 })).includes('conflicts'), 'and is offered when there are')
  ok(V.handoffKinds(snapshot({ remoteUrl: null })).includes('publish'), 'a repository with no origin is offered publishing')
  ok(!V.handoffKinds(snapshot()).includes('publish'), 'one that already has an origin is not')
  ok(V.handoffKinds(snapshot({ state: 'diverged', ahead: 1, behind: 1 })).includes('diverged'), 'divergence is offered when it exists')
  ok(
    !V.handoffKinds(snapshot({ gh: { status: 'absent', login: null, currentPr: null, checkedAt: null }, ahead: 2 })).includes('pr'),
    'opening a pull request is never offered when gh has not answered'
  )
  ok(
    V.handoffKinds(snapshot({ gh: { status: 'ready', login: 'steve', currentPr: null, checkedAt: 1 }, ahead: 2 })).includes('pr'),
    'and is offered when gh is ready and there is something to open one for'
  )
}

/* -------------------------------------------------------------------- end */

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
