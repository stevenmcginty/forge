import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  formatMemory,
  isMemorySection,
  parseMemory,
  pruneMemory,
  stampFor,
  tidyEntry,
  MEMORY_MAX_ABOUT_CHARS,
  type ProjectMemory
} from '@shared/memory'
import type { MemorySection } from '@shared/types'

/**
 * Per-project agent memory on disk — the thing that makes Forge feel like it
 * knows your projects rather than meeting them for the first time every phrase.
 *
 *   %APPDATA%\Forge\memory\<projectId>.md
 *
 * One markdown file per project, in the format defined by shared/memory.ts.
 * This module owns only the file half of it:
 *
 *   • Writes are atomic (tmp + rename), as everywhere else in Forge's store.
 *   • Every write is pruned first, so the file can never outgrow its cap — it
 *     is sent to a model on every turn.
 *   • Nothing here throws at the caller. A memory that cannot be written must
 *     not take the voice panel down with it; the worst case is a project that
 *     forgets, which is exactly where it started.
 *
 * Deliberately free of any `electron` import — it is handed a directory and an
 * `ipcMain` rather than reaching for them. That is what lets
 * scripts/memory-smoke.mjs drive the real module head-less instead of a copy.
 */

export type { ProjectMemory }

/** Filenames come from project ids, which come from ids.ts — belt and braces. */
export function memoryFileName(projectId: string): string {
  const safe = String(projectId ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${safe || 'unknown'}.md`
}

export class ProjectMemoryStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  fileFor(projectId: string): string {
    return join(this.dir, memoryFileName(projectId))
  }

  /** The markdown as it stands. Empty string when there is nothing yet. */
  read(projectId: string): string {
    const path = this.fileFor(projectId)
    if (!existsSync(path)) return ''
    try {
      return readFileSync(path, 'utf8')
    } catch (err) {
      console.error(`[memory] ${path} is unreadable:`, err)
      try {
        renameSync(path, `${path}.corrupt`)
      } catch {
        /* best effort */
      }
      return ''
    }
  }

  /** Parsed sections — the shape append/replaceSummary work on. */
  load(projectId: string): ProjectMemory {
    return parseMemory(this.read(projectId))
  }

  /**
   * Add one entry. Resolves with the file as it now stands, so a caller keeping
   * a warm copy for the next prompt never needs a second read.
   *
   * Repeating an entry is a no-op: saying "always use strict mode" twice should
   * not make the memory say it twice, and heuristic extraction repeats itself
   * constantly. Activity is the exception — the same action an hour later is
   * real history — so only a back-to-back repeat is dropped there.
   */
  append(projectId: string, section: MemorySection, entry: string, at: number = Date.now()): string {
    const text = tidyEntry(entry)
    if (!text) return this.read(projectId)

    const memory = this.load(projectId)
    if (section === 'about') {
      memory.about = (memory.about ? `${memory.about} ${text}` : text).slice(0, MEMORY_MAX_ABOUT_CHARS).trim()
      return this.write(projectId, memory)
    }

    const list = memory[section]
    if (section === 'activity') {
      if (list[list.length - 1]?.endsWith(`— ${text}`)) return this.read(projectId)
      list.push(`${stampFor(at)} — ${text}`)
    } else {
      if (list.includes(text)) return this.read(projectId)
      list.push(text)
    }
    return this.write(projectId, memory)
  }

  /** Rewrite the rolling summary wholesale. That is what a summary is. */
  replaceSummary(projectId: string, text: string): string {
    const memory = this.load(projectId)
    memory.about = String(text ?? '')
      .replace(/\r\n/g, '\n')
      .trim()
      .slice(0, MEMORY_MAX_ABOUT_CHARS)
    return this.write(projectId, memory)
  }

  /** Forget this project entirely. The file goes; nothing is kept behind. */
  clear(projectId: string): boolean {
    const path = this.fileFor(projectId)
    try {
      if (existsSync(path)) unlinkSync(path)
      return true
    } catch (err) {
      console.error(`[memory] could not clear ${path}:`, err)
      return false
    }
  }

  /** Atomic: a half-written memory would be worse than no memory at all. */
  private write(projectId: string, memory: ProjectMemory): string {
    const markdown = formatMemory(pruneMemory(memory))
    const path = this.fileFor(projectId)
    try {
      mkdirSync(this.dir, { recursive: true })
      if (!markdown) {
        if (existsSync(path)) unlinkSync(path)
        return ''
      }
      const tmp = `${path}.tmp`
      writeFileSync(tmp, markdown, 'utf8')
      renameSync(tmp, path)
    } catch (err) {
      console.error(`[memory] failed to write ${path}:`, err)
      // Hand back what is actually on disk, not what we hoped to put there.
      return this.read(projectId)
    }
    return markdown
  }
}

/* ------------------------------------------------------- process singleton */

let store: ProjectMemoryStore | null = null

/** Called once at startup with `<data root>\memory`. */
export function setMemoryDir(dir: string): void {
  store = new ProjectMemoryStore(dir)
}

/**
 * Wire the four channels onto an `ipcMain`.
 *
 * `ipcMain` and the channel names are parameters rather than imports so this
 * module stays free of `electron`. Every argument is coerced on the way in: the
 * renderer is never trusted with something that becomes part of a file path.
 */
export function registerMemoryHandlers(
  ipc: Electron.IpcMain,
  channels: { read: string; append: string; replaceSummary: string; clear: string }
): void {
  ipc.handle(channels.read, (_e, projectId: string) => store?.read(String(projectId ?? '')) ?? '')

  ipc.handle(channels.append, (_e, projectId: string, section: unknown, entry: string, at?: number) => {
    if (!store) return ''
    const id = String(projectId ?? '')
    if (!isMemorySection(section)) return store.read(id)
    return store.append(id, section, String(entry ?? ''), Number.isFinite(at) ? (at as number) : Date.now())
  })

  ipc.handle(channels.replaceSummary, (_e, projectId: string, text: string) =>
    store?.replaceSummary(String(projectId ?? ''), String(text ?? '')) ?? ''
  )

  ipc.handle(channels.clear, (_e, projectId: string) => store?.clear(String(projectId ?? '')) ?? false)
}
