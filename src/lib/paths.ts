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
