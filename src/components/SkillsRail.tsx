import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SkillInfo } from '@shared/skills'
import { resolveProfile } from '@/lib/agents'
import { paneLabel } from '@/lib/appactions'
import { collectLeaves } from '@/lib/splitTree'
import { setSkillCatalogue, setSkillHandler } from '@/lib/skillbus'
import {
  SKILL_DRAG_MIME,
  installSkillDropTarget,
  skillLibrary,
  typeSkillIntoPane,
  useSkills
} from '@/lib/skills'
import { terminalHost } from '@/lib/terminals'
import { useApp } from '@/state/AppState'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'
import { Popover, PopoverDivider, PopoverRow, PopoverSection } from './Popover'
import './SkillsRail.css'

/**
 * SKILLS — the second half of the rail.
 *
 * A skill here is not a Forge feature. It is a folder that every `claude` and
 * `kimi` on this machine reads, whether Forge opened the session or not, and the
 * toggle in each row is the switch that puts it there. That is the whole promise
 * of the section, so the empty state says it out loud rather than describing the
 * button.
 */
export function SkillsRail(): ReactNode {
  const { state, actions } = useApp()
  const collapsed = state.settings.railCollapsed
  const skills = useSkills()
  const [open, setOpen] = useState(true)
  const [adding, setAdding] = useState(false)
  const addRef = useRef<HTMLButtonElement | null>(null)

  /* Tell the voice agent's manifest what is in the library. Registered once,
     reads live — see setSkillCatalogue for why it is a getter and not a value. */
  useEffect(
    () =>
      setSkillCatalogue(() =>
        skillLibrary
          .snapshot()
          .map((s) => ({ name: s.name, description: s.description, enabled: s.enabled }))
      ),
    []
  )

  /* ------------------------------------------------------- drag onto a pane
   *
   * Both halves of "drop a skill on a terminal" are installed from here rather
   * than from TerminalPane, which belongs to somebody else: the document-level
   * drop target (see installSkillDropTarget) and the profile lookup that decides
   * whether the pane gets `/name` or the skill's prose.
   */
  const workspaces = state.workspaces
  const profiles = state.settings.agentProfiles
  useEffect(() => {
    return installSkillDropTarget((paneId, name) => {
      const skill = skillLibrary.find(name)
      if (!skill) return
      for (const ws of Object.values(workspaces)) {
        for (const tab of ws.tabs) {
          const leaf = collectLeaves(tab.root).find((l) => l.id === paneId)
          if (!leaf) continue
          const profile = resolveProfile(profiles, leaf.profileId)
          actions.focusPane(paneId)
          void typeSkillIntoPane(paneId, skill, profile).then((ok) => {
            terminalHost.focus(paneId)
            if (!ok) actions.setNotice(`${skill.title} could not be typed — that pane is not running`)
          })
          return
        }
      }
    })
  }, [actions, profiles, workspaces])

  /* --------------------------------------------------------- use_skill
   *
   * The voice agent's route to the same behaviour. Registered on the bus rather
   * than passed down, because the runner it would travel in is built inside
   * VoicePanel — see src/lib/skillbus.ts.
   *
   * The pane arrives already resolved: `runAppAction` puts the spoken target
   * through the same `resolvePaneTarget` as `send_prompt`, so "terminal two"
   * cannot mean one terminal for a prompt and another for a skill, and an
   * ambiguous handle was refused before it reached here. All that is left is to
   * bring the pane forward and type.
   */
  useEffect(() => {
    return setSkillHandler(({ name, pane }) => {
      const skill = skillLibrary.find(name)
      if (!skill) return { ok: false, summary: `No skill called “${name}” in the library`, requested: 1, done: 0 }

      const profile = resolveProfile(profiles, pane.profileId)
      // revealPane, not focusPane: the resolver spans every tab in the project,
      // so the answer may well be in one that is not on screen.
      actions.revealPane(pane.paneId)
      void typeSkillIntoPane(pane.paneId, skill, profile).then((ok) => {
        terminalHost.focus(pane.paneId)
        if (!ok) actions.setNotice(`${skill.title} could not be typed — that pane is not running`)
      })
      return {
        ok: true,
        summary: `Typed /${skill.name} into ${paneLabel(pane)} — press Enter when you have read it`,
        requested: 1,
        done: 1
      }
    })
  }, [actions, profiles])

  if (collapsed) return null

  const enabled = skills.filter((s) => s.enabled).length

  return (
    <section className="skills" data-open={open}>
      <header className="skills__head">
        <button
          type="button"
          className="skills__toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="chevronDown" size={12} />
          <span className="eyebrow">Skills</span>
        </button>
        {skills.length > 0 ? (
          <span className="skills__count mono" title={`${enabled} of ${skills.length} live in every session`}>
            {enabled}/{skills.length}
          </span>
        ) : null}
        <button
          ref={addRef}
          type="button"
          className="ghost-btn skills__add"
          title="Add a skill"
          onClick={() => setAdding(true)}
        >
          <Icon name="plus" size={14} />
        </button>
      </header>

      {open ? (
        <div className="skills__list">
          {skills.length === 0 ? (
            <EmptyState
              icon="panel"
              size="sm"
              title="No skills yet"
              body="Skills you add work in every Claude and Kimi session — not just the panes Forge opened."
              action={
                <button type="button" className="cta-btn" onClick={() => setAdding(true)}>
                  Add skill
                </button>
              }
            />
          ) : (
            skills.map((skill) => <SkillRow key={skill.name} skill={skill} />)
          )}
        </div>
      ) : null}

      <AddSkillMenu anchor={addRef.current} open={adding} onClose={() => setAdding(false)} />
    </section>
  )
}

/* ------------------------------------------------------------------- row */

function SkillRow({ skill }: { skill: SkillInfo }): ReactNode {
  const { actions } = useApp()
  const rowRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLButtonElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const conflicted = skill.link === 'conflict'
  const title = [
    skill.description || 'No description in this skill’s frontmatter.',
    skill.problem ? `\n\n⚠ ${skill.problem}` : '',
    skill.alsoIn.length > 0 ? `\n\nAlso exists in: ${skill.alsoIn.join(', ')}` : ''
  ].join('')

  const toggle = async (): Promise<void> => {
    setBusy(true)
    const result = await window.forge.skills.setEnabled(skill.name, !skill.enabled)
    skillLibrary.apply(result.skills)
    setBusy(false)
    if (!result.ok && result.error) actions.setNotice(result.error)
  }

  return (
    <div
      ref={rowRef}
      className="srow"
      data-enabled={skill.enabled}
      data-problem={skill.problem ? 'true' : undefined}
      title={title}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SKILL_DRAG_MIME, skill.name)
        // A plain-text fallback so dropping on a text field is still useful.
        e.dataTransfer.setData('text/plain', `/${skill.name}`)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuOpen(true)
      }}
    >
      <span className="srow__grip" aria-hidden="true">
        <Icon name="grip" size={12} />
      </span>

      <span className="srow__text">
        <span className="srow__name truncate">{skill.title}</span>
        <span className="srow__desc truncate">
          {skill.problem ?? skill.description ?? ''}
          {!skill.problem && !skill.description ? `/${skill.name}` : ''}
        </span>
      </span>

      {skill.alsoIn.length > 0 ? (
        <span className="srow__dupe mono" title={`This name also exists in: ${skill.alsoIn.join(', ')}`}>
          2×
        </span>
      ) : null}

      <button
        type="button"
        className="srow__switch"
        role="switch"
        aria-checked={skill.enabled}
        aria-label={`${skill.enabled ? 'Disable' : 'Enable'} ${skill.title} everywhere`}
        data-conflict={conflicted ? 'true' : undefined}
        disabled={busy}
        title={
          conflicted
            ? `A different “${skill.name}” already exists in ~/.claude/skills — Forge will not overwrite it`
            : skill.enabled
              ? 'Live in every Claude and Kimi session. Click to remove.'
              : 'Turn on to make this skill available in every Claude and Kimi session'
        }
        onClick={() => void toggle()}
      >
        <span className="srow__knob" />
      </button>

      <button
        ref={menuRef}
        type="button"
        className="ghost-btn srow__menu"
        title="Skill actions"
        onClick={(e) => {
          e.stopPropagation()
          setMenuOpen(true)
        }}
      >
        <Icon name="dots" size={14} />
      </button>

      <SkillMenu
        anchor={menuRef.current ?? rowRef.current}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        skill={skill}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ menu */

function SkillMenu({
  anchor,
  open,
  onClose,
  skill
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  skill: SkillInfo
}): ReactNode {
  const { actions } = useApp()
  const [confirm, setConfirm] = useState(false)

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="start" width={272} label="Skill actions">
      <PopoverSection title={`/${skill.name}`}>
        <div className="popover__hint">
          {skill.enabled
            ? 'Live in every Claude and Kimi session on this machine.'
            : 'In your library only. Turn the switch on to make it live everywhere.'}
        </div>
      </PopoverSection>

      <PopoverRow
        onClick={() => {
          void window.forge.skills.openFolder(skill.name)
          onClose()
        }}
      >
        <Icon name="folder" size={14} />
        <span className="srow__menu-name">Open folder</span>
      </PopoverRow>

      <PopoverDivider />

      {confirm ? (
        <>
          <div className="popover__hint">
            Deletes {skill.name} from your library and removes it from ~/.claude/skills. This is a real delete.
          </div>
          <div className="popover__actions">
            <button type="button" className="ghost-btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="ghost-btn"
              data-danger="true"
              onClick={() => {
                void window.forge.skills.remove(skill.name).then((r) => {
                  skillLibrary.apply(r.skills)
                  if (!r.ok && r.error) actions.setNotice(r.error)
                })
                onClose()
              }}
            >
              Delete
            </button>
          </div>
        </>
      ) : (
        <PopoverRow danger onClick={() => setConfirm(true)}>
          <Icon name="trash" size={14} />
          <span className="srow__menu-name">Delete skill…</span>
        </PopoverRow>
      )}
    </Popover>
  )
}

/* ------------------------------------------------------------------- add */

function AddSkillMenu({
  anchor,
  open,
  onClose
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
}): ReactNode {
  const { actions } = useApp()
  const [mode, setMode] = useState<'pick' | 'new'>('pick')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const close = (): void => {
    setMode('pick')
    setName('')
    setDescription('')
    setError(null)
    onClose()
  }

  const create = async (): Promise<void> => {
    const result = await window.forge.skills.create(name, description)
    skillLibrary.apply(result.skills)
    if (!result.ok) {
      setError(result.error ?? 'Could not create that skill')
      return
    }
    close()
    void window.forge.skills.openFolder(result.name)
  }

  const importFolder = async (): Promise<void> => {
    const result = await window.forge.skills.importFolder()
    skillLibrary.apply(result.skills)
    if (result.cancelled) return
    if (!result.ok) {
      setError(result.error ?? 'Could not import that folder')
      return
    }
    close()
    actions.setNotice(`Imported ${result.name} — turn it on to use it everywhere`)
  }

  return (
    <Popover anchor={anchor} open={open} onClose={close} align="end" width={300} label="Add a skill">
      {mode === 'pick' ? (
        <>
          <PopoverSection title="Add a skill">
            <div className="popover__hint">
              A skill is a folder with a SKILL.md in it. Import one you already have, or start from a template.
            </div>
          </PopoverSection>
          <PopoverRow onClick={() => void importFolder()}>
            <Icon name="folder" size={14} />
            <span className="srow__menu-name">Import a folder…</span>
          </PopoverRow>
          <PopoverRow onClick={() => setMode('new')}>
            <Icon name="plus" size={14} />
            <span className="srow__menu-name">New skill from template</span>
          </PopoverRow>
          {error ? <div className="popover__hint" data-danger="true">{error}</div> : null}
        </>
      ) : (
        <PopoverSection title="New skill">
          <div className="field">
            <label className="field__label" htmlFor="skill-new-name">
              Name
            </label>
            <input
              id="skill-new-name"
              className="field__input mono"
              value={name}
              autoFocus
              spellCheck={false}
              placeholder="release-checklist"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="skill-new-desc">
              Description
            </label>
            <input
              id="skill-new-desc"
              className="field__input"
              value={description}
              spellCheck={false}
              placeholder="When and why an agent should use this"
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter' && name.trim()) void create()
              }}
            />
          </div>
          <div className="popover__hint">
            The description is what an agent reads to decide whether the skill applies — write it for the agent, not
            for yourself.
          </div>
          {error ? <div className="popover__hint" data-danger="true">{error}</div> : null}
          <div className="popover__actions">
            <button type="button" className="ghost-btn" onClick={() => setMode('pick')}>
              Back
            </button>
            <button type="button" className="cta-btn" disabled={!name.trim()} onClick={() => void create()}>
              Create
            </button>
          </div>
        </PopoverSection>
      )}
    </Popover>
  )
}
