/**
 * Parser check for the GitHub half of the rail's git section.
 *
 *   node scripts/gh-check.mjs
 *
 * `gh` does three things that catch people out, and all three of them look like
 * a working command reporting a fault:
 *
 *   1. `gh auth status` writes its answer to **stderr**, signed in or out. Read
 *      stdout, find it empty, and you have concluded the command is broken.
 *   2. It **exits 1 when you are logged out** — an ordinary state, reported
 *      through the only channel a CLI has. Treat that as an error and "sign in
 *      to gh for pull requests" becomes a red banner about a fault.
 *   3. `gh pr view` **exits non-zero when a branch simply has no pull request**.
 *      That is `currentPr: null`, not a failure.
 *
 * So the parsers in electron/git/gh.ts take the exit code and both streams and
 * have no I/O of their own, and this file feeds them output recorded from the
 * real thing. Zero processes, zero network, milliseconds to run.
 *
 * The last section is the one that is not about parsing at all: a machine with
 * no gh on it must spawn **nothing**. That is a claim about behaviour rather
 * than about text, so it is observed — PATH is emptied, the module is asked its
 * questions, and its own spawn counter is read back.
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

const G = await import('../electron/git/gh.ts')

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

/* ------------------------------------------------------- recorded output */

/** gh 2.x, signed in. Every line of this arrives on stderr. */
const AUTH_IN_NEW = `github.com
  ✓ Logged in to github.com account stevenmcginty (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
`

/** An older gh, which said "as" rather than "account". Both are in the wild. */
const AUTH_IN_OLD = `github.com
  ✓ Logged in to github.com as stevenmcginty (oauth_token)
  ✓ Git operations for github.com configured to use https protocol.
  ✓ Token: *******************
`

/** Signed out. Exit code 1, and again entirely on stderr. */
const AUTH_OUT = `You are not logged into any GitHub hosts. To log in, run: gh auth login
`

/** `gh pr view feat/x --json …` on a branch with no pull request. Exit code 1. */
const NO_PR = `no pull requests found for branch "feat/git-tree"
`

/** `gh pr list --state open --limit 30 --json …` */
const PR_LIST = JSON.stringify([
  {
    number: 412,
    title: 'The rail learns to stack',
    url: 'https://github.com/steve/forge/pull/412',
    isDraft: false,
    state: 'OPEN',
    headRefName: 'feat/rail-stack',
    reviewDecision: 'APPROVED'
  },
  {
    number: 415,
    title: 'wip: git section',
    url: 'https://github.com/steve/forge/pull/415',
    isDraft: true,
    state: 'OPEN',
    headRefName: 'feat/git-tree',
    reviewDecision: null
  }
])

const PR_ONE = JSON.stringify({
  number: 412,
  title: 'The rail learns to stack',
  url: 'https://github.com/steve/forge/pull/412',
  isDraft: false,
  state: 'OPEN',
  headRefName: 'feat/rail-stack',
  reviewDecision: 'CHANGES_REQUESTED'
})

/* ---------------------------------------------------------------- signed in */

console.log('\nsigned in')
{
  // The whole answer on stderr, nothing at all on stdout — the shape that reads
  // as a broken command to anybody looking at the wrong stream.
  const a = G.parseAuthStatus(0, '', AUTH_IN_NEW)
  ok(a.status === 'ready', 'exit 0 is signed in', a.status)
  ok(a.login === 'stevenmcginty', 'the login is read off stderr', String(a.login))

  const b = G.parseAuthStatus(0, '', AUTH_IN_OLD)
  ok(b.status === 'ready', 'an older gh is signed in too')
  ok(b.login === 'stevenmcginty', '"as" is read as well as "account"', String(b.login))

  ok(
    G.parseAuthStatus(0, '', '').status === 'ready',
    'empty stdout with a zero exit is still signed in — the first classic bug, refused'
  )
  ok(G.parseAuthStatus(0, '', '').login === null, 'with no name to show, rather than a wrong one')
  ok(G.parseGhLogin(AUTH_IN_NEW) === 'stevenmcginty', 'the login parser on its own')
  ok(G.parseGhLogin('nothing of the sort') === null, 'and it invents nobody')
}

/* --------------------------------------------------------------- signed out */

console.log('\nsigned out')
{
  const a = G.parseAuthStatus(1, '', AUTH_OUT)
  ok(
    a.status === 'unauthenticated',
    'exit 1 is signed out, not broken — the second classic bug, refused',
    a.status
  )
  ok(a.status !== 'error', 'and specifically not an error: not being signed in is not a fault')
  ok(a.login === null, 'nobody is signed in')
  ok(G.parseAuthStatus(4, '', 'anything').status === 'unauthenticated', 'any non-zero exit gh chooses reads the same')
  ok(
    G.parseAuthStatus(-1, '', '').status === 'error',
    'a process that could not run or was killed on the timeout is the one real error'
  )
}

/* --------------------------------------------------------- pull requests */

console.log('\nthe branch with no pull request')
{
  const v = G.parsePrView(1, '', NO_PR)
  ok(v.pr === null, 'no pull request is null')
  ok(v.failed === false, 'and is not a failure — the third classic bug, refused')
  ok(G.isNoPullRequest(NO_PR) === true, 'the sentence is recognised')
  ok(G.isNoPullRequest('fatal: could not reach api.github.com') === false, 'and a real failure is not mistaken for it')

  const bad = G.parsePrView(1, '', 'HTTP 401: Bad credentials')
  ok(bad.pr === null && bad.failed === true, 'a genuine failure is reported as one, so the old answer is kept')
}

console.log('\npull requests')
{
  const v = G.parsePrView(0, PR_ONE, '')
  ok(v.failed === false, 'a successful view is not a failure')
  ok(v.pr?.number === 412, 'the number', String(v.pr?.number))
  ok(v.pr?.reviewDecision === 'CHANGES_REQUESTED', 'the review decision survives')
  ok(v.pr?.state === 'OPEN', 'the state survives')

  const list = G.parsePrList(PR_LIST)
  ok(list.length === 2, 'two open pull requests', String(list.length))
  ok(list[0].headRefName === 'feat/rail-stack', 'the head branch is what the list is matched by')
  ok(list[1].isDraft === true, 'a draft is flagged, so the badge can be drawn hollow')
  ok(list[1].reviewDecision === null, 'a pull request nobody has reviewed says null rather than guessing')
  ok(list[0].title === 'The rail learns to stack', 'and the title survives its spaces')
}

console.log('\nmalformed output')
ok(G.parsePrList('').length === 0, 'nothing at all is no pull requests, not a crash')
ok(G.parsePrList('not json').length === 0, 'junk is no pull requests')
ok(G.parsePrList('{"number":1}').length === 0, 'an object where an array was promised is no pull requests')
ok(G.parsePrList('[{"number":0,"headRefName":"x"}]').length === 0, 'a row with no number is dropped rather than half-read')
ok(G.parsePrList('[{"number":3}]').length === 0, 'and so is one with no head branch to match it against')
ok(
  G.parsePrList('[{"number":3,"headRefName":"x","state":"NONSENSE"}]')[0].state === 'OPEN',
  'a state gh has never emitted falls back to OPEN rather than becoming a type lie'
)
ok(G.parsePrView(0, 'not json', '').failed === true, 'unparseable success is a failure, not an empty pull request')

/* -------------------------------------------------- gh is not on the machine */

console.log('\nno gh on the machine')
{
  /*
   * The behavioural half. PATH is emptied so whichCommand('gh') cannot find
   * anything, and the module's answers are then read alongside its own spawn
   * counter. This is the promise that makes gh an enhancement rather than a
   * dependency: the rail asks about git several times a minute, and a failing
   * spawn behind each of those would be a feature that costs something to not
   * have.
   */
  process.env['PATH'] = ''
  const before = G.ghSpawnCount()
  ok(before === 0, 'nothing has been spawned by the parser tests above', String(before))
  ok(G.ghAvailable() === false, 'gh is not found')

  const state = await G.ghState('C:\\repo', 'steve/forge', 'main')
  ok(state.status === 'absent', 'a GitHub repository on a machine with no gh is simply absent', state.status)
  ok(state.currentPr === null, 'with no pull request claimed either way')

  const noSlug = await G.ghState('C:\\repo', null, 'main')
  ok(noSlug.status === 'absent', 'and a GitLab or Azure remote gets the same nothing')

  const prs = await G.ghOpenPrs('C:\\repo')
  ok(prs.length === 0, 'and no pull requests')

  ok(G.ghSpawnCount() === 0, 'and not one process was spawned to find any of that out', String(G.ghSpawnCount()))
}

console.log('\nthe rate limits')
ok(G.GH_TIMEOUT_MS >= 5_000, 'gh gets long enough to reach api.github.com', String(G.GH_TIMEOUT_MS))
ok(G.GH_AUTH_TTL_MS >= 5 * 60_000, 'and is not asked whether it is signed in more than a few times an hour')
ok(G.GH_POLL_MIN_GAP_MS >= 30_000, 'nor asked about pull requests more than twice a minute')

/* -------------------------------------------------------------------- end */

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
