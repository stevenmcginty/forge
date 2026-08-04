import type React from 'react'

/** `C:\Users\steve\Desktop\forge` → `…\Desktop\forge` — enough to tell two folders apart. */
export function shortPath(fullPath: string, segments = 2): string {
  const parts = fullPath.split(/[\\/]/).filter(Boolean)
  if (parts.length <= segments) return fullPath
  return `…\\${parts.slice(-segments).join('\\')}`
}

/** Last path segment, used to name a project after its folder. */
export function basename(fullPath: string): string {
  const parts = fullPath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? fullPath
}

/**
 * Whether a drag is worth taking as a possible file drop. Deliberately
 * generous: a drag whose payload we cannot see yet counts as maybe-files.
 *
 * Being strict here is what made dropping an image a coin toss. The `drop`
 * event only fires at all if something called `preventDefault` on `dragover`
 * first — so any drag we decline mid-flight is a drop that never happens,
 * silently. An OS drag out of Explorer, and Electron's own `startDrag` from
 * the screenshot tray, do not always advertise `Files` in `types` on every
 * dragover. So we accept anything that is not plainly *not* a file, and sort
 * it out at drop time, where the real payload is finally readable.
 */
export function maybeFiles(e: React.DragEvent): boolean {
  const types = Array.from(e.dataTransfer.types)
  if (types.includes('Files')) return true
  // Forge's own drags (a tab headed for the mosaic wall) are application/*
  // and are not files.
  if (types.some((t) => t.startsWith('application/'))) return false
  return !types.includes('text/plain') && !types.includes('text/uri-list')
}

/**
 * The absolute paths behind a drop. Only the preload can resolve a File to a
 * path (webUtils), and anything the OS did not back with a real file has none —
 * asking anyway throws, and a throw inside a drop handler would take the
 * component down with it.
 */
export function droppedFilePaths(e: React.DragEvent): string[] {
  const out: string[] = []
  for (const file of Array.from(e.dataTransfer.files)) {
    try {
      const path = window.forge.pathForFile(file)
      if (path) out.push(path)
    } catch {
      /* not a real file — skip it */
    }
  }
  return out
}
