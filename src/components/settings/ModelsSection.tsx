import { useState, type ReactNode } from 'react'
import type { ImportedKeyResult } from '@shared/types'
import { useApp } from '@/state/AppState'
import { Card, KeyField, Row, Section, StateChip, TextField } from './parts'
import { BrainTestButton } from './BrainTest'

/**
 * Keys — every API key Forge holds, in one list.
 *
 * Settings > Agents & CLIs. The Main agent's cards (Voice & Agent) show the
 * key their engine needs inline; it is the same field, so a key typed in
 * either place is the key. Which engine answers, and each engine's model, live
 * on those cards — this page only holds keys, plus the one model that is not
 * an agent's (images).
 *
 * Everything here is stored in plain JSON in %APPDATA%\Forge — which is said
 * out loud at the bottom, because a masked field implies a safe that is not
 * there.
 */

/** Empty means "whatever gemini-media.ts defaults to" — say so, do not guess. */
const IMAGE_MODEL_PLACEHOLDER = 'gemini-2.5-flash-image'

export function ModelsSection(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings

  return (
    <Section title="Keys" blurb="The API keys Forge holds. The Main agent’s cards show the key their engine needs — it is the same key.">
      <Card title="Google Gemini">
        <KeyField
          label="API key"
          value={s.geminiKey}
          onCommit={actions.setGeminiKey}
          placeholder="AIza…"
          actions={
            <>
              {/*
                Not "Import from DictationMic": on anyone else's machine that
                names an app they have never heard of. The main process looks in
                several places and the result says which one it found.
              */}
              <ImportButton
                label="Import a saved key"
                onImport={() => window.forge.voice.importKey('gemini')}
                onUse={actions.setGeminiKey}
              />
              <BrainTestButton target={{ kind: 'key', vendor: 'gemini' }} />
            </>
          }
          note={
            <>
              Gemini Live, Gemini Flash, images, the Gemini voice and phone transcription all use it. Sent only to{' '}
              <span className="mono">generativelanguage.googleapis.com</span>.
            </>
          }
        />
        <Row label="Image model" hint="Used by make_image and edit_image, here and in the MCP bridge" htmlFor="gemini-image-model">
          <TextField
            id="gemini-image-model"
            value={s.geminiImageModel}
            onCommit={(v) => actions.patchSettings({ geminiImageModel: v.trim() })}
            placeholder={IMAGE_MODEL_PLACEHOLDER}
            mono
          />
        </Row>
        <Row label="Text model" hint="Gemini Flash, phone transcription and project memory. Set on the Gemini Flash card.">
          <span className="srow__readout mono">{s.geminiModel}</span>
          <button type="button" className="ghost-btn" onClick={() => actions.setSettingsSection('voice')}>
            Change
          </button>
        </Row>
      </Card>

      <Card title="OpenAI">
        <KeyField
          label="API key"
          value={s.openaiKey}
          onCommit={(key) => actions.patchSettings({ openaiKey: key.trim() })}
          placeholder="sk-…"
          actions={<BrainTestButton target={{ kind: 'key', vendor: 'openai' }} />}
          note={
            <>
              For GPT Realtime and its mini. An API platform key with billing — a ChatGPT subscription does not cover
              it. The key stays in Forge&apos;s main process: each session gets a short-lived secret from{' '}
              <span className="mono">api.openai.com</span>.
            </>
          }
        />
      </Card>

      <Card title="Groq">
        <KeyField
          label="API key"
          value={s.groqKey}
          onCommit={(key) => actions.patchSettings({ groqKey: key.trim() })}
          placeholder="gsk_…"
          actions={
            <>
              <ImportButton
                label="Import a saved key"
                onImport={() => window.forge.voice.importKey('groq')}
                onUse={(key) => actions.patchSettings({ groqKey: key })}
              />
              <BrainTestButton target={{ kind: 'key', vendor: 'groq' }} />
            </>
          }
          note={
            <>
              Free at <span className="mono">console.groq.com</span> — no card. Sent only to{' '}
              <span className="mono">api.groq.com</span>, and only while Groq answers.
            </>
          }
        />
      </Card>

      <Card title="OpenRouter">
        <KeyField
          label="API key"
          value={s.openrouterKey}
          onCommit={(key) => actions.patchSettings({ openrouterKey: key.trim() })}
          placeholder="sk-or-…"
          actions={
            <>
              <ImportButton
                label="Import from ~/.kimi-key"
                onImport={() => window.forge.voice.importKey('openrouter')}
                onUse={(key) => actions.patchSettings({ openrouterKey: key })}
              />
              <BrainTestButton target={{ kind: 'key', vendor: 'openrouter' }} />
            </>
          }
          note={
            <>
              Sent only to <span className="mono">openrouter.ai</span>, and only while OpenRouter answers. If you run{' '}
              <span className="mono">kimi</span> in a pane its key is in <span className="mono">~/.kimi-key</span> and
              the button above fetches it.
            </>
          }
        />
      </Card>

      <Card title="Z.AI">
        <KeyField
          label="Coding Plan key"
          value={s.zaiKey}
          onCommit={(key) => actions.patchSettings({ zaiKey: key.trim() })}
          placeholder="from z.ai/manage-apikey"
          note={
            <>
              Only the <span className="mono">GLM 5.3</span> pane uses this. It is sent to{' '}
              <span className="mono">api.z.ai</span> as Claude Code&apos;s gateway, and never to a regular Claude pane
              — that one stays on your claude.ai login. Sign up at <span className="mono">z.ai/subscribe</span>, then
              paste the key from <span className="mono">z.ai/manage-apikey/apikey-list</span>.
            </>
          }
        />
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
