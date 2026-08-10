import { useMemo, type ReactNode } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { Icon } from '@/components/Icon'
import { useRepo } from '../lib/repo'
import { CommitBox } from './CommitBox'
import { Failure } from './GitHubFailure'

/**
 * One file, read from GitHub and editable in a `<textarea>`.
 *
 * **A textarea on purpose.** No CodeMirror, no Monaco: the brief for this mode
 * is Forge's *shell* and not Forge's *powers*, and a hundred-kilobyte editor
 * would be the largest thing in a bundle whose whole reason for existing is to
 * load when the machine that does the real work is off. Syntax highlighting is
 * not what somebody needs at 11pm from a phone — a correct save is. The one
 * concession to editing code is `tab` inserting a tab rather than moving focus,
 * because losing your place in a file is the fastest way to a bad commit.
 *
 * ## What is not offered
 *
 * There is no run button, no terminal and no agent here, and there must not be.
 * With the PC powered off there is no computer to run one; an affordance that
 * implied otherwise would be the interface lying about the one limitation
 * docs/forge-web.md is most explicit about.
 */
export function FileView(): ReactNode {
  const { state, actions } = useRepo()
  const file = state.open
  // A NUL byte is the same "this is not text" test `git diff` uses, and the
  // hook has to run before the early return below rather than after it.
  const binary = useMemo(() => (file?.text ?? '').includes(String.fromCharCode(0)), [file?.text])

  if (!file) {
    return (
      <EmptyState
        icon="file"
        eyebrow={state.slug ?? 'GitHub'}
        title="Pick a file"
        body={
          <>
            This is the repository as GitHub has it on{' '}
            <span className="mono">{state.ref || state.info?.defaultBranch || 'the default branch'}</span>. Editing one
            commits to <span className="mono">{state.branch}</span> — never to a default branch — and the desktop picks
            it up with an ordinary <span className="mono">git pull</span>.
          </>
        }
      />
    )
  }

  const dirty = file.text !== file.base
  return (
    <div className="ghfile" data-testid="github-file">
      <header className="ghfile__head">
        <Icon name="file" size={12} />
        <span className="ghfile__path mono truncate" data-testid="github-file-path">
          {file.path}
        </span>
        {file.cached ? (
          <span className="pane__perm mono" data-frozen="true" title="Out of this browser's cache — GitHub has not answered yet">
            CACHED
          </span>
        ) : null}
        {dirty ? (
          <span className="pane__perm mono" data-dirty="true" title="Edited here and not yet committed">
            EDITED
          </span>
        ) : null}
        <div className="ghfile__actions">
          {dirty ? (
            <button type="button" className="ghost-btn" onClick={() => actions.revert()}>
              Discard edit
            </button>
          ) : null}
          <button type="button" className="ghost-btn" onClick={() => actions.closeFile()}>
            <Icon name="close" size={12} />
          </button>
        </div>
      </header>

      {state.fileFailure ? <Failure failure={state.fileFailure} /> : null}

      {file.tooLarge ? (
        <p className="ghfile__note">
          GitHub will not inline this file — it is past the size the contents endpoint returns a body for. It can be
          read on github.com; it cannot be edited from here.
        </p>
      ) : binary ? (
        <p className="ghfile__note">
          This file has bytes that are not text in it. Editing it through a textarea would corrupt it, so it is shown
          read-only.
        </p>
      ) : (
        <textarea
          className="ghfile__editor mono"
          spellCheck={false}
          value={file.text}
          data-testid="github-editor"
          onChange={(e) => actions.edit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Tab' || e.shiftKey) return
            e.preventDefault()
            const el = e.currentTarget
            const { selectionStart: from, selectionEnd: to } = el
            const next = `${file.text.slice(0, from)}\t${file.text.slice(to)}`
            actions.edit(next)
            // After React has re-rendered with the new value, or the caret jumps
            // to the end of the file on every tab.
            requestAnimationFrame(() => {
              el.selectionStart = el.selectionEnd = from + 1
            })
          }}
        />
      )}

      <CommitBox />
    </div>
  )
}
