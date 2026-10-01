import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import { agentLogoFor } from '@shared/agent-logos'
import type { ClaudePermissionMode } from '@shared/types'
import {
  effortRefusal,
  effortSlash,
  matchAgentModel,
  modePickerSlash,
  modelRefusal,
  modelSlash,
  permissionSpec,
  tabsToPermissionMode,
  type AgentModelSpec,
  type EffortLevel,
  type EffortLevelSpec,
  type PermissionModeSpec
} from '@shared/agents'
import { sortWindows, windowLabel, type UsageWindow } from '@shared/usage-windows'
import { Icon } from '@/components/Icon'
import { Popover } from '@/components/Popover'
import type { PaneStatus } from '@/lib/rich'
import { fmtTokens, usePaneUsage, usePaneUsageFrame } from '../lib/usage'
import './agentpicker.css'

/**
 * The deck bar's agent picker, drawn as the desktop bar's (src/components/hub/
 * ModelPicker.tsx, root class `apick`): one chip in the bar's row with the
 * model and effort by name, a quiet usage line under the row, and one menu
 * behind both — plan limits, this session, then Model, Effort and Mode.
 *
 * The same sections in the same colours: plan limits blue, this session cyan,
 * model violet, effort gold, mode pink — the blue-to-yellow run a red-green
 * colourblind eye keeps. The pick in force is a shape first: a bar at the
 * row's left edge, a solid haloed tile, the name bold and a size up, a tick and
 * the word "current". A limit near its end says so in words ("near limit",
 * "almost full", "full") and changes its fill's pattern (amber stripes at 80%,
 * a dense dark-red hatch at 92%).
 *
 * Only what this browser already has: the pane's screen (model, mode) and the
 * desktop's `usage` frame (context, every plan-limit window, the model and
 * effort the CLI reports, the session's cost). A pane with no frame shows no
 * usage — nothing is guessed. The picks themselves go out through
 * SessionComposer's own `sendModel` / `sendEffort` / `sendMode`, unchanged.
 *
 * Its own `dk-apick` names, never the desktop's: the menu is portalled to
 * <body>, outside the deck root, and a global name can collide (the desktop's
 * `.modelpick` once squashed a menu into one clipped row).
 */

/** The menu's width — the desktop's. */
const MENU_WIDTH = 336
/** Popover's gap to its anchor + its margin to the window edge + its border, with a little air. */
const MENU_CHROME = 6 + 8 + 2 + 8
/** Never shorter than this, however little room the window leaves. */
const MENU_MIN = 180
/** Numbers older than this say how old they are. */
const STALE_MS = 5 * 60_000
/** Claude Code's two windows, as the older `limits` slots name them. */
const FIVE_HOURS = 300
const ONE_WEEK = 10080

/* ----------------------------------------------------- picks, per pane */

interface Picked {
  model?: string
  modelAt?: number
  effort?: EffortLevel
  effortAt?: number
}

/** What was picked here, per pane: no CLI echoes a pick at once, so it stands in until one does. */
const picks = new Map<string, Picked>()
let picksVersion = 0
const pickListeners = new Set<() => void>()

function subscribePicks(cb: () => void): () => void {
  pickListeners.add(cb)
  return () => {
    pickListeners.delete(cb)
  }
}

function remember(paneId: string, next: Picked): void {
  picks.set(paneId, { ...picks.get(paneId), ...next })
  picksVersion += 1
  for (const l of pickListeners) l()
}

function forgetModelPick(paneId: string): void {
  const had = picks.get(paneId)
  if (!had?.model) return
  picks.set(paneId, { ...had, model: undefined, modelAt: undefined })
  picksVersion += 1
  for (const l of pickListeners) l()
}

function usePicked(paneId: string): Picked {
  useSyncExternalStore(subscribePicks, () => picksVersion, () => picksVersion)
  return picks.get(paneId) ?? {}
}

/* ------------------------------------------------ the usage line, shown */

const STRIP_KEY = 'forge.deck.usageStrip'

/** Shown unless Steve hid it. A per-viewer convenience: storage that will not answer means shown. */
function readStripShown(): boolean {
  try {
    return window.localStorage.getItem(STRIP_KEY) !== 'hidden'
  } catch {
    return true
  }
}

let stripShown = typeof window === 'undefined' ? true : readStripShown()
const stripListeners = new Set<() => void>()

function setStripShown(next: boolean): void {
  stripShown = next
  try {
    window.localStorage.setItem(STRIP_KEY, next ? 'shown' : 'hidden')
  } catch {
    // Nothing to remember it with; it is back next time.
  }
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

/** A clock that ticks once a minute, so "resets in 3 h 12 m" stays true. Nothing is drawn by it. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

/* -------------------------------------------------------- words, numbers */

type Level = 'calm' | 'warn' | 'full'

/** The phone's thresholds (lib/usage.ts usageLevel): 80 warns, 92 is full. */
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

function fmtCost(usd: number): string {
  return `$${usd >= 100 ? usd.toFixed(0) : usd.toFixed(2)}`
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** When a window starts again, from epoch seconds — the desktop's words; `short` is the line's. */
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

/** A model's tile: the first letter of its name — Fable F, Opus O, Sonnet S. */
function monogram(label: string): string {
  return label.trim().charAt(0).toUpperCase()
}

/* ---------------------------------------------------------------- picker */

export interface DeckPickerProps {
  paneId: string
  /** The terminal's one name — "Zeb". */
  paneName: string
  /** What runs in it — "Claude Code". */
  agentName: string
  command: string
  models: AgentModelSpec[]
  levels: EffortLevelSpec[]
  modes: PermissionModeSpec[]
  /** The pane's own screen, read (lib/pane-status.ts). */
  status: PaneStatus | undefined
  /** The model row the screen names, when one matches. */
  currentModelId: string | null
  /** The mode the screen names; `auto` is Claude's extra rung. */
  rung: ClaudePermissionMode | 'auto' | null
  disabled: boolean
  onModel: (id: string) => void
  onEffort: (level: EffortLevel) => void
  onMode: (mode: ClaudePermissionMode) => void
}

/**
 * The chip, its usage line, and the one menu behind both. Each lands in its
 * own cell of the bar's grid (voicebar.css): the chip beside the words, the
 * line under the row. With no numbers from the desktop yet, the line is not
 * there and the bar is one row, as before.
 */
export function DeckAgentPicker(props: DeckPickerProps): ReactNode {
  const { paneId, paneName, agentName, command, models, levels, modes, status, currentModelId, rung, disabled } = props
  const usage = usePaneUsage(paneId, status)
  const frame = usePaneUsageFrame(paneId)
  const picked = usePicked(paneId)
  const shown = useStripShown()
  const now = useNow()
  const [chip, setChip] = useState<HTMLButtonElement | null>(null)
  const [strip, setStrip] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState<{ from: 'chip' | 'strip'; room: number; keyboard: boolean } | null>(null)

  // The screen named a new model: a pick made here was only standing in for it.
  useEffect(() => forgetModelPick(paneId), [paneId, currentModelId])
  // The pane changed under an open menu: its rows were for the old one.
  useEffect(() => setOpen(null), [paneId])

  // What is current: a pick made here while it is newer than the desktop's
  // reading, else the reading (the frame, then the screen), else the pick.
  const liveAt = frame?.at ?? 0
  const pickedModel = picked.model ? (models.find((m) => m.id === picked.model) ?? null) : null
  const frameModel = frame?.model ? matchAgentModel(models, bareModel(frame.model)) : null
  const screenModel = currentModelId ? (models.find((m) => m.id === currentModelId) ?? null) : null
  const model =
    pickedModel && (picked.modelAt ?? 0) > liveAt ? pickedModel : (frameModel ?? screenModel ?? pickedModel)
  const modelName = model ? null : frame?.model ? bareModel(frame.model) : (status?.model ?? null)

  const pickedEffort = picked.effort ? (levels.find((l) => l.id === picked.effort) ?? null) : null
  const liveEffort = frame?.effort ? (levels.find((l) => l.id === frame.effort?.toLowerCase()) ?? null) : null
  const effort = pickedEffort && (picked.effortAt ?? 0) > liveAt ? pickedEffort : (liveEffort ?? pickedEffort)

  const face = [model?.label ?? modelName ?? 'Model', effort?.label].filter(Boolean).join(' · ')

  // Every plan-limit window by its true length; an older desktop's two slots
  // when that is all there is.
  const windows: UsageWindow[] = frame?.windows?.length
    ? sortWindows(frame.windows)
    : [
        ...(usage.limits?.fiveHour ? [{ minutes: FIVE_HOURS, label: windowLabel(FIVE_HOURS), ...usage.limits.fiveHour }] : []),
        ...(usage.limits?.week ? [{ minutes: ONE_WEEK, label: windowLabel(ONE_WEEK), ...usage.limits.week }] : [])
      ]
  const context = usage.context
  const costUsd = typeof frame?.costUsd === 'number' ? frame.costUsd : null
  const hasNumbers = Boolean(context || windows.length || costUsd !== null)

  const close = useCallback((): void => {
    setOpen(null)
    // Focus inside the menu (a keyboard pick, or Escape) goes back to the words.
    const at = document.activeElement
    if (at === document.body || (at instanceof Element && at.closest('.dk-apick'))) {
      chip?.closest('.composer__card')?.querySelector<HTMLElement>('.composer__input')?.focus()
    }
  }, [chip])

  const card = chip?.closest<HTMLElement>('.composer__card') ?? null

  // The menu hangs off the whole bar, so Popover counts a press anywhere in the
  // bar as inside. A press in the bar that is not on this trigger still closes it.
  useEffect(() => {
    if (!open || !card) return undefined
    const trigger = open.from === 'chip' ? chip : strip
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (card.contains(t) && !trigger?.contains(t)) close()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open, card, chip, strip, close])

  const toggle = (from: 'chip' | 'strip') => (e: MouseEvent<HTMLButtonElement>) => {
    if (open) {
      close()
      return
    }
    const top = (card ?? e.currentTarget).getBoundingClientRect().top
    setOpen({ from, room: Math.max(MENU_MIN, Math.floor(top - MENU_CHROME)), keyboard: e.detail === 0 })
  }

  const most = windows.reduce<UsageWindow | null>((top, w) => (!top || w.usedPct > top.usedPct ? w : top), null)
  const items = [
    ...(context ? [{ key: 'context', label: 'Context', pct: clampPct(context.usedPct), reset: null, rank: most ? 1 : 0, sec: 'session' }] : []),
    ...windows.map((w) => ({
      key: `w${w.minutes}`,
      label: w.label,
      pct: clampPct(w.usedPct),
      reset: resetWords(w.resetsAt, now)?.short ?? null,
      rank: w === most ? 0 : 2,
      sec: 'plan'
    }))
  ]
  // The mode the pane's own screen names, as a word on the usage line.
  const modeWord = rung === 'auto' ? 'Auto' : rung ? (modes.find((m) => m.id === rung)?.label ?? null) : null
  // Whose agent it is: the maker's own mark on the chip (shared/agent-logos.ts).
  const logo = agentLogoFor({ id: '', command, kind: 'agent' })
  const maker = logo && logo.key !== 'shell' ? logo : null
  const summary = [
    ...items.map((it) => `${it.label} ${it.pct}% used${levelWord(it.pct) ? `, ${levelWord(it.pct)}` : ''}`),
    costUsd !== null ? `session cost ${fmtCost(costUsd)}` : null,
    modeWord ? `mode ${modeWord}` : null
  ]
    .filter(Boolean)
    .join('; ')

  return (
    <>
      <span className="dk-apick-slot">
        <button
          ref={setChip}
          type="button"
          className="dk-apick-chip"
          data-open={open ? 'true' : undefined}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open !== null}
          aria-label={`Change model, effort or mode for ${paneName} (now: ${face})`}
          title={`${agentName} in ${paneName} — model, effort, mode and usage`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggle('chip')}
        >
          {maker ? (
            <span
              className="dk-apick-chip__tile dk-mplate"
              style={
                maker.color
                  ? ({ '--logo-on-dark': maker.color.dark, '--logo-on-light': maker.color.light } as CSSProperties)
                  : undefined
              }
              aria-hidden="true"
            >
              <svg width="11" height="11" viewBox={maker.viewBox} fill="currentColor" aria-hidden="true">
                {maker.paths.map((path, i) => (
                  <path key={i} d={path.d} fillRule={maker.evenOdd ? 'evenodd' : undefined} />
                ))}
              </svg>
            </span>
          ) : (
            <span className="dk-apick-chip__tile" aria-hidden="true">
              {model ? monogram(model.label) : modelName ? monogram(modelName) : <Icon name="sparkle" size={10} />}
            </span>
          )}
          <span className="dk-apick-chip__face">{face}</span>
          <Icon name="chevronDown" size={11} className="dk-apick-chip__chev" />
        </button>
        {hasNumbers ? (
          // Down tucks the usage line away under the bar; up brings it back. A shape, not a colour.
          <button
            type="button"
            className="dk-apick-toggle"
            data-shown={shown ? 'true' : 'false'}
            aria-pressed={shown}
            aria-label={shown ? 'Hide the usage line under the bar' : 'Show the usage line under the bar'}
            title={shown ? 'Hide usage' : 'Show usage'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setStripShown(!shown)}
          >
            <Icon name="chevronDown" size={11} className="dk-apick-toggle__chev" />
          </button>
        ) : null}
      </span>

      {hasNumbers && shown ? (
        <button
          ref={setStrip}
          type="button"
          className="dk-ustrip"
          data-open={open?.from === 'strip' ? 'true' : undefined}
          aria-haspopup="menu"
          aria-expanded={open?.from === 'strip'}
          aria-label={`${paneName}: ${summary}. Open details`}
          title={`${agentName} in ${paneName} — usage, model, effort`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggle('strip')}
        >
          {items.map((it) => (
            <span
              key={it.key}
              className="dk-ustrip__item"
              data-rank={it.rank}
              data-level={levelOf(it.pct)}
              data-sec={it.sec}
              aria-hidden="true"
            >
              <span className="dk-ustrip__label">{it.label}</span>
              <span className="dk-ustrip__bar">
                <span style={{ width: `${it.pct}%` }} />
              </span>
              <span className="dk-ustrip__pct">{it.pct}%</span>
              {levelWord(it.pct) ? <span className="dk-ustrip__word">{levelWord(it.pct)}</span> : null}
              {it.reset ? <span className="dk-ustrip__reset">{it.reset}</span> : null}
            </span>
          ))}
          {costUsd !== null ? (
            <span className="dk-ustrip__item" data-rank={3} data-sec="session" aria-hidden="true">
              <span className="dk-ustrip__label">Session</span>
              <span className="dk-ustrip__pct">{fmtCost(costUsd)}</span>
            </span>
          ) : null}
          {modeWord ? (
            <span className="dk-ustrip__item" data-rank={3} data-sec="mode" aria-hidden="true">
              <span className="dk-ustrip__label">Mode</span>
              <span className="dk-ustrip__val">{modeWord}</span>
            </span>
          ) : null}
          <span className="dk-ustrip__more" aria-hidden="true">
            <span className="dk-ustrip__more-word">Details</span>
            <Icon name="chevronDown" size={11} className="dk-ustrip__chev" />
          </span>
        </button>
      ) : null}

      <Popover
        anchor={card ?? chip}
        open={open !== null}
        onClose={close}
        align="end"
        side="top"
        width={MENU_WIDTH}
        label={`${agentName} in ${paneName}`}
      >
        {open ? (
          <PickerMenu
            {...props}
            room={open.room}
            takeFocus={open.keyboard}
            model={model}
            modelName={modelName}
            effort={effort}
            windows={windows}
            context={context}
            costUsd={costUsd}
            stale={frame && now - frame.at > STALE_MS ? `as of ${agoWords(frame.at, now)}` : null}
            now={now}
            onPickModel={(id) => {
              close()
              if (modelSlash(props.command)) remember(paneId, { model: id, modelAt: Date.now() })
              props.onModel(id)
            }}
            onPickEffort={(level) => {
              close()
              if (effortSlash(props.command)) remember(paneId, { effort: level, effortAt: Date.now() })
              props.onEffort(level)
            }}
            onPickMode={(mode) => {
              close()
              props.onMode(mode)
            }}
          />
        ) : null}
      </Popover>
    </>
  )
}

/* ---------------------------------------------------------------- menu */

const ITEMS = '[role^="menuitem"]:not(:disabled)'

function PickerMenu({
  paneName,
  agentName,
  command,
  models,
  levels,
  modes,
  rung,
  room,
  takeFocus,
  model,
  modelName,
  effort,
  windows,
  context,
  costUsd,
  stale,
  now,
  onPickModel,
  onPickEffort,
  onPickMode
}: DeckPickerProps & {
  room: number
  takeFocus: boolean
  model: AgentModelSpec | null
  modelName: string | null
  effort: EffortLevelSpec | null
  windows: UsageWindow[]
  context: { usedPct: number; usedTokens?: number; windowTokens?: number } | null
  costUsd: number | null
  stale: string | null
  now: number
  onPickModel: (id: string) => void
  onPickEffort: (level: EffortLevel) => void
  onPickMode: (mode: ClaudePermissionMode) => void
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  const canModel = models.length > 0 && modelSlash(command) !== null
  const canEffort = levels.length > 0 && effortSlash(command) !== null
  const picker = modePickerSlash(command)
  // Mode only when the screen names it: a guessed starting rung would walk
  // Shift+Tab to the wrong place. An agent with its own mode pop-up (Codex's
  // /permissions) needs no starting rung, so it always gets the row.
  const showMode = (rung !== null || picker !== null) && modes.length > 0
  const hasSession = Boolean(context) || costUsd !== null
  const modeWord = rung === 'auto' ? 'Auto' : rung ? (permissionSpec(command, rung)?.label ?? null) : null

  // From the keyboard: onto the current pick, else the first row. The popover
  // is placed a frame after it mounts, and a hidden button cannot take focus before that.
  useEffect(() => {
    if (!takeFocus) return undefined
    const raf = window.requestAnimationFrame(() => {
      const root = ref.current
      const here = root?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)')
      ;(here ?? root?.querySelector<HTMLButtonElement>(ITEMS))?.focus()
    })
    return () => window.cancelAnimationFrame(raf)
  }, [takeFocus])

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const rows = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(ITEMS) ?? [])
    if (rows.length === 0) return
    e.preventDefault()
    const i = rows.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? rows.length - 1
          : e.key === 'ArrowDown'
            ? (i + 1) % rows.length
            : (i <= 0 ? rows.length : i) - 1
    rows[next]?.focus()
  }

  return (
    <div
      ref={ref}
      className="dk-apick"
      style={{ maxHeight: room }}
      onKeyDown={onKeyDown}
      // A click picks without taking focus from the bar or the pane.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="dk-apick__head">
        <span className="dk-apick__eyebrow">{agentName}</span>
        <span className="dk-apick__hint">sends to {paneName}</span>
      </div>

      {windows.length > 0 ? (
        <section className="dk-apick__section" data-sec="plan" aria-label="Plan limits">
          <div className="dk-apick__label">
            <span className="dk-apick__label-name">Plan limits</span>
            {stale ? <span className="dk-apick__label-hint">{stale}</span> : null}
          </div>
          {windows.map((w) => (
            <Meter key={w.minutes} label={w.label} pct={clampPct(w.usedPct)} sub={resetWords(w.resetsAt, now)?.long ?? null} />
          ))}
        </section>
      ) : null}

      {hasSession ? (
        <section className="dk-apick__section" data-sec="session" aria-label="This session">
          <div className="dk-apick__label">
            <span className="dk-apick__label-name">This session</span>
            {stale && windows.length === 0 ? <span className="dk-apick__label-hint">{stale}</span> : null}
          </div>
          {context ? (
            <Meter
              label="Context"
              pct={clampPct(context.usedPct)}
              sub={
                context.usedTokens !== undefined && context.windowTokens
                  ? `${fmtTokens(context.usedTokens)} of ${fmtTokens(context.windowTokens)} tokens`
                  : `${100 - clampPct(context.usedPct)}% left before the window is full`
              }
            />
          ) : null}
          {costUsd !== null ? (
            <div className="dk-apick__stat">
              <span className="dk-apick__meter-label">Cost so far</span>
              <span className="dk-apick__stat-value">{fmtCost(costUsd)}</span>
            </div>
          ) : null}
        </section>
      ) : null}

      {windows.length > 0 || hasSession ? <div className="dk-apick__divider" /> : null}

      <div role="menu" aria-label={`Model, effort and mode for ${paneName}`}>
        <div className="dk-apick__group" data-sec="model" role="group" aria-label="Model">
          <div className="dk-apick__label" aria-hidden="true">
            <span className="dk-apick__label-name">Model</span>
            {modelName ? <span className="dk-apick__label-hint">now {modelName}</span> : null}
          </div>
          {canModel ? (
            models.map((m) => (
              <Row
                key={m.id}
                tile={monogram(m.label)}
                label={m.label}
                note={m.note}
                current={m.id === model?.id}
                onPick={() => onPickModel(m.id)}
              />
            ))
          ) : (
            <p className="dk-apick__refusal">{modelRefusal(command)}</p>
          )}
        </div>

        <div className="dk-apick__divider" />

        <div className="dk-apick__group" data-sec="effort" role="group" aria-label="Effort">
          <div className="dk-apick__label" aria-hidden="true">
            <span className="dk-apick__label-name">Effort</span>
          </div>
          {canEffort ? (
            levels.map((l, i) => (
              <Row
                key={l.id}
                tile={<EffortBars level={i + 1} of={levels.length} />}
                label={l.label}
                note={l.note}
                current={l.id === effort?.id}
                onPick={() => onPickEffort(l.id)}
              />
            ))
          ) : (
            <p className="dk-apick__refusal">{effortRefusal(command)}</p>
          )}
        </div>

        {showMode ? (
          <>
            <div className="dk-apick__divider" />
            <div className="dk-apick__group" data-sec="mode" role="group" aria-label="Mode">
              <div className="dk-apick__label" aria-hidden="true">
                <span className="dk-apick__label-name">Mode</span>
                {modeWord && !modes.some((m) => m.id === rung) ? <span className="dk-apick__label-hint">now {modeWord}</span> : null}
              </div>
              {modes.map((m) => {
                const current = m.id === rung
                const reachable = picker !== null || current || tabsToPermissionMode(command, rung, m.id) !== null
                return (
                  <Row
                    key={m.id}
                    tile={monogram(m.label)}
                    label={m.label}
                    note={reachable ? (picker ? `${m.note} — opens ${picker}` : m.note) : 'only when the pane opens'}
                    current={current}
                    warn={m.danger === true && current}
                    disabled={!reachable}
                    onPick={() => onPickMode(m.id)}
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
 * One reading: its name, "% used" and — near the end — the word for it, a bar,
 * and a line under it (when it resets, or tokens). A progressbar to a screen
 * reader, with the words as its value.
 */
function Meter({ label, pct, sub }: { label: string; pct: number; sub: string | null }): ReactNode {
  const word = levelWord(pct)
  const said = `${pct}% used${word ? `, ${word}` : ''}`
  return (
    <div
      className="dk-apick__meter"
      data-level={levelOf(pct)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={sub ? `${said}; ${sub}` : said}
    >
      <div className="dk-apick__meter-head">
        <span className="dk-apick__meter-label">{label}</span>
        <span className="dk-apick__meter-pct">
          {pct}% used
          {word ? <span className="dk-apick__meter-word">{word}</span> : null}
        </span>
      </div>
      <span className="dk-apick__meter-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
      {sub ? <span className="dk-apick__meter-sub">{sub}</span> : null}
    </div>
  )
}

/**
 * One choice: a round tile, the name over its note, and — on the one in force —
 * a tick and the word "current". The tile inverts for it too: a shape, not only
 * a tint. One that cannot be reached from here gets a dashed, empty tile and
 * says why. The dangerous rung, while it is in force, adds a warning triangle.
 */
function Row({
  tile,
  label,
  note,
  current,
  warn = false,
  disabled = false,
  onPick
}: {
  tile: ReactNode
  label: string
  note: string
  current: boolean
  warn?: boolean
  disabled?: boolean
  onPick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={current}
      className="dk-apick__row"
      data-selected={current ? 'true' : undefined}
      disabled={disabled}
      onClick={onPick}
    >
      <span className="dk-apick__tile" data-look={current ? 'use' : disabled ? 'off' : undefined} aria-hidden="true">
        {tile}
      </span>
      <span className="dk-apick__text">
        <span className="dk-apick__name">
          {label}
          {warn ? <WarnMark /> : null}
        </span>
        <span className="dk-apick__sub">{note}</span>
      </span>
      {current ? (
        <span className="dk-apick__state">
          <Icon name="check" size={12} className="dk-apick__check" />
          current
        </span>
      ) : null}
    </button>
  )
}

/** The warning mark beside Bypass while it is in force: a triangle with a "!". */
function WarnMark(): ReactNode {
  return (
    <svg
      className="dk-apick__warn"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="dangerous"
      role="img"
    >
      <path d="M8 2.1 14.7 13.7H1.3Z" />
      <path d="M8 6.4v3.4" />
      <circle cx="8" cy="11.75" r="0.35" fill="currentColor" />
    </svg>
  )
}

/** An effort's tile: a rising row of bars, as many lit as the level is high — it reads by shape. */
function EffortBars({ level, of }: { level: number; of: number }): ReactNode {
  const W = 14
  const H = 12
  const bar = 2
  const step = of > 1 ? (W - bar) / (of - 1) : 0
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {Array.from({ length: of }, (_, i) => {
        const h = of > 1 ? 3 + ((H - 3) * i) / (of - 1) : H
        return <rect key={i} x={i * step} y={H - h} width={bar} height={h} rx={0.75} fill="currentColor" opacity={i < level ? 1 : 0.28} />
      })}
    </svg>
  )
}
