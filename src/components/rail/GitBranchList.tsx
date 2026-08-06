import { useEffect, useState, type ReactNode } from 'react'
import type { GitBranch, GitSnapshot } from '@shared/types'
import { upstreamSymbol, upstreamTone } from '@/lib/gitview'

/**
 * Every branch in the repository, and where each one stands.
 *
 * Two marks per row and no icons: a dot in the state's tone, and one mono glyph.
 * `✓` is up to date, `▲3` is three commits nobody else has, `▼2` is two commits
 * you have not taken, `▼▲` is both, `▲+` has never been pushed at all, `!` had
 * its upstream deleted underneath it. That is GitLens' vocabulary on purpose —
 * it is already in people's heads — and it is glyphs rather than drawings
 * because a glyph says the same thing while completely still, which is what
 * makes the reduced-motion case identical to the normal one rather than a
 * lesser version of it.
 *
 * Clicking a branch switches to it. Not a menu, not a confirm: `git switch
 * --no-guess` on a repository with no conflicts is one of the five safe things,
 * and anything it refuses comes back as a sentence rather than as a surprise.
 */
export function GitBranchList({
  snap,
  onSwitch,
  disabled
}: {
  snap: GitSnapshot
  onSwitch: (branch: string) => void
  disabled: boolean
}): ReactNode {
  const [remotes, setRemotes] = useState<GitBranch[] | null>(null)
  const [showRemotes, setShowRemotes] = useState(false)

  /*
   * refs/remotes is not in the ordinary read — it is a second process for
   * information most people never look at — so it is fetched the first time the
   * group is opened, and dropped whenever the project changes underneath.
   */
  useEffect(() => {
    setRemotes(null)
    setShowRemotes(false)
  }, [snap.projectId])

  useEffect(() => {
    if (!showRemotes || remotes !== null) return
    let live = true
    void window.forge.git.remoteBranches(snap.projectId).then((list) => {
      if (live) setRemotes(list)
    })
    return () => {
      live = false
    }
  }, [showRemotes, remotes, snap.projectId])

  /*
   * A repository before its first commit has a perfectly real branch and no refs
   * at all, so `for-each-ref` answers with nothing. Rendering only the list would
   * put "no branches" directly beside the name of the branch you are on, which is
   * the kind of small lie that makes people distrust the whole panel.
   */
  const local = snap.branches
  const missingCurrent = Boolean(snap.branch) && !local.some((b) => b.name === snap.branch)

  return (
    <div className="gbr">
      {missingCurrent && snap.branch ? (
        <BranchRow
          branch={{
            name: snap.branch,
            current: true,
            remote: false,
            upstream: snap.upstream,
            ahead: snap.ahead,
            behind: snap.behind,
            state: snap.state,
            lastCommitAt: 0,
            lastSubject: snap.unborn ? 'No commits yet' : ''
          }}
          disabled
          onSwitch={onSwitch}
        />
      ) : null}

      {local.map((branch) => (
        <BranchRow key={branch.name} branch={branch} disabled={disabled} onSwitch={onSwitch} />
      ))}

      <button
        type="button"
        className="gbr__more"
        aria-expanded={showRemotes}
        title="Branches on origin, as of the last fetch"
        onClick={() => setShowRemotes((v) => !v)}
      >
        <span className="eyebrow">Remote</span>
        {remotes ? <span className="gbr__count mono">{remotes.length}</span> : null}
      </button>

      {showRemotes
        ? (remotes ?? []).map((branch) => <BranchRow key={branch.name} branch={branch} disabled onSwitch={onSwitch} />)
        : null}
    </div>
  )
}

/* ------------------------------------------------------------------- a row */

function BranchRow({
  branch,
  disabled,
  onSwitch
}: {
  branch: GitBranch
  disabled: boolean
  onSwitch: (branch: string) => void
}): ReactNode {
  const symbol = upstreamSymbol(branch.state, branch.ahead, branch.behind)
  const tone = upstreamTone(branch.state)
  // A remote-tracking ref is not somewhere `switch --no-guess` will take you,
  // and neither is the branch you are already on.
  const canSwitch = !disabled && !branch.current && !branch.remote

  const title = [
    branch.name,
    branch.upstream ? `tracks ${branch.upstream}` : branch.remote ? 'on origin' : 'not published',
    branch.lastSubject
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <button
      type="button"
      className="gbrow"
      data-current={branch.current ? 'true' : undefined}
      data-tone={tone}
      disabled={!canSwitch}
      title={canSwitch ? `${title}\n\nClick to switch` : title}
      onClick={() => canSwitch && onSwitch(branch.name)}
    >
      <span className="gbrow__dot" />
      <span className="gbrow__name mono truncate">{branch.name}</span>
      {branch.pr ? (
        <span className="gbrow__pr mono" data-draft={branch.pr.isDraft ? 'true' : undefined}>
          #{branch.pr.number}
        </span>
      ) : null}
      {symbol ? <span className="gbrow__mark mono">{symbol}</span> : null}
    </button>
  )
}
