import { execFile } from 'node:child_process'
import type { GhState, GitPullRequest } from '@shared/types'
import { whichCommand } from '../which'

/**
 * What GitHub knows that git does not — and nothing else.
 *
 * `gh` is an enhancement here, never a dependency. A machine without it, a
 * machine with it but not signed in, and a repository on GitLab all get exactly
 * the same treatment: Forge asks git, renders that, and says nothing about pull
 * requests. Not being signed into GitHub is not a fault, and a panel that treats
 * it as one is a panel that nags about something nobody asked it to check.
 *
 * ## Read-only, on purpose and permanently
 *
 * Nothing in this file writes. There is no `gh repo create`, no `gh pr create`,
 * no `gh pr merge`. Creating a repository is a decision with a name, a
 * visibility and a default branch in it, and the answer to all three lives with
 * Steve — so that job is handed to an agent as a pre-written prompt he can read
 * before pressing Enter (see src/lib/gitview.ts). This module only ever asks.
 *
 * ## The three things gh does that surprise people
 *
 * 1. `gh auth status` writes its answer to **stderr**, in both directions.
 *    Reading stdout and finding it empty looks exactly like a broken command.
 * 2. It **exits 1 when you are logged out**. That is a perfectly ordinary state
 *    reported through the only channel a CLI has, and treating a non-zero exit
 *    as "gh is broken" turns "sign in for pull requests" into a red error.
 * 3. `gh pr view` **exits non-zero when the branch simply has no pull request**,
 *    saying so in words. That is `currentPr: null`, not a failure.
 *
 * Each of those is one line of code and one wrong afternoon, so each has a
 * named parser below and a recorded fixture in `npm run gh:check`.
 */

/** Generous: `gh` talks to api.github.com, and a slow VPN is not a fault. */
export const GH_TIMEOUT_MS = 8_000

/**
 * How long a "yes, signed in as X" answer is trusted.
 *
 * Ten minutes because signing in and out is a thing that happens a few times a
 * year, and asking on every status read would mean a network round trip behind
 * every filesystem event in the repository.
 */
export const GH_AUTH_TTL_MS = 10 * 60 * 1000

/**
 * The hard floor between two gh calls for one project.
 *
 * Much longer than git's, because these leave the machine. The watcher also
 * refuses to ask gh from the filesystem path at all — see electron/git-watcher.ts
 * — so this is the ceiling on a feature that is already only asking on focus, on
 * an explicit refresh, and when the branch changes underneath.
 */
export const GH_POLL_MIN_GAP_MS = 60_000

/** The fields a pull request needs to be rendered. Asked for once, shaped once. */
const PR_FIELDS = 'number,title,url,isDraft,state,headRefName,reviewDecision'

/** Enough open pull requests to badge a branch list that holds fifty branches. */
const PR_LIST_LIMIT = 30

/* ------------------------------------------------------------- availability */

let cachedGh: string | null | undefined
let cachedAuth: { at: number; status: GhState['status']; login: string | null } | null = null

/**
 * Is `gh` on the machine at all?
 *
 * Cached for the life of the process, and the gate on every single call below.
 * The whole point is that a machine without gh spends **zero** processes on it:
 * the rail asks about git several times a minute, and a failing spawn behind
 * each of those would be a feature that costs something to not have.
 */
export function ghAvailable(): boolean {
  if (cachedGh === undefined) cachedGh = whichCommand('gh')
  return cachedGh !== null
}

/**
 * Forget both cached answers. Only the refresh button calls this — it is the
 * one gesture that means "I have just changed something you would not have
 * noticed", which is exactly what installing gh or running `gh auth login` in
 * the pane next door is.
 */
export function invalidateGhCaches(): void {
  cachedGh = undefined
  cachedAuth = null
}

/**
 * How many gh processes have been spawned since the module loaded.
 *
 * Exists for `npm run gh:check`, which asserts that a machine without gh spawns
 * none at all. That is a claim about behaviour rather than about code, so it is
 * worth being able to observe rather than merely read.
 */
let spawns = 0
export function ghSpawnCount(): number {
  return spawns
}

/* --------------------------------------------------------------------- run */

interface GhResult {
  code: number
  out: string
  err: string
}

/**
 * One gh command, in one folder, never able to ask a question.
 *
 * `GH_PROMPT_DISABLED` is the load-bearing one: gh is interactive by default and
 * will happily sit at a prompt nobody can see, holding a process open until the
 * timeout. The pager matters for the same reason — a pager on a background
 * process is a process that never exits.
 *
 * Never rejects. `code: -1` means there was no exit code to have: a spawn
 * failure or a timeout.
 */
function runGh(cwd: string, args: string[]): Promise<GhResult> {
  spawns++
  return new Promise((resolve) => {
    execFile(
      'gh',
      args,
      {
        cwd,
        timeout: GH_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: '1',
          GH_PAGER: 'cat',
          PAGER: 'cat',
          NO_COLOR: '1',
          GH_NO_UPDATE_NOTIFIER: '1'
        }
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '')
        const err = String(stderr ?? '')
        if (!error) {
          resolve({ code: 0, out, err })
          return
        }
        const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1
        resolve({ code, out, err: err || error.message })
      }
    )
  })
}

/* ----------------------------------------------------------------- parsers */

/**
 * The login out of `gh auth status`.
 *
 * Two spellings in the wild, because gh renamed the field when it grew support
 * for several accounts on one host: older builds print "Logged in to github.com
 * as steve", newer ones "Logged in to github.com account steve". Both are
 * matched rather than picking one and letting the other read as signed out.
 */
export function parseGhLogin(text: string): string | null {
  const m = /Logged in to \S+ (?:as|account) ([^\s(]+)/i.exec(text ?? '')
  return m?.[1] ? m[1] : null
}

/**
 * `gh auth status`, interpreted.
 *
 * Exit 0 is signed in. **Any other exit is signed out, not broken** — that is
 * the whole of the distinction this function exists to hold, and the reason it
 * is a pure function with fixtures rather than three lines inside a promise
 * chain. The single exception is `code: -1`, which is not gh's answer at all: it
 * is the process failing to run or being killed on the timeout, and that really
 * is an error.
 *
 * Both streams are read together because the answer arrives on stderr in every
 * version of gh there has ever been, signed in or out.
 */
export function parseAuthStatus(
  code: number,
  out: string,
  err: string
): { status: GhState['status']; login: string | null } {
  const text = `${err ?? ''}\n${out ?? ''}`
  if (code === 0) return { status: 'ready', login: parseGhLogin(text) }
  if (code === -1) return { status: 'error', login: null }
  return { status: 'unauthenticated', login: null }
}

/** True when gh is telling us the branch has no pull request rather than failing. */
export function isNoPullRequest(text: string): boolean {
  return /no pull requests? found/i.test(text ?? '')
}

/** One `--json` object into the shape the rail renders, or null if it is not one. */
function toPullRequest(value: unknown): GitPullRequest | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const number = typeof v['number'] === 'number' ? v['number'] : 0
  const headRefName = typeof v['headRefName'] === 'string' ? v['headRefName'] : ''
  if (number <= 0 || !headRefName) return null
  const state = v['state']
  const decision = v['reviewDecision']
  return {
    number,
    title: typeof v['title'] === 'string' ? v['title'] : '',
    url: typeof v['url'] === 'string' ? v['url'] : '',
    isDraft: v['isDraft'] === true,
    state: state === 'MERGED' || state === 'CLOSED' ? state : 'OPEN',
    headRefName,
    reviewDecision:
      decision === 'APPROVED' || decision === 'CHANGES_REQUESTED' || decision === 'REVIEW_REQUIRED'
        ? decision
        : null
  }
}

/**
 * `gh pr list --json …`, which is a JSON array or nothing useful.
 *
 * Malformed output is an empty list rather than a throw: the caller's honest
 * answer for "gh said something I could not read" is the same as its answer for
 * "gh is not here", and neither is worth an error line in a rail.
 */
export function parsePrList(stdout: string): GitPullRequest[] {
  let parsed: unknown
  try {
    parsed = JSON.parse((stdout ?? '').trim() || '[]')
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: GitPullRequest[] = []
  for (const row of parsed) {
    const pr = toPullRequest(row)
    if (pr) out.push(pr)
  }
  return out
}

/**
 * `gh pr view --json …`, which answers in three ways rather than two.
 *
 * `failed` separates "there is no pull request for this branch" — an ordinary
 * answer gh reports through a non-zero exit — from "gh could not tell us". The
 * first is rendered as nothing at all; the second leaves whatever was known
 * before in place rather than replacing it with a confident "no PR".
 */
export function parsePrView(code: number, out: string, err: string): { pr: GitPullRequest | null; failed: boolean } {
  if (code === 0) {
    let parsed: unknown
    try {
      parsed = JSON.parse((out ?? '').trim() || 'null')
    } catch {
      return { pr: null, failed: true }
    }
    return { pr: toPullRequest(parsed), failed: false }
  }
  if (isNoPullRequest(`${err ?? ''}\n${out ?? ''}`)) return { pr: null, failed: false }
  return { pr: null, failed: true }
}

/* ------------------------------------------------------------------ asking */

/** Signed in, and as whom. Cached for GH_AUTH_TTL_MS. */
async function authStatus(cwd: string): Promise<{ status: GhState['status']; login: string | null }> {
  if (cachedAuth && Date.now() - cachedAuth.at < GH_AUTH_TTL_MS) {
    return { status: cachedAuth.status, login: cachedAuth.login }
  }
  const r = await runGh(cwd, ['auth', 'status'])
  const parsed = parseAuthStatus(r.code, r.out, r.err)
  cachedAuth = { at: Date.now(), status: parsed.status, login: parsed.login }
  return parsed
}

/**
 * What GitHub says about this repository and this branch.
 *
 * `slug` gates the whole thing. A null slug is a remote that is not github.com —
 * GitLab, Azure, a bare path on a network share — and those get no process and
 * no message, because Forge has nothing useful to say about them and saying it
 * anyway is noise on somebody else's workflow. The caller is expected not to
 * call at all in that case; the guard here is so that a future caller which
 * forgets cannot spend a process finding out.
 */
export async function ghState(cwd: string, slug: string | null, branch: string | null): Promise<GhState> {
  const checkedAt = Date.now()
  if (!slug || !cwd) return { status: 'absent', login: null, currentPr: null, checkedAt }
  if (!ghAvailable()) return { status: 'absent', login: null, currentPr: null, checkedAt }

  const auth = await authStatus(cwd)
  if (auth.status !== 'ready') {
    return { status: auth.status, login: auth.login, currentPr: null, checkedAt: Date.now() }
  }

  if (!branch) return { status: 'ready', login: auth.login, currentPr: null, checkedAt: Date.now() }

  const view = await runGh(cwd, ['pr', 'view', branch, '--json', PR_FIELDS])
  const { pr } = parsePrView(view.code, view.out, view.err)
  return { status: 'ready', login: auth.login, currentPr: pr, checkedAt: Date.now() }
}

/**
 * Every open pull request on the repository, in one call.
 *
 * One call for the whole branch list rather than one per branch, which is the
 * difference between a badge on a fifty-branch list costing one network round
 * trip and costing fifty. The caller matches them up by `headRefName`.
 */
export async function ghOpenPrs(cwd: string): Promise<GitPullRequest[]> {
  if (!cwd || !ghAvailable()) return []
  const auth = await authStatus(cwd)
  if (auth.status !== 'ready') return []
  const r = await runGh(cwd, ['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', PR_FIELDS])
  if (r.code !== 0) return []
  return parsePrList(r.out)
}
