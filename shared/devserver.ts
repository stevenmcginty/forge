/**
 * Where a project's web app is being served, read out of the project's own
 * terminal.
 *
 * Nothing tells Forge this. There is no IPC for it, no config file every
 * framework agrees on, and no port anyone can assume — but every dev server on
 * earth prints its URL on the first line it says, and Forge *is* the terminal.
 * So the Devices preview learns where to point exactly the way a person does:
 * by reading the line Vite (or Next, or Rails, or `python -m http.server`) just
 * printed. See `scanForDevUrl` in src/lib/terminals.ts for the tap.
 *
 * Deliberately dependency-free (no Electron, no Node, no DOM): the renderer
 * scans PTY chunks with it and scripts/preview-check.mjs tests it head-less —
 * the same arrangement shared/remote.ts has for the Remote Control URL.
 */

/**
 * ANSI escape sequences, removed before the scan rather than merely survived.
 *
 * A conservative URL charclass is enough to stop escapes being *swallowed*, but
 * not enough to find the URL in the first place: Vite colours its banner and
 * bolds the port inside the URL, so what actually arrives down the PTY is
 * `http://localhost:\x1b[1m5173\x1b[22m/`. Scanning that raw finds a hostname
 * with no port. Stripping first puts the URL back together; the charclass below
 * then keeps whatever escapes this misses from being eaten as path characters.
 *
 * CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC ] … ST`, which is how a
 * shell sets the window title), and the two-character escapes. An OSC with no
 * terminator in this chunk is left alone rather than allowed to eat the rest of
 * it — the terminator arrives in the next chunk, and the caller's overlap is
 * what stitches the two together.
 */
const ANSI = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g

/**
 * A loopback URL, split so the host can be rewritten without disturbing the
 * rest of it.
 *
 * The tail's charclass is the conservative half: no whitespace, no quotes, no
 * angle brackets, no control characters — and no `;` or `,`, which are legal in
 * a URL but on a terminal line are how the next command starts. PSReadLine
 * redraws an edited line with cursor moves instead of spaces, so a pasted
 * `curl http://localhost:5199/ ; curl -sI …` can arrive down the PTY with the
 * separator glued straight onto the URL — the semicolon has to end the match,
 * or the "URL" is half a shell script. `\d{1,5}` for the port because six
 * digits is not a port, it is a URL that ran into the next thing on the line.
 */
const DEV_SERVER_URL = /(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])((?::\d{1,5})?(?:\/[^\s'"`<>|\\^{};,\x00-\x1F\x7F]*)?)/g

/**
 * Hosts that mean "this machine" but cannot simply be handed to an iframe.
 *
 * `0.0.0.0` is a bind address, not an address you can dial — a server that says
 * it is listening on `http://0.0.0.0:3000` is reachable at `localhost:3000`, and
 * Chromium will not fetch the former. `[::1]` *is* dialable, but it is a
 * different origin from `localhost` for cookies, storage and any host check the
 * dev server does, which is a class of confusion nobody asked the preview for.
 * Both become the name every dev server already answers to.
 */
const HOST_ALIASES: Record<string, string> = {
  '0.0.0.0': 'localhost',
  '[::1]': 'localhost'
}

/** Punctuation a URL collects from the sentence it was printed in. */
const TRAILING = /[.,;:)\]'"]+$/

/**
 * Whether a URL's path half is a *page* rather than a file the page asked for.
 *
 * A dev server prints more loopback URLs than its banner: Vite logs optimised
 * deps (`/node_modules/.vite/deps/react.js`), its own client (`/@vite/client`,
 * `/@fs/...`), HMR pings (`/__vite_ping`), and a stack trace can quote any
 * asset on the site. Last-match-wins would happily point both phones at a
 * JavaScript file, which renders as two blank white screens — the bug this
 * function exists to have fixed. A banner URL is the root or a short mount
 * path; internals name files. So: no `node_modules`, no segment that starts
 * with `@` or `__`, and no dot in the final segment (a file extension), judged
 * with any query string or fragment already set aside.
 */
function pageLike(tail: string): boolean {
  const path = tail.replace(/^:\d+/, '').replace(/[?#].*$/, '')
  if (path.includes('/node_modules')) return false
  const segments = path.split('/').filter(Boolean)
  if (segments.some((s) => s.startsWith('@') || s.startsWith('__'))) return false
  // A colon inside a path segment is never a page either — it is another URL
  // (or half a command) glued onto this one by a terminal redraw.
  if (segments.some((s) => s.includes(':'))) return false
  const last = segments[segments.length - 1]
  return !last || !last.includes('.')
}

/** The `:port` off the front of a matched tail, or ''. */
function portOf(tail: string): string {
  return /^:\d+/.exec(tail)?.[0] ?? ''
}

/**
 * The local dev-server URL in a chunk of terminal output, or null.
 *
 * The **last** one wins, not the first, and that is the whole policy: Vite
 * prints `Local:` and then `Network:`, a restarted server prints a new port
 * over the old one, and a project that opens a second server means the second
 * one. Later output is simply more current than earlier output.
 */
export function findDevServerUrl(text: string): string | null {
  const clean = text.replace(ANSI, '')
  let found: string | null = null
  for (const m of clean.matchAll(DEV_SERVER_URL)) {
    // Trimmed off the tail only, so the `]` closing an IPv6 host is safe.
    const tail = m[3]!.replace(TRAILING, '')
    const host = HOST_ALIASES[m[2]!] ?? m[2]!
    // An internals URL is not a page anyone wants framed, but it is proof a
    // server lives at that origin — a project whose banner scrolled past hours
    // before Forge was watching still announces itself through every deps line
    // and HMR ping it prints. The page keeps its path; internals keep only
    // their door.
    found = pageLike(tail) ? `${m[1]!}${host}${tail}` : `${m[1]!}${host}${portOf(tail)}/`
  }
  return found
}
