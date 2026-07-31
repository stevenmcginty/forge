import { useState, type ReactNode } from 'react'
import type { ImportedKeyResult, VoiceBrainId } from '@shared/types'
import { DEFAULT_GEMINI_MODEL, DEFAULT_GROQ_MODEL, DEFAULT_OPENROUTER_MODEL } from '@/lib/voicebrain'
import { useApp } from '@/state/AppState'
import { Card, KeyField, Row, Section, StateChip, TextField } from './parts'

/**
 * Keys and models.
 *
 * Everything on this page is stored in plain JSON in %APPDATA%\Forge — which is
 * said out loud at the bottom, because a masked field implies a safe that is
 * not there. Only one of these keys is ever sent anywhere.
 */

/**
 * The recommended fast brain. Measured on this machine: a full voice turn back
 * in 1.9s with valid brain JSON every time, which is the bar the voice hub
 * actually cares about. It is *not* DEFAULT_GEMINI_MODEL — the default is what
 * a settings.json written before today already says, and silently rewriting a
 * stored model id is not this page's job. The hint below points at it; the
 * dropdown lets you take it.
 */
const RECOMMENDED_GEMINI_MODEL = 'gemini-3.6-flash'

const GEMINI_MODELS = [
  { id: RECOMMENDED_GEMINI_MODEL, label: 'Flash 3.6 — fastest, recommended' },
  { id: DEFAULT_GEMINI_MODEL, label: 'Flash 2.5 — fast, cheap, the old default' },
  { id: 'gemini-2.5-pro', label: 'Pro — slower, better at long reasoning' }
]

/** Empty means "whatever gemini-media.ts defaults to" — say so, do not guess. */
const IMAGE_MODEL_PLACEHOLDER = 'gemini-2.5-flash-image'

/**
 * Groq's own suggestions, newest verified 2026-07-31.
 *
 * Ordered by what Forge actually needs rather than by size. The free tier's
 * ceiling is tokens-per-minute and the capability manifest is ~3,000 tokens of
 * every turn, so the headline "30 requests a minute" is not the number that
 * matters — the TPM column is, and it is why the 8b model is last despite being
 * the quickest and cheapest.
 */
const GROQ_MODELS = [
  { id: DEFAULT_GROQ_MODEL, label: 'Llama 3.3 70B — 12k tokens/min free, best at JSON' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B — the fastest thing here' },
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B — slower, stronger' },
  { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B — cheapest, but only 6k tokens/min free' }
]

const BRAINS: Array<{ id: VoiceBrainId; name: string; note: string; ready: boolean }> = [
  { id: 'gemini', name: 'Gemini', note: 'live — needs a key', ready: true },
  { id: 'groq', name: 'Groq', note: 'live — free tier, no card', ready: true },
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
          actions={
            // Not "Import from DictationMic": on anyone else's machine that
            // names an app they have never heard of. The main process looks in
            // several places and the result says which one it found.
            <ImportButton
              label="Import a saved key"
              onImport={() => window.forge.voice.importKey('gemini')}
              onUse={actions.setGeminiKey}
            />
          }
          note={
            <>
              The only key Forge sends anywhere. When Gemini is the voice brain, what you say plus a summary of your
              projects, tabs and panes goes to <span className="mono">generativelanguage.googleapis.com</span> and
              nowhere else.
            </>
          }
        />

        <Row
          label="Model"
          hint={
            <>
              Flash is plenty for the voice agent. <span className="mono">{RECOMMENDED_GEMINI_MODEL}</span> is the one
              to pick — a voice turn comes back in about 1.9s with brain JSON that parses every time. Your stored
              choice is left alone until you change it here.
            </>
          }
        >
          {/*
            Picking "Custom…" used to write the current model back with a
            trailing space, and `setGeminiModel` trims — so the marker was
            destroyed on the way in, `custom` never flipped, the text box never
            appeared and the dropdown snapped straight back to what it already
            said. Choosing Custom did visibly nothing.

            There is no marker now. The model id box below is always there and
            always wins, which is both un-breakable and one less thing to
            explain: the list is a shortcut, the box is the truth.
          */}
          <select
            className="select"
            value={custom ? '__custom' : s.geminiModel}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              if (e.target.value !== '__custom') actions.setGeminiModel(e.target.value)
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

        <Row label="Model id" hint="Overrides the list above" htmlFor="gemini-model-id">
          <TextField
            id="gemini-model-id"
            value={s.geminiModel}
            onCommit={(v) => actions.setGeminiModel(v)}
            placeholder={DEFAULT_GEMINI_MODEL}
            mono
          />
        </Row>
      </Card>

      <Card title="Voice brain" hint="The voice hub keeps a shortcut to this, but it lives here now.">
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

      <Card title="Groq">
        <KeyField
          label="API key"
          value={s.groqKey}
          onCommit={(key) => actions.patchSettings({ groqKey: key.trim() })}
          placeholder="gsk_…"
          actions={
            <ImportButton
              label="Import a saved key"
              onImport={() => window.forge.voice.importKey('groq')}
              onUse={(key) => actions.patchSettings({ groqKey: key })}
            />
          }
          note={
            <>
              Free at <span className="mono">console.groq.com</span> — no card. Sent only to{' '}
              <span className="mono">api.groq.com</span>, and only while Groq is the selected brain. The free tier is
              capped on tokens per minute rather than requests, so the model below matters more than how often you
              talk.
            </>
          }
        />

        <Row label="Model" hint="Any model id Groq serves" htmlFor="groq-model">
          <select
            id="groq-model"
            className="select"
            value={GROQ_MODELS.some((m) => m.id === s.groqModel) ? s.groqModel : '__custom'}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              if (e.target.value !== '__custom') actions.patchSettings({ groqModel: e.target.value })
            }}
          >
            {GROQ_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value="__custom">Custom…</option>
          </select>
        </Row>

        <Row label="Model id" hint="Overrides the list above" htmlFor="groq-model-id">
          <TextField
            id="groq-model-id"
            value={s.groqModel}
            onCommit={(v) => actions.patchSettings({ groqModel: v.trim() || DEFAULT_GROQ_MODEL })}
            placeholder={DEFAULT_GROQ_MODEL}
            mono
          />
        </Row>

        {s.voiceBrain === 'groq' && !s.groqKey ? (
          <p className="scard__hint">Groq is selected but no key is stored, so the panel is running the offline stub.</p>
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
