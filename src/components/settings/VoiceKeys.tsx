import { useState, type ReactNode } from 'react'
import { useKeymap } from '@/hooks/useHub'
import { TALK_AGENT_ID, TALK_DICTATE_ID } from '@/lib/shortcutCommands'
import { useHubView } from '../hub/hubView'
import { KeyRecorder, Keys } from '../hub/KeyRecorder'
import { Card } from './parts'
import './VoiceKeys.css'

/**
 * The two voice keys, side by side, so neither can quietly take the other's.
 *
 *   Dictate key   raw words typed into the pane you are in (settings.sttHotkey)
 *   Listen key    Listen on or off — a hands-free talk with the main agent
 *                 (keymap `voice.talk.agent`)
 *
 * Both record through the keymap (B10's `kind: 'talk'` commands), so a key the
 * other one holds is refused with a visible "Take it over", never swapped in
 * silently — the way Steve's Right Shift once ended up dictating.
 */
export function VoiceKeysCard(): ReactNode {
  const km = useKeymap()
  const hub = useHubView()
  const [editing, setEditing] = useState<string | null>(null)
  const [clash, setClash] = useState<{ id: string; combo: string; others: string[] } | null>(null)
  const [error, setError] = useState<{ id: string; text: string } | null>(null)

  const cmd = (id: string) => km.commands.find((c) => c.id === id)
  const titleOf = (id: string): string => (id === TALK_DICTATE_ID ? 'the Dictate key' : id === TALK_AGENT_ID ? 'the Listen key' : (cmd(id)?.title ?? id))

  const record = (id: string, combo: string, takeOver = false): void => {
    const r = km.setKeys(id, [combo], { takeOver })
    setEditing(null)
    if (r.ok) {
      setClash(null)
      setError(null)
      return
    }
    if (r.conflictsWith?.length) setClash({ id, combo, others: r.conflictsWith })
    else setError({ id, text: r.error })
  }

  const keys = [
    { id: TALK_DICTATE_ID, name: 'Dictate key', what: 'raw typing', says: 'Your words, typed as they are into the pane you are in — no agent.' },
    { id: TALK_AGENT_ID, name: 'Listen key', what: `talk to ${hub.brainLabel}`, says: 'Listen on or off: a hands-free talk with the main agent. It sends when you pause and answers.' }
  ]

  return (
    <Card title="Voice keys" hint="One key each, and never the same one. Tap to start or stop, hold to talk.">
      <div className="vkeys">
        {keys.map((k) => {
          const c = cmd(k.id)
          const key = c?.keys[0] ?? null
          return (
            <div key={k.id} className="vkey" data-editing={editing === k.id ? 'true' : undefined}>
              <span className="vkey__name">
                {k.name} <span className="vkey__what">({k.what})</span>
              </span>
              <span className="vkey__says">{k.says}</span>
              <div className="vkey__key">
                {editing === k.id ? (
                  <KeyRecorder
                    talk
                    value={key}
                    onRecord={(combo) => record(k.id, combo)}
                    onCancel={() => setEditing(null)}
                  />
                ) : key ? (
                  <Keys combo={key} />
                ) : (
                  <span className="vkey__none">no key</span>
                )}
              </div>
              <div className="vkey__acts">
                {editing === k.id ? null : (
                  <button
                    type="button"
                    className="ghost-btn vkey__btn"
                    onClick={() => {
                      setClash(null)
                      setError(null)
                      setEditing(k.id)
                    }}
                  >
                    Change
                  </button>
                )}
                {c?.customised ? (
                  <button type="button" className="ghost-btn vkey__btn" title="Back to Forge's default" onClick={() => km.reset(k.id)}>
                    Reset
                  </button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
      {clash ? (
        <div className="kmrow__clash vkeys__clash" role="alert">
          <span aria-hidden="true">⚠</span>
          <span>
            <Keys combo={clash.combo} size="sm" /> is already <strong>{clash.others.map(titleOf).join(', ')}</strong>. One key can only do one job.
          </span>
          <button type="button" className="cta-btn vkey__btn" onClick={() => record(clash.id, clash.combo, true)}>
            Take it over
          </button>
          <button type="button" className="ghost-btn vkey__btn" onClick={() => setClash(null)}>
            Keep both as they were
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="kmrow__clash vkeys__clash" role="alert">
          <span aria-hidden="true">✕</span>
          <span>{error.text}</span>
        </div>
      ) : null}
    </Card>
  )
}
