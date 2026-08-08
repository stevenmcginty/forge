import { useEffect, useState, type ReactNode } from 'react'
import type { SkillInfo } from '@shared/skills'
import { packSize, pluginIsShareable, pluginRecipe, type PackPlugin, type SkillPack } from '@shared/skillpack'
import { skillLibrary, useSkills } from '@/lib/skills'
import { useApp } from '@/state/AppState'
import { Popover, PopoverSection } from './Popover'
import './SkillPack.css'

/**
 * Skill packs, in the interface.
 *
 * A `.forgepack` is the file you hand somebody so they end up with your skills.
 * Two sheets, and the asymmetry between them is the whole design:
 *
 * **Sharing** is a checklist — pick what goes in, save it, done. Nothing risky
 * can happen; it is your own library leaving your own machine.
 *
 * **Installing** is a *preview*, with the Install button at the bottom of it. A
 * pack is instructions an agent will follow, written by somebody else, and no
 * validator can tell you whether they are a good idea — `installPack` can prove
 * a pack does not write outside the folder it owns, and that is all it can
 * prove. So the sheet shows what is in the pack before a byte is written, and
 * says out loud that what lands arrives switched off.
 *
 * Split out of SkillsFlyout.tsx rather than added to it: that file is already
 * the rail, the rows, the drag and three menus, and a pack preview is none of
 * those things.
 */

/* ----------------------------------------------------------------- share */

/** Pick library skills, optionally attach the plugin recipes, save the file. */
export function SharePackSheet({
  anchor,
  open,
  skills,
  onClose
}: {
  anchor: HTMLElement | null
  open: boolean
  skills: SkillInfo[]
  onClose: () => void
}): ReactNode {
  const { actions } = useApp()
  const [chosen, setChosen] = useState<string[]>([])
  const [withPlugins, setWithPlugins] = useState(false)
  const [note, setNote] = useState('')
  const [recipes, setRecipes] = useState<PackPlugin[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Read once the sheet is actually open, so the flyout is not parsing Claude
  // Code's plugin manifest every time the rail renders.
  useEffect(() => {
    if (!open) return
    let live = true
    void window.forge.skills.pack.plugins().then((list) => {
      if (live) setRecipes(list)
    })
    return () => {
      live = false
    }
  }, [open])

  const close = (): void => {
    setChosen([])
    setWithPlugins(false)
    setNote('')
    setError(null)
    onClose()
  }

  const toggle = (name: string): void =>
    setChosen((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))

  /**
   * Both save buttons, which differ only in which call they make.
   *
   * The zip is the primary action because it is the one that works for the
   * larger audience: a `.forgepack` is richer — it previews and installs with
   * one button — and completely useless to somebody who does not run Forge,
   * which is most people a skill gets sent to.
   */
  const save = async (as: 'zip' | 'pack'): Promise<void> => {
    setBusy(true)
    const result =
      as === 'zip'
        ? await window.forge.skills.pack.exportZip(chosen, withPlugins, note)
        : await window.forge.skills.pack.exportPack(chosen, withPlugins, note)
    setBusy(false)
    if (result.cancelled) return
    if (!result.ok) {
      setError(result.error ?? 'Could not save that')
      return
    }
    const parts = [
      `${result.skills ?? 0} skill${result.skills === 1 ? '' : 's'}`,
      result.plugins ? `${result.plugins} plugin recipe${result.plugins === 1 ? '' : 's'}` : ''
    ].filter(Boolean)
    close()
    // Anything left out is folded into the same sentence rather than raised as
    // a second notice: the save worked, and a skipped file is not a failure —
    // but an archive that quietly contained less than was asked for would be
    // discovered by the recipient instead of the sender.
    const left = result.skipped.length > 0 ? ` · left out ${result.skipped.length}` : ''
    actions.setNotice(`Saved ${parts.join(' and ')} — ${packSize(result.bytes ?? 0)}${left}`)
  }

  const nothing = chosen.length === 0 && !withPlugins
  const all = skills.length > 0 && chosen.length === skills.length

  return (
    <Popover anchor={anchor} open={open} onClose={close} align="end" width={340} label="Share skills">
      <PopoverSection title="Share skills">
        <div className="popover__hint">
          Your own skills travel as files. Installed plugins travel as the commands that reinstall them — never as
          copies, so the author keeps the update path.
        </div>
      </PopoverSection>

      {skills.length > 1 ? (
        <div className="pack__all">
          <button type="button" className="ghost-btn" onClick={() => setChosen(all ? [] : skills.map((s) => s.name))}>
            {all ? 'Clear' : `Select all ${skills.length}`}
          </button>
        </div>
      ) : null}

      <div className="pack__list">
        {skills.map((skill) => (
          <label key={skill.name} className="pack__pick">
            <input type="checkbox" checked={chosen.includes(skill.name)} onChange={() => toggle(skill.name)} />
            <span className="pack__pick-text">
              <span className="pack__pick-name">{skill.title || skill.name}</span>
              {skill.description ? <span className="pack__pick-desc">{skill.description}</span> : null}
            </span>
          </label>
        ))}
      </div>

      <PopoverSection>
        <label className="pack__pick">
          <input
            type="checkbox"
            checked={withPlugins}
            disabled={recipes.length === 0}
            onChange={() => setWithPlugins((v) => !v)}
          />
          <span className="pack__pick-text">
            <span className="pack__pick-name">
              Include my plugin list
              {recipes.length > 0 ? <span className="mono pack__count">{recipes.length}</span> : null}
            </span>
            <span className="pack__pick-desc">
              {recipes.length === 0
                ? 'No plugins installed'
                : 'The commands that reinstall them, for the recipient to run'}
            </span>
          </span>
        </label>

        <div className="field">
          <label className="field__label" htmlFor="pack-note">
            Note (optional)
          </label>
          <input
            id="pack-note"
            className="field__input"
            value={note}
            spellCheck={false}
            placeholder="What this is, for whoever opens it"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>

        {error ? (
          <div className="popover__hint" data-danger="true">
            {error}
          </div>
        ) : null}

        {/* Which file to send, said in one line rather than left to the button
            labels — "zip" and "pack" mean nothing until you know that only one
            of them works for someone without Forge. */}
        <div className="popover__hint">
          A <strong>zip</strong> works for anyone: they unzip it into their skills folder, Forge or no Forge. A{' '}
          <strong>pack</strong> is one file another Forge previews and installs in a click.
        </div>

        <div className="popover__actions">
          <button type="button" className="ghost-btn" disabled={nothing || busy} onClick={() => void save('pack')}>
            Save pack…
          </button>
          <button type="button" className="cta-btn" disabled={nothing || busy} onClick={() => void save('zip')}>
            {busy ? 'Saving…' : 'Save zip…'}
          </button>
        </div>
      </PopoverSection>
    </Popover>
  )
}

/* --------------------------------------------------------------- install */

/**
 * What is in this pack, before any of it is written.
 *
 * Skills whose names the library already has are shown and cannot be ticked:
 * an import never overwrites (see installPack), so offering the tick and then
 * refusing it would be telling the same lie twice.
 */
export function PackPreview({
  pack,
  path,
  dropped,
  onBack,
  onDone
}: {
  pack: SkillPack
  path: string
  dropped: string[]
  onBack: () => void
  onDone: () => void
}): ReactNode {
  const { actions } = useApp()
  const { skills: library } = useSkills()
  const taken = new Set(library.map((s) => s.name))
  const [chosen, setChosen] = useState<string[]>(() => pack.skills.filter((s) => !taken.has(s.name)).map((s) => s.name))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (name: string): void =>
    setChosen((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))

  const install = async (): Promise<void> => {
    setBusy(true)
    const result = await window.forge.skills.pack.install(path, chosen)
    setBusy(false)
    skillLibrary.apply(result)
    if (!result.ok && result.error) {
      setError(result.error)
      return
    }
    onDone()
    const skipped = result.skipped.length > 0 ? ` · skipped ${result.skipped.length}` : ''
    actions.setNotice(
      result.installed.length > 0
        ? `Installed ${result.installed.length} skill${result.installed.length === 1 ? '' : 's'} — switched off until you turn them on${skipped}`
        : `Nothing was installed${skipped}`
    )
  }

  return (
    <>
      <PopoverSection title="Install from a pack">
        <div className="popover__hint">
          {pack.from ? `From ${pack.from}. ` : ''}
          {pack.skills.length} skill{pack.skills.length === 1 ? '' : 's'}
          {pack.plugins.length > 0
            ? `, ${pack.plugins.length} plugin recipe${pack.plugins.length === 1 ? '' : 's'}`
            : ''}
          .
        </div>
        {pack.note ? <div className="pack__note">{pack.note}</div> : null}
      </PopoverSection>

      {pack.skills.length > 0 ? (
        <div className="pack__list">
          {pack.skills.map((skill) => {
            const clash = taken.has(skill.name)
            return (
              <label key={skill.name} className="pack__pick" data-off={clash ? 'true' : undefined}>
                <input
                  type="checkbox"
                  checked={!clash && chosen.includes(skill.name)}
                  disabled={clash}
                  onChange={() => toggle(skill.name)}
                />
                <span className="pack__pick-text">
                  <span className="pack__pick-name">{skill.title || skill.name}</span>
                  <span className="pack__pick-desc">
                    {clash
                      ? 'Already in your library — nothing will be replaced'
                      : skill.description || 'No description'}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      ) : null}

      {pack.plugins.length > 0 ? <PackPlugins plugins={pack.plugins} /> : null}

      {dropped.length > 0 ? (
        <PopoverSection title="Left out of this pack">
          {/* Never silent. A pack that carries less than it claimed says so
              here, rather than being discovered later as a skill missing a
              file it needed. */}
          <div className="popover__hint" data-danger="true">
            {dropped.slice(0, 4).map((entry) => (
              <div key={entry}>{entry}</div>
            ))}
            {dropped.length > 4 ? <div>…and {dropped.length - 4} more</div> : null}
          </div>
        </PopoverSection>
      ) : null}

      <PopoverSection>
        <div className="popover__hint">
          Skills install <strong>switched off</strong>. A skill is instructions an agent follows — read it, then turn it
          on when you are happy with it.
        </div>
        {error ? (
          <div className="popover__hint" data-danger="true">
            {error}
          </div>
        ) : null}
        <div className="popover__actions">
          <button type="button" className="ghost-btn" onClick={onBack}>
            Back
          </button>
          <button
            type="button"
            className="cta-btn"
            disabled={chosen.length === 0 || busy}
            onClick={() => void install()}
          >
            {busy ? 'Installing…' : `Install ${chosen.length || ''}`.trim()}
          </button>
        </div>
      </PopoverSection>
    </>
  )
}

/**
 * The plugin half: commands to run, not something Forge installs.
 *
 * `/plugin` belongs to Claude Code, the tree it writes belongs to its plugin
 * manager, and installing somebody else's plugin should cost a deliberate
 * keystroke in a pane a person is looking at. So this offers the commands for
 * copying and gets out of the way.
 */
function PackPlugins({ plugins }: { plugins: PackPlugin[] }): ReactNode {
  const { actions } = useApp()
  const shareable = plugins.filter(pluginIsShareable)
  const local = plugins.filter((plugin) => !pluginIsShareable(plugin))

  return (
    <PopoverSection title="Plugins the sender had">
      <div className="popover__hint">Not installed by Forge. Copy these into a Claude pane and run them there.</div>
      {shareable.map((plugin) => (
        <div key={`${plugin.plugin}@${plugin.marketplace}`} className="pack__recipe">
          <div className="pack__recipe-head">
            <span className="pack__pick-name">{plugin.plugin}</span>
            <span className="mono pack__count">{plugin.version}</span>
            <button
              type="button"
              className="ghost-btn pack__copy"
              title={`Copy the install commands for ${plugin.plugin}`}
              onClick={() => {
                void navigator.clipboard.writeText(pluginRecipe(plugin).join('\n'))
                actions.setNotice(`Copied the install commands for ${plugin.plugin}`)
              }}
            >
              Copy
            </button>
          </div>
          {pluginRecipe(plugin).map((line) => (
            <code key={line} className="mono pack__cmd">
              {line}
            </code>
          ))}
        </div>
      ))}
      {local.length > 0 ? (
        <div className="popover__hint">
          {local.length} came from a folder on the sender&rsquo;s own machine and cannot be installed from here:{' '}
          {local.map((plugin) => plugin.plugin).join(', ')}.
        </div>
      ) : null}
    </PopoverSection>
  )
}
