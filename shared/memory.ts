import type { MemorySection } from './types'

/**
 * The *format* of a project's agent memory: how the markdown is read, written
 * and kept small. No file I/O, no Electron, no DOM — which is what lets the
 * main process (electron/memory-store.ts, which owns the files) and the
 * renderer (src/lib/agentmemory.ts, which reads it back for "what do you
 * remember?") agree on the shape without either owning the other.
 *
 * Markdown rather than JSON on purpose. The file is folded verbatim into the
 * brain's system text, so the storage format *is* the prompt format — nothing
 * has to be re-rendered or kept in step. And it stays readable: Steve can open
 * `%APPDATA%\Forge\memory\<projectId>.md` in Notepad and see exactly what Forge
 * believes about him, which is the only honest way to ship something that
 * quietly remembers what you say.
 */

export interface ProjectMemory {
  /** The rolling summary. One paragraph; may be empty. */
  about: string
  decisions: string[]
  preferences: string[]
  /** Already stamped, oldest first: "2026-07-30 15:04 — Opened 3 Kimi tabs". */
  activity: string[]
}

/** The whole file is sent on every turn, so an unbounded memory is a bill. */
export const MEMORY_MAX_BYTES = 8 * 1024
/** Ceilings applied before the byte cap even gets a look in. */
export const MEMORY_MAX_ACTIVITY = 40
export const MEMORY_MAX_LIST = 24
export const MEMORY_MAX_ENTRY_CHARS = 300
export const MEMORY_MAX_ABOUT_CHARS = 1200

export const MEMORY_HEADINGS: Record<MemorySection, string> = {
  about: 'About this project',
  decisions: 'Decisions',
  preferences: 'Preferences',
  activity: 'Recent activity'
}

export const MEMORY_SECTIONS: MemorySection[] = ['about', 'decisions', 'preferences', 'activity']

export function isMemorySection(value: unknown): value is MemorySection {
  return typeof value === 'string' && (MEMORY_SECTIONS as string[]).includes(value)
}

export function emptyMemory(): ProjectMemory {
  return { about: '', decisions: [], preferences: [], activity: [] }
}

/** Tolerant of case and of the stray colon a hand-edited file might grow. */
function sectionForHeading(heading: string): MemorySection | null {
  const want = heading.trim().toLowerCase().replace(/[:.]+$/, '')
  for (const section of MEMORY_SECTIONS) {
    if (MEMORY_HEADINGS[section].toLowerCase() === want) return section
  }
  return null
}

/* ---------------------------------------------------------------- parsing */

/**
 * Read the markdown back into sections.
 *
 * Tolerant by design — this file is meant to be hand-editable, so an unknown
 * heading, a missing section or a bullet written with `*` instead of `-` must
 * not cost the rest of the file.
 */
export function parseMemory(markdown: string): ProjectMemory {
  const memory = emptyMemory()
  if (!markdown) return memory

  let current: MemorySection | null = null
  const about: string[] = []

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading) {
      current = sectionForHeading(heading[1] ?? '')
      continue
    }
    // The `# Project memory` title, and anything before the first section.
    if (/^#\s/.test(line) || !current) continue

    if (current === 'about') {
      about.push(line)
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    const text = (bullet?.[1] ?? line).trim()
    if (!text) continue
    memory[current].push(text)
  }

  memory.about = about.join('\n').trim()
  return memory
}

/* -------------------------------------------------------------- rendering */

/**
 * Render sections back to markdown. Empty sections are dropped entirely: this
 * text goes into a prompt, and a heading with nothing under it teaches a model
 * only that Forge has nothing to say.
 */
export function formatMemory(memory: ProjectMemory): string {
  const blocks: string[] = []
  if (memory.about.trim()) blocks.push(`## ${MEMORY_HEADINGS.about}\n${memory.about.trim()}`)
  for (const section of ['decisions', 'preferences', 'activity'] as const) {
    const list = memory[section]
    if (!list.length) continue
    blocks.push(`## ${MEMORY_HEADINGS[section]}\n${list.map((e) => `- ${e}`).join('\n')}`)
  }
  if (!blocks.length) return ''
  return `# Project memory\n\n${blocks.join('\n\n')}\n`
}

/* --------------------------------------------------------------- pruning */

const encoder = new TextEncoder()

export function memoryBytes(text: string): number {
  return encoder.encode(text).length
}

/**
 * Bring a memory back under the caps, cheapest loss first.
 *
 * The order is the actual policy: activity is a log and ages out; the summary
 * can be clipped; decisions can be forgotten; preferences are the things Steve
 * explicitly asked it to remember, and are given up only when there is
 * literally nothing else left to drop.
 */
export function pruneMemory(memory: ProjectMemory, maxBytes = MEMORY_MAX_BYTES): ProjectMemory {
  const out: ProjectMemory = {
    about: memory.about.trim().slice(0, MEMORY_MAX_ABOUT_CHARS).trim(),
    decisions: memory.decisions.slice(-MEMORY_MAX_LIST),
    preferences: memory.preferences.slice(-MEMORY_MAX_LIST),
    activity: memory.activity.slice(-MEMORY_MAX_ACTIVITY)
  }

  while (memoryBytes(formatMemory(out)) > maxBytes) {
    if (out.activity.length) {
      out.activity.shift()
      continue
    }
    if (out.about.length > 200) {
      out.about = `${out.about.slice(0, Math.max(200, out.about.length - 400)).trim()}…`
      continue
    }
    if (out.decisions.length) {
      out.decisions.shift()
      continue
    }
    if (out.preferences.length > 1) {
      out.preferences.shift()
      continue
    }
    // One entry, on its own, longer than the whole cap. Clip it and stop:
    // looping forever would be worse than a memory with one blunt line in it.
    out.preferences = out.preferences.map((p) => p.slice(0, 200))
    out.about = out.about.slice(0, 200)
    break
  }
  return out
}

/* ---------------------------------------------------------------- entries */

/** One line, no bullet, no newlines, bounded — whatever the caller hands over. */
export function tidyEntry(entry: string): string {
  const flat = String(entry ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= MEMORY_MAX_ENTRY_CHARS) return flat
  return `${flat.slice(0, MEMORY_MAX_ENTRY_CHARS - 1).trim()}…`
}

/** `2026-07-30 15:04` — local time, sortable, no seconds worth reading. */
export function stampFor(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** The body of an activity line, without its timestamp. */
export function activityBody(line: string): string {
  const m = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} — (.*)$/.exec(line)
  return (m?.[1] ?? line).trim()
}
