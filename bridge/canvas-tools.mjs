/**
 * The canvas board, as the forge-bridge sees it.
 *
 * Forge gives every pane `FORGE_CANVAS_DIR` — its project's board folder under
 * the data dir — and the bridge a CLI spawns inherits the pane's environment.
 * So posting to the board is just copying a file into that folder; Forge's own
 * watcher (electron/canvas-board.ts) does the rest. Nothing here talks to Forge.
 *
 * Two things use it: `show_on_canvas`, for an agent that wants to put an
 * existing file on the board by name, and `postToCanvas`, which make_image,
 * edit_image and make_video call on every file they write so generated media
 * appears on the board without anyone asking.
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'

export const CANVAS_DIR_ENV = 'FORGE_CANVAS_DIR'

/** Same list as shared/hub.ts `canvasKindOf`. */
const CANVAS_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp4', '.webm', '.md', '.txt', '.html']
const MAX_BYTES = 512 * 1024 * 1024

export const SHOW_ON_CANVAS_TOOL = {
  name: 'show_on_canvas',
  description:
    'Put a file on the Forge canvas board — the shared board in the Forge app where Steve sees every image, clip ' +
    'and note the agents make. Pass an absolute path to a png/jpg/webp/gif/svg image, an mp4/webm clip, or a ' +
    'md/txt/html note; it is copied onto the board (the original is left where it is) and appears at once. ' +
    'Images from make_image/edit_image/make_video are posted automatically, so there is no need to call this for ' +
    'those. Alternatively, save a file straight into the folder named by the FORGE_CANVAS_DIR environment variable.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path of the file to show.' },
      title: { type: 'string', description: 'Optional short title for the board, e.g. "Landing page hero, dark".' }
    },
    required: ['path']
  }
}

function canvasDir() {
  const dir = (process.env[CANVAS_DIR_ENV] ?? '').trim()
  return dir ? resolve(dir) : ''
}

function slug(title) {
  return String(title)
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60)
}

function freshName(dir, stem, ext) {
  let name = `${stem}${ext}`
  let n = 2
  while (existsSync(join(dir, name))) {
    name = `${stem} -${n}${ext}`
    n += 1
  }
  return name
}

/**
 * Copy one file onto this pane's board. Resolves `{ ok: true, path }`,
 * `{ ok: false, error }`, or `{ ok: false, skipped: true }` when this process
 * has no board (not started from a Forge pane) — which is not an error for the
 * automatic path.
 */
export function postToCanvas(src, title) {
  const dir = canvasDir()
  if (!dir) return { ok: false, skipped: true, error: `${CANVAS_DIR_ENV} is not set — this is not a Forge pane, so there is no board to post to.` }
  const from = resolve(String(src ?? ''))
  const ext = extname(from).toLowerCase()
  if (!CANVAS_EXTENSIONS.includes(ext)) {
    return { ok: false, error: `The board shows ${CANVAS_EXTENSIONS.join(' ')} files — not ${ext || 'that file'}.` }
  }
  let size = 0
  try {
    const st = statSync(from)
    if (!st.isFile()) return { ok: false, error: `${from} is not a file.` }
    size = st.size
  } catch {
    return { ok: false, error: `There is no file at ${from}.` }
  }
  if (size > MAX_BYTES) return { ok: false, error: 'That file is over 512 MB — too big for the board.' }
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    return { ok: false, error: `Cannot create the board folder ${dir}: ${err?.message ?? err}` }
  }
  if (resolve(join(from, '..')) === dir) return { ok: true, path: from }
  const stem = (title && slug(title)) || basename(from, extname(from)) || 'canvas-item'
  const name = freshName(dir, stem, ext)
  const target = join(dir, name)
  // Dot-prefixed tmp: the board ignores dotfiles and unknown extensions, so a
  // half-copied clip never shows up as a broken tile.
  const tmp = join(dir, `.${name}.tmp`)
  try {
    copyFileSync(from, tmp)
    renameSync(tmp, target)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* nothing to clean */
    }
    return { ok: false, error: `Could not copy it onto the board: ${err?.message ?? err}` }
  }
  return { ok: true, path: target }
}

/** The automatic path: post every file, and say in one line what happened. '' when there is no board. */
export function autoPost(paths) {
  const posted = []
  for (const p of paths) {
    const r = postToCanvas(p)
    if (r.skipped) return ''
    if (r.ok) posted.push(r.path)
    else process.stderr.write(`[forge-bridge] could not post ${p} to the canvas: ${r.error}\n`)
  }
  return posted.length ? `Also posted to the Forge canvas board (${posted.length} file${posted.length === 1 ? '' : 's'}).` : ''
}

/** The `show_on_canvas` tool. `ok`/`fail` are the bridge's own result builders. */
export function showOnCanvasHandler(ok, fail) {
  return async function showOnCanvas(args) {
    const path = typeof args?.['path'] === 'string' ? args['path'].trim() : ''
    if (!path) throw new Error('`path` is required — an absolute path to the file to show')
    if (!isAbsolute(path)) throw new Error('`path` must be absolute')
    const title = typeof args?.['title'] === 'string' ? args['title'].trim() : ''
    const r = postToCanvas(path, title)
    if (!r.ok) return fail(`Nothing was put on the canvas: ${r.error}`)
    return ok(`On the Forge canvas board now: ${r.path}${title ? ` ("${title}")` : ''}.`)
  }
}
