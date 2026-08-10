import { useState, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { useRepo } from '../lib/repo'

/**
 * The one screen in Forge Web that asks for a credential it cannot mint.
 *
 * ## Why a pasted token rather than a sign-in button
 *
 * Every other door in this client is a Firebase sign-in, so a "Sign in with
 * GitHub" button is the obvious shape and it is the one thing that cannot be
 * built here. GitHub's OAuth *device* flow ends at `login/oauth/access_token`,
 * and that endpoint — like `login/device/code` before it — sends no
 * `Access-Control-Allow-Origin`, so a browser cannot complete the exchange. The
 * usual answer is a tiny server to do it; Forge Web deliberately has none
 * (decision 12: the bundle is served by Firebase Hosting precisely so that
 * "desktop off" mode can load at all). A fine-grained personal access token is
 * the honest remaining option.
 *
 * ## Which is why this screen says what it says
 *
 * A token in browser storage is a capability against those repositories for as
 * long as it lives. That sentence is on the screen, in those words, rather than
 * in a comment — the person pasting it is the only one who can decide how narrow
 * to make it, and they can only decide that if they are told. So the screen
 * names the exact permission (Contents, read and write), says out loud that
 * nothing else is needed, offers "forget this token", and lists what the token
 * can actually reach so the blast radius is a list rather than an assumption.
 *
 * The token never leaves this browser: not to the desktop, not into the offline
 * snapshot, not into a log line and not into any error message. See the header
 * of lib/repo.tsx.
 */
export function GitHubGate({ slug }: { slug: string }): ReactNode {
  const { actions } = useRepo()
  const [value, setValue] = useState('')

  return (
    <div className="gate">
      <form
        className="gate__card"
        data-reason="github-token"
        onSubmit={(e) => {
          e.preventDefault()
          actions.saveToken(value)
          setValue('')
        }}
      >
        <div className="gate__mark">
          <Icon name="key" size={22} />
        </div>
        <h1 className="gate__title">Open {slug} from GitHub</h1>
        <p className="gate__body">
          Forge is asleep, so there is no terminal and no agent — there is no computer to run one. What is still possible
          is the repository itself: read it, change a file, and commit to a <span className="mono">forge-web/</span>{' '}
          branch for the desktop to pull when it wakes.
        </p>

        <div className="ghgate__ask">
          <p className="ghgate__ask-title">Paste a fine-grained personal access token</p>
          <ul className="ghgate__list">
            <li>
              Repository access: <strong>only select repositories</strong>, and name{' '}
              <span className="mono">{slug}</span>.
            </li>
            <li>
              Permissions: <strong>Contents — Read and write</strong>. Nothing else. (Metadata — Read comes with every
              fine-grained token and cannot be switched off.)
            </li>
            <li>Give it the shortest expiry you can live with.</li>
          </ul>
        </div>

        <p className="gate__hint ghgate__warning">
          <Icon name="key" size={12} /> A token in browser storage is a capability against those repositories for as
          long as it lives. It stays in this browser — it is never sent to the desktop, never written into the offline
          snapshot, and never printed in a message. You can forget it here at any time.
        </p>

        <label className="gate__field">
          <span className="eyebrow">Token</span>
          <input
            className="gate__input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="github_pat_…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            data-testid="github-token-input"
          />
        </label>

        <button type="submit" className="cta-btn gate__go" disabled={!value.trim()}>
          Use this token
        </button>

        <p className="gate__hint">
          <a className="ghgate__link" href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noreferrer">
            github.com/settings/personal-access-tokens
          </a>{' '}
          is where these are made.
        </p>
      </form>
    </div>
  )
}

/**
 * "This is what that token can reach."
 *
 * Shown from the mode's own header rather than as a screen, because by the time
 * a token is stored the person is trying to read a repository and not trying to
 * administer a credential. The probe is one `GET /repos/{owner}/{repo}` per
 * distinct remote in the cached project list: it is the cheapest question that
 * distinguishes "this token can see it", "this token cannot" and "GitHub will
 * not say", and every answer is GitHub's own rather than an inference from the
 * token's shape.
 */
export function TokenSettled(): ReactNode {
  const { state, actions } = useRepo()
  const [open, setOpen] = useState(false)

  return (
    <div className="ghtoken">
      <button
        type="button"
        className="ghost-btn ghtoken__toggle"
        aria-expanded={open}
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next && state.reach.length === 0) actions.probeReach()
        }}
        data-testid="github-token-reach"
      >
        <Icon name="key" size={12} />
        Token
      </button>

      {open ? (
        <div className="ghtoken__sheet">
          <p className="ghtoken__lede">
            A token in browser storage is a capability against these repositories for as long as it lives. This is
            everything it was asked about:
          </p>
          <ul className="ghtoken__reach">
            {state.reach.map((row) => (
              <li key={row.slug} data-state={row.state}>
                <span className="mono ghtoken__slug">{row.slug}</span>
                <span className="ghtoken__detail">
                  {row.state === 'checking' ? 'Asking GitHub…' : row.detail}
                </span>
                <span className="ghtoken__for">{row.projects.join(', ')}</span>
              </li>
            ))}
            {state.reach.length === 0 ? <li className="ghtoken__detail">Asking GitHub…</li> : null}
          </ul>
          <p className="gate__hint">
            This lists the repositories <em>Forge</em> knows about. A token scoped more widely can reach more than is
            shown here — which is the reason to scope it to the repositories you name.
          </p>
          <button
            type="button"
            className="cta-btn ghtoken__forget"
            data-danger="true"
            onClick={() => {
              setOpen(false)
              actions.forgetToken()
            }}
            data-testid="github-forget-token"
          >
            <Icon name="trash" size={13} />
            Forget this token
          </button>
        </div>
      ) : null}
    </div>
  )
}
