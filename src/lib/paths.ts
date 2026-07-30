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
