import { type ReactNode } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { Icon } from '@/components/Icon'
import type { GitHubFailure } from '../lib/github'
import { useRepo } from '../lib/repo'
import { useForge } from '../state'
import { CommitBox } from './CommitBox'
import { FileTree } from './FileTree'
import { FileView } from './FileView'
import { Failure, failureHint, failureIcon, failureTitle } from './GitHubFailure'
import { GitHubGate, TokenSettled } from './GitHubGate'

/**
 * GitHub mode: what Forge Web offers when the desktop is off and somebody wants
 * to *do* something rather than look at a photograph.
 *
 * Decision 9 in docs/forge-web.md, drawn: "the browser reads and writes GitHub
 * directly, committing to a `forge-web/*` branch. The desktop shows a banner and
 * reconciles with an ordinary `git pull`." Decision 10 — the frozen, badged
 * terminals — is the other half of the same screen, which is why this is a mode
 * rather than an app: the same titlebar, the same rail, the same theme, and
 * `OfflineBanner` holding the switch between the two.
 *
 * ## The honest limitation, which is the reason for every absence here
 *
 * With the PC powered off there is no terminal and no agent, because there is no
 * computer to run one. So there is no run button on this screen, no pane, no
 * agent chooser and no prompt. What there is is Forge's *shell*: the repository,
 * a file, an edit, and a commit that lands somewhere the desktop can pull from.
 * Anything more would be the interface implying a capability the machine does
 * not have.
 */
export function GitHubMode(): ReactNode {
  const { state } = useRepo()

  switch (state.stage.kind) {
    case 'no-project':
      return (
        <div className="ghmode">
          <EmptyState
            icon="folder"
            eyebrow="GitHub"
            title="No project selected"
            body="Pick one in the rail. Which repository this opens comes from that project's git remote."
          />
        </div>
      )

    case 'unknown-remote':
      return (
        <div className="ghmode" data-testid="github-unknown-remote">
          <EmptyState
            icon="branch"
            eyebrow={state.stage.projectName}
            title="This browser has never been told what git thinks of this project"
            body={
              <>
                The repository a project belongs to reaches here in a <span className="mono">git</span> push from the
                desktop, and this browser has not had one for {state.stage.projectName}. Open the project once while
                Forge is awake and it is remembered for the next time it is not.
              </>
            }
          />
        </div>
      )

    case 'no-remote':
      return (
        <div className="ghmode" data-testid="github-no-remote">
          <EmptyState
            icon="branch"
            eyebrow={state.stage.projectName}
            title="No GitHub remote"
            body={
              <>
                Git has been read for {state.stage.projectName} and its remote is not a github.com one — or it has no
                remote at all. GitHub mode has nothing to open, which is not the same as something being broken: the
                project is fine, it simply does not live anywhere this browser can reach with the desktop off.
              </>
            }
          />
        </div>
      )

    case 'no-token':
      return <GitHubGate slug={state.stage.slug} />

    case 'failed':
      return <Stopped failure={state.stage.failure} />

    case 'reading':
    case 'ready':
      break
  }

  return (
    <div className="ghmode" data-testid="github-mode">
      <Header />
      <div className="ghmode__body">
        <aside className="ghmode__tree">
          <FileTree />
        </aside>
        <section className="ghmode__file">
          {state.warning ? <Failure failure={state.warning} /> : null}
          <FileView />
          {/*
            With no file open, `FileView` draws its empty state and stops — which
            would leave an uncommitted edit invisible, and a draft nobody can see
            is a draft that is lost in every way that matters. So the commit box
            comes back on its own for exactly that case.
          */}
          {!state.open && state.drafts.length > 0 ? <CommitBox /> : null}
        </section>
      </div>
    </div>
  )
}

/** Repository, ref, and the token's own control. */
function Header(): ReactNode {
  const { state, actions } = useRepo()
  const { state: forge } = useForge()
  const name = forge.stage.kind === 'offline' ? (forge.stage.record?.name ?? forge.cached?.desktopName ?? '') : ''

  return (
    <header className="ghmode__head">
      <Icon name="branch" size={13} />
      <span className="mono ghmode__slug truncate" data-testid="github-slug">
        {state.slug}
      </span>
      <span className="ghmode__ref mono" data-testid="github-ref">
        {state.ref || '…'}
      </span>
      {state.shelf ? (
        <span
          className="pane__perm mono"
          data-testid="github-shelf"
          title={`${state.shelf.machine} shelved its uncommitted working tree of ${state.shelf.of} at ${new Date(state.shelf.at).toLocaleString()}. This is newer than ${state.shelf.of} on GitHub, so it is what you are reading.`}
        >
          SHELF · {state.shelf.machine.toUpperCase()}
        </span>
      ) : null}
      {state.info?.private ? <span className="pane__perm mono">PRIVATE</span> : null}
      {state.treeCached ? (
        <span
          className="pane__perm mono"
          data-frozen="true"
          title="This listing is the one cached in this browser, not one GitHub has just answered with"
        >
          CACHED
        </span>
      ) : null}
      <span className="ghmode__lede truncate">
        {state.stage.kind === 'reading'
          ? `Reading ${state.slug} from GitHub…`
          : name
            ? `${name} is asleep, so this is GitHub rather than the working tree.`
            : 'This is GitHub, not the working tree.'}
      </span>
      <button
        type="button"
        className="ghost-btn"
        title="Read GitHub again"
        aria-label="Read GitHub again"
        onClick={() => actions.refresh()}
      >
        <Icon name="refresh" size={13} />
      </button>
      <TokenSettled />
    </header>
  )
}

/** A failure with nothing on screen underneath it: the whole pane is the news. */
function Stopped({ failure }: { failure: GitHubFailure }): ReactNode {
  const { actions } = useRepo()
  return (
    <div className="ghmode">
      <div className="gate">
        <div className="gate__card" data-reason={`github-${failure.kind}`} data-testid={`github-failure-${failure.kind}`}>
          <div className="gate__mark">
            <Icon name={failureIcon(failure)} size={22} />
          </div>
          <h1 className="gate__title">{failureTitle(failure)}</h1>
          <p className="gate__body">{failure.message}</p>
          <p className="gate__hint">{failureHint(failure)}</p>
          {failure.kind === 'signed-out' || failure.kind === 'forbidden' ? (
            <button type="button" className="cta-btn gate__go" onClick={() => actions.forgetToken()}>
              Forget this token and paste another
            </button>
          ) : failure.kind === 'missing' || failure.kind === 'empty-repo' || failure.kind === 'refused' ? (
            // Nothing to press. A repository with no commits, a slug GitHub does
            // not have, and a change refused on its merits are not states a
            // button improves — offering one would be a button that does nothing.
            null
          ) : (
            <button type="button" className="cta-btn gate__go" onClick={() => actions.refresh()}>
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
