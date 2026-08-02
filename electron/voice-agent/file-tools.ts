import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { copyFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { whichCommand } from '../which'

/**
 * The voice agent's hands on the file system and the machine — tier three of
 * the JARVIS build-out.
 *
 * Tier one gave the agent Forge, tier two the desktop. What was still missing
 * was the join between them: it could ask the bridge for an image and then had
 * no way to tell Steve where it went, let alone put it on his desktop. So this
 * module is the four verbs that were absent — look in a folder, move a file
 * into place, write a text file, run one command and read what it printed.
 *
 * ## Every export answers in one sentence
 *
 * The model reads these results and then says them out loud, so a stack trace
 * is a worse answer than "there is already a file there". Expected failures —
 * a missing folder, a relative path, a refusal to overwrite — come back as
 * ordinary prose, and only a genuine bug is allowed to reject. That is the same
 * contract every handler in voice-agent/host.ts is written against.
 *
 * ## Deliberately Electron-free
 *
 * Same rule as ../desktop-control.ts and voice-agent/host.ts, which import it:
 * plain Node only, so scripts/voice-brain-smoke.mjs can load the host headless.
 *
 * ## Safety shape
 *
 * Nothing here deletes. `saveAsset` and `writeTextFile` refuse to land on an
 * existing file unless the caller passes `overwrite`, which the model only does
 * after Steve has said so out loud, and `runCommand` is bounded by a timeout
 * and a truncated transcript rather than by what it is allowed to run. The
 * persona layer owns "ask first"; this layer's job is that a slip of the model's
 * tongue cannot silently destroy something that was already on disk.
 */

/* ------------------------------------------------------------------ limits */

/** Long enough for a build to say something useful, short enough to speak. */
const COMMAND_TIMEOUT_MS = 30_000

/** Roughly a page of transcript. Beyond this the model is reading noise. */
const MAX_OUTPUT_CHARS = 8_000

/** A voice agent dictating more than this is not writing a note any more. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024

/* ------------------------------------------------------------------- paths */

/**
 * Where the Gemini bridge saves what it generates.
 *
 * This mirrors `defaultOutDir()` in bridge/gemini-bridge.mjs exactly, and has
 * to: the bridge runs as its own process and never tells anyone where it put
 * the file beyond its own tool result, so the only way to answer "show me what
 * you made" a turn later is to agree on the folder independently. If that
 * function moves, this one moves with it.
 *
 * One seam to know about: electron/bridge/mcp-config.ts sets FORGE_BRIDGE_OUT
 * in the *bridge subprocess* env, from `getDataDir()`. Those agree on an
 * ordinary run, because the data dir is %APPDATA%\Forge — but a Forge started
 * with --data-dir puts the files somewhere this function will not guess. When
 * that starts to matter, the answer is to hand the real directory in through
 * VoiceAgentDeps rather than to make this function cleverer.
 */
export function defaultAssetsDir(): string {
  const configured = process.env['FORGE_BRIDGE_OUT']
  if (configured) return configured
  const appData = process.env['APPDATA']
  if (appData) return join(appData, 'Forge', 'bridge-out')
  return join(homedir(), '.forge', 'bridge-out')
}

/**
 * What is at a path, without throwing about it.
 *
 * A path we cannot stat for permission reasons reports as missing, which is a
 * small lie in a rare case and the right one: every caller treats "missing" as
 * "safe to write here", and the write itself will fail loudly if it is not.
 */
async function pathKind(target: string): Promise<'file' | 'dir' | 'missing'> {
  try {
    return (await stat(target)).isDirectory() ? 'dir' : 'file'
  } catch {
    return 'missing'
  }
}

/* -------------------------------------------------------------- formatting */

/** Sizes a person would say aloud. Never bytes past a kilobyte. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Local date and time, minutes precision. Not a relative "two minutes ago":
 * the model is comparing these to each other to find the newest one, and an
 * absolute stamp is the only form that stays true for the length of a turn.
 */
function shortStamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  )
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ------------------------------------------------------------------ listing */

/**
 * What is in a folder, newest first.
 *
 * The absolute directory goes on the first line on purpose: everything the
 * model does next — save_asset, open_file_or_link — wants a full path, and it
 * has no other way to build one from a bare file name.
 */
export async function listFiles(dir?: string, limit = 40): Promise<string> {
  const target = resolve((dir ?? '').trim() || defaultAssetsDir())

  let entries: Dirent[]
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch (err) {
    const kind = await pathKind(target)
    if (kind === 'missing') return `There is no folder at ${target} yet.`
    if (kind === 'file') return `${target} is a file, not a folder.`
    return `Could not read ${target}: ${errText(err)}`
  }

  // Subdirectories are skipped rather than listed: this is a "what has been
  // produced" view, and a folder has neither a size nor a useful timestamp for
  // the sorting that follows.
  const files = entries.filter((e) => e.isFile())
  if (!files.length) return `${target} is empty.`

  const rows: Array<{ name: string; size: number; at: number }> = []
  for (const entry of files) {
    try {
      const info = await stat(join(target, entry.name))
      rows.push({ name: entry.name, size: info.size, at: info.mtimeMs })
    } catch {
      // Vanished between the readdir and the stat, or locked by whatever wrote
      // it. Either way it is not something to report as a failure of the whole
      // listing.
    }
  }
  if (!rows.length) return `${target} has files in it, but none of them could be read.`

  rows.sort((a, b) => b.at - a.at)
  const shown = rows.slice(0, Math.max(1, limit))
  const lines = shown.map((r) => `${r.name} — ${humanSize(r.size)} — ${shortStamp(new Date(r.at))}`)
  const more = rows.length - shown.length
  if (more > 0) lines.push(`…and ${more} more, older.`)

  return [`${rows.length} file${rows.length === 1 ? '' : 's'} in ${target}, newest first:`, ...lines].join('\n')
}

/* ------------------------------------------------------------------ saving */

export interface SaveAssetOptions {
  /** Move rather than copy. The source is gone afterwards. */
  move?: boolean
  /** Land on an existing file. Only ever set after Steve has said so. */
  overwrite?: boolean
}

/**
 * Put a file where it was asked to go.
 *
 * `destination` is either a folder — in which case the source keeps its name,
 * which is what "put that on my desktop" means — or the full path of the file
 * to create. Both paths must be absolute because there is no working directory
 * a voice turn could sensibly be relative to.
 */
export async function saveAsset(
  source: string,
  destination: string,
  opts: SaveAssetOptions = {}
): Promise<string> {
  const from = (source ?? '').trim()
  const to = (destination ?? '').trim()
  if (!from || !to) return 'I need both a file to move and somewhere to put it.'
  if (!isAbsolute(from)) return `The source has to be a full path, and ${from} is not one.`
  if (!isAbsolute(to)) return `The destination has to be a full path, and ${to} is not one.`

  const sourceKind = await pathKind(from)
  if (sourceKind === 'missing') return `There is no file at ${from}.`
  if (sourceKind === 'dir') return `${from} is a folder, and this moves one file at a time.`

  // A destination that already exists as a folder means "in here"; anything
  // else is taken as the full name of the file to write.
  const destKind = await pathKind(to)
  const target = destKind === 'dir' ? join(to, basename(from)) : to

  if (!opts.overwrite && (await pathKind(target)) === 'file') {
    return `There is already a file at ${target}, so I left it alone. Say the word and I will overwrite it.`
  }

  try {
    await mkdir(dirname(target), { recursive: true })
    if (opts.move) {
      try {
        await rename(from, target)
      } catch (err) {
        // rename cannot cross volumes, which on Windows is the ordinary case:
        // the output folder is on C: and the project may not be. Copy and
        // remove is the same outcome, one syscall later.
        if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err
        await copyFile(from, target)
        await unlink(from)
      }
      return `Moved to ${target}`
    }
    await copyFile(from, target)
    return `Saved to ${target}`
  } catch (err) {
    return `Could not ${opts.move ? 'move' : 'save'} that: ${errText(err)}`
  }
}

/* ------------------------------------------------------------------ writing */

export interface WriteTextOptions {
  /** Land on an existing file. Only ever set after Steve has said so. */
  overwrite?: boolean
}

/**
 * Write a text file — a note, a brief, an answer worth keeping.
 *
 * UTF-8 and nothing else: Node writes no byte-order mark, which is what keeps
 * the result readable by every tool that will open it afterwards.
 */
export async function writeTextFile(
  path: string,
  content: string,
  opts: WriteTextOptions = {}
): Promise<string> {
  const target = (path ?? '').trim()
  if (!target) return 'I need a full path to write to.'
  if (!isAbsolute(target)) return `The path has to be a full one, and ${target} is not.`

  const body = String(content ?? '')
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > MAX_TEXT_BYTES) {
    return `That is ${humanSize(bytes)} of text, which is past the two megabyte limit on this tool.`
  }

  if (!opts.overwrite && (await pathKind(target)) === 'file') {
    return `There is already a file at ${target}, so I left it alone. Say the word and I will overwrite it.`
  }

  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body, 'utf8')
    return `Wrote ${humanSize(bytes)} to ${target}`
  } catch (err) {
    return `Could not write that file: ${errText(err)}`
  }
}

/* ----------------------------------------------------------------- commands */

/** What one PowerShell run produced, before it is turned into a sentence. */
interface CommandRun {
  code: number
  output: string
  timedOut: boolean
}

/**
 * pwsh where it exists, Windows PowerShell where it does not.
 *
 * Resolved per call rather than cached: pwsh is frequently installed while
 * Forge is running, and a cache would mean the agent kept using the older shell
 * until the app restarted.
 */
function powershellExe(): string {
  return whichCommand('pwsh') ?? 'powershell.exe'
}

function runShell(command: string, cwd: string): Promise<CommandRun> {
  return new Promise((done) => {
    execFile(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { cwd: cwd || undefined, timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // stdout and stderr are joined because a voice answer has nowhere to
        // put two streams: what the model needs is "what did it say", and the
        // interesting half of a failed command is usually the stderr one.
        const output = `${stdout ?? ''}${stderr ?? ''}`
        // `killed` is how the timeout announces itself. The exit code is a
        // number for an ordinary non-zero exit and an errno string when the
        // spawn itself failed; the second case is still a failure, so it lands
        // on 1 rather than on 0.
        const timedOut = Boolean(err?.killed)
        const code = typeof err?.code === 'number' ? err.code : err ? 1 : 0
        done({ code, output, timedOut })
      }
    )
  })
}

/** One terminal colour escape, written as an escape so no raw ESC byte lands in this file. */
const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g

/**
 * Cut a transcript down to something a model can read without drowning.
 *
 * The colour escapes go first. PowerShell 7 writes its errors in red whether or
 * not anyone is looking, and left in they are characters the model has to read
 * past and, on a bad day, tries to pronounce.
 */
function clip(output: string): string {
  const trimmed = output.replace(ANSI, '').trim()
  if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n…truncated`
}

/**
 * Run one PowerShell command and hand back what it printed.
 *
 * There is no allow-list of commands here and there deliberately is not one:
 * any list either blocks something ordinary or is trivially worked around, and
 * a false sense of safety is worse than none. What bounds this instead is the
 * timeout, the truncated transcript, and the rule in the tool description that
 * anything destructive needs Steve to say yes first.
 */
export async function runCommand(command: string, cwd?: string): Promise<string> {
  const line = (command ?? '').trim()
  if (!line) return 'There was no command to run.'

  const where = (cwd ?? '').trim()
  if (where) {
    if (!isAbsolute(where)) return `The working directory has to be a full path, and ${where} is not.`
    const kind = await pathKind(where)
    if (kind !== 'dir') return `There is no folder at ${where} to run that in.`
  }

  let run: CommandRun
  try {
    run = await runShell(line, where)
  } catch (err) {
    return `That command could not be started: ${errText(err)}`
  }

  const output = clip(run.output)
  if (run.timedOut) {
    return output
      ? `It was still running after thirty seconds so I stopped it. What it printed first: ${output}`
      : 'It was still running after thirty seconds so I stopped it, and it had printed nothing.'
  }
  if (run.code !== 0) {
    return `Exited with code ${run.code}: ${output || 'it printed nothing at all.'}`
  }
  return output || 'It ran and printed nothing.'
}
