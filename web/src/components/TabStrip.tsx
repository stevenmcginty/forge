import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { AgentProfile, TerminalTab } from '@shared/types'
import { isShellProfile, resolveProfile } from '@/lib/agents'
import { collectLeaves } from '@/lib/splitTree'
import { AgentBadge } from '@/components/AgentBadge'
import { Icon } from '@/components/Icon'
import { Popover } from '@/components/Popover'
import { useForge, useProfiles, useWorkspace } from '../state'
import { AgentChooser } from './AgentChooser'
import { BottomSheet, SheetConfirm, SheetGlyph, SheetRow, SheetSection } from './BottomSheet'
import { CommandsButton, SkillsButton } from './Flyouts'
import { PaneHandoffMenu } from './TopBar'
import './WaitingPill.css'

/**
 * The tab strip, in the desktop's own `.tabstrip` / `.tab` classes.
 *
 * Every gesture here is a request. Selecting a tab sends `select-tab`, closing
 * one sends `close-tab`, and neither touches local state: what moves the strip
 * is the `workspace` push that comes back, because the desktop renderer owns the
 * split tree and is the one thing that persists it (decision 5). That is why
 * there is no `setActiveTab` anywhere in this file, and why clicking a tab on a
 * frozen desktop does nothing rather than lying about it.
 *
 * ## What a request may say about itself
 *
 * That rule made clicking a tab feel dead, because nothing at all moved until
 * the desktop's persist — debounced 250ms in src/state/AppState.tsx — pushed the
 * workspace back, while clicking a *project* moved instantly. Two identical
 * gestures behaving differently for a reason nobody outside this file can see.
 *
 * The fix is the smallest one that is not a lie: the clicked tab says it has
 * been asked for. It does not say it has been granted — no local `setActiveTab`
 * appears below, and the strip still moves only when the push arrives — because
 * a switch this page performed and the desk then contradicted is worse than a
 * beat of latency. `pending` is cleared by the answer, whichever answer it is:
 * the push that agrees, or the sentence that refuses.
 *
 * Absent, deliberately: renaming, tab colours, drag reordering and the mosaic
 * toggle. `WEB_LAYOUT_OPS` has seven verbs and none of them is any of those —
 * the browser can create, close, select, split, focus and switch project, and a
 * strip that offered more would be offering something the wire cannot carry.
 *
 * ## On a phone
 *
 * Neutral pills: an agent dot, the title, and — when it asks — the "!". The
 * active pill is lifted (raised surface, heavier weight), not coloured, so
 * "which tab am I in" and "which agent is this" stop being the same signal.
 * There is no × in the pill; a long-press opens a sheet with Close tab (behind
 * the same confirm), Hand off and New agent here. `+` sits outside the scroller
 * so it never scrolls away, and the scroller fades at whichever edge has more.
 * Two tabs with the same title say which folder each is in.
 */
export function TabStrip({ mobile = false }: { mobile?: boolean }): ReactNode {
  const { state, actions } = useForge()
  const workspace = useWorkspace()
  const newTabRef = useRef<HTMLButtonElement | null>(null)
  const [chooserOpen, setChooserOpen] = useState(false)
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  const project = (state.picture?.projects ?? state.cached?.projects ?? []).find((p) => p.id === state.projectId)
  const profiles = useProfiles()

  /**
   * The tab this browser has asked for, and where the strip stood when it asked.
   *
   * Derived on the way out rather than cleared in an effect, so the mark comes
   * off in the same commit as the `workspace` push that answers it rather than a
   * paint later. Any move at all is the answer — to the tab that was asked for,
   * or to a different one, because the desk is entitled to do either and a mark
   * that outlived its own answer would be this page inventing a state the
   * desktop knows nothing about.
   *
   * ## Why the request is then thrown away, and not merely stopped being drawn
   *
   * Deriving alone answered the wrong question. It says "is the strip still
   * where it was when I asked", which is true again the moment the desk comes
   * *back* to that tab — so a request that had been asked, granted and finished
   * with rose from the dead, and the pill it named went permanently untappable:
   * `Tab` refuses to send a second request for a tab that is already pending,
   * which is right, and it was being told a lie. Steve met it as a phone that
   * would not change tabs.
   *
   * So the answer retires the request as well as the mark, in the same render
   * that stops drawing it. Adjusting state during render rather than in an
   * effect keeps the promise the paragraph above makes — React re-runs this
   * component before it paints, so nothing is ever on screen holding the stale
   * one — and it cannot loop, because the next pass has no `ask` to retire.
   */
  const [ask, setAsk] = useState<{ tabId: string; from: string | null } | null>(null)
  const pending = ask && ask.from === workspace.activeTabId ? ask.tabId : null
  if (ask && !pending) setAsk(null)

  /**
   * The strip scrolls sideways on a phone, and an active pill that sits past
   * the edge is a pill the thumb cannot reach — or worse, half of one, cut
   * mid-word by the viewport with no hint there is more either way. So the
   * active tab is walked to the middle of the strip whenever the answer to
   * "which tab" changes. `block: 'nearest'` keeps the walk horizontal: the
   * strip's ancestors must not scroll a pixel vertically for a pill.
   */
  const activeRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [workspace.activeTabId])

  /** Every pill's element, so the long-press sheet's Hand off can anchor to the pill it came from. */
  const tabEls = useRef(new Map<string, HTMLDivElement>())

  /*
   * The phone's scroller fades at the edge that has more pills past it, and
   * only there — a fade at an edge with nothing beyond it would be a pill
   * dissolving for no reason. Written to the element rather than to state:
   * a scroll is sixty of these a second and none of them needs a render.
   */
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!mobile || !el) return
    const update = (): void => {
      const start = el.scrollLeft > 2
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
      el.dataset.fade = start && end ? 'both' : start ? 'start' : end ? 'end' : 'none'
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [mobile, workspace.tabs.length])

  /*
   * Two pills called "Claude Code" are two pills nobody can tell apart, and the
   * wire has no rename. So a repeated title carries the leaf of its pane's
   * folder, and where even that repeats, its place among the twins.
   */
  const suffixes = tabSuffixes(workspace.tabs, state.picture?.sessions ?? [])

  /* ------------------------------------------------------ the long-press sheet */
  const [sheetTabId, setSheetTabId] = useState<string | null>(null)
  const [sheetStep, setSheetStep] = useState<'list' | 'close'>('list')
  const [handoffTabId, setHandoffTabId] = useState<string | null>(null)
  const sheetTab = workspace.tabs.find((t) => t.id === sheetTabId) ?? null
  const handoffTab = workspace.tabs.find((t) => t.id === handoffTabId) ?? null
  const handoffPaneId = handoffTab ? activeLeafId(handoffTab) : null
  const sessions = state.picture?.sessions ?? []

  // A tab that goes away while its sheet is open takes the sheet with it.
  useEffect(() => {
    if (sheetTabId && !sheetTab) setSheetTabId(null)
    if (handoffTabId && !handoffTab) setHandoffTabId(null)
  }, [sheetTabId, sheetTab, handoffTabId, handoffTab])

  const openSheet = (tabId: string): void => {
    setSheetStep('list')
    setSheetTabId(tabId)
  }

  const select = async (tabId: string): Promise<void> => {
    setAsk({ tabId, from: workspace.activeTabId })
    // `layout` resolves with the desktop's refusal sentence rather than throwing
    // one, and a tab that was refused must not go on looking like one that is
    // about to open.
    if (await actions.layout({ op: 'select-tab', tabId })) setAsk(null)
  }

  const newTab = (
    <button
      ref={newTabRef}
      type="button"
      className="ghost-btn tabstrip__new"
      title={live ? 'New terminal tab' : 'The desktop is not answering, so it cannot open a tab'}
      aria-label="New tab"
      disabled={!live}
      onClick={() => setChooserOpen(true)}
    >
      <Icon name="plus" size={mobile ? 20 : 14} />
    </button>
  )

  return (
    <div className="tabstrip" role="tablist" aria-label="Terminal tabs">
      <div className="tabstrip__tabs" ref={scrollerRef}>
        {workspace.tabs.map((tab) => (
          <Tab
            key={tab.id}
            tab={tab}
            active={tab.id === workspace.activeTabId}
            pending={tab.id === pending}
            live={live}
            mobile={mobile}
            suffix={suffixes.get(tab.id) ?? ''}
            onSelect={() => void select(tab.id)}
            onLongPress={() => openSheet(tab.id)}
            ref={(el) => {
              if (el) tabEls.current.set(tab.id, el)
              else tabEls.current.delete(tab.id)
              if (tab.id === workspace.activeTabId) activeRef.current = el
            }}
          />
        ))}

        {mobile ? null : newTab}
      </div>

      {mobile ? (
        newTab
      ) : (
        <>
          <div className="tabstrip__spacer" />
          <SkillsButton />
          <CommandsButton />
        </>
      )}

      {mobile ? (
        <TabSheet
          tab={sheetTab}
          title={sheetTab ? sheetTab.title + (suffixes.get(sheetTab.id) ? ` · ${suffixes.get(sheetTab.id)}` : '') : ''}
          profiles={profiles}
          step={sheetStep}
          live={live}
          alive={(id) => sessions.some((s) => s.id === id)}
          projectName={project?.name ?? 'this project'}
          onStep={setSheetStep}
          onClose={() => setSheetTabId(null)}
          onNewAgent={() => {
            setSheetTabId(null)
            setChooserOpen(true)
          }}
          onHandoff={(tabId) => {
            setSheetTabId(null)
            setHandoffTabId(tabId)
          }}
          onCloseTab={(tabId) => {
            setSheetTabId(null)
            void actions.layout({ op: 'close-tab', tabId })
          }}
        />
      ) : null}

      {mobile ? (
        <PaneHandoffMenu
          paneId={handoffPaneId}
          tab={handoffTab}
          anchor={handoffTabId ? (tabEls.current.get(handoffTabId) ?? null) : null}
          open={!!handoffTab && !!handoffPaneId}
          onClose={() => setHandoffTabId(null)}
        />
      ) : null}

      <AgentChooser
        anchor={newTabRef.current}
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        onPick={(profileId, permissionMode) => void actions.layout({ op: 'create-tab', profileId, permissionMode })}
        selectedId={project?.defaultProfileId}
      />
    </div>
  )
}

/** How long a finger rests on a pill before it opens the tab's sheet. */
const LONG_PRESS_MS = 450
/** A finger that moves further than this is scrolling the strip, not pressing a pill. */
const LONG_PRESS_SLOP_PX = 10

function Tab({
  tab,
  active,
  pending,
  live,
  mobile,
  suffix,
  onSelect,
  onLongPress,
  ref
}: {
  tab: TerminalTab
  active: boolean
  /** Asked for, not yet granted. See the header. */
  pending: boolean
  live: boolean
  mobile: boolean
  /** The folder leaf (or ordinal) that tells this tab from a twin of the same title. */
  suffix: string
  onSelect: () => void
  /** Phone only: the finger rested. Opens the tab's sheet. */
  onLongPress: () => void
  /** Every pill hands its element up: the strip walks the active one into view and anchors menus to any. */
  ref?: (el: HTMLDivElement | null) => void
}): ReactNode {
  const { state, actions } = useForge()
  const profiles = useProfiles()
  const leaves = collectLeaves(tab.root)
  const badges = leaves.slice(0, 3).map((leaf) => resolveProfile(profiles, leaf.profileId))
  const primary = badges[0] ?? null
  // Agent tabs inherit the profile accent; an explicit tab colour still wins —
  // the same rule, in the same order, as the desktop's strip.
  const agentTint = primary && !isShellProfile(primary) ? primary.accent : undefined
  const tint = tab.color ?? agentTint
  const asking = leaves.some((leaf) => state.asking.has(leaf.id))
  const closeBtnRef = useRef<HTMLButtonElement | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  /** What pressed the pill last. A finger selects on `click`; see below. */
  const pointerType = useRef('')

  /*
   * The long-press. A timer from the finger landing; moving past the slop
   * (a scroll), lifting, or the browser cancelling the pointer (a pan) all
   * stop it. When it fires, the click that follows the lift is swallowed, so
   * opening the sheet never also selects the tab underneath.
   */
  const press = useRef<{ timer: number; x: number; y: number } | null>(null)
  const longFired = useRef(false)
  const endPress = (): void => {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = null
  }
  useEffect(() => endPress, [])

  if (mobile) {
    const dots = uniqueProfiles(badges)
    return (
      <div
        ref={ref}
        className="tab"
        role="tab"
        aria-selected={active}
        aria-busy={pending || undefined}
        aria-haspopup="dialog"
        aria-label={`${tab.title}${suffix ? `, ${suffix}` : ''}${asking ? ', waiting on you' : ''}. Press and hold for more`}
        data-active={active}
        data-pending={pending ? 'true' : undefined}
        data-working={asking ? 'true' : undefined}
        onPointerDown={(e) => {
          pointerType.current = e.pointerType
          longFired.current = false
          endPress()
          if (e.pointerType === 'mouse' && e.button !== 0) return
          press.current = {
            x: e.clientX,
            y: e.clientY,
            timer: window.setTimeout(() => {
              press.current = null
              longFired.current = true
              navigator.vibrate?.(12)
              onLongPress()
            }, LONG_PRESS_MS)
          }
          if (e.pointerType !== 'touch' && !active && !pending && live) onSelect()
        }}
        onPointerMove={(e) => {
          const p = press.current
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP_PX) endPress()
        }}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        onPointerLeave={endPress}
        // Android raises the context menu on a long-press, and a right-click or
        // the menu key raises it everywhere: all three mean "this tab's sheet".
        onContextMenu={(e) => {
          e.preventDefault()
          endPress()
          if (!longFired.current) {
            longFired.current = true
            onLongPress()
          }
        }}
        onClick={() => {
          const touched = pointerType.current === 'touch'
          pointerType.current = ''
          if (longFired.current) {
            longFired.current = false
            return
          }
          if (touched && !active && !pending && live) onSelect()
        }}
      >
        <span className="tab__dots" aria-hidden="true">
          {dots.map((profile) => (
            <span key={profile.id} className="tab__dot" style={{ background: profile.accent }} />
          ))}
        </span>
        <span className="tab__title truncate">
          {tab.title}
          {suffix ? <span className="tab__suffix"> · {suffix}</span> : null}
        </span>
        {asking ? (
          <span className="tab__ask" aria-hidden="true">
            !
          </span>
        ) : null}
        {/*
         * The same sheet as the long-press, in plain sight on the tab you are
         * on. A hidden gesture alone was not found: Steve asked where closing
         * a tab had gone. It opens a sheet (Close tab still asks first), so a
         * stray tap never closes anything.
         */}
        {active ? (
          <span
            className="tab__menu"
            role="button"
            tabIndex={0}
            aria-label={`Options for ${tab.title}: close, hand off, new agent`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onLongPress()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onLongPress()
              }
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 10l5 5 5-5" />
            </svg>
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <div
      ref={ref}
      className="tab"
      role="tab"
      aria-selected={active}
      aria-busy={pending || undefined}
      data-active={active}
      data-pending={pending ? 'true' : undefined}
      data-tint={tint ? 'true' : undefined}
      data-working={asking ? 'true' : undefined}
      title={
        !live
          ? `${tab.title} — the desktop is not answering, so it cannot switch tab`
          : pending
            ? `${tab.title} — asked for; waiting for the desktop to say it has switched`
            : asking
              ? `${tab.title} — a pane in here is waiting on an answer`
              : tab.title
      }
      style={
        {
          ...(tint ? { '--tab-tint': tint } : {}),
          ...(tab.textColor ? { '--tab-text-tint': tab.textColor } : {})
        } as CSSProperties
      }
      // A tap selects; a swipe does not. A mouse still selects on the press,
      // as it always has — but a finger's `pointerdown` arrives at the *start*
      // of every gesture, including the sideways drag that scrolls this strip,
      // so selecting there picked whichever pill the thumb landed on, and moved
      // the desk's tab with it. `click` is the event a scroll does not produce
      // (the browser cancels the pointer once it pans), so a finger selects on
      // that — the same split `PaneView` makes for focus.
      //
      // Nothing at all on a link that cannot carry the request, exactly as the
      // header says: a strip that moved on a dropped socket would be claiming
      // the desk had agreed to something it has not been told about.
      onPointerDown={(e) => {
        pointerType.current = e.pointerType
        if (e.pointerType !== 'touch' && !active && !pending && live) onSelect()
      }}
      onClick={() => {
        const touched = pointerType.current === 'touch'
        pointerType.current = ''
        if (touched && !active && !pending && live) onSelect()
      }}
    >
      <div className="tab__badges">
        {badges.map((profile, index) => (
          <AgentBadge key={`${profile.id}-${index}`} profile={profile} size="sm" />
        ))}
        {leaves.length > 3 ? <span className="tab__more mono">+{leaves.length - 3}</span> : null}
      </div>

      {asking ? (
        <span className="tab__ask" aria-hidden="true">
          !
        </span>
      ) : null}
      <span className="tab__title truncate">{tab.title}</span>

      <button
        ref={closeBtnRef}
        type="button"
        className="ghost-btn tab__close"
        data-danger="true"
        title="Close tab"
        aria-label={`Close tab ${tab.title}`}
        onPointerDown={(e) => {
          e.stopPropagation()
        }}
        onClick={(e) => {
          e.stopPropagation()
          setConfirmOpen(true)
        }}
      >
        <Icon name="close" size={11} />
      </button>

      {confirmOpen ? (
        <Popover
          anchor={closeBtnRef.current}
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          align="center"
          side="bottom"
          width={240}
          label={`Confirm closing tab ${tab.title}`}
        >
          <div className="tab-confirm" onPointerDown={(e) => e.stopPropagation()}>
            <div className="tab-confirm__head">
              <span className="eyebrow tab-confirm__eyebrow">Close Tab</span>
            </div>
            <p className="tab-confirm__body">
              Close <strong className="tab-confirm__name truncate">“{tab.title}”</strong>?
            </p>
            <p className="tab-confirm__hint">
              Terminal processes in this tab will be terminated.
            </p>
            <div className="tab-confirm__actions">
              <button
                type="button"
                className="ghost-btn tab-confirm__cancel"
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmOpen(false)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ghost-btn tab-confirm__close"
                data-danger="true"
                autoFocus
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmOpen(false)
                  void actions.layout({ op: 'close-tab', tabId: tab.id })
                }}
              >
                Close tab
              </button>
            </div>
          </div>
        </Popover>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ helpers */

function activeLeafId(tab: TerminalTab): string | null {
  const leaves = collectLeaves(tab.root)
  return (leaves.find((leaf) => leaf.id === tab.activePaneId) ?? leaves[0])?.id ?? null
}

/** Distinct profiles, in pane order, at most three — a split of two shells is one grey dot, not two. */
function uniqueProfiles(profiles: AgentProfile[]): AgentProfile[] {
  const seen = new Set<string>()
  const out: AgentProfile[] = []
  for (const profile of profiles) {
    if (seen.has(profile.id)) continue
    seen.add(profile.id)
    out.push(profile)
  }
  return out.slice(0, 3)
}

function folderLeaf(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

/**
 * The words that tell twins apart: tab id → suffix, for tabs whose title is
 * shared with another. The folder leaf of the tab's active pane first; where
 * two twins share that too, their place among the twins ("2", "3").
 */
export function tabSuffixes(tabs: TerminalTab[], sessions: { id: string; cwd: string }[]): Map<string, string> {
  const byTitle = new Map<string, TerminalTab[]>()
  for (const tab of tabs) byTitle.set(tab.title, [...(byTitle.get(tab.title) ?? []), tab])
  const out = new Map<string, string>()
  for (const twins of byTitle.values()) {
    if (twins.length < 2) continue
    const leaves = twins.map((tab) => {
      const paneId = activeLeafId(tab)
      return folderLeaf(sessions.find((s) => s.id === paneId)?.cwd ?? '')
    })
    twins.forEach((tab, index) => {
      const leaf = leaves[index]
      const shared = !leaf || leaves.filter((other) => other === leaf).length > 1
      out.set(tab.id, shared ? (leaf ? `${leaf} ${index + 1}` : String(index + 1)) : leaf)
    })
  }
  return out
}

/**
 * What a long-press on a pill opens: the three things you might want to do to
 * a tab you are not necessarily in. Close tab asks first, in place, with the
 * safe answer focused — the same question the desktop-width strip asks.
 */
function TabSheet({
  tab,
  title,
  profiles,
  step,
  live,
  alive,
  projectName,
  onStep,
  onClose,
  onNewAgent,
  onHandoff,
  onCloseTab
}: {
  tab: TerminalTab | null
  title: string
  profiles: AgentProfile[]
  step: 'list' | 'close'
  live: boolean
  alive: (paneId: string) => boolean
  projectName: string
  onStep: (step: 'list' | 'close') => void
  onClose: () => void
  onNewAgent: () => void
  onHandoff: (tabId: string) => void
  onCloseTab: (tabId: string) => void
}): ReactNode {
  // Held while the sheet animates out, so the rows do not blank mid-exit.
  const last = useRef<{ tab: TerminalTab; title: string } | null>(null)
  if (tab) last.current = { tab, title }
  const shown = last.current
  if (!shown) return null

  const leaves = collectLeaves(shown.tab.root)
  const paneId = activeLeafId(shown.tab)
  const pane = leaves.find((leaf) => leaf.id === paneId) ?? null
  const profile = pane ? resolveProfile(profiles, pane.profileId) : null
  const isAgent = !!profile && !isShellProfile(profile)
  const canHandoff = isAgent && live && !!paneId && alive(paneId)
  const names = uniqueProfiles(leaves.map((leaf) => resolveProfile(profiles, leaf.profileId)))

  return (
    <BottomSheet
      open={!!tab}
      onClose={onClose}
      onBack={step === 'close' ? () => onStep('list') : undefined}
      label={step === 'close' ? `Close tab ${shown.title}` : `Tab ${shown.title}`}
      title={
        step === 'close' ? null : (
          <span className="tabsheet__title">
            <span className="tab__dots" aria-hidden="true">
              {names.map((p) => (
                <span key={p.id} className="tab__dot" style={{ background: p.accent }} />
              ))}
            </span>
            <span className="truncate">{shown.title}</span>
          </span>
        )
      }
      subtitle={step === 'close' ? undefined : names.map((p) => p.name).join(' + ')}
      testId="tab-sheet"
    >
      {step === 'close' ? (
        <SheetConfirm
          question={`Close “${shown.title}”?`}
          detail="Terminal processes in this tab will be terminated."
          confirmLabel="Close tab"
          onCancel={() => onStep('list')}
          onConfirm={() => onCloseTab(shown.tab.id)}
          testId="tab-close-confirm"
        />
      ) : (
        <SheetSection>
          <SheetRow
            icon={<Icon name="plus" size={20} />}
            label="New agent here"
            secondary={live ? `Open another agent in ${projectName}` : 'Needs a live link to the desktop'}
            disabled={!live}
            onClick={onNewAgent}
            testId="tab-sheet-new"
          />
          <SheetRow
            icon={<SheetGlyph name="handoff" />}
            label="Hand off"
            secondary={
              canHandoff
                ? 'Ask this agent to write a handoff pack for another'
                : !isAgent
                  ? 'Shells cannot hand off'
                  : !live
                    ? 'Needs a live link to the desktop'
                    : 'This pane has no session running'
            }
            disabled={!canHandoff}
            onClick={() => onHandoff(shown.tab.id)}
            testId="tab-sheet-handoff"
          />
          <SheetRow
            icon={<Icon name="close" size={20} />}
            label="Close tab"
            secondary="Ends the terminals in it. Asks first."
            tone="danger"
            onClick={() => onStep('close')}
            testId="tab-sheet-close"
          />
        </SheetSection>
      )}
    </BottomSheet>
  )
}
