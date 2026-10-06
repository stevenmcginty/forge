/**
 * Source fixes before the shared renderer (web/src/lib/markdown.tsx) sees it.
 *
 * That renderer is the phone chat's too, and is not ours to change. It only
 * makes links out of `[text](https://…)`, so the links a document uses to point
 * at its neighbours — `[plan](docs/plan.md)`, `[top](#handoff)` — would come
 * out as bracket soup. Here they are rewritten to an address on a reserved
 * host (`.invalid` can never resolve) that the renderer happily turns into an
 * `<a>`; the page's click handler recognises the host and does the real work.
 * Task-list boxes become ballot-box glyphs, so `- [x] done` reads as a tick.
 *
 * Fenced code and inline code spans are left exactly as written.
 */

export const READER_LINK_HOST = 'forge-reader.invalid'

const FENCE = /^ {0,3}(`{3,}|~{3,})/
// A code span (left alone) | an image | a link whose target has no spaces or brackets.
const INLINE = /(`+)[^`]*?\1|(!?)\[([^\]\n]+)\]\(([^()\s]+)\)/g
const TASK = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[( |x|X)\]\s+/

function readerHref(params: Record<string, string>): string {
  return `https://${READER_LINK_HOST}/?${new URLSearchParams(params).toString()}`
}

function rewriteLine(line: string): string {
  const task = TASK.exec(line)
  if (task) line = `${task[1]}${task[2] === ' ' ? '☐' : '☑'} ${line.slice(task[0].length)}`
  return line.replace(INLINE, (whole, ticks: string | undefined, bang: string, text: string, target: string) => {
    if (ticks) return whole
    if (bang) return /^https?:\/\//i.test(target) ? `[Image: ${text}](${target})` : `*Image: ${text}*`
    if (/^https?:\/\//i.test(target)) return whole
    if (target.startsWith('#')) return `[${text}](${readerHref({ hash: target.slice(1) })})`
    // mailto:, file:, vscode: and friends: leave the source as written.
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) return whole
    return `[${text}](${readerHref({ to: target })})`
  })
}

export function prepareMarkdown(source: string): string {
  const lines = source.split('\n')
  let fence: string | null = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const f = FENCE.exec(line)
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null
      continue
    }
    if (f) {
      fence = f[1]!
      continue
    }
    if (line.includes('[') || line.includes('`')) lines[i] = rewriteLine(line)
  }
  return lines.join('\n')
}

/** Heading text → the slug GitHub would give it, for `#fragment` links. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

/** Words in the source, code included — for the header's reading-time note. */
export function wordCount(source: string): number {
  const m = source.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)
  return m ? m.length : 0
}
