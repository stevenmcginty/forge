import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { ClaudePermissionMode } from '@shared/types'
import type { AgentModelSpec, EffortLevel, EffortLevelSpec, PermissionModeSpec } from '@shared/agents'
import { Icon } from '@/components/Icon'
import { pickEffort, pickModel, useEffortPicked, useModelPicked, type PaneSetup } from '../lib/pane-setup'
import { BottomSheet, SheetSection } from './BottomSheet'
import './ModelChip.css'

/**
 * The phone's short readout of how this agent is set up — "Opus · High / Plan" —
 * sitting in the status strip, and the sheet it opens to change any of the
 * three. Words, never a colour: the mode used to be a tint on the composer's
 * chip, which said nothing to a red-green colourblind eye and hid the model
 * name behind the word "Model".
 *
 * Effort has no reading off the pane (no CLI prints it), so the chip shows the
 * rung picked here, per pane, and leaves it out until one is. The model is the
 * pane's own, matched to the roster; a pick shows at once and gives way to the
 * pane's reading when that changes.
 *
 * Bypass is an ordinary row at rest. Only when it is the mode in force does it
 * carry its warning — a warning triangle beside the word, in the chip and in
 * the sheet; the red is only a third signal.
 *
 * The chip stacks two short lines in its 32px face: the model (and effort) on
 * top, the mode under it. The strip gives the chip well under half a phone's
 * width, so on one line the mode — the part that matters most when it is
 * Bypass — was the first thing an ellipsis ate. Stacked, each line truncates on
 * its own: effort gives way before the model, and the mode keeps a line.
 */
/*
 * The picks themselves live in lib/pane-setup.ts, outside the chip: the side
 * drawer mounts it only while the drawer is out, no CLI prints the effort
 * back, and the top bar's context chip shows the same picks.
 */

export function ModelChip({
  paneId,
  agentName,
  models,
  currentModelId,
  modelText,
  onModel,
  effortLevels,
  onEffort,
  modes,
  currentModeId,
  modeText,
  onMode,
  disabled,
  variant = 'chip'
}: {
  paneId: string
  /** "Claude Code" — the sheet's heading. */
  agentName: string
  models: AgentModelSpec[]
  currentModelId: string | null
  /** The model as the pane printed it, for a pane whose model is not on the roster. */
  modelText?: string
  onModel?: (id: string) => void
  effortLevels: EffortLevelSpec[]
  onEffort?: (level: EffortLevel) => void
  modes: PermissionModeSpec[]
  currentModeId: ClaudePermissionMode | null
  /** A rung the ladder does not list (Claude's `auto`), in words. */
  modeText?: string
  onMode?: (id: ClaudePermissionMode) => void
  disabled: boolean
  /** `pill`: the side drawer's face, one small capsule centred in the drawer. */
  variant?: 'chip' | 'pill'
}): ReactNode {
  const [open, setOpen] = useState(false)
  // The pane's own reading wins once it moves: a pick only stands in for it.
  const pickedModel = useModelPicked(paneId, currentModelId)
  const effortId = useEffortPicked(paneId)

  const modelId = pickedModel ?? currentModelId
  const model = modelId ? (models.find((m) => m.id === modelId) ?? null) : null
  const effort = effortId ? (effortLevels.find((l) => l.id === effortId) ?? null) : null
  const mode = currentModeId ? (modes.find((m) => m.id === currentModeId) ?? null) : null
  const bypass = currentModeId === 'bypass'

  const modelWord = model?.label ?? modelText ?? null
  const effortWord = effort?.label ?? null
  const modeWord = mode?.label ?? modeText ?? null
  const words = [modelWord, effortWord].filter((w): w is string => Boolean(w))

  const hasModels = Boolean(onModel && models.length)
  const hasEffort = Boolean(onEffort && effortLevels.length)
  const hasModes = Boolean(onMode && modes.length)

  const stop = (event: MouseEvent | KeyboardEvent): void => event.stopPropagation()

  /*
   * The side drawer's face: one small capsule in the middle of the drawer —
   * the model and the effort, a hairline, then the mode with its dot (the
   * warning triangle and red when it is Bypass) — and a chevron. A tap opens
   * the one sheet for all three.
   */
  const face =
    variant === 'pill' ? (
      <div className="mpill-row">
        <button
          type="button"
          className="mpill"
          data-open={open ? 'true' : undefined}
          data-warn={bypass ? 'true' : undefined}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${[...words, modeWord].filter(Boolean).join(', ') || 'Model'} — change model, effort or mode`}
          onClick={(event) => {
            stop(event)
            setOpen(true)
          }}
          onKeyDown={stop}
        >
          <span className="mpill__spark" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" focusable="false">
              <path d="M7 .8c.4 2.9 1.9 4.4 4.8 4.8v.8C8.9 6.8 7.4 8.3 7 11.2h-.8C5.8 8.3 4.3 6.8 1.4 6.4v-.8C4.3 5.2 5.8 3.7 6.2.8z" transform="translate(.4 .9)" />
            </svg>
          </span>
          <span className="mpill__model">{modelWord ?? 'Model'}</span>
          {effortWord ? <span className="mpill__effort">{effortWord}</span> : null}
          {modeWord ? (
            <>
              <span className="mpill__sep" aria-hidden="true" />
              <span className="mpill__mode" data-mode={currentModeId ?? undefined}>
                {bypass ? <WarnMark size={12} /> : <span className="mpill__dot" aria-hidden="true" />}
                {modeWord}
              </span>
            </>
          ) : null}
          <Icon name="chevronDown" size={12} className="mpill__chev" />
        </button>
      </div>
    ) : null

  return (
    <>
      {face ?? (
      <button
        type="button"
        className="mchip"
        data-open={open ? 'true' : undefined}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${[...words, modeWord].filter(Boolean).join(', ') || 'Model'} — change model, effort or mode`}
        onClick={(event) => {
          stop(event)
          setOpen(true)
        }}
        onKeyDown={stop}
      >
        <span className="mchip__face">
          <span className="mchip__text">
            {words.length ? (
              <span className="mchip__lead">
                {modelWord ? <span className="mchip__model">{modelWord}</span> : null}
                {effortWord ? <span className="mchip__effort">{effortWord}</span> : null}
              </span>
            ) : null}
            {modeWord ? (
              <span className="mchip__mode" data-warn={bypass ? 'true' : undefined}>
                {bypass ? <WarnMark size={12} /> : null}
                <span className="mchip__mode-word">{modeWord}</span>
              </span>
            ) : null}
            {!words.length && !modeWord ? <span className="mchip__lead">Model</span> : null}
          </span>
          <Icon name="chevronDown" size={12} />
        </span>
      </button>
      )}
      {/* The sheet is portalled, but React still bubbles its taps up through
          the strip, whose own click opens the raw footer. They stop here. */}
      <span className="mchip__sheet" onClick={(event) => event.stopPropagation()} onKeyDown={stop}>
        <BottomSheet
          open={open}
          onClose={() => setOpen(false)}
          label={`${agentName} — model, effort and mode`}
          title={agentName}
          subtitle="Model, effort and permission mode for this pane"
          testId="model-sheet"
        >
          {hasModels ? (
            <SheetSection title="Model">
              <div role="radiogroup" aria-label="Model">
                {models.map((m) => (
                  <PickRow
                    key={m.id}
                    label={m.label}
                    note={m.note}
                    current={m.id === modelId}
                    onPick={() => {
                      setOpen(false)
                      pickModel(paneId, m.id, currentModelId)
                      onModel?.(m.id)
                    }}
                  />
                ))}
              </div>
            </SheetSection>
          ) : null}
          {hasEffort ? (
            <SheetSection title="Effort">
              {/* Five short words that read as a scale, so one row, not five. */}
              <div className="mseg" role="radiogroup" aria-label="Effort">
                {effortLevels.map((level) => (
                  <button
                    key={level.id}
                    type="button"
                    className="mseg__opt"
                    role="radio"
                    aria-checked={level.id === effortId}
                    title={level.note}
                    onClick={() => {
                      setOpen(false)
                      pickEffort(paneId, level.id)
                      onEffort?.(level.id)
                    }}
                  >
                    {level.label}
                  </button>
                ))}
              </div>
              <p className="mseg__note">{effort ? effort.note : 'Not set from this phone yet.'}</p>
            </SheetSection>
          ) : null}
          {hasModes ? (
            <SheetSection title="Permission mode">
              <div role="radiogroup" aria-label="Permission mode">
                {modes.map((m) => (
                  <PickRow
                    key={m.id}
                    label={m.label}
                    note={m.note}
                    current={m.id === currentModeId}
                    warn={m.danger === true && m.id === currentModeId}
                    onPick={() => {
                      setOpen(false)
                      onMode?.(m.id)
                    }}
                  />
                ))}
              </div>
            </SheetSection>
          ) : null}
        </BottomSheet>
      </span>
    </>
  )
}

/**
 * The same three picks, laid out to sit in the top bar's context panel above
 * its context and limits: the sheet's segmented effort control, used for all
 * three — the model and the mode as two-up grids, the effort as its one row of
 * five. The one in force is filled with ink, `aria-checked` says it; Bypass in
 * force fills red behind its warning triangle and its word.
 *
 * A pick goes out through the pill's own senders (`usePaneSetup`) and is
 * remembered in the same store, so the chip and the pill both show it at once.
 * `onPicked` folds the panel, as a pick closes the sheet: a second pick fired
 * before the first one's Enter would land in the same line of the TUI.
 */
export function SetupPicks({
  paneId,
  setup,
  onPicked
}: {
  paneId: string
  setup: PaneSetup
  onPicked: () => void
}): ReactNode {
  const { roster, levels, ladder, modelId, currentModelId, modelText, currentModeId, modeText, effortId, canType } = setup
  const effort = effortId ? (levels.find((l) => l.id === effortId) ?? null) : null
  const mode = currentModeId ? (ladder.find((m) => m.id === currentModeId) ?? null) : null
  const offRoster = !modelId && modelText ? modelText : null

  return (
    <div className="msetup" data-live={canType ? 'true' : 'false'}>
      {roster.length ? (
        <SheetSection title="Model">
          <div className="mseg mseg--grid" role="radiogroup" aria-label="Model">
            {roster.map((m) => (
              <button
                key={m.id}
                type="button"
                className="mseg__opt"
                role="radio"
                aria-checked={m.id === modelId}
                title={m.note}
                disabled={!canType}
                onClick={() => {
                  onPicked()
                  pickModel(paneId, m.id, currentModelId)
                  void setup.sendModel(m.id)
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
          {offRoster ? <p className="mseg__note">Running {offRoster}, which this list does not name.</p> : null}
        </SheetSection>
      ) : null}
      {levels.length ? (
        <SheetSection title="Effort">
          <div className="mseg" role="radiogroup" aria-label="Effort">
            {levels.map((level) => (
              <button
                key={level.id}
                type="button"
                className="mseg__opt"
                role="radio"
                aria-checked={level.id === effortId}
                title={level.note}
                disabled={!canType}
                onClick={() => {
                  onPicked()
                  pickEffort(paneId, level.id)
                  void setup.sendEffort(level.id)
                }}
              >
                {level.label}
              </button>
            ))}
          </div>
          <p className="mseg__note">{effort ? effort.note : 'Not set from this phone yet.'}</p>
        </SheetSection>
      ) : null}
      {ladder.length ? (
        <SheetSection title="Permission mode">
          <div className="mseg mseg--grid" role="radiogroup" aria-label="Permission mode">
            {ladder.map((m) => {
              const current = m.id === currentModeId
              const warn = m.danger === true && current
              return (
                <button
                  key={m.id}
                  type="button"
                  className="mseg__opt"
                  role="radio"
                  aria-checked={current}
                  data-warn={warn ? 'true' : undefined}
                  title={m.note}
                  disabled={!canType}
                  onClick={() => {
                    onPicked()
                    void setup.sendMode(m.id)
                  }}
                >
                  {warn ? <WarnMark size={15} /> : null}
                  {m.label}
                </button>
              )
            })}
          </div>
          <p className="mseg__note" data-warn={mode?.danger ? 'true' : undefined}>
            {mode ? `${mode.label}: ${mode.note}.` : modeText ? `${modeText}: chosen on the pane.` : 'The pane has not printed its mode yet.'}
          </p>
        </SheetSection>
      ) : null}
    </div>
  )
}

/**
 * One choice: the sheet's 56px row, a radio by role, with a tick on the one in
 * force. The tick is a shape and `aria-checked` says it to a screen reader, so
 * the choice never rests on a tint.
 */
function PickRow({
  label,
  note,
  current,
  warn = false,
  onPick
}: {
  label: string
  note?: string
  current: boolean
  /** The dangerous rung, while it is the one in force: a warning triangle after the word. */
  warn?: boolean
  onPick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className="bsrow mpick"
      role="radio"
      aria-checked={current}
      data-current={current ? 'true' : undefined}
      data-warn={warn ? 'true' : undefined}
      onClick={onPick}
    >
      <span className="bsrow__text">
        <span className="bsrow__label">
          {label}
          {warn ? <WarnMark size={16} /> : null}
        </span>
        {note ? <span className="bsrow__sub">{note}</span> : null}
      </span>
      <span className="bsrow__trail mpick__tick" aria-hidden="true">
        {current ? <Icon name="check" size={20} /> : null}
      </span>
    </button>
  )
}

/**
 * The warning mark: a triangle with a "!" in it, drawn in the current colour.
 * The shape is the signal (Icon has no warning glyph); the word sits beside it.
 */
function WarnMark({ size }: { size: number }): ReactNode {
  return (
    <svg
      className="mchip__warn"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 2.1 14.7 13.7H1.3Z" />
      <path d="M8 6.4v3.4" />
      <circle cx="8" cy="11.75" r="0.35" fill="currentColor" />
    </svg>
  )
}
