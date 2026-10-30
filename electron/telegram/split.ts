/**
 * Cut a long reply into Telegram-sized messages (a message holds 4096
 * characters; 4000 leaves room). Cuts at a blank line when it can, then at a
 * line break, then at a space, and hard at `max` only when a run has none.
 * Every chunk is trimmed and none is empty, so blank input gives no messages.
 *
 * Pure, no imports: scripts/telegram-check.mjs tests it directly.
 */
export function splitForTelegram(text: string, max = 4000): string[] {
  const limit = Math.max(1, Math.floor(max))
  const chunks: string[] = []
  let rest = String(text ?? '').trim()
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1)
    let cut = window.lastIndexOf('\n\n')
    if (cut <= 0) cut = window.lastIndexOf('\n')
    if (cut <= 0) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = limit
    const chunk = rest.slice(0, cut).trim()
    if (chunk) chunks.push(chunk)
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}
