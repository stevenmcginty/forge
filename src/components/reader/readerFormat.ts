import { useEffect, useState } from 'react'

/** The last part of a path. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** Everything before the last separator. */
export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return i > 0 ? path.slice(0, i) : path
}

/**
 * Where a file lives, said the short way: under the project, `project/docs`;
 * anywhere else, the whole folder.
 */
export function folderLabel(path: string, projectRoot: string | null, projectName: string | null): string {
  const dir = dirName(path)
  if (projectRoot) {
    const root = projectRoot.replace(/[\\/]+$/, '')
    const d = dir.toLowerCase().replace(/\//g, '\\')
    const r = root.toLowerCase().replace(/\//g, '\\')
    if (d === r) return projectName ?? baseName(root)
    if (d.startsWith(`${r}\\`)) return `${projectName ?? baseName(root)}/${dir.slice(root.length + 1).replace(/\\/g, '/')}`
  }
  // Elsewhere on the machine: the drive and the last three folders, which is what tells two places apart.
  const parts = dir.split(/[\\/]/)
  return parts.length > 5 ? `${parts[0]}\\…\\${parts.slice(-3).join('\\')}` : dir
}

/** "just now", "4 min ago", "3 h ago", "yesterday", "12 Sep". */
export function timeAgo(ms: number, now: number): string {
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d > 300 ? 'numeric' : undefined })
}

/** The list's tight age column: "now", "4m", "3h", "5d", "12 Sep". */
export function shortAge(ms: number, now: number): string {
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** A clock that ticks every `everyMs`, so relative times stay true while the page is open. */
export function useNow(everyMs = 30000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(t)
  }, [everyMs])
  return now
}
