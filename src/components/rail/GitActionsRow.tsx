import { useState, type ReactNode } from 'react'
import type { GitActionKind, GitSnapshot } from '@shared/types'
import { COMMIT_MESSAGE_MAX } from '@/lib/gitview'

/**
 * The four safe writes, and nothing else.
 *
 * Fetch, fast-forward pull, push, and stage-everything-then-commit. Every one of
 * them has exactly one outcome and none of them can lose work — which is the
 * line this row is drawn on. Rebase, merge, reset, discard and history rewriting
 * are all one gesture away in the section's handoff menu, as a brief for an
 * agent that Steve reads before pressing Enter.
 *
 * **A disabled button says why.** Push on a detached HEAD is greyed with "HEAD
 * is detached — switch to a branch first" in its tooltip rather than being a
 * mystery grey rectangle. Main refuses the same cases again on the live
 * snapshot; this is the half that explains rather than the half that enforces.
 */
export function GitActionsRow({
  snap,
  running,
  onRun
}: {
  snap: GitSnapshot
  running: boolean
  onRun: (action: GitActionKind, opts?: { message?: string }) => void
}): ReactNode {
  const [message, setMessage] = useState('')

  const noRemote = !snap.remoteUrl
  const stuck = snap.detached || snap.unborn
  const conflicted = snap.conflicted > 0

  const why = (action: GitActionKind): string => {
    if (running) return 'A git command is already running'
    if (action === 'commit') {
      if (conflicted) return 'Resolve the conflicts first'
      if (snap.changed === 0) return 'Nothing has changed here to commit'
      if (!message.trim()) return 'A commit needs a message'
      return snap.unborn ? 'Stage everything and make the first commit' : 'Stage everything and commit'
    }
    if (noRemote) return 'This repository has no origin yet'
    if (action === 'fetch') return 'Fetch from origin and prune branches that are gone'
    if (snap.unborn) return 'There are no commits here yet'
    if (snap.detached) return 'HEAD is detached — switch to a branch first'
    if (action === 'pull') {
      if (snap.state === 'unpublished') return 'This branch has no upstream to pull from'
      return 'Fast-forward onto origin. Never a merge, never a rebase'
    }
    return snap.state === 'unpublished' ? 'Push and set the upstream to origin' : 'Push to origin'
  }

  const canCommit = !running && !conflicted && snap.changed > 0 && message.trim().length > 0
  const canFetch = !running && !noRemote
  const canPull = !running && !noRemote && !stuck && snap.state !== 'unpublished'
  const canPush = !running && !noRemote && !stuck

  const commit = (): void => {
    if (!canCommit) return
    onRun('commit', { message: message.trim() })
    setMessage('')
  }

  return (
    <div className="gact">
      <div className="gact__row">
        <button type="button" className="ghost-btn" disabled={!canFetch} title={why('fetch')} onClick={() => onRun('fetch')}>
          Fetch
        </button>
        <button type="button" className="ghost-btn" disabled={!canPull} title={why('pull')} onClick={() => onRun('pull')}>
          Pull
        </button>
        <button type="button" className="ghost-btn" disabled={!canPush} title={why('push')} onClick={() => onRun('push')}>
          Push
        </button>
      </div>

      {/*
        The composer only exists when there is something to commit — an empty
        message box under an unchanged tree is a field asking to be filled in for
        no reason. On a repository before its first commit the button says so,
        because "Commit" and "First commit" are different enough events to be
        worth different words.
      */}
      {snap.changed > 0 && !conflicted ? (
        <div className="gact__commit">
          <input
            className="field__input gact__msg"
            value={message}
            spellCheck={false}
            maxLength={COMMIT_MESSAGE_MAX}
            placeholder={snap.unborn ? 'First commit…' : 'Commit message…'}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              // Stopped here rather than allowed to bubble: the app's shortcut
              // layer listens on the window, and a branch name with a "t" in it
              // must not open a tab.
              e.stopPropagation()
              if (e.key === 'Enter') commit()
            }}
          />
          <button type="button" className="cta-btn gact__go" disabled={!canCommit} title={why('commit')} onClick={commit}>
            {snap.unborn ? 'First commit' : 'Commit'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
