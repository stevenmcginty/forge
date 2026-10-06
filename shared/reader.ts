/**
 * The Markdown reader — the types both sides of the bridge agree on.
 *
 * Steve gets a steady stream of .md files from agents and reads them in Forge
 * rather than in Notepad. Everything that touches the disk lives in
 * electron/reader.ts; this file is the contract, free of any Electron or Node
 * import so the renderer can share it.
 *
 * Paths cross this boundary on purpose (a reader is for files anywhere on the
 * machine), so every channel that takes one is re-checked in main: an absolute
 * path to an existing file with a markdown extension, and nothing else.
 */

/** Lower-case, with the dot. Anything else is refused by read, write and watch. */
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown'] as const

/** The largest file `read` will hand over, and the largest text `write` will take. */
export const READER_MAX_BYTES = 5 * 1024 * 1024

/** `list` stops descending past this many folders below the root. */
export const READER_LIST_MAX_DEPTH = 8

/** `list` stops collecting at this many files. */
export const READER_LIST_MAX_ENTRIES = 2000

/** How many files `recent` remembers. */
export const READER_RECENT_MAX = 20

/**
 * Folders `list` never walks into. Every dot-directory (`.git`, `.forge`,
 * `.venv`, ...) is skipped as well, by rule rather than by name.
 */
export const READER_SKIP_DIRS = ['node_modules', '.git', 'out', 'dist', 'release', 'build', 'coverage'] as const

/** One markdown file found by `list` (or remembered by `recent`). */
export interface ReaderEntry {
  /** Absolute path. */
  path: string
  /** Relative to the listed root, with the platform's separators. For `recent`, the file name. */
  rel: string
  mtimeMs: number
  size: number
}

/** One file's contents, as `read` saw them. */
export interface ReaderDoc {
  path: string
  /** UTF-8, BOM dropped, line endings normalised to LF. */
  text: string
  mtimeMs: number
  /** Of the bytes on disk. `write` takes it back as `baseHash`. */
  hash: string
}

/** Who asked for a file to be shown. */
export type ReaderOpenSource = 'windows' | 'terminal' | 'agent' | 'app'

/** Main → renderer: show this file. */
export interface ReaderOpenRequest {
  path: string
  source: ReaderOpenSource
  /** The agent or pane that asked, when `source` is 'agent'. */
  agent?: string
}

/**
 * The answer to `write`.
 *
 * `conflict` means the file changed on disk since the renderer read it (its
 * hash is no longer `baseHash`): nothing was written, and `doc` is what is
 * there now.
 */
export type ReaderWriteResult =
  | { ok: true; mtimeMs: number; hash: string }
  | { ok: false; conflict: true; doc: ReaderDoc }
  | { ok: false; error: string }

/** The answer to `open` and `revealFolder`. */
export type ReaderActionResult = { ok: true } | { ok: false; error: string }

/** True for a path whose extension is one of MARKDOWN_EXTENSIONS. Case-insensitive. */
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase()
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext) && lower.length > ext.length)
}
