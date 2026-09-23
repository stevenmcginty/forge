import { useMemo, useState, type ReactNode } from 'react'
import { useKeymap } from '@/hooks/useHub'
import { formatCombo } from '@/lib/keymap'
import { KeyRecorder, Keys } from '../hub/KeyRecorder'
import { Card, Section } from './parts'
import '../hub/Shortcuts.css'

/**
 * Settings › Shortcuts: every command Forge knows, the keys it answers to, and
 * a way to change them.
 *
 * Click Change and press the new keys. A combo a terminal needs is refused on
 * the spot with the reason; one another command already has is not taken
 * silently — the row says who has it and offers to take it over, which
 * unbinds the other command explicitly. Reset puts one command (or all of
 * them) back to Forge's defaults. Saved to keymap.json the moment it changes.
 */
export function ShortcutsSection(): ReactNode {
  const km = useKeymap()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [clash, setClash] = useState<{ id: string; combo: string; error: string; others: string[] } | null>(null)
  const [error, setError] = useState<{ id: string; text: string } | null>(null)

  const titleOf = useMemo(() => new Map(km.commands.map((c) => [c.id, c.title])), [km.commands])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = new Map<string, typeof km.commands>()
    for (const c of km.commands) {
      if (q && !`${c.title} ${c.group} ${c.description ?? ''} ${c.keys.join(' ')}`.toLowerCase().includes(q)) continue
      const list = out.get(c.group) ?? []
      list.push(c)
      out.set(c.group, list)
    }
    return [...out.entries()]
  }, [km.commands, query])

  const customised = km.commands.filter((c) => c.customised).length

  const record = (id: string, combo: string, takeOver = false): void => {
    const r = km.setKeys(id, [combo], { takeOver })
    if (r.ok) {
      setEditing(null)
      setClash(null)
      setError(null)
      return
    }
    setEditing(null)
    if (r.conflictsWith?.length) setClash({ id, combo, error: r.error, others: r.conflictsWith })
    else setError({ id, text: r.error })
  }

  return (
    <Section
      title="Shortcuts"
      blurb="Every key Forge answers to. Keys a terminal needs — plain letters, Ctrl+C, arrows, Esc — can never be taken, so a shortcut can never eat your typing. Ctrl+Shift+/ shows them all at once."
    >
      <div className="kmap__bar">
        <input
          className="field__input kmap__search"
          placeholder="Search commands or keys…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <span className="kmap__count">
          {km.commands.length} commands{customised ? ` · ${customised} changed by you` : ''}
        </span>
        <button type="button" className="ghost-btn" disabled={!customised} onClick={() => km.reset()}>
          Reset all
        </button>
      </div>

      {km.conflicts.length || km.rejected.length ? (
        <Card tone="warn" title="Needs a look">
          {km.conflicts.map((c) => (
            <p key={c.combo} className="kmap__warn">
              <span aria-hidden="true">⚠</span> <Keys combo={c.combo} size="sm" /> is wanted by{' '}
              {c.commandIds.map((id) => titleOf.get(id) ?? id).join(' and ')} — {titleOf.get(c.commandIds[0]!) ?? c.commandIds[0]} keeps it.
            </p>
          ))}
          {km.rejected.map((r) => (
            <p key={`${r.commandId}:${r.combo}`} className="kmap__warn">
              <span aria-hidden="true">⚠</span> {titleOf.get(r.commandId) ?? r.commandId}: {formatCombo(r.combo)} was not bound — {r.reason}
            </p>
          ))}
        </Card>
      ) : null}

      {groups.map(([group, list]) => (
        <Card key={group} title={group}>
          <div className="kmap__list">
            {list.map((c) => (
              <div key={c.id} className="kmrow" data-editing={editing === c.id ? 'true' : undefined} data-custom={c.customised ? 'true' : undefined}>
                <div className="kmrow__text">
                  <span className="kmrow__title">
                    {c.title}
                    {c.customised ? <span className="kmrow__tag">changed</span> : null}
                    {!c.available ? <span className="kmrow__tag kmrow__tag--idle" title="Nothing that runs this is on screen right now; the key passes through to the terminal">idle</span> : null}
                  </span>
                  {c.description ? <span className="kmrow__desc">{c.description}</span> : null}
                </div>

                <div className="kmrow__keys">
                  {editing === c.id ? (
                    <KeyRecorder
                      talk={c.kind === 'talk'}
                      value={c.keys[0] ?? null}
                      onRecord={(combo) => record(c.id, combo)}
                      onCancel={() => setEditing(null)}
                      onClear={() => {
                        km.setKeys(c.id, [])
                        setEditing(null)
                      }}
                    />
                  ) : c.keys.length ? (
                    c.keys.map((k) => <Keys key={k} combo={k} />)
                  ) : (
                    <span className="kmrow__none">no key</span>
                  )}
                </div>

                <div className="kmrow__acts">
                  {editing === c.id ? null : (
                    <button
                      type="button"
                      className="ghost-btn kmrow__btn"
                      onClick={() => {
                        setClash(null)
                        setError(null)
                        setEditing(c.id)
                      }}
                    >
                      Change
                    </button>
                  )}
                  {c.customised ? (
                    <button type="button" className="ghost-btn kmrow__btn" title="Back to Forge's default" onClick={() => km.reset(c.id)}>
                      Reset
                    </button>
                  ) : null}
                </div>

                {clash?.id === c.id ? (
                  <div className="kmrow__clash" role="alert">
                    <span aria-hidden="true">⚠</span>
                    <span>
                      <Keys combo={clash.combo} size="sm" /> already runs{' '}
                      <strong>{clash.others.map((id) => titleOf.get(id) ?? id).join(', ')}</strong>.
                    </span>
                    <button type="button" className="cta-btn kmrow__btn" onClick={() => record(c.id, clash.combo, true)}>
                      Take it over
                    </button>
                    <button type="button" className="ghost-btn kmrow__btn" onClick={() => setClash(null)}>
                      Keep both as they were
                    </button>
                  </div>
                ) : null}
                {error?.id === c.id ? (
                  <div className="kmrow__clash" role="alert">
                    <span aria-hidden="true">✕</span>
                    <span>{error.text}</span>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      ))}
      {groups.length === 0 ? <p className="sset__foot">No command matches “{query}”.</p> : null}
    </Section>
  )
}
