import { useRef, useState, type ReactNode } from 'react'
import type { GitActionKind, GitSnapshot } from '@shared/types'
import { useGitSnapshot } from '@/hooks/useGitSnapshot'
import { useHandOff } from '@/hooks/useHandOff'
import {
  branchLabel,
  handoffKinds,
  handoffLabel,
  handoffPrompt,
  sinceLabel,
  upstreamSymbol,
  upstreamTone,
  type HandoffKind
} from '@/lib/gitview'
import { shortPath } from '@/lib/paths'
import { useActiveProject, useApp } from '@/state/AppState'
import { EmptyState } from '../EmptyState'
import { Icon } from '../Icon'
import { Popover, PopoverRow, PopoverSection } from '../Popover'
import { GitActionsRow } from './GitActionsRow'
import { GitBranchList } from './GitBranchList'
import { GitChangesList } from './GitChangesList'
import { RailExpand } from './RailExpand'
import { RailSection } from './RailSection'
import './GitSection.css'

/**
 * Where this project stands: branch, what has changed, whether it is pushed.
 *
 * The one thing this section must never do is treat "no git" as a fault. A
 * folder with no repository is the state Forge was built for first and the state
 * most of Steve's folders are in; git is the addition. So every unhappy answer
 * below is written as a state with a sentence and, where there is one, a way
 * forward — and the way forward is nearly always an agent with a brief, because
 * `git init`, a .gitignore and a repository name are decisions rather than
 * button presses.
 *
 * A folder with no GitHub at all stays completely first-class. "Local only.
 * Nothing here needs GitHub." is a full stop, not a prompt.
 */
export function GitSection(): ReactNode {
  const { state, actions } = useApp()
  const project = useActiveProject()
  const { snap, running, error, refresh, run, dismissError } = useGitSnapshot()
  const handOff = useHandOff('Git')

  const menuRef = useRef<HTMLButtonElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const kinds = handoffKinds(snap)
  const label = branchLabel(snap)
  const tone = snap ? upstreamTone(snap.state) : 'none'
  const expanded = state.railExpanded === 'git'

  const send = (kind: HandoffKind): void => {
    setMenuOpen(false)
    handOff(handoffPrompt(kind, snap))
  }

  /*
   * The header's three pieces, built once and rendered in whichever header is on
   * screen — the rail's or the panel's. Once, because the menu button carries the
   * popover's anchor ref: two live copies of it and the popover would open under
   * whichever of them rendered last.
   */
  const status = label ? (
    <span className="gsec__head" data-tone={tone} title={upstreamTitle(snap)}>
      <span className="gsec__branch mono truncate">{label}</span>
      <span className="gsec__dot" />
    </span>
  ) : null

  const headerActions = (
    <>
      {kinds.length > 0 ? (
        <button
          ref={menuRef}
          type="button"
          className="ghost-btn"
          title="Hand a git job to an agent"
          onClick={() => setMenuOpen(true)}
        >
          <Icon name="dots" size={14} />
        </button>
      ) : null}
      <button
        type="button"
        className="ghost-btn"
        data-running={running ? 'true' : undefined}
        title={running ? 'A git command is running' : 'Ask git again now'}
        onClick={refresh}
      >
        <Icon name="refresh" size={14} className="gsec__spin" />
      </button>
    </>
  )

  const body = (
    <div className="gsec">
      {project ? (
        <Body snap={snap} running={running} run={run} handOff={send} />
      ) : (
        <EmptyState icon="branch" size="sm" title="No project" body="Select a project to see where it stands." />
      )}

      {/*
        A refusal from main, shown where the button that caused it is.
        Dismissed by the next action rather than by a timer: a sentence that
        vanishes before it has been read is worse than no sentence.
      */}
      {error ? (
        <button type="button" className="gsec__error" title="Dismiss" onClick={dismissError}>
          {error}
        </button>
      ) : null}
    </div>
  )

  return (
    <>
      <RailSection
        id="git"
        title="Git"
        count={snap?.changed ?? null}
        hint="Branch, changes, and whether this project is pushed"
        status={expanded ? null : status}
        actions={expanded ? null : headerActions}
        expanded={expanded}
        onExpand={() => actions.setRailExpanded(expanded ? null : 'git')}
      >
        {body}
      </RailSection>

      {/*
        The same body, in a panel over the app. It is the same element rendered
        in one place or the other — never both — so expanding costs no second
        git watch and no refetch, and closing puts the section back exactly as
        it was rather than reloading it.
      */}
      {expanded ? (
        <RailExpand
          id="git"
          title="Git"
          hint="Where this project stands: its branch, what has changed, and whether it is pushed."
          status={status}
          actions={headerActions}
        >
          {body}
        </RailExpand>
      ) : null}

      {/*
        Outside the section rather than inside it, because a closed section does
        not render its body — and the button that opens this popover lives in the
        header, which is on screen either way. Inside, the menu would simply not
        exist for the one arrangement where it is most likely to be wanted.
      */}
      <Popover
        anchor={menuRef.current}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        align="end"
        width={248}
        label="Hand to an agent"
      >
        <PopoverSection title="Hand to an agent">
          {kinds.map((kind) => (
            <PopoverRow key={kind} onClick={() => send(kind)}>
              <Icon name="branch" size={14} />
              <span className="gsec__menu-name">{handoffLabel(kind)}</span>
            </PopoverRow>
          ))}
        </PopoverSection>
        <div className="popover__hint">Typed into an agent, never submitted — you press Enter.</div>
      </Popover>
    </>
  )
}

/* -------------------------------------------------------------------- body */

function Body({
  snap,
  running,
  run,
  handOff
}: {
  snap: GitSnapshot | null
  running: boolean
  run: (action: GitActionKind, opts?: { branch?: string; message?: string }) => void
  handOff: (kind: HandoffKind) => void
}): ReactNode {
  const { actions } = useApp()
  const project = useActiveProject()

  if (!snap) {
    return <EmptyState icon="branch" size="sm" title="Asking git…" body="This takes a process and a moment." />
  }

  /* ------------------------------------------------------- not ok at all */

  if (snap.presence === 'no-git') {
    return (
      <EmptyState
        icon="branch"
        size="sm"
        title="Git is not installed"
        body="Forge asks git about this folder. Nothing else here needs it."
        action={
          <button type="button" className="cta-btn" onClick={() => actions.openSettings('updates')}>
            Updates &amp; tools
          </button>
        }
      />
    )
  }

  if (snap.presence === 'no-folder') {
    return (
      <EmptyState
        icon="folder"
        size="sm"
        title="This folder is gone"
        body="It has been moved, renamed or unmounted since it was added."
        hint={project ? shortPath(project.path) : ''}
      />
    )
  }

  if (snap.presence === 'no-repo') {
    return (
      <EmptyState
        icon="branch"
        size="sm"
        title="No GitHub set"
        body="This folder is not a git repository. Nothing here needs one — Forge works exactly the same either way."
        action={
          <button type="button" className="cta-btn" onClick={() => handOff('init')}>
            Set one up
          </button>
        }
        hint="or run `git init` yourself"
      />
    )
  }

  if (snap.presence === 'error') {
    return (
      <EmptyState
        icon="branch"
        size="sm"
        title="git could not answer"
        body={snap.error ?? 'Something went wrong asking git about this folder.'}
      />
    )
  }

  /* ----------------------------------------------------------------- ok */

  return (
    <>
      {snap.conflicted > 0 ? (
        <div className="gsec__strip" data-tone="warn">
          <span className="gsec__strip-text">
            {snap.conflicted} file{snap.conflicted === 1 ? '' : 's'} conflicted
          </span>
          {/*
            One button, and it is not a resolve. Forge offers no conflict
            resolution of its own at any slice: choosing between two versions of
            a line is a judgement, and the whole design of this section is that
            judgements go to an agent with a brief you can read first.
          */}
          <button type="button" className="ghost-btn" onClick={() => handOff('conflicts')}>
            Ask an agent to resolve
          </button>
        </div>
      ) : null}

      {snap.detached ? (
        <div className="gsec__strip" data-detached="true">
          <span className="gsec__strip-text mono">HEAD @ {snap.head ?? '?'}</span>
          <span className="gsec__strip-note">Switch to a branch to push or pull</span>
        </div>
      ) : null}

      {snap.unborn ? <div className="gsec__note">No commits yet. The first one is below.</div> : null}

      {!snap.remoteUrl ? (
        <div className="gsec__remote">
          <div className="gsec__note">
            {snap.changed === 0
              ? 'Local only. Nothing here needs GitHub.'
              : `${snap.branch ?? 'This branch'} lives on this machine only.`}
          </div>
          <button type="button" className="cta-btn" onClick={() => handOff('publish')}>
            Publish to GitHub
          </button>
        </div>
      ) : null}

      <GitBranchList snap={snap} disabled={running} onSwitch={(branch) => run('switch', { branch })} />

      {snap.changed > 0 ? <GitChangesList snap={snap} /> : null}

      <GitActionsRow snap={snap} running={running} onRun={run} />

      <Foot snap={snap} />
    </>
  )
}

/* -------------------------------------------------------------------- foot */

/**
 * The two quiet lines at the bottom.
 *
 * "fetched 6m ago" exists because ahead/behind is measured against the
 * remote-tracking ref as it was at the last fetch, and Forge deliberately never
 * fetches on a timer — so the number can be an hour old, and the only dishonest
 * thing would be to show it without saying so.
 *
 * gh is absent → **nothing at all**. Do not advertise a tool that is not
 * installed. Signed out gets one dim line and no button, because not being
 * signed into GitHub is not a fault worth a call to action.
 */
function Foot({ snap }: { snap: GitSnapshot }): ReactNode {
  const gh = snap.gh
  return (
    <div className="gsec__foot">
      {snap.remoteUrl ? (
        <span className="gsec__foot-line">
          {snap.state === 'synced' ? 'up to date · ' : ''}
          fetched {sinceLabel(snap.fetchedAt)}
        </span>
      ) : null}
      {gh.status === 'unauthenticated' ? (
        <span className="gsec__foot-line">Sign in to gh for pull requests</span>
      ) : null}
      {/* The URL is gh's output, not Forge's, so it is only a link once it is really https. */}
      {gh.status === 'ready' && gh.currentPr && gh.currentPr.url.startsWith('https://') ? (
        <a
          className="gsec__foot-line gsec__pr"
          href={gh.currentPr.url}
          target="_blank"
          rel="noreferrer noopener"
          title={gh.currentPr.title}
        >
          #{gh.currentPr.number} {gh.currentPr.title}
        </a>
      ) : null}
    </div>
  )
}

/* ----------------------------------------------------------------- helpers */

function upstreamTitle(snap: GitSnapshot | null): string {
  if (!snap || snap.presence !== 'ok') return ''
  const symbol = upstreamSymbol(snap.state, snap.ahead, snap.behind)
  const where = snap.upstream ? `tracks ${snap.upstream}` : 'not published'
  return `${snap.branch ?? 'HEAD'} — ${where}${symbol ? ` ${symbol}` : ''}`
}

/*
 * `useHandOff` used to live here. It moved to src/hooks/useHandOff.ts when the
 * SHARE section needed the same gesture — the pane-preference order, the
 * live-only rule and the DECSET 1004 frame are all documented there.
 */
