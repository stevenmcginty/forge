import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import {
  capBody,
  emptySlot,
  formatSlot,
  isSlotIndex,
  parseSlot,
  slotFileName,
  slotIndexes,
  slotOf,
  tidyTitle,
  SHARE_MAX_PANES,
  SHARE_SLOTS
} from '@shared/share'
import type { ShareSlot, ShareSlotBody, SharePane, ShareVia, ShareWriteRequest, ShareWriteResult } from '@shared/types'

/**
 * Five pigeonholes in the project folder, and the two things this module
 * refuses to do: **write outside them, and overwrite work it did not read
 * first.**
 *
 *   <project>\.forge\share\slot-1.md … slot-5.md   the slots
 *   <project>\.forge\share\README.md               the protocol, for agents
 *   <project>\.forge\share\panes.json              who is in this project
 *
 * Inside the project rather than under %APPDATA%\Forge, which is where every
 * other per-project thing Forge owns lives (memory, layouts, shots). The reason
 * is the entire feature: an agent has to be able to read a slot with the tools it
 * already has, and `read .forge/share/slot-2.md` is a relative path inside its
 * own workspace — no permission prompt, no sandbox argument, no ninety-character
 * absolute path pasted into a prompt. The cost is a folder appearing in the
 * user's repo, which is paid for by adding `.forge/` to `.git/info/exclude` —
 * local, per-clone, and never their `.gitignore` (see `ensureExcluded`).
 *
 * Deliberately free of any `electron` import — it is handed a project path rather
 * than reaching for one, which is what lets scripts/share-check.mjs drive the
 * real module against `mkdtempSync()` instead of a copy. The `ipcMain` half,
 * the watcher and the debouncing all live in electron/share-watcher.ts.
 *
 * Nothing here throws at the caller. A slot that cannot be read comes back as a
 * slot with a `problem` on it; the worst case is a row that goes dim, which is
 * exactly where the feature started.
 */

/* --------------------------------------------------------------- the README */

/**
 * First line of the README, and the permission to rewrite it.
 *
 * Forge keeps the protocol doc up to date across versions, so it rewrites the
 * file when the template changes — but only while this marker is still the first
 * line. Someone who replaced the file deliberately has said something, and the
 * answer to that is to leave it alone.
 */
const README_MARKER = '<!-- forge-managed: Forge rewrites this file. Put your own notes in a slot. -->'

function readmeText(): string {
  return `${README_MARKER}

# Shared scratchpad

Five markdown slots that every agent working in this project can read and write —
Claude Code, Codex, Antigravity, Qwen, OpenCode, and whoever is typing into
Forge's rail. Use it to hand work between panes: draft a plan in one, have
another review it, leave an API contract where a third can find it.

    .forge/share/slot-1.md … slot-5.md

The slot *number* is its name. A slot with no file is an empty slot.

## Reading

Just read the file. \`.forge/share/panes.json\` lists the panes currently open in
this project, so "who else is working here" is a file too.

## Writing

Two ways, both fine:

1. **The \`forge_share\` MCP tools**, if you can see them: \`share_list\`,
   \`share_read\`, \`share_write\`, \`share_clear\`, \`share_panes\`. Prefer these —
   \`share_write\` refuses rather than clobbering a slot somebody changed while
   you were thinking.
2. **Write the file yourself.** Forge reads a slot with no front matter as
   \`via: agent\` and takes its title from the first heading. Nothing is lost.

Front matter, all of it optional:

    ---
    slot: 2
    title: API contract for the sync endpoint
    updatedAt: 2026-01-01T00:00:00Z
    author: Claude Code — main
    via: mcp
    ---

    The body, verbatim markdown.

## House rules

- **Say who you are.** Set \`author\` to your pane's name. Another agent is going
  to read this and will want to know whose opinion it is holding.
- **Do not rewrite a slot you were not asked to rewrite.** Add a new one.
- A body over 64 KiB keeps its head and loses its tail, with a comment saying so.
- Forge types prompts into panes and never presses Enter, so nothing in here
  submits work on anybody's behalf.

\`.forge/\` is added to this clone's \`.git/info/exclude\`, so none of it is
committed and your \`.gitignore\` is untouched.
`
}

/* -------------------------------------------------------- .git/info/exclude */

const EXCLUDE_RULE = '.forge/'
const EXCLUDE_NOTE = '# Forge — local per-project state (shared scratchpad). Deliberately here and not in .gitignore.'

/** Every spelling of "ignore .forge" that means the job is already done. */
const EXCLUDE_EQUIVALENTS = new Set(['.forge', '.forge/', '/.forge', '/.forge/', '.forge/**', '/.forge/**'])

export interface ShareEnsureResult {
  ok: boolean
  created: boolean
  error?: string
}

export class ShareStore {
  /** The project folder. */
  readonly projectPath: string
  /** `<project>\.forge\share` — the only directory this class ever writes in. */
  readonly root: string

  constructor(projectPath: string) {
    this.projectPath = resolve(String(projectPath ?? ''))
    this.root = join(this.projectPath, '.forge', 'share')
  }

  /**
   * The path of one slot.
   *
   * The only place in Forge a slot filename is built, and it is built from an
   * integer. That is what makes traversal impossible rather than sanitised: no
   * caller — not the rail, not an MCP tool — ever supplies a path.
   */
  slotPath(index: number): string | null {
    if (!isSlotIndex(index)) return null
    return join(this.root, slotFileName(index))
  }

  /** Create the folder, the README and the exclude line. Idempotent. */
  ensure(): ShareEnsureResult {
    const created = !existsSync(this.root)
    try {
      mkdirSync(this.root, { recursive: true })
    } catch (err) {
      return { ok: false, created: false, error: `Could not create ${this.root}: ${(err as Error).message}` }
    }
    this.writeReadme()
    this.ensureExcluded()
    return { ok: true, created }
  }

  /** Is the folder there? Nothing else in here creates it as a side effect. */
  opened(): boolean {
    return existsSync(this.root)
  }

  /* ------------------------------------------------------------------ read */

  /**
   * All five slots, filled or not, in index order.
   *
   * Rows, not bodies: five 64 KiB bodies would be 320 KiB structured-cloned to
   * the renderer on every write, to draw five one-line rows.
   */
  list(): ShareSlot[] {
    return slotIndexes().map((index) => {
      const parsed = this.readOrProblem(index)
      if ('problem' in parsed) return { ...emptySlot(index), problem: parsed.problem }
      return slotOf(parsed)
    })
  }

  /**
   * One slot's full body. `null` when there is no file, and equally when there is
   * one that cannot be read — a caller opening a row for editing wants "there is
   * nothing here to edit", and `list()` is where the reason is reported.
   */
  read(index: number): ShareSlotBody | null {
    const path = this.slotPath(index)
    if (!path || !existsSync(path)) return null
    const parsed = this.readOrProblem(index)
    if ('problem' in parsed) return null
    return parsed
  }

  /** The roster as last written. The same file `share_panes` reads. */
  readRoster(): SharePane[] {
    const path = join(this.root, 'panes.json')
    if (!existsSync(path)) return []
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { panes?: unknown }
      if (!Array.isArray(parsed?.panes)) return []
      return parsed.panes.slice(0, SHARE_MAX_PANES).map((p) => {
        const pane = (p ?? {}) as Partial<SharePane>
        return {
          paneId: String(pane.paneId ?? ''),
          title: String(pane.title ?? ''),
          agent: String(pane.agent ?? ''),
          profileId: String(pane.profileId ?? ''),
          openedAt: Number.isFinite(pane.openedAt) ? (pane.openedAt as number) : 0
        }
      })
    } catch {
      // A roster nobody can parse is a roster nobody has. Not worth a problem
      // badge — the panes are in the rail anyway.
      return []
    }
  }

  private readOrProblem(index: number): ShareSlotBody | { problem: string } {
    const path = this.slotPath(index)
    if (!path) return { problem: `Slot ${index} is not a slot` }
    if (!existsSync(path)) return parseSlot(index, '', 0)
    try {
      const stat = statSync(path)
      if (!stat.isFile()) return { problem: `${slotFileName(index)} is not a file` }
      return parseSlot(index, readFileSync(path, 'utf8'), stat.mtimeMs)
    } catch (err) {
      return { problem: `${slotFileName(index)} could not be read: ${(err as Error).message}` }
    }
  }

  /* ----------------------------------------------------------------- write */

  /**
   * Put a body in a slot.
   *
   * Refuses rather than clobbers when `expectUpdatedAt` does not match what is on
   * disk. Three panes can hold the same slot open, so a write that does not say
   * what it thought it was editing is a write that can quietly lose somebody's
   * afternoon. The refusal names who got there first, because "conflict" on its
   * own is not something a person or an agent can act on.
   */
  write(req: ShareWriteRequest, at: number = Date.now()): ShareWriteResult {
    const index = req?.index as number
    if (!isSlotIndex(index)) {
      return { ok: false, error: `There is no slot ${String(req?.index)} — slots are 1 to ${SHARE_SLOTS}.` }
    }
    const path = this.slotPath(index)
    if (!path) return { ok: false, error: `There is no slot ${index}.` }

    const current = this.readOrProblem(index)
    if ('problem' in current) return { ok: false, error: current.problem }

    if (typeof req.expectUpdatedAt === 'number' && current.body.trim() && current.updatedAt !== req.expectUpdatedAt) {
      const who = current.author.trim() || 'Somebody'
      return {
        ok: false,
        conflict: true,
        error: `Slot ${index} changed since you read it — ${who} wrote it ${agoLabel(at - current.updatedAt)}.`,
        slot: slotOf(current)
      }
    }

    const incoming = String(req.body ?? '')
    const joined = req.append && current.body.trim() ? `${current.body.replace(/\s+$/, '')}\n\n${incoming.replace(/^\s+/, '')}` : incoming
    const capped = capBody(joined)
    const title = tidyTitle(req.title ?? '') || (req.append ? current.title : '') || `Slot ${index}`
    const via: ShareVia = req.via ?? 'agent'

    const text = formatSlot({ index, title, body: capped.body, updatedAt: at, author: String(req.author ?? ''), via })

    try {
      mkdirSync(this.root, { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, text, 'utf8')
      renameSync(tmp, path)
    } catch (err) {
      return { ok: false, error: `Could not write ${slotFileName(index)}: ${(err as Error).message}` }
    }

    const written = this.read(index)
    return {
      ok: true,
      truncated: capped.truncated,
      ...(capped.truncated ? { dropped: capped.dropped } : {}),
      ...(written ? { slot: slotOf(written) } : {})
    }
  }

  /**
   * Empty a slot by deleting its file.
   *
   * Deleting rather than blanking, because an empty file is indistinguishable
   * from an agent having truncated one by accident, and `ls .forge/share` should
   * show exactly what is filled.
   */
  clear(index: number): ShareWriteResult {
    const path = this.slotPath(index)
    if (!path) return { ok: false, error: `There is no slot ${String(index)}.` }
    try {
      if (existsSync(path)) unlinkSync(path)
      return { ok: true, slot: emptySlot(index) }
    } catch (err) {
      return { ok: false, error: `Could not clear ${slotFileName(index)}: ${(err as Error).message}` }
    }
  }

  /**
   * Write the pane roster, if it has changed.
   *
   * Deduped against what `readRoster` makes of the file already there rather than
   * against a remembered hash — the two go through the same normaliser, so the
   * comparison is about the panes and not about `updatedAt`, which moves every
   * time and means nothing. It is also correct across a restart, which a
   * remembered hash is not. A roster that churns is a file that wakes every
   * watcher anyone has pointed at their repo.
   */
  writeRoster(panes: SharePane[], at: number = Date.now()): void {
    if (!this.opened()) return
    /*
     * `openedAt` is filled in here rather than in the renderer, which does not
     * know it: a pane leaf carries no birthday, and the renderer would have to
     * invent a second place to remember one. So "first time this roster saw the
     * pane" is the definition, kept across writes by reading the roster back.
     */
    const known = new Map(this.readRoster().map((p) => [p.paneId, p.openedAt]))
    const list = (Array.isArray(panes) ? panes : []).slice(0, SHARE_MAX_PANES).map((p) => {
      const paneId = String(p?.paneId ?? '')
      const given = Number.isFinite(p?.openedAt) && (p.openedAt as number) > 0 ? (p.openedAt as number) : 0
      return {
        paneId,
        title: String(p?.title ?? ''),
        agent: String(p?.agent ?? ''),
        profileId: String(p?.profileId ?? ''),
        openedAt: given || known.get(paneId) || at
      }
    })
    const path = join(this.root, 'panes.json')
    try {
      if (existsSync(path) && JSON.stringify(this.readRoster()) === JSON.stringify(list)) return
      const text = `${JSON.stringify({ updatedAt: new Date(at).toISOString(), panes: list }, null, 2)}\n`
      const tmp = `${path}.tmp`
      writeFileSync(tmp, text, 'utf8')
      renameSync(tmp, path)
    } catch (err) {
      console.error(`[share] could not write ${path}:`, err)
    }
  }

  /** Write or refresh the protocol doc. Leaves a de-marked README alone. */
  writeReadme(): void {
    const path = join(this.root, 'README.md')
    const wanted = readmeText()
    try {
      if (existsSync(path)) {
        const existing = readFileSync(path, 'utf8')
        if (!existing.startsWith(README_MARKER)) return
        if (existing === wanted) return
      }
      const tmp = `${path}.tmp`
      writeFileSync(tmp, wanted, 'utf8')
      renameSync(tmp, path)
    } catch (err) {
      console.error(`[share] could not write ${path}:`, err)
    }
  }

  /* -------------------------------------------------------------- git hygiene */

  /**
   * Is `.forge/` already excluded from git in this clone?
   *
   * False also means "there is nothing to exclude it in" — a folder that is not
   * a repository, or one whose `.git` is a *file* rather than a directory, which
   * is what a linked worktree and a submodule look like. Their real exclude file
   * lives wherever `git rev-parse --git-common-dir` points, and spawning git for
   * a comfort feature is not worth it, so those are skipped and reported rather
   * than guessed at.
   */
  excluded(): boolean {
    const path = this.excludePath()
    if (!path || !existsSync(path)) return false
    try {
      return hasExcludeRule(readFileSync(path, 'utf8'))
    } catch {
      return false
    }
  }

  /**
   * Append `.forge/` to `.git/info/exclude`, once, ever.
   *
   * Called on every watch start rather than once at setup: a folder becomes a
   * repository the moment somebody runs `git init`, and the exclude has to catch
   * up. One `existsSync` and one small `readFileSync` — cheaper than the settle
   * timer it sits next to.
   *
   * Idempotent by *content*, not by a memory of having done it. It never rewrites
   * an existing line, never reorders, and keeps the file's own line endings —
   * this is a file people hand-edit, and Forge is a guest in it.
   */
  ensureExcluded(): boolean {
    const path = this.excludePath()
    if (!path) return false
    try {
      const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
      if (hasExcludeRule(existing)) return true

      const eol = /\r\n/.test(existing) ? '\r\n' : '\n'
      const lead = existing.length === 0 ? '' : existing.endsWith('\n') ? eol : `${eol}${eol}`
      const block = `${lead}${EXCLUDE_NOTE}${eol}${EXCLUDE_RULE}${eol}`

      mkdirSync(join(this.projectPath, '.git', 'info'), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, `${existing}${block}`, 'utf8')
      renameSync(tmp, path)
      return true
    } catch (err) {
      console.error(`[share] could not update ${path}:`, err)
      return false
    }
  }

  /** `<project>\.git\info\exclude`, or null when `.git` is not a directory. */
  private excludePath(): string | null {
    const gitDir = join(this.projectPath, '.git')
    try {
      if (!existsSync(gitDir)) return null
      if (!statSync(gitDir).isDirectory()) return null
    } catch {
      return null
    }
    return join(gitDir, 'info', 'exclude')
  }

  /* ------------------------------------------------------------------ misc */

  /** Every entry in the share folder. Used by the check script, not the app. */
  entries(): string[] {
    if (!this.opened()) return []
    try {
      return readdirSync(this.root).sort()
    } catch {
      return []
    }
  }

  /** Is this path inside the folder this store owns? The belt to slotPath's braces. */
  contains(path: string): boolean {
    const target = resolve(path)
    const base = resolve(this.root)
    return target !== base && (target + sep).startsWith(base + sep)
  }
}

/* ------------------------------------------------------------------ helpers */

function hasExcludeRule(text: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    // A comment mentioning .forge/ is not a rule, and must not be mistaken for
    // one — otherwise a note somebody left explains why the rule is missing.
    if (!line || line.startsWith('#')) continue
    if (EXCLUDE_EQUIVALENTS.has(line)) return true
  }
  return false
}

/** `8s`, `4m`, `2h`, `3d` — for a sentence handed to a person or a model. */
function agoLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
