import { useState, type ReactNode } from 'react'
import type { ImportedKeyResult, VoiceBrainId } from '@shared/types'
import { DEFAULT_GEMINI_MODEL, DEFAULT_OPENROUTER_MODEL } from '@/lib/voicebrain'
import { useApp } from '@/state/AppState'
import { Card, KeyField, Row, Section, StateChip, TextField } from './parts'

/**
 * Keys and models.
 *
 * Everything on this page is stored in plain JSON in %APPDATA%\Forge — which is
 * said out loud at the bottom, because a masked field implies a safe that is
 * not there. Only one of these keys is ever sent anywhere.
 */

const GEMINI_MODELS = [
  { id: DEFAULT_GEMINI_MODEL, label: 'Flash — fast, cheap, the default' },
  { id: 'gemini-2.5-pro', label: 'Pro — slower, better at long reasoning' }
]

/** Empty means "whatever gemini-media.ts defaults to" — say so, do not guess. */
const IMAGE_MODEL_PLACEHOLDER = 'gemini-2.5-flash-image'

const BRAINS: Array<{ id: VoiceBrainId; name: string; note: string; ready: boolean }> = [
  { id: 'gemini', name: 'Gemini', note: 'live — needs a key', ready: true },
  { id: 'openrouter', name: 'OpenRouter', note: 'live — any model', ready: true },
  { id: 'stub', name: 'Stub', note: 'offline, echoes you', ready: true },
  { id: 'claude', name: 'Claude', note: 'coming soon', ready: false },
  { id: 'openai', name: 'OpenAI', note: 'coming soon', ready: false }
]

export function ModelsSection(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  const custom = !GEMINI_MODELS.some((m) => m.id === s.geminiModel)

  return (
    <Section title="Models &amp; APIs" blurb="The keys Forge holds, and which model the voice agent thinks with.">
      <Card title="Google Gemini">
        <KeyField
          label="API key"
          value={s.geminiKey}
          onCommit={actions.setGeminiKey}
          placeholder="AIza…"
          actions={<ImportButton label="Import from DictationMic" onImport={() => window.forge.voice.importKey('gemini')} onUse={actions.setGeminiKey} />}
          note={
            <>
              The only key Forge sends anywhere. When Gemini is the voice brain, what you say plus a summary of your
              projects, tabs and panes goes to <span className="mono">generativelanguage.googleapis.com</span> and
              nowhere else.
            </>
          }
        />

        <Row label="Model" hint="Flash is plenty for the voice agent">
          <select
            className="select"
            value={custom ? '__custom' : s.geminiModel}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              if (e.target.value === '__custom') actions.setGeminiModel(`${s.geminiModel} `)
              else actions.setGeminiModel(e.target.value)
            }}
          >
            {GEMINI_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value="__custom">Custom…</option>
          </select>
        </Row>

        <Row
          label="Image model"
          hint="Used by make_image and edit_image, here and in the MCP bridge"
          htmlFor="gemini-image-model"
        >
          <TextField
            id="gemini-image-model"
            value={s.geminiImageModel}
            onCommit={(v) => actions.patchSettings({ geminiImageModel: v.trim() })}
            placeholder={IMAGE_MODEL_PLACEHOLDER}
            mono
          />
        </Row>

        {custom ? (
          <Row label="Model id" htmlFor="gemini-model-custom">
            <input
              id="gemini-model-custom"
              className="field__input mono"
              spellCheck={false}
              defaultValue={s.geminiModel}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              onBlur={(e) => actions.setGeminiModel(e.target.value)}
            />
          </Row>
        ) : null}
      </Card>

      <Card title="Voice brain" hint="The voice panel keeps a shortcut to this, but it lives here now.">
        <div className="sbrains">
          {BRAINS.map((b) => (
            <button
              key={b.id}
              type="button"
              className="sbrain"
              data-selected={s.voiceBrain === b.id ? 'true' : undefined}
              disabled={!b.ready}
              onClick={() => actions.setVoiceBrain(b.id)}
            >
              <span className="sbrain__name">{b.name}</span>
              <span className="sbrain__note mono">{b.note}</span>
            </button>
          ))}
        </div>
        {s.voiceBrain === 'gemini' && !s.geminiKey ? (
          <p className="scard__hint">
            Gemini is selected but no key is stored, so the panel is running the offline stub — commands still work,
            conversation does not.
          </p>
        ) : null}
      </Card>

      <Card title="Anthropic" tone="quiet">
        <KeyField
          label="API key"
          value={s.anthropicKey}
          onCommit={actions.setAnthropicKey}
          placeholder="sk-ant-…"
          note="Stored and used nowhere. No code in Forge sends this anywhere — it is here for the Claude brain that has not been built."
        />
      </Card>

      <Card title="OpenRouter">
        <KeyField
          label="API key"
          value={s.openrouterKey}
          onCommit={(key) => actions.patchSettings({ openrouterKey: key.trim() })}
          placeholder="sk-or-…"
          actions={
            <ImportButton
              label="Import from ~/.kimi-key"
              onImport={() => window.forge.voice.importKey('openrouter')}
              onUse={(key) => actions.patchSettings({ openrouterKey: key })}
            />
          }
          note={
            <>
              Sent only to <span className="mono">openrouter.ai</span>, and only while OpenRouter is the selected
              brain. If you already run <span className="mono">kimi</span> in a pane its key is in{' '}
              <span className="mono">~/.kimi-key</span> and the button above will fetch it.
            </>
          }
        />

        <Row label="Model" hint="Any model id OpenRouter serves" htmlFor="openrouter-model">
          <TextField
            id="openrouter-model"
            value={s.openrouterModel}
            onCommit={(v) => actions.patchSettings({ openrouterModel: v.trim() || DEFAULT_OPENROUTER_MODEL })}
            placeholder={DEFAULT_OPENROUTER_MODEL}
            mono
          />
        </Row>

        {s.voiceBrain === 'openrouter' && !s.openrouterKey ? (
          <p className="scard__hint">
            OpenRouter is selected but no key is stored, so the panel is running the offline stub.
          </p>
        ) : null}
      </Card>

      <p className="sset__foot">
        All of these live in <span className="mono">%APPDATA%\Forge\settings.json</span> as plain text. That is the
        same place your shell keeps its own credentials, and it is worth knowing rather than being reassured about.
      </p>
    </Section>
  )
}

/* ---------------------------------------------------------------- importing */

/**
 * Import a key from disk. Deliberately two steps: find it, show what was found
 * and where, *then* adopt it — silently swallowing a file's contents into a
 * password field is how you end up with the wrong key and no idea why.
 */
function ImportButton({
  label,
  onImport,
  onUse
}: {
  label: string
  onImport: () => Promise<ImportedKeyResult>
  onUse: (key: string) => void
}): ReactNode {
  const [found, setFound] = useState<{ key: string; last4: string; source: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (found) {
    return (
      <div className="simport">
        <span className="simport__text">
          Found a key ending <span className="mono">{found.last4}</span> in{' '}
          <span className="mono simport__path">{found.source}</span>
        </span>
        <div className="simport__actions">
          <button type="button" className="ghost-btn sbtn" onClick={() => setFound(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="ghost-btn sbtn"
            onClick={() => {
              onUse(found.key)
              setFound(null)
            }}
          >
            Use this key
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="simport">
      <button
        type="button"
        className="ghost-btn sbtn"
        onClick={() => {
          setError(null)
          void onImport().then((r) => {
            if (r.ok) setFound({ key: r.key, last4: r.last4, source: r.source })
            else setError(r.error)
          })
        }}
      >
        {label}
      </button>
      {error ? <StateChip tone="warn">{error}</StateChip> : null}
    </div>
  )
}
