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
import { registerHooks } from 'node:module'

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

const P = await import('../electron/git/porcelain.ts')

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

/* -------------------------------------------------------------------- end */

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
