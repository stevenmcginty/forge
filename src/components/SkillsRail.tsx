import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MachineSkillInfo, SkillInfo } from '@shared/skills'
import { resolveProfile } from '@/lib/agents'
import { paneLabel } from '@/lib/appactions'
import { collectLeaves } from '@/lib/splitTree'
import { setSkillCatalogue, setSkillHandler } from '@/lib/skillbus'
import {
  SKILL_DRAG_MIME,
  dedupeSkills,
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
 * SKILLS — one row at the foot of the rail, and a flyout behind it.
 *
 * A skill here is not a Forge feature. It is a folder that every `claude` and
 * `kimi` on this machine reads, whether Forge opened the session or not, and the
 * toggle in each library row is the switch that puts it there.
 *
 * It used to be an inline section, and it ate a third of the rail. The rail is
 * for *navigating* — projects — and skills are a thing you keep, reach for
 * occasionally and otherwise want out of the way. So the section collapsed to a
 * single button and everything it used to show moved into a flyout: a popover
 * takes no rail height at all (an inline expander still owns its row plus the
 * space it grows into), it can be wider than the rail, which is what lets the
 * descriptions actually read, and it closes itself the moment you look away.
 * Every behaviour survived the move — drag to a pane, toggles, add/import, the
 * ⋯ menus — because the flyout is where they live now, not a summary of them.
 */
export function SkillsRail(): ReactNode {
  const { state, actions } = useApp()
  const collapsed = state.settings.railCollapsed
  const { skills, machineSkills } = useSkills()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  /* Tell the voice agent's manifest what it may name. Registered once, reads
     live — see setSkillCatalogue for why it is a getter and not a value. The
     roster is both groups, machine skills shadowed by the library. */
  useEffect(() => setSkillCatalogue(() => skillLibrary.catalogue()), [])

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
      const found = skillLibrary.find(name)
      if (!found) return
      for (const ws of Object.values(workspaces)) {
        for (const tab of ws.tabs) {
          const leaf = collectLeaves(tab.root).find((l) => l.id === paneId)
          if (!leaf) continue
          const profile = resolveProfile(profiles, leaf.profileId)
          actions.focusPane(paneId)
          void typeSkillIntoPane(paneId, found, profile).then((ok) => {
            terminalHost.focus(paneId)
            if (!ok) {
              actions.setNotice(`${found.skill.title} could not be typed — that pane is not running`)
            }
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
   *
   * `find` spans both folders, so "use the apple design skill" reaches one of
   * Steve's own ~/.claude/skills exactly as it reaches a library one.
   */
  useEffect(() => {
    return setSkillHandler(({ name, pane }) => {
      const found = skillLibrary.find(name)
      if (!found) return { ok: false, summary: `No skill called “${name}”`, requested: 1, done: 0 }

      const profile = resolveProfile(profiles, pane.profileId)
      // revealPane, not focusPane: the resolver spans every tab in the project,
      // so the answer may well be in one that is not on screen.
      actions.revealPane(pane.paneId)
      void typeSkillIntoPane(pane.paneId, found, profile).then((ok) => {
        terminalHost.focus(pane.paneId)
        if (!ok) actions.setNotice(`${found.skill.title} could not be typed — that pane is not running`)
      })
      return {
        ok: true,
        summary: `Typed /${found.skill.name} into ${paneLabel(pane)} — press Enter when you have read it`,
        requested: 1,
        done: 1
      }
    })
  }, [actions, profiles])

  if (collapsed) return null

  // The badge counts what is actually reachable: the library, plus the machine
  // skills the library is not already shadowing. Counting both raw would claim
  // a name twice.
  const total = skills.length + dedupeSkills(skills, machineSkills).length
  const live = skills.filter((s) => s.enabled).length + dedupeSkills(skills, machineSkills).length

  return (
    <section className="skills">
      <button
        ref={buttonRef}
        type="button"
        className="skills__btn"
        aria-expanded={open}
        title={`${total} skill${total === 1 ? '' : 's'} — ${live} live in every Claude and Kimi session`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="panel" size={13} />
        <span className="skills__label">Skills</span>
        {total > 0 ? <span className="skills__count mono">{total}</span> : null}
        <span className="skills__chev" aria-hidden="true">
          <Icon name="chevronDown" size={12} />
        </span>
      </button>

      <SkillsFlyout anchor={buttonRef.current} open={open} onClose={() => setOpen(false)} />
    </section>
  )
}

/* --------------------------------------------------------------- flyout */

/**
 * Everything the section used to be, floating.
 *
 * `nested` is the one piece of plumbing worth explaining. The ⋯ menus and the
 * add menu are Popovers of their own, portalled to <body> — so a pointerdown
 * inside one lands *outside* this flyout, and the flyout's own
 * close-on-outside-click would pull the ground out from under the menu before
 * its click ever fired. Counting the open children and refusing to close while
 * any of them are up is what makes a menu inside a flyout behave like a menu.
 */
function SkillsFlyout({
  anchor,
  open,
  onClose
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
}): ReactNode {
  const { skills, machineSkills } = useSkills()
  const [nested, setNested] = useState(0)
  const [adding, setAdding] = useState(false)
  const addRef = useRef<HTMLButtonElement | null>(null)

  const enabled = skills.filter((s) => s.enabled).length
  const machine = dedupeSkills(skills, machineSkills)

  const track = (up: boolean): void => setNested((n) => Math.max(0, n + (up ? 1 : -1)))

  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={() => {
        if (nested === 0) onClose()
      }}
      align="start"
      side="top"
      // Wider than the rail on purpose — that is half of why this is a flyout
      // and not an inline expander. A skill's description is the only thing
      // that tells you which of "fable-loop" and "fable-method" you want.
      width={404}
      label="Skills"
    >
      <div className="sfly">
        <header className="sfly__head">
          <span className="eyebrow">Skills</span>
          <span className="sfly__hint">Available to every Claude and Kimi session</span>
          <button
            ref={addRef}
            type="button"
            className="ghost-btn sfly__add"
            title="Add a skill"
            onClick={() => {
              track(true)
              setAdding(true)
            }}
          >
            <Icon name="plus" size={14} />
          </button>
        </header>

        <div className="sfly__scroll">
          <div className="sfly__group">
            <span className="eyebrow sfly__eyebrow">
              Library
              {skills.length > 0 ? <span className="mono sfly__tally">{enabled}/{skills.length} on</span> : null}
            </span>
            {skills.length === 0 ? (
              <EmptyState
                icon="panel"
                size="sm"
                title="No skills yet"
                body="Skills you add work in every Claude and Kimi session — not just the panes Forge opened."
                action={
                  <button
                    type="button"
                    className="cta-btn"
                    onClick={() => {
                      track(true)
                      setAdding(true)
                    }}
                  >
                    Add skill
                  </button>
                }
              />
            ) : (
              skills.map((skill) => <SkillRow key={skill.name} skill={skill} onMenu={track} />)
            )}
          </div>

          {machineSkills.length > 0 ? (
            <div className="sfly__group">
              <span className="eyebrow sfly__eyebrow">
                On this machine
                <span className="mono sfly__tally">~/.claude/skills</span>
              </span>
              {machine.map((skill) => (
                <MachineSkillRow key={skill.name} skill={skill} onMenu={track} />
              ))}
              {/* A machine skill the library also has a name for is not listed
                  twice — the library row above is the one with the switch. */}
              {machineSkills.length > machine.length ? (
                <div className="sfly__shadow">
                  {machineSkills.length - machine.length} more shadowed by a library skill of the same name
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <AddSkillMenu
        anchor={addRef.current}
        open={adding}
        onClose={() => {
          setAdding(false)
          track(false)
        }}
      />
    </Popover>
  )
}

/* ------------------------------------------------------------------- row */

/**
 * The drag payload, and the reason the flyout gets out of the way.
 *
 * A popover is a real element with real pointer events, so a skill dragged out
 * of it would be dropped *on the flyout* the moment the pointer crossed back
 * over one. Marking the body for the length of the drag turns every popover
 * transparent to it, and the document-level drop target underneath sees the
 * pane it was actually aimed at.
 */
function beginSkillDrag(e: React.DragEvent, name: string): void {
  e.dataTransfer.setData(SKILL_DRAG_MIME, name)
  // A plain-text fallback so dropping on a text field is still useful.
  e.dataTransfer.setData('text/plain', `/${name}`)
  e.dataTransfer.effectAllowed = 'copy'
  document.body.dataset['skillDragging'] = 'true'
}

function endSkillDrag(): void {
  delete document.body.dataset['skillDragging']
}

function SkillRow({ skill, onMenu }: { skill: SkillInfo; onMenu: (up: boolean) => void }): ReactNode {
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

  const openMenu = (): void => {
    onMenu(true)
    setMenuOpen(true)
  }
  const closeMenu = (): void => {
    setMenuOpen(false)
    onMenu(false)
  }

  const toggle = async (): Promise<void> => {
    setBusy(true)
    const result = await window.forge.skills.setEnabled(skill.name, !skill.enabled)
    skillLibrary.apply(result)
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
      onDragStart={(e) => beginSkillDrag(e, skill.name)}
      onDragEnd={endSkillDrag}
      onContextMenu={(e) => {
        e.preventDefault()
        openMenu()
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
          openMenu()
        }}
      >
        <Icon name="dots" size={14} />
      </button>

      <SkillMenu anchor={menuRef.current ?? rowRef.current} open={menuOpen} onClose={closeMenu} skill={skill} />
    </div>
  )
}

/* ----------------------------------------------------------- machine row */

/**
 * One of Steve's own skills, read straight out of ~/.claude/skills.
 *
 * No switch, deliberately: there is nothing to turn on. These are already
 * loaded by every claude and kimi session on the machine — that is what being
 * in that folder *means* — so a toggle here could only ever mean "delete it",
 * and Forge does not delete Steve's skills. The row still drags onto a pane and
 * the voice agent can still name it; the ⋯ menu opens the folder, or takes a
 * copy into the library where Forge is allowed to edit.
 */
function MachineSkillRow({
  skill,
  onMenu
}: {
  skill: MachineSkillInfo
  onMenu: (up: boolean) => void
}): ReactNode {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLButtonElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const openMenu = (): void => {
    onMenu(true)
    setMenuOpen(true)
  }
  const closeMenu = (): void => {
    setMenuOpen(false)
    onMenu(false)
  }

  return (
    <div
      ref={rowRef}
      className="srow"
      data-machine="true"
      data-problem={skill.problem ? 'true' : undefined}
      title={[skill.description || 'No description in this skill’s frontmatter.', skill.problem ? `\n\n⚠ ${skill.problem}` : ''].join('')}
      draggable
      onDragStart={(e) => beginSkillDrag(e, skill.name)}
      onDragEnd={endSkillDrag}
      onContextMenu={(e) => {
        e.preventDefault()
        openMenu()
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

      <span className="srow__live" title="Already loaded by every Claude and Kimi session — nothing to switch on">
        active everywhere
      </span>

      <button
        ref={menuRef}
        type="button"
        className="ghost-btn srow__menu"
        title="Skill actions"
        onClick={(e) => {
          e.stopPropagation()
          openMenu()
        }}
      >
        <Icon name="dots" size={14} />
      </button>

      <MachineSkillMenu anchor={menuRef.current ?? rowRef.current} open={menuOpen} onClose={closeMenu} skill={skill} />
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
                  skillLibrary.apply(r)
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

/**
 * The machine menu has no delete and never will.
 *
 * "Copy into library" is a copy in the strict sense — the folder in
 * ~/.claude/skills is read and left exactly as it was. Enabling the copy
 * afterwards would hit the conflict interlock against the original, which is
 * the right answer: that name is already taken on the machine.
 */
function MachineSkillMenu({
  anchor,
  open,
  onClose,
  skill
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  skill: MachineSkillInfo
}): ReactNode {
  const { actions } = useApp()

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="start" width={288} label="Skill actions">
      <PopoverSection title={`/${skill.name}`}>
        <div className="popover__hint">
          Yours, in ~/.claude/skills — every Claude and Kimi session already has it. Forge only reads this folder.
        </div>
      </PopoverSection>

      <PopoverRow
        onClick={() => {
          void window.forge.skills.openFolder(skill.name, 'machine')
          onClose()
        }}
      >
        <Icon name="folder" size={14} />
        <span className="srow__menu-name">Open folder</span>
      </PopoverRow>

      <PopoverRow
        onClick={() => {
          void window.forge.skills.copyToLibrary(skill.name).then((r) => {
            skillLibrary.apply(r)
            actions.setNotice(
              r.ok
                ? `Copied ${skill.name} into your library — the original is untouched`
                : (r.error ?? `Could not copy ${skill.name}`)
            )
          })
          onClose()
        }}
      >
        <Icon name="plus" size={14} />
        <span className="srow__menu-name">Copy into library</span>
      </PopoverRow>
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
    skillLibrary.apply(result)
    if (!result.ok) {
      setError(result.error ?? 'Could not create that skill')
      return
    }
    close()
    void window.forge.skills.openFolder(result.name)
  }

  const importFolder = async (): Promise<void> => {
    const result = await window.forge.skills.importFolder()
    skillLibrary.apply(result)
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
