import { useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { ClaudePermissionMode } from '@shared/types'
import type { AgentModelSpec, EffortLevel, EffortLevelSpec, PermissionModeSpec } from '@shared/agents'
import { Icon } from '@/components/Icon'
import { BottomSheet, SheetSection } from './BottomSheet'
import './ModelChip.css'

/**
 * The phone's one line about how this agent is set up — "Opus · High · Plan" —
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
 * carry its warning — a "!" mark beside the word, in the chip and in the sheet.
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
  disabled
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
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [pickedModel, setPickedModel] = useState<Record<string, string>>({})
  const [pickedEffort, setPickedEffort] = useState<Record<string, EffortLevel>>({})

  // The pane's own reading wins once it moves: a pick was only standing in for it.
  useEffect(() => {
    setPickedModel((all) => {
      if (!(paneId in all)) return all
      const next = { ...all }
      delete next[paneId]
      return next
    })
  }, [paneId, currentModelId])

  const modelId = pickedModel[paneId] ?? currentModelId
  const model = modelId ? (models.find((m) => m.id === modelId) ?? null) : null
  const effortId = pickedEffort[paneId] ?? null
  const effort = effortId ? (effortLevels.find((l) => l.id === effortId) ?? null) : null
  const mode = currentModeId ? (modes.find((m) => m.id === currentModeId) ?? null) : null
  const bypass = currentModeId === 'bypass'

  const modelWord = model?.label ?? modelText ?? null
  const modeWord = mode?.label ?? modeText ?? null
  const words = [modelWord, effort?.label ?? null].filter((w): w is string => Boolean(w))

  const hasModels = Boolean(onModel && models.length)
  const hasEffort = Boolean(onEffort && effortLevels.length)
  const hasModes = Boolean(onMode && modes.length)

  const stop = (event: MouseEvent | KeyboardEvent): void => event.stopPropagation()

  return (
    <>
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
          <span className="mchip__words">
            {words.length || modeWord ? (
              <>
                {words.join(' · ')}
                {modeWord ? (
                  <>
                    {words.length ? ' · ' : ''}
                    {bypass ? (
                      <span className="mchip__warn" aria-hidden="true">
                        !
                      </span>
                    ) : null}
                    {modeWord}
                  </>
                ) : null}
              </>
            ) : (
              'Model'
            )}
          </span>
          <Icon name="chevronDown" size={12} />
        </span>
      </button>
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
                      setPickedModel((all) => ({ ...all, [paneId]: m.id }))
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
                      setPickedEffort((all) => ({ ...all, [paneId]: level.id }))
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
  /** The dangerous rung, while it is the one in force: a "!" beside the tick. */
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
      onClick={onPick}
    >
      <span className="bsrow__text">
        <span className="bsrow__label">
          {warn ? (
            <span className="mchip__warn" aria-hidden="true">
              !
            </span>
          ) : null}
          {label}
        </span>
        {note ? <span className="bsrow__sub">{note}</span> : null}
      </span>
      <span className="bsrow__trail mpick__tick" aria-hidden="true">
        {current ? <Icon name="check" size={20} /> : null}
      </span>
    </button>
  )
}
