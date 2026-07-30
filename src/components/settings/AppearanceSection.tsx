import { useState, type ReactNode } from 'react'
import type { ThemeCore } from '@shared/types'
import { useApp } from '@/state/AppState'
import { BUILTIN_THEMES, allThemes, findTheme, resolveTheme } from '@/theme/themes'
import { Icon } from '../Icon'
import { Card, Row, Section, Stepper, Toggle } from './parts'
import { ThemeEditor } from './ThemeEditor'

/**
 * Themes, type size and motion.
 *
 * Picking a theme applies it immediately — including to every open terminal —
 * because a theme you have to restart to see is a theme you will never try.
 */
export function AppearanceSection(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  const themes = allThemes(s.customThemes)
  const current = findTheme(s.themeId, s.customThemes)
  const [editing, setEditing] = useState<{ base: ThemeCore; existing: ThemeCore | null } | null>(null)

  return (
    <Section title="Appearance" blurb="One theme drives the whole app, terminals included.">
      <Card
        title="Theme"
        actions={
          <button
            type="button"
            className="ghost-btn sbtn"
            onClick={() => setEditing({ base: current, existing: null })}
          >
            <Icon name="plus" size={12} />
            New from {current.name}
          </button>
        }
      >
        <div className="sthemes">
          {themes.map((theme) => (
            <ThemeTile
              key={theme.id}
              theme={theme}
              selected={theme.id === s.themeId}
              onPick={() => actions.setTheme(theme.id)}
              onEdit={theme.custom ? () => setEditing({ base: theme, existing: theme }) : undefined}
              onDelete={theme.custom ? () => actions.deleteCustomTheme(theme.id) : undefined}
            />
          ))}
        </div>
        {BUILTIN_THEMES.some((t) => t.id === s.themeId) ? null : (
          <p className="scard__hint">
            Custom themes live in <span className="mono">settings.json</span> and survive restarts.
          </p>
        )}
      </Card>

      {editing ? (
        <ThemeEditor
          base={editing.base}
          existing={editing.existing}
          onCancel={() => setEditing(null)}
          onSave={(theme) => {
            actions.saveCustomTheme(theme)
            setEditing(null)
          }}
        />
      ) : null}

      <Card title="Text &amp; motion">
        <Row label="Terminal font size" hint="Ctrl + and Ctrl − do this too">
          <Stepper
            label="Terminal font size"
            value={s.terminalFontSize}
            display={`${s.terminalFontSize}px`}
            min={9}
            max={24}
            onChange={actions.setFontSize}
          />
        </Row>
        <Row label="Reduce motion" hint="Windows already asks for this; here it can be forced on">
          <Toggle checked={s.reducedMotion} onChange={actions.setReducedMotion} label="Reduce motion" />
        </Row>
      </Card>
    </Section>
  )
}

/* ------------------------------------------------------------------- tile */

function ThemeTile({
  theme,
  selected,
  onPick,
  onEdit,
  onDelete
}: {
  theme: ThemeCore
  selected: boolean
  onPick: () => void
  onEdit?: () => void
  onDelete?: () => void
}): ReactNode {
  const tokens = resolveTheme(theme)

  return (
    <div className="stheme" data-selected={selected ? 'true' : undefined}>
      <button
        type="button"
        className="stheme__swatch"
        aria-pressed={selected}
        aria-label={`Use the ${theme.name} theme`}
        onClick={onPick}
        style={{
          background: tokens['bg-base'],
          borderColor: selected ? theme.accent : tokens['line-hairline']
        }}
      >
        {/* A miniature of the app: rail, terminal, accent seam. */}
        <span className="stheme__rail" style={{ background: tokens['bg-panel'] }}>
          <span className="stheme__seam" style={{ background: theme.accent }} />
        </span>
        <span className="stheme__term" style={{ background: theme.termBg }}>
          <span style={{ background: theme.ansi[2] }} />
          <span style={{ background: theme.ansi[1] }} />
          <span style={{ background: theme.ansi[4] }} />
          <span style={{ background: theme.termFg }} />
        </span>
        {selected ? (
          <span className="stheme__check" style={{ color: theme.accent }}>
            <Icon name="check" size={12} />
          </span>
        ) : null}
      </button>
      <div className="stheme__foot">
        <span className="stheme__name truncate">{theme.name}</span>
        {onEdit ? (
          <button type="button" className="ghost-btn stheme__act" title={`Edit ${theme.name}`} onClick={onEdit}>
            <Icon name="gear" size={11} />
          </button>
        ) : null}
        {onDelete ? (
          <button
            type="button"
            className="ghost-btn stheme__act"
            data-danger="true"
            title={`Delete ${theme.name}`}
            onClick={onDelete}
          >
            <Icon name="trash" size={11} />
          </button>
        ) : null}
      </div>
    </div>
  )
}
