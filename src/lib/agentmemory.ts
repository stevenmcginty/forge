import { activityBody, parseMemory } from '@shared/memory'
import type { MemorySection } from '@shared/types'
import type { ActionOutcome } from './appactions'
import type { BrainReply } from './voicebrain'

/**
 * The learning loop: how a project's memory grows, and how it is read back.
 *
 * Every line of this lives here rather than in VoicePanel on purpose. The panel
 * is already the busiest file in the app and is being edited by someone else at
 * the same time, so its share of this feature is six additive lines — prime the
 * cache when the project changes, put `projectMemory` in the brain context, run
 * the two memory actions, and hand each finished exchange to `record()`.
 * Everything that decides *what* is worth remembering is in this module, where
 * it can be unit-tested with no renderer at all.
 *
 * What gets remembered, and why it is heuristic rather than a second model call:
 *
 *   • Anything Steve opens with remember / prefer / always / never is stored
 *     verbatim as a Preference. He said it deliberately; paraphrasing it would
 *     be the one way to get it wrong.
 *   • Actions that actually ran become Recent activity, using the executor's own
 *     outcome summaries — so the memory records what happened, never what was
 *     asked for.
 *   • A drafted prompt names what the project is working on, so its subject
 *     becomes a Decision and a line of activity.
 *
 * That costs nothing, runs offline, and is predictable — you can read the rule
 * and know what the file will say. The optional `memoryLlmSummarize` setting
 * (off by default) adds the one thing heuristics genuinely cannot do: rewrite
 * the "About this project" paragraph. It fires once every ten exchanges, not on
 * every turn, because a memory that costs an extra API call per phrase is a
 * memory you would switch off.
 */

/* ------------------------------------------------------------------ types */

export interface MemoryUpdate {
  section: MemorySection
  entry: string
}

/** Everything `record()` needs to know about one finished exchange. */
export interface MemoryExchange {
  projectId: string | null
  utterance: string
  /** Epoch ms from the caller — this module never invents a time. */
  at: number
  reply?: BrainReply | undefined
  outcomes?: ActionOutcome[] | undefined
}

/** The IPC surface, injectable so the extraction rules can be tested head-less. */
export interface MemoryBackend {
  read(projectId: string): Promise<string>
  append(projectId: string, section: MemorySection, entry: string, at: number): Promise<string>
  replaceSummary(projectId: string, text: string): Promise<string>
  clear(projectId: string): Promise<boolean>
}

/** Given the memory as it stands, return a new About paragraph — or null. */
export type MemorySummariser = (markdown: string) => Promise<string | null>

/* ------------------------------------------------------------ extraction */

/**
 * Utterances that are standing instructions rather than requests.
 *
 * Anchored at the start: "remember I prefer strict mode" is a preference,
 * "can you remember to check the tests" is a question about this task. The
 * distinction is not perfect, and it does not need to be — a wrong entry is one
 * readable line in a file Steve can open, and "forget this project's memory"
 * clears the lot.
 */
const PREFERENCE_RE =
  /^\s*(?:(?:and|also|please|oh|so|right|ok|okay|hey)[,\s]+)*(?:remember|note that|from now on|always|never|i always|i never|prefer|i prefer|i'd prefer|i would prefer|don't|dont|do not)\b/i

/** A provisional summary ("Generating…") is not something that happened yet. */
function settled(outcome: { ok: boolean; summary: string }): boolean {
  return outcome.ok && !outcome.summary.trimEnd().endsWith('…')
}

/** What a drafted prompt is about: its first heading, else its first line. */
export function draftSubject(draft: string): string | null {
  for (const raw of draft.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const heading = /^#{1,3}\s+(.*)$/.exec(line)
    const text = (heading?.[1] ?? line).replace(/^[-*]\s+/, '').trim()
    if (!text) continue
    // "# Goal" on its own says nothing; keep looking for the line that does.
    if (/^(goal|task|objective|summary|brief|context)$/i.test(text)) continue
    return text.length > 140 ? `${text.slice(0, 139).trim()}…` : text
  }
  return null
}

/**
 * The whole learning rule, as a pure function. Order matters only in that
 * preferences come first — they are the entries worth keeping when the file is
 * later pruned, and being early makes that obvious when reading the code.
 */
export function extractMemoryUpdates(exchange: {
  utterance: string
  reply?: BrainReply | undefined
  outcomes?: Array<{ ok: boolean; summary: string }> | undefined
}): MemoryUpdate[] {
  const updates: MemoryUpdate[] = []
  const said = (exchange.utterance ?? '').trim()

  if (said && PREFERENCE_RE.test(said)) {
    // Verbatim. He chose those words; this is not the place to improve them.
    updates.push({ section: 'preferences', entry: said })
  }

  for (const outcome of exchange.outcomes ?? []) {
    if (settled(outcome)) updates.push({ section: 'activity', entry: outcome.summary })
  }

  const draft = exchange.reply?.draftPrompt?.trim()
  if (draft) {
    const subject = draftSubject(draft) ?? exchange.reply?.understood?.trim()
    if (subject) {
      updates.push({ section: 'decisions', entry: `Working on: ${subject}` })
      updates.push({ section: 'activity', entry: `Drafted a prompt for: ${subject}` })
    }
  }

  return updates
}

/* -------------------------------------------------------------- read-back */

/** How much of the memory a single outcome chip is allowed to be. */
const RECALL_LIMIT = 600

/**
 * One chip's worth of "here is what I remember", built off the file rather than
 * off a model — so it is instant, free, and cannot be a hallucination.
 */
export function describeMemory(markdown: string, limit = RECALL_LIMIT): string {
  const memory = parseMemory(markdown ?? '')
  const groups: string[] = []

  if (memory.about) groups.push(`About: ${memory.about.replace(/\s+/g, ' ').trim()}`)
  if (memory.preferences.length) groups.push(`You told me: ${memory.preferences.slice(-4).join('; ')}`)
  if (memory.decisions.length) groups.push(`Decisions: ${memory.decisions.slice(-3).join('; ')}`)
  if (memory.activity.length) {
    const last = memory.activity[memory.activity.length - 1]!
    groups.push(`Last thing I did: ${activityBody(last)}`)
  }

  if (!groups.length) return 'Nothing yet — I have not learned anything about this project.'
  const text = groups.join(' · ')
  return text.length > limit ? `${text.slice(0, limit - 1).trim()}…` : text
}

/* --------------------------------------------------------------- backend */

function rendererBackend(): MemoryBackend {
  return {
    read: (projectId) => window.forge.memory.read(projectId),
    append: (projectId, section, entry, at) => window.forge.memory.append(projectId, section, entry, at),
    replaceSummary: (projectId, text) => window.forge.memory.replaceSummary(projectId, text),
    clear: (projectId) => window.forge.memory.clear(projectId)
  }
}

let backend: MemoryBackend | null = null

function io(): MemoryBackend {
  if (!backend) backend = rendererBackend()
  return backend
}

/** Test seam. Passing null puts the real IPC backend back. */
export function setMemoryBackend(next: MemoryBackend | null): void {
  backend = next
}

/* ------------------------------------------------------------ summarising */

/** How many exchanges between optional LLM rewrites of the About paragraph. */
export const SUMMARISE_EVERY = 10

const SUMMARISE_SYSTEM = [
  'You maintain the one-paragraph "About this project" summary that a coding assistant reads before every reply.',
  'You will be given the assistant’s current memory of one project, as markdown.',
  'Reply with the replacement paragraph and nothing else — no heading, no bullets, no preamble, no markdown.',
  'Three or four sentences at most: what this project is, what it is built with, and how its owner likes to work.',
  'Use only what the memory actually says. Invent nothing. If it says almost nothing, say almost nothing.'
].join('\n')

/**
 * The default summariser: one plain-text call to whichever brain is configured,
 * with no manifest and no schema attached. Returns null whenever it cannot or
 * should not run — no key, the setting off, an API error — because failing to
 * improve a summary is not an error worth showing anybody.
 */
async function defaultSummariser(markdown: string): Promise<string | null> {
  try {
    const { settings } = await window.forge.store.snapshot()
    if (!settings.memoryLlmSummarize) return null

    const gemini = (settings.geminiKey ?? '').trim()
    const openrouter = (settings.openrouterKey ?? '').trim()
    const useOpenRouter = settings.voiceBrain === 'openrouter' || (!gemini && Boolean(openrouter))

    if (useOpenRouter) {
      if (!openrouter) return null
      const res = await window.forge.voice.openrouter({
        key: openrouter,
        model: settings.openrouterModel,
        system: SUMMARISE_SYSTEM,
        turns: [{ role: 'user', text: markdown }],
        maxTokens: 400
      })
      return res.ok ? res.text.trim() || null : null
    }

    if (!gemini) return null
    const res = await window.forge.voice.gemini({
      key: gemini,
      model: settings.geminiModel,
      system: SUMMARISE_SYSTEM,
      turns: [{ role: 'user', text: markdown }]
    })
    return res.ok ? res.text.trim() || null : null
  } catch {
    return null
  }
}

let summariser: MemorySummariser | null = null

/** Test seam. Passing null puts the real one back. */
export function setMemorySummariser(next: MemorySummariser | null): void {
  summariser = next
}

/* ------------------------------------------------------------------ store */

/**
 * A warm copy per project, so the brain context can be built synchronously.
 *
 * The alternative — awaiting a read inside the phrase handler — would put an
 * IPC round trip in front of every single reply for a file that changes only
 * when this module changes it. So the cache is written on prime, on every
 * append and on recall, and is therefore never behind.
 */
const warm = new Map<string, string>()
const exchanges = new Map<string, number>()

export const agentMemory = {
  /** What the brain should be told, right now, with no awaiting. */
  cached(projectId: string | null): string {
    return projectId ? (warm.get(projectId) ?? '') : ''
  },

  /** Read a project's memory into the cache. Called when the project changes. */
  async prime(projectId: string | null): Promise<string> {
    if (!projectId) return ''
    try {
      const text = await io().read(projectId)
      warm.set(projectId, text)
      return text
    } catch {
      return warm.get(projectId) ?? ''
    }
  },

  /**
   * Learn from one finished exchange. Never rejects and never blocks the panel:
   * the reply is already on screen by the time this runs, and a memory that
   * could not be written is a project that forgets, not an app that breaks.
   */
  async record(exchange: MemoryExchange): Promise<void> {
    const projectId = exchange.projectId
    if (!projectId) return
    try {
      const updates = extractMemoryUpdates(exchange)
      for (const update of updates) {
        warm.set(projectId, await io().append(projectId, update.section, update.entry, exchange.at))
      }

      const n = (exchanges.get(projectId) ?? 0) + 1
      exchanges.set(projectId, n)
      if (n % SUMMARISE_EVERY !== 0) return

      const current = warm.get(projectId) ?? (await io().read(projectId))
      if (!current.trim()) return
      const summary = await (summariser ?? defaultSummariser)(current)
      if (summary) warm.set(projectId, await io().replaceSummary(projectId, summary))
    } catch (err) {
      console.warn('[memory] could not record this exchange:', err)
    }
  },

  /** "What do you remember?" — answered off the file, with no model involved. */
  async recall(projectId: string | null): Promise<ActionOutcome> {
    if (!projectId) {
      return { ok: false, summary: 'No project open — there is nothing for me to remember yet', requested: 1, done: 0 }
    }
    try {
      const text = await io().read(projectId)
      warm.set(projectId, text)
      return { ok: true, summary: describeMemory(text), requested: 1, done: 1 }
    } catch (err) {
      return {
        ok: false,
        summary: `Could not read this project's memory: ${err instanceof Error ? err.message : String(err)}`,
        requested: 1,
        done: 0
      }
    }
  },

  /** "Forget this project's memory" — and say plainly that it is gone. */
  async forget(projectId: string | null): Promise<ActionOutcome> {
    if (!projectId) {
      return { ok: false, summary: 'No project open — there is no memory to forget', requested: 1, done: 0 }
    }
    try {
      const had = (await io().read(projectId)).trim().length > 0
      const ok = await io().clear(projectId)
      warm.set(projectId, '')
      exchanges.set(projectId, 0)
      if (!ok) return { ok: false, summary: 'Could not delete this project’s memory file', requested: 1, done: 0 }
      return {
        ok: true,
        summary: had
          ? 'Forgotten — this project’s memory file is deleted. I start again from nothing.'
          : 'There was nothing to forget — this project had no memory yet.',
        requested: 1,
        done: 1
      }
    } catch (err) {
      return {
        ok: false,
        summary: `Could not forget: ${err instanceof Error ? err.message : String(err)}`,
        requested: 1,
        done: 0
      }
    }
  },

  /** Test seam: drop every warm copy and exchange counter. */
  __reset(): void {
    warm.clear()
    exchanges.clear()
  }
}
