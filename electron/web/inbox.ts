import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

/**
 * Where a browser-pasted image becomes a real file, so a pane can be handed
 * its path — the same gesture as dropping a screenshot on an agent at the desk.
 *
 * Electron-free on purpose, like electron/web/fs-browse.ts: the smoke test
 * drives this against a temp directory with no Electron in the process, and
 * electron/web-host.ts is only the callback that names the folder.
 *
 * Kept out of the screenshot tray. That tray is a clipboard catcher with a
 * keep-limit and a content-hash, and a paste from a phone is neither a
 * clipboard event on this machine nor something the tray should prune on its
 * own clock. A small newest-first inbox is enough: the agent reads the file
 * the moment the path is typed, and old pastes are not a gallery.
 */

/** Newest this-many files stay. A working day of pastes, not a photo library. */
export const INBOX_KEEP = 20

const OK_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

export type InboxSave = { ok: true; path: string } | { ok: false; error: string }

/**
 * Write `bytes` into `dir` under a stamped name and prune back to INBOX_KEEP.
 *
 * `ext` is a suffix this module will actually write (`.png`, `.jpg`, …);
 * anything else is refused rather than becoming a surprise executable. The
 * caller already filtered the mime; this is the last check before a syscall.
 */
export function saveInboxImage(dir: string, bytes: Uint8Array, ext: string, now = new Date()): InboxSave {
  if (!dir) return { ok: false, error: 'That image could not be saved on the desktop.' }
  if (!bytes.length) return { ok: false, error: 'That image was empty.' }
  const suffix = sanitiseExt(ext)
  if (!suffix) return { ok: false, error: 'That is not an image this desktop will take.' }

  try {
    mkdirSync(dir, { recursive: true })
    const target = freshPath(dir, stamp(now), suffix)
    writeFileSync(target, bytes)
    prune(dir)
    return { ok: true, path: target }
  } catch {
    return { ok: false, error: 'Could not save that image on the desktop.' }
  }
}

/** The suffix a `WEB_IMAGE_MIMES` type corresponds to, or '' if it is not one. */
export function extForMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    default:
      return ''
  }
}

function sanitiseExt(ext: string): string {
  const suffix = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
  return OK_EXTS.has(suffix) ? suffix : ''
}

function stamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

function freshPath(dir: string, stamped: string, ext: string): string {
  const first = join(dir, `paste-${stamped}${ext}`)
  if (!existsSync(first)) return first
  for (let i = 2; i < 50; i++) {
    const next = join(dir, `paste-${stamped}-${i}${ext}`)
    if (!existsSync(next)) return next
  }
  return join(dir, `paste-${stamped}-${Date.now()}${ext}`)
}

function prune(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const files = names
    .filter((name) => name.startsWith('paste-') && OK_EXTS.has(extname(name).toLowerCase()))
    .map((name) => join(dir, name))
    .sort()
  const extra = files.length - INBOX_KEEP
  if (extra <= 0) return
  for (const path of files.slice(0, extra)) {
    try {
      unlinkSync(path)
    } catch {
      /* a file we cannot delete is left; the next paste tries again */
    }
  }
}
