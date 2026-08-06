import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MachineSkillInfo, SkillInfo } from '@shared/skills'
import { resolveProfile } from '@/lib/agents'
import { paneLabel } from '@/lib/appactions'
import { collectLeaves } from '@/lib/splitTree'
import { setSkillCatalogue, setSkillHandler } from '@/lib/skillbus'
import { dedupeSkills, skillLibrary, startSkillDrag, typeSkillIntoPane, useSkills } from '@/lib/skills'
import { terminalHost } from '@/lib/terminals'
import { useActiveTab, useApp } from '@/state/AppState'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'
import { Popover, PopoverDivider, PopoverRow, PopoverSection } from './Popover'
import './SkillsFlyout.css'

/**
 * SKILLS — a word in the tab strip, and a flyout under it.
 *
 * A skill here is not a Forge feature. It is a folder that every `claude` and
 * `kimi` on this machine reads, whether Forge opened the session or not, and the
 * toggle in each library row is the switch that puts it there.
 *
 * It has moved twice, and both moves were the same argument. First out of an
 * inline rail section, which ate a third of the rail, into a button and a
 * flyout — a popover costs no height at all, can be wider than whatever opened
 * it, and closes itself the moment you look away. Then out of the rail
 * altogether and into the strip beside Commands, because the rail is for
 * *navigating* (which project am I in) and a skill is a thing you reach for
 * while looking at a pane. It now sits with the other reference control, and
 * the strip had the room.
 *
 * Every behaviour survived both moves — drag to a pane, toggles, add/import,
 * the ⋯ menus — because the flyout is where they live, not a summary of them.
 * The one thing that changed with this move is which way it opens: from the
 * foot of the rail it grew upward, from the strip it drops, exactly like
 * Commands does.
 */
export function SkillsButton(): ReactNode {
  const { state, actions } = useApp()
  const { skills, machineSkills } = useSkills()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  /* Tell the voice agent's manifest what it may name. Registered once, reads
     live — see setSkillCatalogue for why it is a getter and not a value. The
     roster is both groups, machine skills shadowed by the library. */
  useEffect(() => setSkillCatalogue(() => skillLibrary.catalogue()), [])

  const profiles = state.settings.agentProfiles

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

  // The badge counts what is actually reachable: the library, plus the machine
  // skills the library is not already shadowing. Counting both raw would claim
  // a name twice.
  const total = skills.length + dedupeSkills(skills, machineSkills).length
  const live = skills.filter((s) => s.enabled).length + dedupeSkills(skills, machineSkills).length

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="ghost-btn tabstrip__skills"
        aria-expanded={open}
        data-on={open ? 'true' : undefined}
        title={`${total} skill${total === 1 ? '' : 's'} — ${live} live in every Claude and Kimi session`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="panel" size={12} />
        Skills
        {total > 0 ? <span className="tabstrip__tally mono">{total}</span> : null}
      </button>

      <SkillsPanel anchor={buttonRef.current} open={open} onClose={() => setOpen(false)} />
    </>
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
function SkillsPanel({
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
      // Anchored to the button's right edge and dropping, which is what the
      // Commands flyout beside it does — two controls a few pixels apart that
      // opened in different directions would read as two unrelated things.
      align="end"
      // Wide on purpose — that is half of why this is a flyout and not an
      // inline expander. A skill's description is the only thing that tells you
      // which of "fable-loop" and "fable-method" you want.
      width={404}
      label="Skills"
    >
      <div className="sfly">
        <header className="sfly__head">
          <span className="eyebrow">Skills</span>
          {/* The one line of the flyout that has to teach something: a skill is
              only useful once it is in a terminal, and neither way of getting
              it there is visible until you know it. */}
          <span className="sfly__hint">Drag one onto a terminal — or double-click</span>
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

/* ---------------------------------------------------------- drop on a pane
 *
 * The other half of the drag: the pane id comes back from the gesture, and this
 * is the profile lookup that decides whether that pane gets `/name` or the
 * skill's prose. It searches every loaded workspace, not just the active one,
 * because the mosaic wall shows panes from tabs you are not currently in.
 */
function useDropSkill(): (paneId: string, name: string) => void {
  const { state, actions } = useApp()

  return (paneId: string, name: string): void => {
    const found = skillLibrary.find(name)
    if (!found) return
    for (const ws of Object.values(state.workspaces)) {
      for (const tab of ws.tabs) {
        const leaf = collectLeaves(tab.root).find((l) => l.id === paneId)
        if (!leaf) continue
        const profile = resolveProfile(state.settings.agentProfiles, leaf.profileId)
        actions.focusPane(paneId)
        void typeSkillIntoPane(paneId, found, profile).then((ok) => {
          terminalHost.focus(paneId)
          if (!ok) actions.setNotice(`${found.skill.title} could not be typed — that pane is not running`)
        })
        return
      }
    }
  }
}

/* ------------------------------------------------------ send to a terminal
 *
 * The drag is the quick way. This is the one that always works: no pointer
 * gymnastics across a flyout, no question of which pane you were over. It types
 * into the pane that already has focus, which is nearly always the pane you
 * meant — and it is what the ⋯ menu and a double-click on a row both call.
 */
function useSendSkill(): (name: string) => void {
  const { state, actions } = useApp()
  const tab = useActiveTab()

  return (name: string): void => {
    const found = skillLibrary.find(name)
    if (!found) return
    const leaf = tab ? collectLeaves(tab.root).find((l) => l.id === tab.activePaneId) : undefined
    if (!leaf) {
      actions.setNotice('Open a terminal first — a skill has to be typed into something')
      return
    }
    const profile = resolveProfile(state.settings.agentProfiles, leaf.profileId)
    actions.focusPane(leaf.id)
    void typeSkillIntoPane(leaf.id, found, profile).then((ok) => {
      terminalHost.focus(leaf.id)
      if (!ok) actions.setNotice(`${found.skill.title} could not be typed — that pane is not running`)
    })
  }
}

/* ------------------------------------------------------------------- row */

function SkillRow({ skill, onMenu }: { skill: SkillInfo; onMenu: (up: boolean) => void }): ReactNode {
  const { actions } = useApp()
  const send = useSendSkill()
  const drop = useDropSkill()
  const rowRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLButtonElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const conflicted =
    skill.link === 'conflict' || skill.codexLink === 'conflict' || skill.antigravityLink === 'conflict'
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
      onPointerDown={(e) => startSkillDrag(e, skill.name, drop)}
      onDoubleClick={() => send(skill.name)}
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
            ? 'A different skill with this name already exists in Claude, Codex, or Antigravity — Forge will not overwrite it'
            : skill.enabled
              ? 'Live in Claude, Codex, and Antigravity. Click to remove.'
              : 'Turn on to make this skill available in Claude, Codex, and Antigravity'
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
  const send = useSendSkill()
  const drop = useDropSkill()
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
      onPointerDown={(e) => startSkillDrag(e, skill.name, drop)}
      onDoubleClick={() => send(skill.name)}
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
  const send = useSendSkill()
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
          send(skill.name)
          onClose()
        }}
      >
        <Icon name="terminal" size={14} />
        <span className="srow__menu-name">Type into this terminal</span>
      </PopoverRow>

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
  const send = useSendSkill()

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="start" width={288} label="Skill actions">
      <PopoverSection title={`/${skill.name}`}>
        <div className="popover__hint">
          Yours, in ~/.claude/skills — every Claude and Kimi session already has it. Forge only reads this folder.
        </div>
      </PopoverSection>

      <PopoverRow
        onClick={() => {
          send(skill.name)
          onClose()
        }}
      >
        <Icon name="terminal" size={14} />
        <span className="srow__menu-name">Type into this terminal</span>
      </PopoverRow>

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
