import { useEffect, useState, type ReactNode } from 'react'
import type { GitActionKind } from '@shared/types'
import { branchLabel, upstreamSymbol, upstreamTone } from '@/lib/gitview'
import { GitActionsRow } from '@/components/rail/GitActionsRow'
import { GitChangesList } from '@/components/rail/GitChangesList'
import { Icon } from '@/components/Icon'
import { useForge } from '../state'

/**
 * The git panel, and the clearest case of decision 4 in the whole client:
 * `GitChangesList` and `GitActionsRow` are the desktop's own components,
 * imported and rendered here unchanged.
 *
 * They can be, because both are pure functions of a `GitSnapshot` plus a
 * callback — no `window.forge`, no AppState — and because `WebGitFrame` carries
 * the snapshot whole. shared/web.ts notes this is the one place the protocol
 * carries desktop paths it did not strictly have to (`repoRoot`, and `absPath`
 * on every changed file), and says why: "the desktop's git panel is reused
 * wholesale in the browser — decision 4 in docs/forge-web.md — and the component
 * reads them." This file is that sentence being true.
 *
 * The paths travel *down* only. Nothing sent back names one: `git-action`
 * carries a project id and the desktop resolves the folder itself.
 */
export function GitPanel({ collapsed }: { collapsed: boolean }): ReactNode {
  const { state, actions } = useForge()
  const [open, setOpen] = useState(true)
  const [running, setRunning] = useState(false)
  /** A git command that was attempted and went wrong. The red box. */
  const [error, setError] = useState('')
  /**
   * A desktop saying what it does not do, which is not the same thing.
   *
   * "This Forge cannot read git for a browser" is `unsupported` — `WebErrorCode`
   * has a word for it precisely because it is a capability gap on an older or
   * narrower build, not a failure anybody can act on. Drawn as a quiet note, so
   * the rail does not carry a permanent red rectangle about a feature that was
   * never switched on.
   */
  const [note, setNote] = useState('')
  const projectId = state.projectId
  const snap = projectId ? (state.git[projectId] ?? null) : null
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'

  // The opening read for whichever project is showing. Pushes on `git` keep it
  // current afterwards, so this fires per project rather than on a timer.
  useEffect(() => {
    if (!projectId || !live) return
    let cancelled = false
    void actions.request({ kind: 'git-status', projectId }).then((result) => {
      if (cancelled) return
      const unsupported = result.kind === 'failed' && result.code === 'unsupported'
      setNote(unsupported ? result.message : '')
      setError(result.kind === 'failed' && !unsupported ? result.message : '')
    })
    return () => {
      cancelled = true
    }
  }, [projectId, live, actions])

  if (collapsed) return null

  const run = (action: GitActionKind, opts?: { message?: string }): void => {
    if (!projectId || running) return
    setRunning(true)
    setError('')
    void actions
      .request({ kind: 'git-action', projectId, action, ...(opts?.message ? { message: opts.message } : {}) })
      .then((result) => {
        // A `git` result is the snapshot re-read *after* the action, exactly as
        // GitActionResult promises, and it arrives through the same push channel
        // the watcher uses — so there is nothing to set here. A failure is the
        // only thing this side has to say.
        if (result.kind === 'failed') setError(result.message)
      })
      .finally(() => setRunning(false))
  }

  return (
    <section className="gsec rsec" data-open={open ? 'true' : undefined}>
      <div className="rsec__head">
        <button type="button" className="rsec__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="rsec__chev">
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
          </span>
          <span className="rsec__title eyebrow">Git</span>
        </button>
        {snap ? (
          <span className="gsec__branch mono truncate" data-tone={upstreamTone(snap.state)}>
            <Icon name="branch" size={11} />
            {branchLabel(snap)}
            <span className="gsec__strip-text">{upstreamSymbol(snap.state, snap.ahead, snap.behind)}</span>
          </span>
        ) : null}
      </div>

      {open ? (
        <div className="rsec__body">
          {!snap ? (
            // One sentence at a time. "Reading git…" over the top of a desktop
            // that has already said it cannot is two states claiming to be true.
            <p className="gsec__note">
              {note || (live ? 'Reading git…' : 'The desktop is not answering, so git is frozen.')}
            </p>
          ) : (
            <>
              <GitChangesList snap={snap} />
              {live ? <GitActionsRow snap={snap} running={running} onRun={run} /> : null}
            </>
          )}
          {error ? <p className="gsec__error">{error}</p> : null}
        </div>
      ) : null}
    </section>
  )
}
