import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  agentModels,
  effortLevels,
  effortRefusal,
  effortSlash,
  isShellProfile,
  modePickerSlash,
  modeRefusal,
  modelRefusal,
  modelSlash,
  permissionModes,
  permissionSpec,
  tabsToPermissionMode,
  type AgentModelSpec,
  type EffortLevel,
  type EffortLevelSpec,
  type PermissionModeSpec
} from '@shared/agents'
import type { AgentProfile, ClaudePermissionMode } from '@shared/types'
import { paneNameInTab } from '@shared/workspace'
import { resolveProfile } from '@/lib/agents'
import { usePaneUsage, type PaneUsage, type UsageWindow } from '@/lib/paneUsage'
import { findLeaf } from '@/lib/splitTree'
import { terminalHost } from '@/lib/terminals'
import { useActiveTab, useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { Popover } from '../Popover'
// The menu wears the voice agent picker's rows (.bpick__*): one menu style in the bar.
import './BrainPicker.css'
import './ModelPicker.css'

/**
 * The agent pane the bar is aimed at — what it runs, how much it has used,
 * and its model, effort and mode, changed in place.
 *
 * Two ways in, one menu:
 *  - the chip in the bar's row (ModelPicker): the model and effort, by name;
 *  - the strip under the row (UsageStrip): how full the context is and how
 *    close each plan-limit window is, at a glance. It is there only once the
 *    pane has reported numbers (lib/paneUsage), so with none the bar looks
 *    exactly as it did without it.
 *
 * The menu is the voice agent picker's (BrainPicker) — same shell, heading,
 * rows, tile and "current" mark — so the bar has one menu style. It reads,
 * top to bottom: the plan limits (each window by its true length, % used, a
 * bar, when it resets), this session (context, cost), then Model, Effort and
 * — when the pane's footer names its mode — Mode. Only windows the pane's CLI
 * really reports are shown; an API-key pane has none, and none are invented.
 *
 * It is placed against the whole bar, not the trigger: above the bar when the
 * bar sits at the bottom edge, below it when the bar is in the top bar, never
 * over the bar's own words. Its height is capped to the room on that side; a
 * long menu scrolls up and down inside it, never sideways.
 *
 * A pick is typed into the pane as its own slash command — `/model <id>`
 * (Gemini: `/model set <id>`) or `/effort <level>` — then Enter, the phone's
 * rhythm (web SessionComposer `sendModel` / `sendEffort`). A mode is walked
 * with Shift+Tab from the mode the footer shows (`sendMode`); Codex's opens
 * its own /permissions picker. The lists and the words come from
 * shared/agents.ts, so the phone and this menu offer the same rows.
 *
 * What is current: the CLI's own report when it is newer than a pick made
 * here, else the pick. The one in force carries a tick and the word
 * "current"; a limit near its end says so in words ("near limit", "almost
 * full", "full") — never a tint alone.
 *
 * A mouse press never takes focus: the bar or the pane keeps the keys. Opened
 * from the keyboard (Enter or Space on the chip or the strip), the menu takes
 * focus, the arrows move through its choices, Enter picks, Escape closes
 * without sending; focus then goes back to the bar.
 */

/** The Enter waits for the pane's echo of the command, then this much quiet. */
const ECHO_QUIET_MS = 150
/** The most the Enter waits: a pane that never goes quiet still gets it. */
const ECHO_MAX_MS = 1500
const ECHO_POLL_MS = 30
/** Shift+Tab, as the terminal sends it. */
const BACK_TAB = '\x1b[Z'
/** Between Shift+Tabs, so the TUI redraws each rung (the phone's beat). */
const BETWEEN_TABS_MS = 80

/** The menu's width — the voice agent picker's. */
const MENU_WIDTH = 336
/** Popover's gap to its anchor + its margin to the window edge + its border, with a little air. */
const MENU_CHROME = 6 + 8 + 2 + 8
/** Never shorter than this, however little room the window leaves. */
const MENU_MIN = 180
/** Numbers older than this say how old they are. */
const STALE_MS = 5 * 60_000

/**
 * Type a short slash command into a pane, then press Enter once the pane has
 * drawn it. Typed, not pasted: a slash command must reach the TUI as keys so
 * its own command box opens; the Enter goes as its own keystroke after the
 * echo, because one that arrives with the words reads as part of a paste and
 * the command sits in the box unsent.
 */
function typeSlash(paneId: string, command: string): boolean {
  if (!terminalHost.has(paneId) || terminalHost.runtime(paneId).status === 'exited') return false
  const before = terminalHost.readiness(paneId).outputBytes
  if (!terminalHost.type(paneId, command)) return false
  const started = performance.now()
  const tick = (): void => {
    const r = terminalHost.readiness(paneId)
    const echoed = r.outputBytes > before && r.quietForMs >= ECHO_QUIET_MS
    if (echoed || performance.now() - started >= ECHO_MAX_MS) {
      terminalHost.submit(paneId)
      return
    }
    window.setTimeout(tick, ECHO_POLL_MS)
  }
  window.setTimeout(tick, ECHO_POLL_MS)
  return true
}

/** Press Shift+Tab `times` times, a beat apart. Raw keys: they are not words in the draft. */
function pressBackTab(paneId: string, times: number): boolean {
  if (!terminalHost.has(paneId) || terminalHost.runtime(paneId).status === 'exited') return false
  for (let i = 0; i < times; i++) {
    window.setTimeout(() => {
      if (terminalHost.has(paneId) && terminalHost.runtime(paneId).status !== 'exited') {
        window.forge.pty.write(paneId, BACK_TAB)
      }
    }, i * BETWEEN_TABS_MS)
  }
  return true
}

/* ----------------------------------------------------- picks, per pane */

interface Picked {
  model?: string
  modelAt?: number
  effort?: EffortLevel
  effortAt?: number
}

/** What was picked here, per pane — shared by every bar that mounts a chip. */
const picks = new Map<string, Picked>()
let picksVersion = 0
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function remember(paneId: string, next: Picked): void {
  picks.set(paneId, { ...picks.get(paneId), ...next })
  picksVersion += 1
  for (const l of listeners) l()
}

function usePicked(paneId: string | null): Picked {
  useSyncExternalStore(subscribe, () => picksVersion)
  return (paneId ? picks.get(paneId) : undefined) ?? {}
}

/** A clock that ticks once a minute (or `ms`), so "resets in 3 h 12 m" stays true. */
function useNow(ms = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}

/* -------------------------------------------------------- words, numbers */

type Level = 'calm' | 'warn' | 'full'

/** The phone's thresholds (web/src/lib/usage.ts usageLevel): 80 warns, 92 is full. */
function levelOf(pct: number): Level {
  return pct >= 92 ? 'full' : pct >= 80 ? 'warn' : 'calm'
}

/** The level in words — the first signal; the colour is only the third. */
function levelWord(pct: number): string {
  if (pct >= 100) return 'full'
  if (pct >= 92) return 'almost full'
  if (pct >= 80) return 'near limit'
  return ''
}

function clampPct(pct: number): number {
  return Math.max(0, Math.min(100, Math.round(pct)))
}

/** `84k` / `1.2M` — tokens at a glance (the phone's fmtTokens). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(Math.round(n))
}

function fmtCost(usd: number): string {
  return `$${usd >= 100 ? usd.toFixed(0) : usd.toFixed(2)}`
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * When a window starts again, from epoch seconds: "resets in 3 h 12 m" within
 * a day, "resets Fri 14:00" within the week, "resets 12 Oct" beyond. `short`
 * is the strip's clipped form.
 */
function resetWords(resetsAt: number | undefined, now: number): { long: string; short: string } | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null
  const ms = resetsAt * 1000 - now
  if (ms <= 0) return { long: 'resets any moment', short: 'resetting' }
  const mins = Math.ceil(ms / 60_000)
  if (mins < 60) return { long: `resets in ${mins} m`, short: `${mins}m` }
  if (ms < 86_400_000) {
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return { long: `resets in ${h} h${m ? ` ${m} m` : ''}`, short: `${h}h${m ? ` ${m}m` : ''}` }
  }
  const at = new Date(resetsAt * 1000)
  if (ms < 6 * 86_400_000) {
    const day = at.toLocaleDateString('en-GB', { weekday: 'short' })
    return { long: `resets ${day} ${hhmm(at)}`, short: `${day} ${hhmm(at)}` }
  }
  const date = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return { long: `resets ${date}`, short: date }
}

function agoWords(at: number, now: number): string {
  const mins = Math.max(1, Math.round((now - at) / 60_000))
  return mins < 60 ? `${mins} m ago` : `${Math.round(mins / 60)} h ago`
}

/** "Opus 5.5 (1M context)" → "Opus 5.5". */
function bareModel(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '').trim()
}

/** The row the CLI's own model name stands for, by id or by name. */
function modelRow(models: AgentModelSpec[], live: string): AgentModelSpec | null {
  const name = bareModel(live).toLowerCase()
  return models.find((m) => m.id === live || m.label.toLowerCase() === name) ?? null
}

/** The footer's mode (src/lib/rich.ts PermissionMode) as a rung of the ladder. */
function liveRung(mode: string | undefined): ClaudePermissionMode | 'auto' | null {
  if (mode === 'default' || mode === 'plan' || mode === 'bypass') return mode
  if (mode === 'accept-edits') return 'acceptEdits'
  if (mode === 'auto') return 'auto'
  return null
}

/* ------------------------------------------------------- the pane, read */

interface PaneAgent {
  paneId: string
  paneName: string
  profile: AgentProfile
  command: string
  models: AgentModelSpec[]
  levels: EffortLevelSpec[]
  modes: PermissionModeSpec[]
  usage: PaneUsage | null
  /** The model row in force, when one matches. */
  model: AgentModelSpec | null
  /** The CLI's own name for its model when no row matches it. */
  modelName: string | null
  effort: EffortLevelSpec | null
  rung: ClaudePermissionMode | 'auto' | null
  /** "Opus 5.5 · High" — the chip's words. */
  face: string
}

/** The pane the bar aims at, as the chip and the strip both read it. Null: no chip. */
function usePaneAgent(): PaneAgent | null {
  const { state } = useApp()
  const tab = useActiveTab()
  const paneId = tab?.activePaneId ?? null
  const leaf = tab && paneId ? findLeaf(tab.root, paneId) : null
  const profile = leaf ? resolveProfile(state.settings.agentProfiles, leaf.profileId) : null
  const paneName = tab && leaf && profile ? paneNameInTab(tab, leaf.id) : null
  const command = profile && !isShellProfile(profile) ? profile.command : ''
  const picked = usePicked(paneId)
  const usage = usePaneUsage(command ? paneId : null)

  if (!paneId || !paneName || !profile || !command) return null
  const models = agentModels(command)
  const levels = effortLevels(command)
  if (models.length === 0 && levels.length === 0) return null

  // The CLI's report wins unless a pick made here is newer than it.
  const liveAt = usage?.at ?? 0
  const pickedModel = picked.model ? (models.find((m) => m.id === picked.model) ?? null) : null
  const liveModel = usage?.model ? modelRow(models, usage.model) : null
  const usePick = pickedModel && (picked.modelAt ?? 0) > liveAt
  const model = usePick ? pickedModel : (liveModel ?? (usage?.model ? null : pickedModel))
  const modelName = !model && usage?.model ? bareModel(usage.model) : null

  const pickedEffort = picked.effort ? (levels.find((l) => l.id === picked.effort) ?? null) : null
  const liveEffort = usage?.effort ? (levels.find((l) => l.id === usage.effort?.toLowerCase()) ?? null) : null
  const effort = pickedEffort && (picked.effortAt ?? 0) > liveAt ? pickedEffort : (liveEffort ?? pickedEffort)

  const face = [model?.label ?? modelName ?? 'Model', effort?.label].filter(Boolean).join(' · ')
  return {
    paneId,
    paneName,
    profile,
    command,
    models,
    levels,
    modes: permissionModes(command),
    usage,
    model,
    modelName,
    effort,
    rung: liveRung(usage?.mode),
    face
  }
}

/* ------------------------------------------------------ the menu, opened */

/** Where the open menu sits: against the bar, on the side with room, and how tall it may be. */
interface Placement {
  bar: HTMLElement
  side: 'top' | 'bottom'
  room: number
}

/**
 * Measured at the press. The bar clipped to the bottom edge opens its menu
 * upward; the bar in the top bar (`.dock[data-place='top']`) opens it
 * downward — Popover only flips bottom → top, so the side is chosen here.
 */
function placeAgainst(trigger: HTMLElement): Placement {
  const bar = trigger.closest<HTMLElement>('.comp') ?? trigger
  const side = trigger.closest('.dock')?.getAttribute('data-place') === 'top' ? 'bottom' : 'top'
  const r = bar.getBoundingClientRect()
  const vh = window.visualViewport?.height ?? window.innerHeight
  const space = side === 'top' ? r.top : vh - r.bottom
  return { bar, side, room: Math.max(MENU_MIN, Math.floor(space - MENU_CHROME)) }
}

/** One trigger's open state: placed against the bar, closed by a press elsewhere in it. */
function useAgentMenu(paneId: string | null, trigger: HTMLElement | null) {
  const [placed, setPlaced] = useState<Placement | null>(null)
  const byKeyboard = useRef(false)

  const close = useCallback((): void => {
    setPlaced(null)
    // Focus inside the menu (a keyboard pick, or Escape) goes back to the bar;
    // focus anywhere else — the bar, a pane, an outside click — stays put.
    const at = document.activeElement
    if (at === document.body || at === trigger || (at instanceof Element && at.closest('.apick'))) {
      const field = trigger?.closest('.comp')?.querySelector<HTMLElement>('.dock__field')
      ;(field ?? trigger)?.focus()
    }
  }, [trigger])

  // The pane changed under an open menu: its rows were for the old one.
  useEffect(() => setPlaced(null), [paneId])

  // The menu hangs off the whole bar, so Popover counts a press anywhere in
  // the bar as "inside". A press in the bar that is not on this trigger (the
  // words, another chip) still closes it; the trigger's own click toggles.
  useEffect(() => {
    if (!placed) return undefined
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (placed.bar.contains(t) && !trigger?.contains(t)) close()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [placed, trigger, close])

  const toggle = (e: React.MouseEvent<HTMLElement>): void => {
    byKeyboard.current = e.detail === 0
    if (placed) close()
    else setPlaced(placeAgainst(e.currentTarget))
  }

  return { placed, open: placed !== null, close, toggle, byKeyboard: byKeyboard.current }
}

/** The popover and its menu, for either trigger. */
function AgentMenuPopover({
  agent,
  trigger,
  menu
}: {
  agent: PaneAgent
  trigger: HTMLElement | null
  menu: ReturnType<typeof useAgentMenu>
}): ReactNode {
  const { actions } = useApp()
  const { paneId, command } = agent
  const placed = menu.placed

  const refuse = (): void => actions.setNotice('That pane has no live shell to send to')

  const sendSlash = (slash: string, next: Picked): void => {
    menu.close()
    if (!typeSlash(paneId, slash)) {
      refuse()
      return
    }
    if (next.model || next.effort) remember(paneId, next)
  }

  const sendMode = (to: ClaudePermissionMode): void => {
    const picker = modePickerSlash(command)
    if (picker) {
      sendSlash(picker, {})
      return
    }
    menu.close()
    const steps = tabsToPermissionMode(command, agent.rung, to)
    if (steps === null) {
      const spec = permissionSpec(command, to)
      actions.setNotice(
        agent.rung === null
          ? 'This pane has not printed its mode yet.'
          : spec
            ? `${spec.label} has to be chosen when the pane opens.`
            : modeRefusal(command)
      )
      return
    }
    if (steps > 0 && !pressBackTab(paneId, steps)) refuse()
  }

  return (
    <Popover
      anchor={placed?.bar ?? trigger}
      open={menu.open}
      onClose={menu.close}
      align="end"
      side={placed?.side ?? 'top'}
      width={MENU_WIDTH}
      label={`${agent.profile.name} in ${agent.paneName}`}
    >
      <AgentMenu
        agent={agent}
        side={placed?.side ?? 'top'}
        room={placed?.room ?? MENU_MIN}
        takeFocus={menu.byKeyboard}
        onModel={(id) => {
          const type = modelSlash(command)
          if (type) sendSlash(type(id), { model: id, modelAt: Date.now() })
        }}
        onEffort={(level) => {
          const type = effortSlash(command)
          if (type) sendSlash(type(level), { effort: level, effortAt: Date.now() })
        }}
        onMode={sendMode}
      />
    </Popover>
  )
}

/* ---------------------------------------------------------------- chip */

export function ModelPicker(): ReactNode {
  const agent = usePaneAgent()
  const [chip, setChip] = useState<HTMLButtonElement | null>(null)
  const menu = useAgentMenu(agent?.paneId ?? null, chip)

  const shown = useStripShown()

  if (!agent) return null
  const label = `${agent.profile.name} in ${agent.paneName}`
  const hasStrip = hasStripNumbers(agent.usage)

  return (
    <>
      <button
        ref={setChip}
        type="button"
        className="apick-chip"
        data-open={menu.open ? 'true' : undefined}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-label={`Change model or effort for ${agent.paneName} (now: ${agent.face})`}
        title={`${label} — change model or effort`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={menu.toggle}
      >
        <span className="apick-chip__tile" aria-hidden="true">
          {agent.model ? monogram(agent.model.label) : agent.modelName ? monogram(agent.modelName) : <Icon name="sparkle" size={10} />}
        </span>
        <span className="apick-chip__face truncate">{agent.face}</span>
        <Icon name="chevronDown" size={11} className="apick-chip__chev" />
      </button>
      {hasStrip ? (
        // Down = fold the strip away below; up = bring it back. A shape, not a colour.
        <button
          type="button"
          className="apick-toggle"
          data-shown={shown ? 'true' : 'false'}
          aria-pressed={shown}
          aria-label={shown ? 'Hide the usage line under the bar' : 'Show the usage line under the bar'}
          title={shown ? 'Hide usage' : 'Show usage'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setStripShown(!shown)}
        >
          <Icon name="chevronDown" size={11} className="apick-toggle__chev" />
        </button>
      ) : null}
      <AgentMenuPopover agent={agent} trigger={chip} menu={menu} />
    </>
  )
}

/* --------------------------------------------------------------- strip */

interface StripItem {
  key: string
  label: string
  pct: number
  reset: string | null
  /** 0 stays longest as the bar narrows: the most-used window, then context, then the rest. */
  rank: number
}

const STRIP_KEY = 'forge.bar.usageStrip'

/** Shown unless Steve hid it. A per-viewer convenience, so storage that will not answer means shown. */
function readStripShown(): boolean {
  try {
    return localStorage.getItem(STRIP_KEY) !== 'hidden'
  } catch {
    return true
  }
}

function saveStripShown(shown: boolean): void {
  try {
    localStorage.setItem(STRIP_KEY, shown ? 'shown' : 'hidden')
  } catch {
    /* nothing to remember it with; it is back next time */
  }
}

/* The chip's toggle and the strip read one answer, so it lives outside both. */
let stripShown = readStripShown()
const stripListeners = new Set<() => void>()

function setStripShown(next: boolean): void {
  stripShown = next
  saveStripShown(next)
  for (const l of stripListeners) l()
}

function subscribeStrip(cb: () => void): () => void {
  stripListeners.add(cb)
  return () => {
    stripListeners.delete(cb)
  }
}

function useStripShown(): boolean {
  return useSyncExternalStore(subscribeStrip, () => stripShown, () => true)
}

/** Does the pane have any number for the strip to show? */
function hasStripNumbers(usage: PaneUsage | null): boolean {
  return Boolean(usage && (usage.context || usage.windows.length > 0 || typeof usage.costUsd === 'number'))
}

/**
 * Under the bar's row: how full the pane's context is and how close each
 * plan-limit window is, in words and a small bar each, and the session's
 * cost. One press (or Enter / Space) opens the menu with the whole story.
 * Nothing at all until the pane has reported numbers.
 *
 * A small chevron beside the Model chip hides it (nothing is left under the
 * bar) and brings it back. The choice is remembered, and the chip's menu
 * shows the same numbers either way.
 *
 * As the bar narrows, the least pressing go first — reset times, then cost,
 * then the other windows, then context — and the most-used window stays.
 */
export function UsageStrip(): ReactNode {
  const agent = usePaneAgent()
  const [strip, setStrip] = useState<HTMLButtonElement | null>(null)
  const menu = useAgentMenu(agent?.paneId ?? null, strip)
  const now = useNow()
  const shown = useStripShown()

  const usage = agent?.usage
  if (!agent || !usage) return null
  const { context, windows, costUsd } = usage
  if (!context && windows.length === 0 && typeof costUsd !== 'number') return null

  const most = windows.reduce<UsageWindow | null>((top, w) => (!top || w.usedPct > top.usedPct ? w : top), null)
  const items: StripItem[] = []
  if (context) items.push({ key: 'context', label: 'Context', pct: clampPct(context.usedPct), reset: null, rank: most ? 1 : 0 })
  for (const w of windows) {
    items.push({
      key: `w${w.minutes}`,
      label: w.label,
      pct: clampPct(w.usedPct),
      reset: resetWords(w.resetsAt, now)?.short ?? null,
      rank: w === most ? 0 : 2
    })
  }

  const summary = [
    ...items.map((it) => `${it.label} ${it.pct}% used${levelWord(it.pct) ? `, ${levelWord(it.pct)}` : ''}`),
    typeof costUsd === 'number' ? `session cost ${fmtCost(costUsd)}` : null
  ]
    .filter(Boolean)
    .join('; ')

  // Hidden: nothing under the bar at all. The chip's chevron brings it back.
  if (!shown) return null

  return (
    <>
      <button
        ref={setStrip}
        type="button"
        className="ustrip"
        data-open={menu.open ? 'true' : undefined}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-label={`${agent.paneName}: ${summary}. Open details`}
        title={`${agent.profile.name} in ${agent.paneName} — usage, model, effort`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={menu.toggle}
      >
        {items.map((it) => (
          <span
            key={it.key}
            className="ustrip__item"
            data-rank={it.rank}
            data-level={levelOf(it.pct)}
            data-sec={it.key === 'context' ? 'session' : 'plan'}
            aria-hidden="true"
          >
            <span className="ustrip__label">{it.label}</span>
            <span className="ustrip__bar">
              <span style={{ width: `${it.pct}%` }} />
            </span>
            <span className="ustrip__pct">{it.pct}%</span>
            {levelWord(it.pct) ? <span className="ustrip__word">{levelWord(it.pct)}</span> : null}
            {it.reset ? <span className="ustrip__reset">{it.reset}</span> : null}
          </span>
        ))}
        {typeof costUsd === 'number' ? (
          <span className="ustrip__item" data-rank={3} data-sec="session" aria-hidden="true">
            <span className="ustrip__label">Session</span>
            <span className="ustrip__pct">{fmtCost(costUsd)}</span>
          </span>
        ) : null}
        <span className="ustrip__more" aria-hidden="true">
          <span className="ustrip__more-word">Details</span>
          <Icon name="chevronDown" size={11} className="ustrip__chev" />
        </span>
      </button>
      <AgentMenuPopover agent={agent} trigger={strip} menu={menu} />
    </>
  )
}

/* ---------------------------------------------------------------- menu */

const ITEMS = '[role^="menuitem"]:not(:disabled)'

function AgentMenu({
  agent,
  side,
  room,
  takeFocus,
  onModel,
  onEffort,
  onMode
}: {
  agent: PaneAgent
  side: 'top' | 'bottom'
  room: number
  takeFocus: boolean
  onModel: (id: string) => void
  onEffort: (level: EffortLevel) => void
  onMode: (mode: ClaudePermissionMode) => void
}): ReactNode {
  const { command, models, levels, modes, usage, paneName } = agent
  const ref = useRef<HTMLDivElement | null>(null)
  const now = useNow()
  const canModel = models.length > 0 && modelSlash(command) !== null
  const canEffort = levels.length > 0 && effortSlash(command) !== null
  const picker = modePickerSlash(command)
  // Mode only when the footer names it: a guessed starting rung would walk
  // Shift+Tab to the wrong place.
  const showMode = Boolean(usage?.mode) && modes.length > 0

  // From the keyboard: onto the current pick, else the first row. The popover
  // is placed a frame after it mounts, and a hidden button cannot take focus
  // before that.
  useEffect(() => {
    if (!takeFocus) return undefined
    const raf = window.requestAnimationFrame(() => {
      const root = ref.current
      const here = root?.querySelector<HTMLButtonElement>(`[aria-checked="true"]:not(:disabled)`)
      ;(here ?? root?.querySelector<HTMLButtonElement>(ITEMS))?.focus()
    })
    return () => window.cancelAnimationFrame(raf)
  }, [takeFocus])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(ITEMS) ?? [])
    if (items.length === 0) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : e.key === 'ArrowDown'
            ? (i + 1) % items.length
            : (i <= 0 ? items.length : i) - 1
    items[next]?.focus()
  }

  const stale = usage && now - usage.at > STALE_MS ? `as of ${agoWords(usage.at, now)}` : null
  const hasSession = Boolean(usage?.context) || typeof usage?.costUsd === 'number'
  const modeWord =
    agent.rung === 'auto' ? 'Auto' : agent.rung ? (permissionSpec(command, agent.rung)?.label ?? null) : null

  return (
    <div
      ref={ref}
      className="apick"
      data-side={side}
      style={{ maxHeight: room }}
      onKeyDown={onKeyDown}
      // A click picks without taking focus from the bar or the pane.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="bpick__head">
        <span className="eyebrow truncate">{agent.profile.name}</span>
        <span className="bpick__hint apick__hint truncate">sends to {paneName}</span>
      </div>

      {usage && usage.windows.length > 0 ? (
        <section className="apick__section" data-sec="plan" aria-label="Plan limits">
          <div className="apick__label">
            <span className="apick__label-name">Plan limits</span>
            {stale ? <span className="apick__label-hint">{stale}</span> : null}
          </div>
          {usage.windows.map((w) => (
            <Meter
              key={w.minutes}
              label={w.label}
              pct={clampPct(w.usedPct)}
              sub={resetWords(w.resetsAt, now)?.long ?? null}
            />
          ))}
        </section>
      ) : null}

      {usage && hasSession ? (
        <section className="apick__section" data-sec="session" aria-label="This session">
          <div className="apick__label">
            <span className="apick__label-name">This session</span>
            {stale && usage.windows.length === 0 ? <span className="apick__label-hint">{stale}</span> : null}
          </div>
          {usage.context ? (
            <Meter
              label="Context"
              pct={clampPct(usage.context.usedPct)}
              sub={
                usage.context.usedTokens !== undefined && usage.context.windowTokens
                  ? `${fmtTokens(usage.context.usedTokens)} of ${fmtTokens(usage.context.windowTokens)} tokens`
                  : `${100 - clampPct(usage.context.usedPct)}% left before the window is full`
              }
            />
          ) : null}
          {typeof usage.costUsd === 'number' ? (
            <div className="apick__stat">
              <span className="apick__meter-label">Cost so far</span>
              <span className="apick__stat-value">{fmtCost(usage.costUsd)}</span>
            </div>
          ) : null}
        </section>
      ) : null}

      {usage && (usage.windows.length > 0 || hasSession) ? <div className="popover__divider" /> : null}

      <div className="apick__menu" role="menu" aria-label={`Model, effort and mode for ${paneName}`}>
        <div className="apick__group" data-sec="model" role="group" aria-label="Model">
          <div className="apick__label" aria-hidden="true">
            <span className="apick__label-name">Model</span>
            {agent.modelName ? <span className="apick__label-hint truncate">now {agent.modelName}</span> : null}
          </div>
          {canModel ? (
            models.map((m) => (
              <Row
                key={m.id}
                tile={monogram(m.label)}
                label={m.label}
                note={m.note}
                current={m.id === agent.model?.id}
                onPick={() => onModel(m.id)}
              />
            ))
          ) : (
            <p className="apick__refusal">{modelRefusal(command)}</p>
          )}
        </div>

        <div className="popover__divider" />

        <div className="apick__group" data-sec="effort" role="group" aria-label="Effort">
          <div className="apick__label" aria-hidden="true">
            <span className="apick__label-name">Effort</span>
          </div>
          {canEffort ? (
            levels.map((l, i) => (
              <Row
                key={l.id}
                tile={<EffortBars level={i + 1} of={levels.length} />}
                label={l.label}
                note={l.note}
                current={l.id === agent.effort?.id}
                onPick={() => onEffort(l.id)}
              />
            ))
          ) : (
            <p className="apick__refusal">{effortRefusal(command)}</p>
          )}
        </div>

        {showMode ? (
          <>
            <div className="popover__divider" />
            <div className="apick__group" data-sec="mode" role="group" aria-label="Mode">
              <div className="apick__label" aria-hidden="true">
                <span className="apick__label-name">Mode</span>
                {modeWord && !modes.some((m) => m.id === agent.rung) ? (
                  <span className="apick__label-hint">now {modeWord}</span>
                ) : null}
              </div>
              {modes.map((m) => {
                const current = m.id === agent.rung
                const reachable = picker !== null || current || tabsToPermissionMode(command, agent.rung, m.id) !== null
                return (
                  <Row
                    key={m.id}
                    tile={monogram(m.label)}
                    label={m.label}
                    note={
                      reachable
                        ? picker
                          ? `${m.note} — opens ${picker}`
                          : m.note
                        : 'only when the pane opens'
                    }
                    current={current}
                    disabled={!reachable}
                    onPick={() => onMode(m.id)}
                  />
                )
              })}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

/**
 * One reading: its name, "% used" and — near the end — the word for it, a
 * bar, and a line under it (when it resets, or tokens). A progressbar to a
 * screen reader, with the words as its value.
 */
function Meter({ label, pct, sub }: { label: string; pct: number; sub: string | null }): ReactNode {
  const word = levelWord(pct)
  const said = `${pct}% used${word ? `, ${word}` : ''}`
  return (
    <div
      className="apick__meter"
      data-level={levelOf(pct)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={sub ? `${said}; ${sub}` : said}
    >
      <div className="apick__meter-head">
        <span className="apick__meter-label">{label}</span>
        <span className="apick__meter-pct">
          {pct}% used
          {word ? <span className="apick__meter-word">{word}</span> : null}
        </span>
      </div>
      <span className="apick__meter-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
      {sub ? <span className="apick__meter-sub">{sub}</span> : null}
    </div>
  )
}

/**
 * One choice, in the voice agent picker's row: a round tile, the name over
 * its note, and — on the one in force — a tick and the word "current". The
 * tile inverts for it too: a shape, not only a tint. One that cannot be
 * reached from here gets the dashed, empty tile and says why.
 */
function Row({
  tile,
  label,
  note,
  current,
  disabled = false,
  onPick
}: {
  tile: ReactNode
  label: string
  note: string
  current: boolean
  disabled?: boolean
  onPick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={current}
      className="popover__row bpick__row apick__row"
      data-selected={current ? 'true' : undefined}
      disabled={disabled}
      onClick={onPick}
    >
      <span
        className="bpick__tile apick__tile"
        data-look={current ? 'use' : disabled ? 'off' : undefined}
        aria-hidden="true"
      >
        {tile}
      </span>
      <span className="bpick__text">
        <span className="bpick__name">{label}</span>
        <span className="bpick__sub">{note}</span>
      </span>
      {current ? (
        <span className="bpick__state" data-tone="use">
          current
          <Icon name="check" size={12} className="bpick__check" />
        </span>
      ) : null}
    </button>
  )
}

/** A model's tile: the first letter of its name — Fable F, Opus O, Sonnet S. */
function monogram(label: string): string {
  return label.trim().charAt(0).toUpperCase()
}

/**
 * An effort's tile: a rising row of bars, as many lit as the level is high —
 * the level reads by shape, whatever the colours.
 */
function EffortBars({ level, of }: { level: number; of: number }): ReactNode {
  const W = 14
  const H = 12
  const bar = 2
  const step = of > 1 ? (W - bar) / (of - 1) : 0
  return (
    <svg className="apick__bars" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {Array.from({ length: of }, (_, i) => {
        const h = of > 1 ? 3 + ((H - 3) * i) / (of - 1) : H
        return (
          <rect
            key={i}
            x={i * step}
            y={H - h}
            width={bar}
            height={h}
            rx={0.75}
            fill="currentColor"
            opacity={i < level ? 1 : 0.28}
          />
        )
      })}
    </svg>
  )
}
