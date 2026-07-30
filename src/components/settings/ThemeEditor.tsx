import { useMemo, useState, type ReactNode } from 'react'
import type { ThemeCore } from '@shared/types'
import { makeId } from '@/lib/ids'
import { ANSI_SLOTS, auditTheme, contrast, forkTheme, resolveTheme } from '@/theme/themes'
import { Icon } from '../Icon'
import { Card, Row, StateChip, TextField } from './parts'

/**
 * Build a theme.
 *
 * The editable surface is deliberately small — a background, a panel, an ink, an
 * accent, and the sixteen ANSI slots — because every other token is derived
 * from those (see src/theme/themes.ts). Editing forty-odd colours by hand is
 * how themes end up with a hover state that is lighter than the thing it is
 * hovering over.
 *
 * The swatch strip under the terminal colours is live: it is the actual
 * resolved palette, with the contrast of each slot measured against the actual
 * terminal background, so an unreadable red is visible here rather than in an
 * error message an hour later.
 */
export function ThemeEditor({
  base,
  existing,
  onSave,
  onCancel
}: {
  base: ThemeCore
  /** Set when re-opening a custom theme, so Save updates rather than forks. */
  existing?: ThemeCore | null
  onSave: (theme: ThemeCore) => void
  onCancel: () => void
}): ReactNode {
  const [draft, setDraft] = useState<ThemeCore>(
    () => existing ?? forkTheme(base, makeId('theme'), `${base.name} (mine)`)
  )

  const tokens = useMemo(() => resolveTheme(draft), [draft])
  const findings = useMemo(() => auditTheme(draft), [draft])

  const patch = (next: Partial<ThemeCore>): void => setDraft((d) => ({ ...d, ...next }))
  const setAnsi = (index: number, value: string): void =>
    setDraft((d) => {
      const ansi = [...d.ansi]
      ansi[index] = value
      return { ...d, ansi }
    })

  return (
    <Card
      title={existing ? `Editing ${existing.name}` : `New theme from ${base.name}`}
      actions={
        <>
          <button type="button" className="ghost-btn sbtn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="ghost-btn sbtn sbtn--go" onClick={() => onSave(draft)}>
            <Icon name="check" size={12} />
            Save &amp; apply
          </button>
        </>
      }
    >
      <Row label="Name" htmlFor="theme-name">
        <TextField id="theme-name" value={draft.name} onCommit={(name) => patch({ name: name.trim() || draft.name })} />
      </Row>

      <Row label="Appearance" hint="Drives how the derived surfaces are mixed">
        <select
          className="select"
          value={draft.appearance}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => patch({ appearance: e.target.value === 'light' ? 'light' : 'dark' })}
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </Row>

      <div className="tedit__core">
        <ColorField label="Background" value={draft.bg} onChange={(bg) => patch({ bg })} />
        <ColorField label="Panel" value={draft.panel} onChange={(panel) => patch({ panel })} />
        <ColorField label="Text" value={draft.text} onChange={(text) => patch({ text })} />
        <ColorField label="Accent" value={draft.accent} onChange={(accent) => patch({ accent })} />
        <ColorField label="Terminal bg" value={draft.termBg} onChange={(termBg) => patch({ termBg })} />
        <ColorField label="Terminal text" value={draft.termFg} onChange={(termFg) => patch({ termFg })} />
      </div>

      <div className="eyebrow tedit__eyebrow">Terminal palette</div>
      <div className="tedit__ansi">
        {ANSI_SLOTS.map((slot, i) => (
          <ColorField
            key={slot}
            label={slot.replace('bright-', '+')}
            value={draft.ansi[i] ?? '#ffffff'}
            onChange={(v) => setAnsi(i, v)}
            compact
          />
        ))}
      </div>

      {/* The live preview: real resolved tokens, real measured contrast. */}
      <div className="tedit__preview" style={{ background: tokens['bg-base'], borderColor: tokens['line-hairline'] }}>
        <div className="tedit__preview-term" style={{ background: draft.termBg, color: draft.termFg }}>
          <span className="mono">PS C:\projects&gt; </span>
          <span className="mono" style={{ color: draft.ansi[2] }}>
            build ok
          </span>{' '}
          <span className="mono" style={{ color: draft.ansi[1] }}>
            2 errors
          </span>{' '}
          <span className="mono" style={{ color: draft.ansi[8] }}>
            (see log)
          </span>
        </div>
        <div className="tedit__swatches">
          {ANSI_SLOTS.map((slot, i) => {
            const colour = draft.ansi[i] ?? draft.termFg
            const ratio = contrast(colour, draft.termBg)
            return (
              <span
                key={slot}
                className="tedit__swatch"
                title={`${slot} ${colour} — ${ratio.toFixed(2)}:1 on the terminal background`}
                data-low={slot !== 'black' && ratio < 4.5 ? 'true' : undefined}
                style={{ background: colour }}
              />
            )
          })}
        </div>
      </div>

      {findings.length > 0 ? (
        <div className="tedit__findings">
          <StateChip tone="warn">{findings.length} hard to read</StateChip>
          <span className="tedit__findings-text">
            {findings
              .slice(0, 4)
              .map((f) => `${f.slot} ${f.ratio}:1`)
              .join(' · ')}
            {findings.length > 4 ? ' …' : ''} — anything under 4.5:1 is a colour you will squint at all day.
          </span>
        </div>
      ) : (
        <div className="tedit__findings">
          <StateChip tone="ok">every slot readable</StateChip>
        </div>
      )}
    </Card>
  )
}

function ColorField({
  label,
  value,
  onChange,
  compact
}: {
  label: string
  value: string
  onChange: (next: string) => void
  compact?: boolean
}): ReactNode {
  return (
    <label className="tfield" data-compact={compact ? 'true' : undefined}>
      <span className="tfield__label">{label}</span>
      <span className="tfield__row">
        <input
          className="tfield__swatch"
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
        />
        {!compact ? (
          <input
            className="field__input mono tfield__hex"
            value={value}
            spellCheck={false}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const next = e.target.value
              if (/^#[0-9a-fA-F]{0,6}$/.test(next)) onChange(next)
            }}
          />
        ) : null}
      </span>
    </label>
  )
}
