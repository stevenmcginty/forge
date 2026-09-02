import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { isClaudeCommand } from '@shared/agents'
import { FOREMAN_SEED_MAX } from '@shared/foreman'
import { Icon } from '@/components/Icon'
import { isShellProfile, resolveProfile } from '@/lib/agents'
import { collectLeaves } from '@/lib/splitTree'
import { handoffTargets, handoffTargetWire, paneHandoffChip, type HandoffTarget } from '@shared/handoffview'
import { useActiveProject, useForge, useProfiles, useWorkspace } from '../state'
import { HandoffMenu } from './HandoffMenu'

/**
 * How tall the seed box grows before it scrolls instead — about four lines of
 * `.foreman-drop__input`'s own font, line-height and padding.
 *
 * Four and not the pane strip's eight, because this box hangs off the top bar
 * over the whole page rather than sitting inside one pane: a seed can still be
 * a whole pasted brief (FOREMAN_SEED_MAX is 40,000 characters), and past four
 * lines it scrolls in place rather than eating the terminal underneath it.
 */
const SEED_MAX_GROW_PX = 92

/**
 * The app bar. Same tokens as the desktop, different job: identity, the
 * project, and whether the link is live. No window controls, no voice
 * (decision 7). On a phone it is the project, one row.
 *
 * It also carries Foreman's switch, which is the one control here that acts on
 * something other than the whole page: the active pane. A pane header on a
 * phone is a floating strip a few characters wide, and a switch that important
 * cannot live somewhere a thumb has to hunt for it — so it sits in this row
 * with the desktop's screen and the notification bell, and the seed box it
 * opens drops into the same band the offline and reconnect strips use.
 */
export function TopBar({
  collapsed,
  onToggleRail,
  onWatchScreen,
  mobile = false
}: {
  collapsed: boolean
  onToggleRail: () => void
  /** Open the screen mirror. Absent while there is no live desktop to ask. */
  onWatchScreen: (() => void) | null
  /** Phone layout. The project identity takes the top of the page. */
  mobile?: boolean
}): ReactNode {
  const { state, actions } = useForge()
  const project = useActiveProject()
  const workspace = useWorkspace()
  const profiles = useProfiles()
  const offline = state.stage.kind === 'offline'
  const desktopName =
    state.picture?.desktopName || (state.stage.kind === 'offline' ? (state.stage.record?.name ?? state.cached?.desktopName ?? '') : '')

  useEffect(() => {
    document.title = project ? `${project.name} · Forge` : 'Forge'
    return () => {
      document.title = 'Forge'
    }
  }, [project])

  /* ------------------------------------------------------------ foreman
   *
   * Whichever pane the desktop says is the active one, resolved the same way
   * `Flyouts` resolves it: the active tab, then that tab's `activePaneId`,
   * then its first leaf if the id names a pane that has gone. Everything below
   * is about *that* pane, and nothing about it is local state — the status
   * comes off the `foreman` push, so a switch flipped at the desk shows its
   * true shape here without anybody saying so.
   */
  const tab = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? workspace.tabs[0]
  const leaves = tab ? collectLeaves(tab.root) : []
  const pane = leaves.find((leaf) => leaf.id === tab?.activePaneId) ?? leaves[0] ?? null
  const paneId = pane?.id ?? null
  const paneProfile = pane ? resolveProfile(profiles, pane.profileId) : null
  /** Claude panes only: Foreman drives a Claude session, not a shell. */
  const drivable = !!paneProfile && isClaudeCommand(paneProfile.command)
  const foreman = paneId ? state.picture?.foreman[paneId] : undefined
  const foremanOn = !!foreman && foreman.status !== 'off'
  const live = !offline && state.connection.state === 'live'
  /** The desktop's own row for this pane. No shell behind it, nothing to drive. */
  const alive = !!paneId && (state.picture?.sessions ?? []).some((s) => s.id === paneId)
  /**
   * A pane that already holds a Claude session can be taken over with no seed
   * at all — the blank answer means exactly that, so it is only offered where
   * it means something.
   */
  const canTakeOver = Boolean(pane?.sessionId)

  const [seeding, setSeeding] = useState(false)
  const [seedDraft, setSeedDraft] = useState('')
  const seedField = useRef<HTMLTextAreaElement | null>(null)

  /**
   * The box closes itself the moment Foreman is on, whichever surface switched
   * it on, and the moment the pill it hangs from leaves the bar — a box left
   * open over a running job would offer a second seed for a job that already
   * has one, and one left open over a shell pane would seed nothing at all.
   */
  useEffect(() => {
    if (foremanOn || !drivable || offline) setSeeding(false)
  }, [foremanOn, drivable, offline])

  /** A seed belongs to the pane it was typed for. Another pane, another job. */
  useEffect(() => {
    setSeeding(false)
    setSeedDraft('')
  }, [paneId])

  // Rows 1 through 4 grow with the text, past that it scrolls in place — a seed
  // can be a whole pasted brief, not just the one line the placeholder
  // suggests. Same shape as the composer's own autosize.
  useEffect(() => {
    const el = seedField.current
    if (!el) return
    el.style.height = '0px'
    const next = Math.min(el.scrollHeight, SEED_MAX_GROW_PX)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > SEED_MAX_GROW_PX ? 'auto' : 'hidden'
  }, [seedDraft, seeding])

  const switchForeman = useCallback(() => {
    if (!paneId || !live || !alive) return
    if (foremanOn) void actions.foremanStop(paneId)
    else setSeeding((open) => !open)
  }, [paneId, live, alive, foremanOn, actions])

  const startForeman = useCallback(() => {
    if (!paneId) return
    const seed = seedDraft.trim().slice(0, FOREMAN_SEED_MAX)
    if (!seed && !canTakeOver) return
    setSeeding(false)
    setSeedDraft('')
    void actions.foremanStart(paneId, seed)
  }, [paneId, seedDraft, canTakeOver, actions])

  /* ------------------------------------------------------------ handoff
   *
   * Handoff for whichever pane is active. Any agent pane (Claude, Antigravity,
   * Grok, Codex, etc.) can write a pack; shells cannot.
   */
  const isAgent = !!paneProfile && !isShellProfile(paneProfile)
  const handoffRecords = (state.projectId ? state.picture?.handoff[state.projectId] : undefined) ?? []
  const handoffChip = paneId ? paneHandoffChip(paneId, handoffRecords) : null
  const handoffBtnRef = useRef<HTMLButtonElement | null>(null)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [handoffBusy, setHandoffBusy] = useState(false)
  const [handoffError, setHandoffError] = useState('')

  const sessions = state.picture?.sessions ?? []
  const targets =
    handoffOpen && paneId
      ? handoffTargets({
          paneId,
          tab: tab ?? null,
          workspace,
          profiles,
          records: handoffRecords,
          isLive: (id) => sessions.some((s) => s.id === id)
        })
      : []

  const pickHandoff = useCallback(
    (target: HandoffTarget) => {
      if (!paneId) return
      setHandoffBusy(true)
      setHandoffError('')
      void actions.handoffStart(paneId, handoffTargetWire(target)).then((error) => {
        setHandoffBusy(false)
        if (error) setHandoffError(error)
        else setHandoffOpen(false)
      })
    },
    [actions, paneId]
  )

  useEffect(() => {
    setHandoffOpen(false)
    setHandoffError('')
  }, [paneId])

  const tint = project ? ({ '--dot': project.color } as CSSProperties) : undefined
  /**
   * The pane's own accent, so the lit switch says *which* pane is being driven
   * rather than merely that one is — the same colour its header and its
   * terminal wear. Named `--pane-accent` because that is what the rest of this
   * page calls it.
   */
  const paneTint = paneProfile ? ({ '--pane-accent': paneProfile.accent } as CSSProperties) : undefined

  return (
    <>
      <header className="titlebar" data-focused="true" style={tint}>
        <div className="titlebar__left">
          <button
            type="button"
            className="ghost-btn titlebar__btn"
            title={collapsed ? 'Show projects' : 'Hide projects'}
            aria-label="Projects rail"
            aria-pressed={!collapsed}
            onClick={onToggleRail}
          >
            <Icon name="panel" size={mobile ? 18 : 15} />
          </button>

          {mobile ? (
            <h1 className="titlebar__project">
              {project ? (
                <>
                  <span className="titlebar__dot" />
                  <span className="truncate">{project.name}</span>
                </>
              ) : (
                'Forge'
              )}
            </h1>
          ) : (
            <>
              <span className="titlebar__mark">
                <Icon name="forge" size={15} />
              </span>
              <span className="titlebar__wordmark">Forge</span>
              {project ? (
                <>
                  <span className="titlebar__sep" />
                  <span className="titlebar__project truncate">
                    <span className="titlebar__dot" />
                    {project.name}
                  </span>
                </>
              ) : null}
            </>
          )}
        </div>

        <div className="titlebar__right">
          {/*
            The connection badge. Three states and not two: "connected" and
            "connected but the link has gone quiet" are different things to a
            person deciding whether their last keystroke arrived, and the app-level
            ping in shared/web.ts exists for no other reason than to tell them
            apart.
          */}
          <span
            className="linkbadge"
            data-state={offline ? 'offline' : state.connection.state}
            data-warm={state.warm ? 'true' : undefined}
            title={
              offline
                ? 'The desktop is not answering — this is the last picture it sent.'
                : state.connection.state === 'live'
                  ? state.warm
                    ? `Mirroring ${desktopName || 'the desktop'}`
                    : `Connected to ${desktopName || 'the desktop'}, but the link has gone quiet`
                  : 'Not connected'
            }
          >
            <span className="linkbadge__dot" />
            <span className="linkbadge__text truncate">
              {offline ? 'Asleep' : state.connection.state === 'live' ? desktopName || 'Live' : 'Connecting'}
            </span>
          </span>

          {/*
            Foreman's switch, for whichever pane is active. Claude panes only —
            Foreman drives a Claude session — and gone rather than greyed on the
            others, because a control that is never available on a shell is not
            news a phone has room to carry.

            Off, a tap drops the seed box under the bar rather than starting
            blind. On, a tap stops it at once, on every surface: switching off is
            how the keyboard comes back, and it must never be two gestures.
          */}
          {drivable && !offline ? (
            <button
              type="button"
              className={mobile ? 'ghost-btn titlebar__btn titlebar__foreman' : 'titlebar__foreman mono'}
              style={paneTint}
              data-on={foremanOn ? 'true' : undefined}
              data-status={foreman?.status ?? 'off'}
              data-open={seeding ? 'true' : undefined}
              aria-pressed={foremanOn}
              aria-expanded={seeding}
              aria-label={
                foremanOn
                  ? foreman?.line
                    ? `Foreman: ${foreman.line} — tap to switch it off`
                    : 'Foreman is driving this pane. Switch it off to take the keyboard back.'
                  : 'Let Foreman drive this pane end to end from one line.'
              }
              disabled={!live || !alive}
              title={
                foremanOn
                  ? foreman?.line
                    ? `Foreman: ${foreman.line} — tap to switch it off`
                    : 'Foreman is driving this pane. Switch it off to take the keyboard back.'
                  : 'Let Foreman drive this pane end to end from one line.'
              }
              onClick={switchForeman}
            >
              {mobile ? <Icon name="foreman" size={15} /> : 'FOREMAN'}
            </button>
          ) : null}

          {/*
            Handoff — ask this agent to write a handoff pack for another one.
            Lives in the top bar beside Foreman, so remote agent actions live
            together cleanly without taking vertical pane space or floating
            cryptic arrows over the content.
          */}
          {handoffChip && !mobile ? (
            <span
              className="titlebar__handoff-chip mono"
              data-state={handoffChip.state}
              title={handoffChip.title}
            >
              {handoffChip.label}
            </span>
          ) : null}

          {isAgent && !offline ? (
            <button
              ref={handoffBtnRef}
              type="button"
              className={mobile ? 'ghost-btn titlebar__btn titlebar__handoff' : 'titlebar__handoff mono'}
              style={paneTint}
              data-open={handoffOpen ? 'true' : undefined}
              data-state={handoffChip?.state}
              aria-expanded={handoffOpen}
              aria-label={
                handoffChip
                  ? `${handoffChip.label} — ${handoffChip.title}`
                  : live && alive
                    ? 'Hand off… — ask this agent to write a handoff pack for another one'
                    : 'Hand off… — needs a live agent session'
              }
              disabled={!live || !alive}
              title={
                handoffChip
                  ? `${handoffChip.label} — ${handoffChip.title}`
                  : live && alive
                    ? 'Hand off… — ask this agent to write a handoff pack for another one'
                    : 'Hand off… — needs a live agent session'
              }
              onClick={() => {
                setHandoffError('')
                setHandoffOpen((v) => !v)
              }}
            >
              {mobile ? (
                <Icon name="send" size={15} />
              ) : (
                handoffChip?.state === 'waiting'
                  ? 'HANDING OFF…'
                  : handoffChip?.state === 'sent' || handoffChip?.state === 'took'
                    ? 'HANDED OFF'
                    : 'HAND OFF'
              )}
            </button>
          ) : null}

          {/*
            The desktop's own screen. Only while the link is live, because it is
            the one control here that cannot mean anything against a cached
            picture: there is no frozen screenshot to show and nothing to ask.
            Everything about whether it is *allowed* is decided on that machine —
            the setting, the second factor, the escalation guard — so this button
            asks and the answer arrives in the overlay.
          */}
          {onWatchScreen ? (
            <button
              type="button"
              className="ghost-btn titlebar__btn"
              title={`Watch ${desktopName || 'this desktop'}’s screen`}
              aria-label="Watch this desktop’s screen"
              onClick={onWatchScreen}
            >
              <Icon name="screen" size={15} />
            </button>
          ) : null}

          {/*
            Desktop notifications, asked for here and nowhere else. A permission
            prompt is only honoured behind a user gesture, so this bell is the
            one place the question is raised — pressed while the answer is still
            "default", merely stating it once it has been given or refused. What
            it buys: a pane that asks a question while this tab is hidden says so
            outside the tab as well.
          */}
          {state.notifyPermission !== 'unsupported' ? (
            <button
              type="button"
              className="ghost-btn titlebar__btn"
              data-permission={state.notifyPermission}
              title={
                state.notifyPermission === 'granted'
                  ? state.pushActive
                    ? 'Notifications are on — a pane asking for you will reach this browser even with the tab closed'
                    : 'Notifications are on — a pane asking for you will raise one while this tab is hidden'
                  : state.notifyPermission === 'denied'
                    ? 'Desktop notifications were refused — allow them for this site in the browser’s settings if you want them'
                    : 'Allow desktop notifications, so a pane that needs you while this tab is hidden can say so'
              }
              aria-label={`Desktop notifications: ${state.notifyPermission}${state.pushActive ? ', push armed' : ''}`}
              data-push={state.pushActive ? 'true' : undefined}
              onClick={() => {
                if (state.notifyPermission === 'default') void actions.requestNotifyPermission()
              }}
            >
              <Icon name={state.notifyPermission === 'granted' ? 'check' : 'note'} size={15} />
            </button>
          ) : null}

          <button
            type="button"
            className="ghost-btn titlebar__btn"
            title={state.session ? `Signed in as ${state.session.email} — sign out` : 'Sign out'}
            aria-label="Sign out"
            onClick={() => actions.signOut()}
          >
            <Icon name="user" size={15} />
          </button>
        </div>
      </header>

      {/*
        The seed box — Foreman's one question before it starts, dropped into the
        same band under the bar that the offline and reconnect strips use, so it
        pushes the page down rather than covering any of it. A line or a whole
        pasted brief, and the blank answer is a real one where the pane already
        holds a session: "take over what is here". Where it does not, Start waits
        for words, because a job with no seed and no session is a switch with
        nothing behind it.
      */}
      {seeding && drivable && !offline ? (
        <div className="foreman-drop" style={paneTint} role="group" aria-label="What Foreman should do">
          <textarea
            ref={seedField}
            className="foreman-drop__input"
            value={seedDraft}
            rows={1}
            // The desktop caps at FOREMAN_SEED_MAX on the way in and this link
            // caps again at the boundary; the attribute keeps the box itself from
            // collecting a paragraph the desktop will only cut.
            maxLength={FOREMAN_SEED_MAX}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="What's the job? A line or a whole brief — both work."
            autoFocus
            onChange={(e) => setSeedDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                startForeman()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setSeeding(false)
              }
            }}
          />
          {canTakeOver ? <span className="foreman-drop__hint">Leave blank to take over the current session.</span> : null}
          <button
            type="button"
            className="foreman-drop__start"
            onClick={startForeman}
            disabled={!seedDraft.trim() && !canTakeOver}
            title={
              canTakeOver
                ? 'Start Foreman — a blank seed takes over the session this pane already holds'
                : 'Type one line for Foreman to start from'
            }
          >
            Start
          </button>
          <button
            type="button"
            className="foreman-drop__cancel"
            aria-label="Cancel"
            onClick={() => {
              setSeeding(false)
              setSeedDraft('')
            }}
          >
            ✕
          </button>
        </div>
      ) : null}

      <HandoffMenu
        anchor={handoffBtnRef.current}
        open={handoffOpen}
        onClose={() => setHandoffOpen(false)}
        targets={targets}
        profiles={profiles}
        autoSend={tab?.settings?.handoffAutoSend === true}
        busy={handoffBusy}
        error={handoffError}
        onPick={pickHandoff}
      />
    </>
  )
}
