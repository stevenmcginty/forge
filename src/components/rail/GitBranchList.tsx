import { useEffect, useState, type ReactNode } from 'react'
import type { GitBranch, GitBranchCompare, GitSnapshot } from '@shared/types'
import { switchConsequence, upstreamSymbol, upstreamTone } from '@/lib/gitview'

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
 * ## Clicking a branch arms it. A second, separate click switches.
 *
 * This used to switch on the first click, and the reasoning was that `git switch
 * --no-guess` on a clean repository is one of the five safe things — which is
 * true, and was the wrong question. The row said `▲+`, meaning "never pushed",
 * which is not a warning about anything; the branch was also forty-six commits
 * behind the one it was clicked from, which the row did not say because the
 * marks measure distance from *origin* and the click's consequence is distance
 * from *here*. One click emptied forty-six commits' worth of work out of the
 * folder with no sentence in front of it. Every commit still existed and the
 * whole app appeared to have reverted itself, which is the same event to the
 * person watching it happen.
 *
 * So the mechanism is: arming asks main how far the branch is from HEAD — one
 * `rev-list`, on demand, because doing it for twenty branches on every poll
 * would be twenty processes for a number nobody has asked for yet — and the row
 * opens into a sentence saying what would happen, in the shape "takes 46 commits
 * out of this folder" rather than "46 behind". Escape closes it, a git command
 * starting closes it, and nothing runs until the second button is pressed.
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

  /** The branch whose confirmation is open, and what the comparison came back as. */
  const [armed, setArmed] = useState<string | null>(null)
  const [compare, setCompare] = useState<GitBranchCompare | null>(null)

  const disarm = (): void => {
    setArmed(null)
    setCompare(null)
  }

  /*
   * refs/remotes is not in the ordinary read — it is a second process for
   * information most people never look at — so it is fetched the first time the
   * group is opened, and dropped whenever the project changes underneath.
   */
  useEffect(() => {
    setRemotes(null)
    setShowRemotes(false)
    setArmed(null)
    setCompare(null)
  }, [snap.projectId])

  /*
   * A git command starting closes the confirmation, because the snapshot it was
   * measured against is the thing about to move. This is also what clears the
   * row after the switch it asked for: pressing the button makes `disabled`
   * true on the next render, and the panel is left showing the new branch
   * rather than a stale question about the old one.
   */
  useEffect(() => {
    if (disabled) disarm()
  }, [disabled])

  /*
   * Escape, on the capture phase. The app's shortcut layer listens on the window
   * and Escape is spoken for elsewhere; an armed row is a small modal state and
   * has first claim on the key that means "no".
   */
  useEffect(() => {
    if (!armed) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      disarm()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [armed])

  /*
   * The measurement. `null` from main means the project or the branch is not
   * something it will answer about, which is still an answer — the row says so
   * rather than sitting on "checking…" forever.
   */
  useEffect(() => {
    if (!armed) return
    let live = true
    setCompare(null)
    void window.forge.git.branchCompare(snap.projectId, armed).then((result) => {
      if (!live) return
      setCompare(result ?? { branch: armed, leaving: 0, gaining: 0, error: 'Forge could not measure that branch' })
    })
    return () => {
      live = false
    }
  }, [armed, snap.projectId])

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
          armed={false}
          onArm={setArmed}
        />
      ) : null}

      {local.map((branch) => (
        <div key={branch.name} className="gbr__slot">
          <BranchRow
            branch={branch}
            disabled={disabled}
            armed={armed === branch.name}
            onArm={setArmed}
          />
          {armed === branch.name ? (
            <SwitchConfirm
              branch={branch.name}
              compare={compare}
              from={snap.branch}
              dirty={snap.changed}
              onCancel={disarm}
              onConfirm={() => onSwitch(branch.name)}
            />
          ) : null}
        </div>
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
        ? (remotes ?? []).map((branch) => (
            <BranchRow key={branch.name} branch={branch} disabled armed={false} onArm={setArmed} />
          ))
        : null}
    </div>
  )
}

/* ------------------------------------------------------------------- a row */

function BranchRow({
  branch,
  disabled,
  armed,
  onArm
}: {
  branch: GitBranch
  disabled: boolean
  armed: boolean
  onArm: (branch: string | null) => void
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
      data-armed={armed ? 'true' : undefined}
      data-tone={tone}
      disabled={!canSwitch}
      aria-expanded={canSwitch ? armed : undefined}
      // "what switching would do" rather than "switch": the row no longer does
      // the thing, and a tooltip promising that it does is the same bug in text.
      title={canSwitch ? `${title}\n\nClick to see what switching here would do` : title}
      onClick={() => canSwitch && onArm(armed ? null : branch.name)}
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

/* --------------------------------------------------------------- the ask */

/**
 * The sentence, and the only button in this list that changes anything.
 *
 * The confirm button is deliberately not the one your finger is already over —
 * it sits at the far end of a row from the row you just clicked, so that a
 * double-click on a branch name cannot arm and confirm in the same gesture.
 *
 * Uncommitted work gets its own line. `git switch` carries changes across rather
 * than leaving them behind, which is the right behaviour and the surprising one:
 * the files do not stay with the branch they were edited on.
 */
function SwitchConfirm({
  branch,
  compare,
  from,
  dirty,
  onCancel,
  onConfirm
}: {
  branch: string
  compare: GitBranchCompare | null
  from: string | null
  dirty: number
  onCancel: () => void
  onConfirm: () => void
}): ReactNode {
  const said = switchConsequence(compare, from)
  const measured = compare !== null

  return (
    <div className="gsw" data-tone={said.tone} role="group" aria-label={`Switch to ${branch}?`}>
      <div className="gsw__what mono truncate">Switch to {branch}</div>
      <div className="gsw__line">{said.text}</div>

      {dirty > 0 ? (
        <div className="gsw__line gsw__carry">
          {dirty} uncommitted {dirty === 1 ? 'file comes' : 'files come'} with you.
        </div>
      ) : null}

      <div className="gsw__row">
        <button type="button" className="ghost-btn gsw__no" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="cta-btn gsw__yes"
          data-rewinds={said.rewinds ? 'true' : undefined}
          disabled={!measured}
          title={measured ? said.text : 'Asking git how far that is'}
          onClick={onConfirm}
        >
          {!measured ? 'Checking…' : said.rewinds ? 'Switch anyway' : 'Switch'}
        </button>
      </div>
    </div>
  )
}
