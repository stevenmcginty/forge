import type { WebContents } from 'electron'

/**
 * Dev only: the renderer's warnings, errors and `[hub]` state lines, copied to
 * main's stdout with a `[renderer]` prefix. In dev, main's stdout is what lands
 * in %APPDATA%\<profile>\dev.log, so a problem in Steve's live window leaves
 * evidence there instead of only in a DevTools console nobody had open.
 *
 * Nothing secret may reach the log: key- and token-shaped text is masked, and a
 * line that repeats inside a couple of seconds is dropped, as is anything past
 * a small per-second budget.
 */

const REPEAT_MS = 2000
const PER_SECOND = 20
const MAX_LEN = 400

const LEVELS: Record<string, string> = { '2': 'warn', '3': 'error', warning: 'warn', error: 'error' }

export function redactLogLine(text: string): string {
  return text
    .replace(/\b(access_token|api[_-]?key|key|token|x-goog-api-key|authorization)(["']?\s*[=:]\s*["']?)(?:Bearer\s+)?[^\s&"',;)]+/gi, '$1$2…')
    .replace(/\bAIza[0-9A-Za-z_-]{8,}/g, 'AIza…')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-…')
    .replace(/\bgsk_[A-Za-z0-9]{8,}/g, 'gsk_…')
    .replace(/\benc:v1:[A-Za-z0-9+/=]+/g, 'enc:…')
    .replace(/\bauth_tokens\/[A-Za-z0-9._-]+/g, 'auth_tokens/…')
}

/** Which console lines are worth keeping: warn/error, and the hub's own state trace. */
function keep(level: string, message: string): string | null {
  const word = LEVELS[level]
  if (word) return word
  if (message.startsWith('[hub]')) return 'info'
  return null
}

export function forwardRendererConsole(wc: WebContents, write: (line: string) => void = (l) => console.log(l)): void {
  const recent = new Map<string, number>()
  let windowStart = 0
  let inWindow = 0
  wc.on('console-message', (...args: unknown[]) => {
    // Electron 43 passes one event object; older builds passed (event, level, message).
    const e = args[0] as { level?: unknown; message?: unknown } | undefined
    const level = String(e?.level ?? args[1] ?? '')
    const message = String(e?.message ?? args[2] ?? '')
    const word = keep(level, message)
    if (!word) return
    const now = Date.now()
    const body = redactLogLine(message.replace(/\s+/g, ' ').trim()).slice(0, MAX_LEN)
    const last = recent.get(body)
    if (last !== undefined && now - last < REPEAT_MS) return
    recent.set(body, now)
    if (recent.size > 200) recent.clear()
    if (now - windowStart >= 1000) {
      windowStart = now
      inWindow = 0
    }
    if (++inWindow > PER_SECOND) return
    const at = new Date(now).toTimeString().slice(0, 8)
    write(`[renderer] ${at} ${word} ${body}`)
  })
}
