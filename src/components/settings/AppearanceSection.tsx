import { useRef, useState, type ReactNode } from 'react'
import type { ThemeCore } from '@shared/types'
import {
  BACKDROPS,
  clearBackdropImage,
  setBackdrop,
  setBackdropImage,
  useBackdrop,
  useBackdropImage,
  type BackdropId
} from '@/lib/backdrop'
import { useApp } from '@/state/AppState'
import { BUILTIN_THEMES, allThemes, findTheme, resolveTheme } from '@/theme/themes'
import { Icon } from '../Icon'
import { Card, Row, Section, Stepper, Toggle } from './parts'
import { ThemeEditor } from './ThemeEditor'

/**
 * Backdrop, themes, type size and motion.
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
    <Section
      title="Theme & backdrop"
      blurb="One theme drives the whole app, terminals included; the backdrop is the room the panes sit in."
    >
      <BackdropCard />

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
        <Row
          label="Full-size text on the Wall"
          hint="Same type size however many tiles are up — each tile is a window onto its terminal, showing the latest output. Off shrinks whole terminals to fit instead. Neither reflows a running TUI. Double-click a tile’s header to override one tile."
        >
          <Toggle
            checked={s.mosaicText !== 'scaled'}
            onChange={(on) => actions.setMosaicText(on ? 'lifesize' : 'scaled')}
            label="Full-size text on the Wall"
          />
        </Row>
        <Row
          label="Show working projects in the project sheet"
          hint="A thin dotted line appears beneath a project’s folder while any of its terminals is still producing output. It ignores your own typing, and settles about a second after the work stops."
        >
          <Toggle
            checked={s.railBusyRing}
            onChange={(on) => actions.patchSettings({ railBusyRing: on })}
            label="Show working projects in the project sheet"
          />
        </Row>
        <Row label="Reduce motion" hint="Windows already asks for this; here it can be forced on">
          <Toggle checked={s.reducedMotion} onChange={actions.setReducedMotion} label="Reduce motion" />
        </Row>
      </Card>

      {/*
        The rail's sections. Projects is absent on purpose — everything else in
        the rail is scoped to whichever project is selected, so a rail you
        cannot change project from is a rail where none of the rest can be
        pointed at anything. It is the one section with no switch.
      */}
      <Card
        title="Project sheet"
        hint="Which sections the dock’s project sheet carries under the project list (they were the left rail). Each one still collapses in place."
      >
        <Row
          label="Git"
          hint="Branch, what has changed, and whether it is pushed. Reads only — the few buttons that change anything are named, and everything harder is handed to an agent. A folder with no repository simply says so."
        >
          <Toggle checked={s.railGit} onChange={(on) => actions.patchSettings({ railGit: on })} label="Git" />
        </Row>
        <Row
          label="Activity"
          hint="Which agent is touching which file. Exact for Claude panes, inferred from timing for the rest. This is the one part of Forge that watches the project folder itself, and it only does so while this is on."
        >
          <Toggle
            checked={s.railActivity}
            onChange={(on) => actions.patchSettings({ railActivity: on })}
            label="Activity"
          />
        </Row>
        {/*
          The hint has to say what this one does to the disk. Every other section
          only draws; this is the only part of Forge that writes into the project
          folder, and finding a directory you did not create in your own
          repository is not a thing anybody should discover by noticing it.
        */}
        <Row
          label="Share"
          hint="Five markdown notes in .forge/share, inside the project, that every agent working in it can read and write — push a plan from one pane and have another review it. Forge adds .forge/ to this clone's .git/info/exclude, never to your .gitignore."
        >
          <Toggle
            checked={s.railShare}
            onChange={(on) => actions.patchSettings({ railShare: on })}
            label="Share"
          />
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

/* --------------------------------------------------------------- backdrop */

/** Small painted previews — the real scenes are drawn from the live theme. */
const PREVIEW: Record<Exclude<BackdropId, 'image'>, string> = {
  deepfield: [
    'radial-gradient(1px 1px at 18% 30%, #fff, transparent)',
    'radial-gradient(1px 1px at 64% 22%, #fff, transparent)',
    'radial-gradient(1.5px 1.5px at 82% 58%, #cfe0ff, transparent)',
    'radial-gradient(1px 1px at 40% 70%, #fff, transparent)',
    'radial-gradient(1px 1px at 90% 12%, #ffe8c8, transparent)',
    'radial-gradient(120% 90% at 15% 110%, rgba(198,255,74,0.22), transparent 60%)',
    'linear-gradient(180deg, #05070c, #0b0e16)'
  ].join(', '),
  nebula: [
    'radial-gradient(40% 50% at 28% 40%, rgba(120,170,255,0.45), transparent 70%)',
    'radial-gradient(38% 46% at 74% 34%, rgba(192,139,255,0.4), transparent 70%)',
    'radial-gradient(50% 44% at 60% 82%, rgba(127,196,255,0.35), transparent 72%)',
    'linear-gradient(160deg, #06080d, #0b0d14)'
  ].join(', '),
  ridgeline: [
    'linear-gradient(172deg, transparent 58%, #0d1422 58.5%)',
    'linear-gradient(188deg, transparent 64%, #111b2c 64.5%)',
    'linear-gradient(176deg, transparent 72%, #070a10 72.5%)',
    'radial-gradient(60% 30% at 30% 62%, rgba(255,179,71,0.22), transparent 70%)',
    'linear-gradient(180deg, #06080d 0%, #10192a 45%, #1d2c44 64%)'
  ].join(', '),
  calm: 'radial-gradient(80% 60% at 50% -10%, rgba(198,255,74,0.12), transparent 70%), linear-gradient(180deg, #0b0c0e, #111418)'
}

const EMPTY_IMAGE =
  'repeating-linear-gradient(135deg, var(--bg-panel), var(--bg-panel) 6px, var(--bg-hover) 6px, var(--bg-hover) 12px)'

function BackdropCard(): ReactNode {
  const backdrop = useBackdrop()
  const image = useBackdropImage()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pickImage = (): void => fileRef.current?.click()

  return (
    <Card
      title="Backdrop"
      hint="Painted once and left still. Drift adds a slow pan of the stars, paused whenever Forge is hidden and never under Reduce motion. Your own image stays on this PC."
    >
      <div className="sbackdrops" role="radiogroup" aria-label="Backdrop">
        {BACKDROPS.map((b) => {
          const selected = backdrop.id === b.id && (b.id !== 'image' || Boolean(image))
          const style: React.CSSProperties =
            b.id === 'image'
              ? image
                ? { backgroundImage: `url("${image}")` }
                : { background: EMPTY_IMAGE }
              : { background: PREVIEW[b.id] }
          return (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className="sbackdrop"
              data-selected={selected ? 'true' : undefined}
              title={b.blurb}
              onClick={() => {
                if (b.id === 'image' && !image) pickImage()
                else setBackdrop({ id: b.id })
              }}
            >
              <span className="sbackdrop__swatch" style={style}>
                {selected ? (
                  <span className="sbackdrop__check">
                    <Icon name="check" size={11} />
                  </span>
                ) : null}
              </span>
              <span className="sbackdrop__name">{b.name}</span>
            </button>
          )
        })}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          setError(null)
          void setBackdropImage(file).catch(() => setError('That file could not be read as an image.'))
        }}
      />

      <Row
        label="Your image"
        hint={
          error ??
          (image ? 'Kept in this window’s storage, downscaled to 2560px.' : 'Pick any picture — a photo, a render, a screenshot.')
        }
      >
        <div className="srange">
          <button type="button" className="ghost-btn sbtn" onClick={pickImage}>
            <Icon name="image" size={12} />
            {image ? 'Change…' : 'Choose…'}
          </button>
          {image ? (
            <button type="button" className="ghost-btn sbtn" data-danger="true" onClick={clearBackdropImage}>
              Remove
            </button>
          ) : null}
        </div>
      </Row>

      <Row label="Dim" hint="Washes the backdrop toward the theme’s background.">
        <div className="srange">
          <input
            type="range"
            min={0}
            max={80}
            step={5}
            value={Math.round(backdrop.dim * 100)}
            aria-label="Dim the backdrop"
            onChange={(e) => setBackdrop({ dim: Number(e.target.value) / 100 })}
          />
          <span className="srange__value">{Math.round(backdrop.dim * 100)}%</span>
        </div>
      </Row>

      <Row label="Blur" hint="Softens the picture behind the panes. Drawn once, so it costs nothing while you work.">
        <div className="srange">
          <input
            type="range"
            min={0}
            max={24}
            step={1}
            value={backdrop.blur}
            aria-label="Blur the backdrop"
            onChange={(e) => setBackdrop({ blur: Number(e.target.value) })}
          />
          <span className="srange__value">{backdrop.blur}px</span>
        </div>
      </Row>

      <Row label="Drift" hint="A very slow pan of the stars and haze. Off keeps the room perfectly still.">
        <Toggle checked={backdrop.drift} onChange={(on) => setBackdrop({ drift: on })} label="Drift" />
      </Row>
    </Card>
  )
}
