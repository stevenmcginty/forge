import { BrowserWindow, clipboard, ipcMain, nativeImage, shell, type NativeImage } from 'electron'
import { IPC } from '@shared/ipc'
import type { Settings, Shot } from '@shared/types'
import { contentHash, ShotShelf, type ShotRecord } from './shots/shelf'
import { getSettings, getShotsDir } from './store'

/**
 * The screenshot tray's engine: poll the clipboard, keep every new image as a
 * real PNG on the shelf, and tell the windows about it.
 *
 * Why poll? Win+Shift+S and Ctrl+C-on-an-image both end at the same place — the
 * clipboard — and Windows offers no cross-process "clipboard changed" event to
 * a sandboxed app. DictationMic polls GetClipboardSequenceNumber; Electron has
 * no equivalent, so we poll the content itself. Measured on a 2560x1440 image:
 * readImage 15ms, getBitmap 5ms, sha1 8ms — cheap enough at 700ms, and
 * `availableFormats()` costs nothing when the clipboard holds plain text, which
 * is nearly always. Only a genuine catch pays for toPNG (~40ms).
 */

const POLL_MS = 700
/** Thumbnails are sized to serve both the tray tile and its hover preview. */
const THUMB_BOX = { width: 300, height: 190 }

let shelf: ShotShelf | null = null
let timer: NodeJS.Timeout | null = null
let enabled = true
/** path -> PNG data URL. Decoding 12 shots on every broadcast would be silly. */
const thumbCache = new Map<string, Shot>()

/* --------------------------------------------------------------- helpers */

/**
 * electron.d.ts declares `getBitmap(): void`; it has always returned a Buffer of
 * BGRA pixels. The cast is the bug, not the call.
 */
function bitmapOf(img: NativeImage): Uint8Array {
  const raw = img.getBitmap() as unknown as Uint8Array | undefined
  return raw ?? new Uint8Array(0)
}

function hashOfImage(img: NativeImage): string {
  const { width, height } = img.getSize()
  if (width === 0 || height === 0) return ''
  const bitmap = bitmapOf(img)
  if (bitmap.length === 0) return ''
  return contentHash(`${width}x${height}`, bitmap)
}

/** Content hash of a file on disk, in the same space as a clipboard image. */
function hashOfFile(path: string): string {
  try {
    return hashOfImage(nativeImage.createFromPath(path))
  } catch {
    return ''
  }
}

/** Decorate a shelf record with the pixels the renderer needs to draw it. */
function toShot(record: ShotRecord): Shot {
  const cached = thumbCache.get(record.path)
  if (cached && cached.bytes === record.bytes) return cached

  let width = 0
  let height = 0
  let thumb = ''
  try {
    const img = nativeImage.createFromPath(record.path)
    const size = img.getSize()
    width = size.width
    height = size.height
    if (!img.isEmpty()) {
      const scale = Math.min(1, THUMB_BOX.width / size.width, THUMB_BOX.height / size.height)
      const scaled =
        scale < 1
          ? img.resize({
              width: Math.max(1, Math.round(size.width * scale)),
              height: Math.max(1, Math.round(size.height * scale)),
              quality: 'good'
            })
          : img
      thumb = scaled.toDataURL()
    }
  } catch (err) {
    console.error('[shots] could not thumbnail', record.path, err)
  }

  const shot: Shot = { ...record, width, height, thumb }
  thumbCache.set(record.path, shot)
  return shot
}

function shots(): Shot[] {
  if (!shelf) return []
  const list = shelf.list()
  const live = new Set(list.map((r) => r.path))
  for (const path of thumbCache.keys()) {
    if (!live.has(path)) thumbCache.delete(path)
  }
  return list.map(toShot)
}

function broadcast(): Shot[] {
  const payload = shots()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.shotsUpdated, payload)
  }
  return payload
}

/* ------------------------------------------------------------------ poll */

/**
 * The clipboard is a shared, lockable OS resource: any app can hold it, and a
 * read that collides with somebody else's write throws. On a timer in the main
 * process an uncaught throw takes the whole app down, so every poll is fenced.
 * Failures are logged once a minute at most — if the clipboard is being held,
 * it will be held for many polls in a row.
 */
let lastPollError = 0

function poll(): void {
  try {
    pollOnce()
  } catch (err) {
    const now = Date.now()
    if (now - lastPollError > 60000) {
      lastPollError = now
      console.error('[shots] clipboard poll failed (will keep trying):', err)
    }
  }
}

function pollOnce(): void {
  // No window, no tray to fill — and no reason to touch the clipboard at all.
  if (!shelf || !enabled || BrowserWindow.getAllWindows().length === 0) return

  const formats = clipboard.availableFormats()
  if (!formats.some((f) => f.startsWith('image/'))) return

  const img = clipboard.readImage()
  if (img.isEmpty()) return

  const hash = hashOfImage(img)
  if (!hash) return
  if (!shelf.shouldCatch(hash)) {
    // Still note it, so the poll after this one is a single comparison.
    shelf.noteClipboard(hash)
    return
  }

  const png = img.toPNG()
  const result = shelf.pinBytes(png, hash)
  if (!result.ok) {
    if (result.reason !== 'duplicate') console.error('[shots] catch failed:', result.reason)
    return
  }
  console.log(`[shots] caught ${result.record.name} (${img.getSize().width}x${img.getSize().height})`)
  broadcast()
}

/**
 * Whatever is on the clipboard right now is "already seen". Called at startup
 * (so relaunching Forge never re-catches the image you were carrying) and after
 * Forge itself writes an image (so a shot cannot boomerang back onto the shelf).
 */
function absorbClipboard(asOurs: boolean): void {
  if (!shelf) return
  try {
    if (!clipboard.availableFormats().some((f) => f.startsWith('image/'))) return
    const img = clipboard.readImage()
    if (img.isEmpty()) return
    const hash = hashOfImage(img)
    if (!hash) return
    if (asOurs) shelf.suppress(hash)
    else shelf.noteClipboard(hash)
  } catch (err) {
    console.error('[shots] could not read the clipboard', err)
  }
}

/* -------------------------------------------------------------- lifecycle */

export function registerShotsHandlers(): void {
  const settings = getSettings()
  shelf = new ShotShelf(getShotsDir(), settings.shotsKeep)
  enabled = settings.catchShots
  shelf.load(hashOfFile)
  absorbClipboard(false)

  timer = setInterval(poll, POLL_MS)

  ipcMain.handle(IPC.shotsList, () => shots())

  ipcMain.handle(IPC.shotsRemove, (_e, path: string) => {
    shelf?.remove(String(path))
    return broadcast()
  })

  ipcMain.handle(IPC.shotsClear, () => {
    shelf?.clear()
    return broadcast()
  })

  ipcMain.handle(IPC.shotsCopy, (_e, path: string) => {
    const target = String(path)
    if (!shelf?.owns(target)) return false
    try {
      const img = nativeImage.createFromPath(target)
      if (img.isEmpty()) return false
      // Both formats at once: an editor or chat takes the image, a terminal or
      // text field takes the quoted path. Electron cannot offer CF_HDROP, so
      // "paste as a file" is served by dragging the thumbnail out instead.
      clipboard.write({ image: img, text: `"${target}"` })
      absorbClipboard(true)
      return true
    } catch (err) {
      // Somebody else is holding the clipboard. Say so rather than throwing.
      console.error('[shots] could not copy to the clipboard:', err)
      return false
    }
  })

  ipcMain.handle(IPC.shotsAdopt, (_e, paths: string[]) => adoptShotFiles(paths))

  ipcMain.on(IPC.shotsDrag, (event, path: string) => {
    const target = String(path)
    if (!shelf?.owns(target)) return
    // Windows refuses a drag without a drag image, and startDrag throws on an
    // empty one, so fall back to the full-size shot before giving up.
    const full = nativeImage.createFromPath(target)
    if (full.isEmpty()) return
    const icon = full.resize({ height: 96, quality: 'good' })
    try {
      event.sender.startDrag({ file: target, icon: icon.isEmpty() ? full : icon })
    } catch (err) {
      console.error('[shots] startDrag failed', err)
    }
  })

  ipcMain.handle(IPC.shotsOpenFolder, () => shell.openPath(getShotsDir()))
}

/**
 * Copy image files onto the shelf and tell the windows. Exported as well as
 * exposed over IPC because generated images (electron/gemini-media.ts) land in
 * the project folder and then want to appear in the tray immediately — same
 * path as a drag-and-drop, no second implementation.
 *
 * Returns how many were adopted. Files already on the shelf are skipped.
 */
export function adoptShotFiles(paths: readonly string[]): number {
  if (!shelf || !Array.isArray(paths)) return 0
  let adopted = 0
  for (const p of paths) {
    if (typeof p !== 'string') continue
    if (shelf.owns(p)) continue // already ours — dragging within the tray
    if (shelf.pinFile(p, hashOfFile).ok) adopted += 1
  }
  if (adopted > 0) broadcast()
  return adopted
}

/** Re-read the two settings the watcher cares about. */
export function applyShotSettings(settings: Settings): void {
  const was = enabled
  enabled = settings.catchShots
  if (!shelf) return
  const pruned = shelf.setKeep(settings.shotsKeep)
  if (pruned.length > 0) broadcast()
  // Turning the catcher back on should not sweep up whatever has been sitting
  // on the clipboard since you turned it off. (Only on the transition — this
  // runs on every settings write, and absorbing mid-snip would lose a shot.)
  if (!was && enabled) absorbClipboard(false)
}

export function disposeShotsWatcher(): void {
  if (timer) clearInterval(timer)
  timer = null
  thumbCache.clear()
  shelf = null
}
