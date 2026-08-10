import { type ReactNode } from 'react'
import { Icon, type IconName } from '@/components/Icon'
import type { GitHubFailure } from '../lib/github'

/**
 * A GitHub refusal, as one sentence and one thing to do about it.
 *
 * The same split web/src/components/Connection.tsx holds the socket to, for the
 * same reason it gives: "the desktop writes the diagnosis; the browser writes
 * the prescription. Neither invents the other's." Here GitHub writes the
 * diagnosis — a status code turned into prose in lib/github.ts — and the tables
 * below are the prescription.
 *
 * Nine kinds rather than one `error` string, because "wait until 14:05", "that
 * token cannot see this repository", "somebody else pushed" and "this browser
 * has no connection" are four different things to do next, and a screen that
 * collapsed them into "could not load" would have thrown away the only part
 * anybody can act on.
 *
 * A file of its own rather than a helper inside the mode, because the tree, the
 * editor and the commit box all render it and a component they imported from
 * one another would be an import cycle.
 */
export function Failure({ failure }: { failure: GitHubFailure }): ReactNode {
  return (
    <div className="ghfail" data-reason={failure.kind} data-testid={`github-failure-${failure.kind}`}>
      <Icon name={failureIcon(failure)} size={13} />
      <span className="ghfail__text">
        <strong>{failureTitle(failure)}</strong> {failure.message} {failureHint(failure)}
      </span>
    </div>
  )
}

export function failureTitle(failure: GitHubFailure): string {
  switch (failure.kind) {
    case 'signed-out':
      return 'That token is no longer good.'
    case 'forbidden':
      return 'That token cannot reach this repository.'
    case 'rate-limited':
      return 'GitHub is rate limiting this token.'
    case 'missing':
      return 'Not found on GitHub.'
    case 'empty-repo':
      return 'That repository is empty.'
    case 'conflict':
      return 'The branch moved.'
    case 'refused':
      return 'GitHub refused that.'
    case 'offline':
      return 'This browser is offline.'
    case 'broken':
      return 'GitHub answered with something unexpected.'
  }
}

export function failureHint(failure: GitHubFailure): string {
  switch (failure.kind) {
    case 'signed-out':
      return 'Make a new fine-grained token with Contents read and write on this repository, and paste it here.'
    case 'forbidden':
      return 'A fine-grained token has to name this repository under "only select repositories" — an account-wide grant is not enough.'
    case 'rate-limited':
      return 'Nothing has been lost. Any edit you have made is still here and still committable once the window resets.'
    case 'missing':
      return 'Check the remote at the desk: this is the slug git reported for that project, and GitHub does not have it.'
    case 'empty-repo':
      return 'There is no commit to branch from, so there is nothing to read and nothing to write to yet.'
    case 'conflict':
      return 'Nothing was committed. Decide which version wins rather than letting a browser tab decide for you.'
    case 'refused':
      return 'The change reached GitHub and was turned down on its own merits, so sending it again unchanged will be turned down again.'
    case 'offline':
      return 'Whatever is on screen came out of this browser, and every edit is kept here until the connection is back.'
    case 'broken':
      return 'Worth one retry. If it says the same thing again it is GitHub, not this page.'
  }
}

export function failureIcon(failure: GitHubFailure): IconName {
  switch (failure.kind) {
    case 'signed-out':
    case 'forbidden':
      return 'key'
    case 'rate-limited':
    case 'offline':
    case 'broken':
      return 'restart'
    case 'conflict':
      return 'branch'
    case 'missing':
    case 'empty-repo':
      return 'gear'
    case 'refused':
      return 'close'
  }
}
