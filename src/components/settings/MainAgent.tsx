import { useEffect, useState, type ReactNode } from 'react'
import type { Settings } from '@shared/types'
import {
  AGENT_BRAINS,
  isRealtimeBrain,
  migrateAgentBrain,
  type AgentBrainKey,
  type AgentBrainKind,
  type AgentBrainSpec,
  type BrainTestResult,
  type BrainTestTarget
} from '@shared/agent-brain'
import { GEMINI_VOICES, OPENAI_VOICES, providerSpec, resolveVoice } from '@shared/realtime'
import { resolveAgentBrain } from '@/lib/realtime/provider'
import { DEFAULT_GEMINI_MODEL, DEFAULT_GROQ_MODEL, DEFAULT_OPENROUTER_MODEL } from '@/lib/voicebrain'
import { useApp } from '@/state/AppState'
import { KeyField, Row, TextField } from './parts'
import './MainAgent.css'

/**
 * The Main agent picker: one card per engine in AGENT_BRAINS, grouped by how
 * it runs, each with what it is good at, what it costs, a status word, a Test
 * button and — opened — its own settings (the key, the model, the voice).
 *
 * Built from the list, not for it: a row added to AGENT_BRAINS (B8's
 * gemini-cli and codex-cli, or whatever comes next) appears here with no UI
 * work. It gets its `note` as its line and its `auth` as its cost until a
 * better sentence is written into BRAIN_COPY, a key field if it has a `key`,
 * and a status from the same Test IPC every other row uses.
 *
 * Status is a word first and a shape second, never a colour alone:
 *   ● Ready   ◇ Needs key   ✕ Not installed   ! Not logged in   ! Not ready   ◌ Checking…
 */

/* ------------------------------------------------------------------ copy */

/** What each engine is good at, and what it costs. Keyed by id as a string so B8's ids fit before the union has them. */
const BRAIN_COPY: Record<string, { good: string; cost: string }> = {
  claude: {
    good: 'Best at driving Forge — opens panes, types for you, shapes a prompt. Parakeet hears you, Edge speaks.',
    cost: 'Free with your Claude plan'
  },
  'gemini-cli': {
    good: 'A hidden Gemini CLI session with the same Forge tools. Parakeet hears you, Edge speaks.',
    cost: 'Free with your Google login'
  },
  'codex-cli': {
    good: 'A hidden Codex session — GPT, with the same Forge tools. Parakeet hears you, Edge speaks.',
    cost: 'Free with your ChatGPT plan'
  },
  'gemini-live': {
    good: 'Real two-way talk you can interrupt. Natural for talking a job through.',
    cost: 'Gemini key · ≈ $3–4 a heavy day'
  },
  'gpt-realtime-mini': {
    good: 'Real two-way talk on GPT. Snappy for short commands.',
    cost: 'OpenAI key · ≈ $3–8 a heavy day'
  },
  'gpt-realtime': {
    good: 'Real two-way talk on GPT’s strongest voice model. Best at long spoken instructions.',
    cost: 'OpenAI key · ≈ $10–20 a heavy day'
  },
  'gemini-flash': {
    good: 'One Gemini call per phrase. Light and quick for simple commands.',
    cost: 'Gemini key · free tier, then per call'
  },
  groq: {
    good: 'The quickest replies. Fine for simple commands.',
    cost: 'Groq key · free tier, no card'
  },
  openrouter: {
    good: 'Any model OpenRouter serves — for trying others.',
    cost: 'OpenRouter key · depends on the model'
  }
}

function copyFor(spec: AgentBrainSpec): { good: string; cost: string } {
  return BRAIN_COPY[spec.id] ?? { good: spec.note, cost: spec.key ? spec.auth : `Free with ${spec.auth}` }
}

/** The groups, in order. A kind not listed here lands in a last "Other" group, so nothing is ever hidden. */
const GROUPS: Array<{ kind: AgentBrainKind; title: string; note: string }> = [
  { kind: 'session', title: 'On your subscription', note: 'No key. A hidden session thinks; Parakeet hears you, Edge speaks.' },
  { kind: 'realtime', title: 'Live voice', note: 'Two-way audio you can talk over. A key, billed as you use it.' },
  { kind: 'json', title: 'Quick text brains', note: 'One call per phrase. Parakeet in, Edge out.' }
]

const CLAUDE_MODELS = [
  { id: 'opus', label: 'Opus — smartest, the default' },
  { id: 'sonnet', label: 'Sonnet — faster, lighter on usage' },
  { id: 'haiku', label: 'Haiku — lightest' }
]

const GEMINI_MODELS = [
  { id: 'gemini-3.8-flash', label: 'Flash 3.8 — newest Flash' },
  { id: 'gemini-3.6-flash', label: 'Flash 3.6 — fastest, recommended' },
  { id: DEFAULT_GEMINI_MODEL, label: 'Flash 2.5 — fast, cheap, the old default' },
  { id: 'gemini-2.5-pro', label: 'Pro — slower, better at long reasoning' }
]

/** Groq's own suggestions; the free tier is capped on tokens per minute, which is why 8B is last. */
const GROQ_MODELS = [
  { id: DEFAULT_GROQ_MODEL, label: 'Llama 3.3 70B — 12k tokens/min free, best at JSON' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B — the fastest thing here' },
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B — slower, stronger' },
  { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B — cheapest, 6k tokens/min free' }
]

/* ---------------------------------------------------------------- status */

interface Probe {
  busy: boolean
  result: BrainTestResult | null
}

type Tone = 'ok' | 'need' | 'bad' | 'wait'
interface Status {
  word: string
  glyph: string
  tone: Tone
}

const READY: Status = { word: 'Ready', glyph: '●', tone: 'ok' }
const NEEDS_KEY: Status = { word: 'Needs key', glyph: '◇', tone: 'need' }
const CHECKING: Status = { word: 'Checking…', glyph: '◌', tone: 'wait' }

function keyOf(s: Settings, key: AgentBrainKey | null): string {
  return key ? String(s[key] ?? '').trim() : ''
}

/** The status word, from the Test result — or from the key alone when there is nothing to test yet. */
function statusOf(spec: AgentBrainSpec, s: Settings, probe: Probe | undefined): Status {
  if (spec.key && !keyOf(s, spec.key)) return NEEDS_KEY
  const r = probe?.result
  if (!r) return CHECKING
  if (r.ok) return READY
  const why = `${r.reason} ${r.detail ?? ''}`.toLowerCase()
  if (/not found|not installed|isn.t installed|no such file|enoent|cannot find|missing cli/.test(why)) {
    return { word: 'Not installed', glyph: '✕', tone: 'bad' }
  }
  if (/not logged in|not signed in|log ?in first|sign ?in first|unauthenticated|run .*\/?login/.test(why)) {
    return { word: 'Not logged in', glyph: '!', tone: 'need' }
  }
  if (/no key|key refused|still encrypted|invalid api key|api key not valid/.test(why)) return NEEDS_KEY
  return { word: 'Not ready', glyph: '!', tone: 'bad' }
}

/**
 * Test results, kept for the session so reopening Settings does not probe
 * every engine again. A probe is read-only (a model list, a CLI's version and
 * auth status — electron/agent-brain-test.ts), so running them on arrival is
 * what lets every card carry a real status word rather than "untested".
 * Keyed on the inputs that change the answer: the key, and Claude's model.
 */
const probeCache = new Map<string, { sig: string; at: number; result: BrainTestResult }>()
const PROBE_TTL = 5 * 60_000

function probeSig(spec: AgentBrainSpec, s: Settings): string {
  return `${keyOf(s, spec.key)}|${spec.id === 'claude' ? s.voiceClaudeModel : ''}`
}

async function runTest(target: BrainTestTarget): Promise<BrainTestResult> {
  const api = (window.forge as unknown as { agentBrain?: { test(t: BrainTestTarget): Promise<BrainTestResult> } }).agentBrain
  if (!api) return { ok: false, reason: 'This Forge build cannot test yet — restart Forge' }
  try {
    return await api.test(target)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

function useProbes(s: Settings): { probes: Record<string, Probe>; test: (spec: AgentBrainSpec) => void } {
  const [probes, setProbes] = useState<Record<string, Probe>>(() => {
    const out: Record<string, Probe> = {}
    for (const spec of AGENT_BRAINS) {
      const hit = probeCache.get(spec.id)
      if (hit && hit.sig === probeSig(spec, s)) out[spec.id] = { busy: false, result: hit.result }
    }
    return out
  })

  const test = (spec: AgentBrainSpec): void => {
    const sig = probeSig(spec, s)
    setProbes((p) => ({ ...p, [spec.id]: { busy: true, result: p[spec.id]?.result ?? null } }))
    void runTest({ kind: 'brain', id: spec.id }).then((result) => {
      probeCache.set(spec.id, { sig, at: Date.now(), result })
      setProbes((p) => ({ ...p, [spec.id]: { busy: false, result } }))
    })
  }

  // On arrival, and again when a key or Claude's model changes: probe every
  // engine that has what it needs and no fresh answer.
  const sigs = AGENT_BRAINS.map((spec) => probeSig(spec, s)).join('\n')
  useEffect(() => {
    for (const spec of AGENT_BRAINS) {
      if (spec.key && !keyOf(s, spec.key)) continue
      const hit = probeCache.get(spec.id)
      if (hit && hit.sig === probeSig(spec, s) && Date.now() - hit.at < PROBE_TTL) {
        setProbes((p) => (p[spec.id]?.result === hit.result ? p : { ...p, [spec.id]: { busy: false, result: hit.result } }))
        continue
      }
      test(spec)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigs])

  return { probes, test }
}

/* ------------------------------------------------------------------ card */

export function MainAgentCard(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  const chosen = s.agentBrain ?? migrateAgentBrain(s.voiceHubProvider, s.voiceBrain)
  const resolved = resolveAgentBrain(chosen, s)
  const { probes, test } = useProbes(s)
  const [open, setOpen] = useState<Set<string>>(() => new Set())

  const toggleOpen = (id: string): void =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const answering = AGENT_BRAINS.find((b) => b.id === resolved.brain) ?? AGENT_BRAINS[0]!
  const chosenSpec = AGENT_BRAINS.find((b) => b.id === chosen) ?? answering
  const answeringStatus = statusOf(answering, s, probes[answering.id])

  const known = new Set(GROUPS.map((g) => g.kind))
  const groups = [
    ...GROUPS.map((g) => ({ ...g, rows: AGENT_BRAINS.filter((b) => b.kind === g.kind) })),
    { kind: 'other' as AgentBrainKind, title: 'Other', note: '', rows: AGENT_BRAINS.filter((b) => !known.has(b.kind)) }
  ].filter((g) => g.rows.length > 0)

  return (
    <div className="scard mag">
      <div className="mag__head">
        <div className="mag__headtext">
          <h3 className="scard__title">Main agent</h3>
          <p className="mag__lede">Who answers the bar. Every engine gets the same Forge tools and the same view of the app.</p>
        </div>
        <div className="mag__now" role="status" aria-live="polite">
          <span className="mag__now-label eyebrow">Answering now</span>
          <span className="mag__now-name">{answering.label}</span>
          <StatusWord status={answeringStatus} />
        </div>
      </div>

      {resolved.fallbackReason && chosenSpec.id !== answering.id ? (
        <p className="va-note" role="note">
          <span className="va-note__mark" aria-hidden="true">
            ◆
          </span>
          {chosenSpec.label} is picked but has no {chosenSpec.auth} yet, so {answering.label} answers until you add it on
          its card.
        </p>
      ) : null}

      <div className="mag__groups" role="radiogroup" aria-label="Main agent">
        {groups.map((g) => (
          <div key={g.kind} className="mag__group">
            <div className="mag__grouphead">
              <span className="mag__grouptitle">{g.title}</span>
              {g.note ? <span className="mag__groupnote">{g.note}</span> : null}
            </div>
            {g.rows.map((spec) => (
              <BrainRow
                key={spec.id}
                spec={spec}
                picked={chosen === spec.id}
                open={chosen === spec.id || open.has(spec.id)}
                status={statusOf(spec, s, probes[spec.id])}
                probe={probes[spec.id]}
                onPick={() => actions.patchSettings({ agentBrain: spec.id })}
                onToggle={() => toggleOpen(spec.id)}
                onTest={() => test(spec)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function StatusWord({ status, title }: { status: Status; title?: string }): ReactNode {
  return (
    <span className="mag__status" data-tone={status.tone} title={title}>
      <span className="mag__status-glyph" aria-hidden="true">
        {status.glyph}
      </span>
      {status.word}
    </span>
  )
}

function BrainRow({
  spec,
  picked,
  open,
  status,
  probe,
  onPick,
  onToggle,
  onTest
}: {
  spec: AgentBrainSpec
  picked: boolean
  open: boolean
  status: Status
  probe: Probe | undefined
  onPick: () => void
  onToggle: () => void
  onTest: () => void
}): ReactNode {
  const copy = copyFor(spec)
  const bodyId = `mag-body-${spec.id}`
  return (
    <div className="mag__row" data-picked={picked ? 'true' : undefined} data-open={open ? 'true' : undefined}>
      <div className="mag__line">
        <button type="button" role="radio" aria-checked={picked} className="mag__pick" onClick={onPick}>
          <span className="mag__lamp" aria-hidden="true" />
          <span className="mag__text">
            <span className="mag__nameline">
              <span className="mag__name">{spec.label}</span>
              {picked ? <span className="mag__inuse">In use</span> : null}
            </span>
            <span className="mag__good">{copy.good}</span>
            <span className="mag__cost">{copy.cost}</span>
          </span>
        </button>
        <div className="mag__side">
          <StatusWord status={status} title={probe?.result?.reason} />
          <button type="button" className="ghost-btn mag__test" disabled={probe?.busy} onClick={onTest}>
            {probe?.busy ? 'Testing…' : 'Test'}
          </button>
          {picked ? null : (
            <button
              type="button"
              className="ghost-btn mag__more"
              aria-expanded={open}
              aria-controls={bodyId}
              title={open ? 'Hide its settings' : 'Show its settings'}
              aria-label={`${open ? 'Hide' : 'Show'} ${spec.label} settings`}
              onClick={onToggle}
            >
              <span className="mag__chev" aria-hidden="true">
                ›
              </span>
            </button>
          )}
        </div>
      </div>
      <div className="mag__fold" id={bodyId} aria-hidden={!open}>
        <div className="mag__foldin">{open ? <BrainDetails spec={spec} probe={probe} /> : null}</div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- details */

const KEY_LABELS: Record<AgentBrainKey, { label: string; placeholder: string; note: ReactNode }> = {
  geminiKey: {
    label: 'Gemini API key',
    placeholder: 'AIza…',
    note: 'The same key Forge’s other Gemini features use. Sent only to generativelanguage.googleapis.com.'
  },
  openaiKey: {
    label: 'OpenAI API key',
    placeholder: 'sk-…',
    note: 'An API platform key with billing — a ChatGPT subscription does not cover it. It stays in Forge’s main process; each session gets a short-lived secret.'
  },
  groqKey: {
    label: 'Groq API key',
    placeholder: 'gsk_…',
    note: 'Free at console.groq.com — no card. Sent only to api.groq.com.'
  },
  openrouterKey: {
    label: 'OpenRouter API key',
    placeholder: 'sk-or-…',
    note: 'Sent only to openrouter.ai, and only while OpenRouter answers.'
  }
}

function BrainDetails({ spec, probe }: { spec: AgentBrainSpec; probe: Probe | undefined }): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  const live = isRealtimeBrain(spec.id) ? providerSpec(spec.id) : null

  const commitKey = (key: AgentBrainKey, value: string): void => {
    if (key === 'geminiKey') actions.setGeminiKey(value)
    else actions.patchSettings({ [key]: value.trim() } as Partial<Settings>)
  }

  return (
    <div className="mag__details">
      <p className="mag__probe" data-ok={probe?.result ? String(probe.result.ok) : undefined}>
        <span className="eyebrow">{live ? live.model : `signs in with ${spec.auth}`}</span>
        {probe?.result ? (
          <span className="mag__probe-text" title={probe.result.detail ?? probe.result.reason}>
            {probe.result.ok ? 'Test passed — ' : 'Test failed — '}
            {probe.result.reason}
          </span>
        ) : null}
      </p>

      {spec.key ? (
        <KeyField
          label={KEY_LABELS[spec.key]?.label ?? spec.auth}
          value={String(s[spec.key] ?? '')}
          onCommit={(v) => commitKey(spec.key!, v)}
          placeholder={KEY_LABELS[spec.key]?.placeholder}
          note={KEY_LABELS[spec.key]?.note}
        />
      ) : null}

      {spec.id === 'claude' ? (
        <Row label="Model" hint="Opus, Sonnet and Haiku use your Claude login. Takes effect on the next turn. For GPT, pick Codex as the main agent." htmlFor="mag-claude-model">
          <select
            id="mag-claude-model"
            className="select"
            value={s.voiceClaudeModel}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => actions.patchSettings({ voiceClaudeModel: e.target.value })}
          >
            {CLAUDE_MODELS.some((m) => m.id === s.voiceClaudeModel) ? null : (
              <option value={s.voiceClaudeModel}>
                {/luna/i.test(s.voiceClaudeModel) ? 'GPT-5.6 Luna — no longer offered, pick another' : s.voiceClaudeModel}
              </option>
            )}
            {CLAUDE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Row>
      ) : null}

      {live?.vendor ? <LiveVoices vendor={live.vendor} /> : null}

      {spec.id === 'gemini-flash' ? (
        <>
          <Row label="Model" hint="Also used for phone transcription and project memory" htmlFor="mag-gemini-model">
            <select
              id="mag-gemini-model"
              className="select"
              value={GEMINI_MODELS.some((m) => m.id === s.geminiModel) ? s.geminiModel : '__custom'}
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
          <Row label="Model id" hint="Overrides the list above" htmlFor="mag-gemini-id">
            <TextField id="mag-gemini-id" value={s.geminiModel} onCommit={(v) => actions.setGeminiModel(v)} placeholder={DEFAULT_GEMINI_MODEL} mono />
          </Row>
        </>
      ) : null}

      {spec.id === 'groq' ? (
        <>
          <Row label="Model" hint="The free tier counts tokens per minute, so the model matters more than how often you talk" htmlFor="mag-groq-model">
            <select
              id="mag-groq-model"
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
          <Row label="Model id" hint="Any model id Groq serves" htmlFor="mag-groq-id">
            <TextField
              id="mag-groq-id"
              value={s.groqModel}
              onCommit={(v) => actions.patchSettings({ groqModel: v.trim() || DEFAULT_GROQ_MODEL })}
              placeholder={DEFAULT_GROQ_MODEL}
              mono
            />
          </Row>
        </>
      ) : null}

      {spec.id === 'openrouter' ? (
        <Row label="Model id" hint="Any model id OpenRouter serves" htmlFor="mag-openrouter-id">
          <TextField
            id="mag-openrouter-id"
            value={s.openrouterModel}
            onCommit={(v) => actions.patchSettings({ openrouterModel: v.trim() || DEFAULT_OPENROUTER_MODEL })}
            placeholder={DEFAULT_OPENROUTER_MODEL}
            mono
          />
        </Row>
      ) : null}
    </div>
  )
}

/** A live brain's own voice: one per vendor, shared by both GPT models. */
function LiveVoices({ vendor }: { vendor: 'gemini' | 'openai' }): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  const voices = vendor === 'gemini' ? GEMINI_VOICES : OPENAI_VOICES
  const voice = resolveVoice(vendor, s.voiceHubVoice[vendor])
  return (
    <div className="mag__voices">
      <span className="mag__voices-label">
        Its voice <strong>{voice}</strong>
        <span className="mag__voices-hint">{vendor === 'openai' ? 'marin and cedar sound best · both GPT models share it' : 'shared with Gemini TTS'}</span>
      </span>
      <div className="mag__voicelist" role="radiogroup" aria-label="Its voice">
        {voices.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={v === voice}
            className="mag__voice"
            data-on={v === voice ? 'true' : undefined}
            onClick={() => actions.patchSettings({ voiceHubVoice: { ...s.voiceHubVoice, [vendor]: v } })}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  )
}
