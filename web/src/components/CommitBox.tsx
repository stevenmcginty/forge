import { useState, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { BRANCH_PREFIX } from '../lib/github'
import { useRepo } from '../lib/repo'
import { Failure } from './GitHubFailure'

/**
 * The commit affordance, and the one place in Forge Web that writes anything.
 *
 * Three things are on screen before the button can be pressed, and each is there
 * because of a rule rather than a preference:
 *
 *  - **The branch, named, above the button.** Decision 9: commits land on a
 *    `forge-web/*` branch and never on `master` or a default branch, because
 *    that is what makes the desktop's reconcile an ordinary `git pull` instead
 *    of a bespoke sync protocol. Somebody about to write to a repository from a
 *    browser tab should be able to read where it is going without pressing
 *    anything. The prefix is fixed — the field edits only what comes after it,
 *    and `assertWebBranch` in lib/github.ts refuses the rest regardless.
 *  - **The message, empty.** A commit message is the author's sentence. Forge
 *    Web knows what file changed and nothing whatsoever about why, and a
 *    generated "Update x.ts" is a line somebody has to read past forever.
 *  - **The unsent edits, if there are any.** A commit that failed left its draft
 *    in browser storage, and a draft nobody can see is a draft that is lost in
 *    every way that matters.
 */
export function CommitBox(): ReactNode {
  const { state, actions } = useRepo()
  const [message, setMessage] = useState('')
  const [suffix, setSuffix] = useState(() => state.branch.slice(BRANCH_PREFIX.length))
  const [editingBranch, setEditingBranch] = useState(false)

  const file = state.open
  const dirty = Boolean(file && file.text !== file.base)
  const canCommit = dirty && message.trim().length > 0 && !state.committing && !file?.tooLarge

  return (
    <div className="ghcommit" data-testid="github-commit">
      {state.landed ? (
        <p className="ghcommit__landed" data-testid="github-landed">
          <Icon name="check" size={12} />
          <span className="ghcommit__landed-text">
            Committed <span className="mono">{state.landed.path}</span> to{' '}
            <span className="mono">{state.landed.branch}</span> as{' '}
            <span className="mono">{state.landed.sha.slice(0, 7)}</span>. On the desktop this is a{' '}
            <span className="mono">git pull</span>.
          </span>
        </p>
      ) : null}

      {state.commitFailure ? <Failure failure={state.commitFailure} /> : null}

      {state.conflict ? (
        <div className="ghcommit__conflict" data-testid="github-conflict">
          <p>
            <strong>{state.conflict.path}</strong> is not the blob this edit was made against — the branch moved on
            GitHub after this page read it. Nothing has been committed, and your edit is still here.
          </p>
          <div className="ghcommit__row">
            <button type="button" className="cta-btn" onClick={() => actions.keepMine()}>
              Commit mine over it
            </button>
            <button type="button" className="ghost-btn" onClick={() => actions.takeTheirs()}>
              Throw mine away and re-read GitHub&rsquo;s
            </button>
          </div>
        </div>
      ) : null}

      <div className="ghcommit__branch">
        <Icon name="branch" size={12} />
        <span className="ghcommit__to">Commits to</span>
        {editingBranch ? (
          <>
            <span className="mono ghcommit__prefix">{BRANCH_PREFIX}</span>
            <input
              className="gate__input mono ghcommit__suffix"
              value={suffix}
              autoFocus
              spellCheck={false}
              onChange={(e) => setSuffix(e.target.value)}
              onBlur={() => {
                actions.setBranch(`${BRANCH_PREFIX}${suffix.trim()}`)
                setEditingBranch(false)
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                e.currentTarget.blur()
              }}
            />
          </>
        ) : (
          <button
            type="button"
            className="ghost-btn ghcommit__name mono"
            title="Change which forge-web branch this commits to"
            onClick={() => {
              setSuffix(state.branch.slice(BRANCH_PREFIX.length))
              setEditingBranch(true)
            }}
            data-testid="github-branch"
          >
            {state.branch}
          </button>
        )}
        <span className="ghcommit__never">
          never{' '}
          {state.info?.defaultBranch ? <span className="mono">{state.info.defaultBranch}</span> : 'the default branch'}
        </span>
      </div>

      <div className="ghcommit__row">
        <input
          className="gate__input ghcommit__message"
          placeholder={dirty ? 'What did you change, and why?' : 'Edit the file first'}
          value={message}
          disabled={!dirty}
          onChange={(e) => setMessage(e.target.value)}
          data-testid="github-commit-message"
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !canCommit) return
            e.preventDefault()
            void actions.commit(message.trim())
          }}
        />
        <button
          type="button"
          className="cta-btn"
          disabled={!canCommit}
          data-testid="github-commit-go"
          onClick={() => void actions.commit(message.trim())}
        >
          {state.committing ? 'Committing…' : 'Commit'}
        </button>
      </div>

      {state.drafts.length > 0 ? (
        <div className="ghcommit__drafts" data-testid="github-drafts">
          <p className="eyebrow">Not committed yet — kept in this browser</p>
          <ul>
            {state.drafts.map((draft) => (
              <li key={draft.path}>
                <button type="button" className="ghost-btn mono" onClick={() => actions.restoreDraft(draft.path)}>
                  {draft.path}
                </button>
                <span className="ghcommit__draft-when">{when(draft.at)}</span>
                <button
                  type="button"
                  className="ghost-btn"
                  data-danger="true"
                  title="Throw this edit away"
                  onClick={() => actions.discardDraft(draft.path)}
                >
                  <Icon name="trash" size={12} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function when(at: number): string {
  const minutes = Math.round(Math.max(0, Date.now() - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
