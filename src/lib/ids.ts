/** Short, collision-safe, human-greppable ids. */
export function makeId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint32Array(2))
  const a = rand[0]!.toString(36)
  const b = rand[1]!.toString(36).slice(0, 4)
  return `${prefix}_${a}${b}`
}
