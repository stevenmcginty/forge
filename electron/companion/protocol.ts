/**
 * The Forge Companion wire protocol — every path, every record shape, every
 * limit, in one dependency-free file.
 *
 * Both ends of the link are written against this module: the main-process
 * service (electron/companion-sync.ts) imports it directly, and the phone PWA
 * (companion/web/js/*.js) is a hand-kept mirror of it. When you change a path
 * or a field here, change companion/README.md's schema table and the PWA in the
 * same commit — the smoke test asserts the two agree about the paths it uses,
 * but it cannot police a field nobody reads yet.
 *
 * Deliberately free of Electron *and* of Node: it is pure data, so the smoke
 * test, the service and (by hand) the browser can all speak it.
 */

/* ------------------------------------------------------------------ limits */

/**
 * Biggest inline image we accept, measured on the base64 payload as stored.
 *
 * RTDB's own ceiling is 10 MB per write, so this is not a technical limit —
 * it is a *bill* limit. Every inbox image is downloaded again by the desktop
 * and streamed to anyone else watching, so a phone that quietly syncs 4 MB
 * holiday snaps costs real money. The phone compresses down a quality ladder
 * to land under this (see companion/web/js/imgpack.js); anything that will not
 * fit is refused on the phone with a plain sentence rather than half-uploaded.
 *
 * The escape hatch for genuinely large images is `storagePath` on the record —
 * a Firebase Storage object reference. Reserved, documented, not built: see
 * "Known gaps" in companion/README.md.
 */
export const MAX_INLINE_BASE64 = 200 * 1024

/**
 * An inbox item older than this is never executed, only marked `stale`.
 *
 * The failure this prevents: the desktop is asleep for two days, wakes up, and
 * replays forty messages at the voice agent at once. `createdAt` is a *server*
 * timestamp precisely so this comparison cannot be fooled by a phone with a
 * wrong clock.
 */
export const STALE_MS = 10 * 60 * 1000

/** Handled inbox items are deleted once they are older than this. */
export const PURGE_AGE_MS = 24 * 60 * 60 * 1000

/** Outbox replies are pruned to the newest this-many per project. */
export const OUTBOX_KEEP = 40

/** RTDB's server-side clock, as a value you can write into a record. */
export const SERVER_TIMESTAMP = { '.sv': 'timestamp' } as const

/* ------------------------------------------------------------------- paths */

/**
 * Every path in the database, built from the uid.
 *
 * There are exactly four, and nothing else in the codebase may build one by
 * string concatenation — that is the rule that makes `database.rules.json`
 * reviewable, because the rules only have to cover what these functions can
 * produce. Everything hangs off `users/<uid>/`, which is the one subtree the
 * rules let a signed-in user touch.
 */
export const paths = {
  /** The account's own row — email and a heartbeat, for the phone's header. */
  presence: (uid: string): string => `users/${uid}/presence`,

  /** `users/<uid>/projects[/<projectId>]` — Forge writes, the phone reads. */
  projects: (uid: string, projectId?: string): string =>
    projectId ? `users/${uid}/projects/${projectId}` : `users/${uid}/projects`,

  /** `users/<uid>/inbox/<projectId>[/<itemId>]` — the phone writes, Forge consumes. */
  inbox: (uid: string, projectId: string, itemId?: string): string =>
    itemId ? `users/${uid}/inbox/${projectId}/${itemId}` : `users/${uid}/inbox/${projectId}`,

  /** The whole inbox across projects — what the service streams. */
  inboxAll: (uid: string): string => `users/${uid}/inbox`,

  /** `users/<uid>/outbox/<projectId>[/<itemId>]` — Forge writes, the phone reads and acks. */
  outbox: (uid: string, projectId: string, itemId?: string): string =>
    itemId ? `users/${uid}/outbox/${projectId}/${itemId}` : `users/${uid}/outbox/${projectId}`,

  outboxAll: (uid: string): string => `users/${uid}/outbox`
} as const

/**
 * RTDB keys may not contain `. $ # [ ] /` or control characters, and Forge's
 * project ids are free-form strings. Sanitise rather than reject: the result
 * is only ever used as a key, never parsed back.
 *
 * Written as a character test rather than a regular expression on purpose.
 * The first version was a tidy-looking class ending in `/ -]`, and a hyphen
 * sitting between two other class members is a *range* — so what it actually
 * matched was a span of control characters, and not the hyphen at all. The
 * desktop published `proj-alpha` while every reader looked for `proj_alpha`,
 * and every message from the phone came back "that project is not open in
 * Forge any more". A list of characters you can read one at a time cannot go
 * wrong that way.
 *
 * Note that `-` and space are both legal in an RTDB key, so they stay.
 */
const FORBIDDEN_KEY_CHARS = '.$#/[]'

export function safeKey(id: string): string {
  let out = ''
  for (const ch of String(id).slice(0, 200)) {
    const code = ch.charCodeAt(0)
    out += FORBIDDEN_KEY_CHARS.includes(ch) || code < 0x20 || code === 0x7f ? '_' : ch
  }
  return out || '_'
}

/* --------------------------------------------------------------------- ids */

/**
 * A time-ordered id, in the spirit of an RTDB push id but generated client-side.
 *
 * We PATCH with a known key rather than POSTing for a server-generated one,
 * because a PATCH is idempotent: the phone's offline outbox can retry the same
 * write forever without ever creating a second copy of the message. The
 * timestamp prefix is what keeps `orderByKey` useful anyway.
 *
 * Base36 of the epoch is 8 characters until the year 2059, so the fixed-width
 * padding below keeps the strings lexicographically sortable for the life of
 * anything that will ever run this code.
 */
export function sortableId(now: number = Date.now(), rand: () => number = Math.random): string {
  const stamp = Math.max(0, Math.floor(now)).toString(36).padStart(9, '0')
  let tail = ''
  for (let i = 0; i < 8; i++) tail += Math.floor(rand() * 36).toString(36)
  return `${stamp}-${tail}`
}

/* ----------------------------------------------------------------- records */

/** What Forge publishes about one project. The phone's list is built from these. */
export interface CompanionProjectRecord {
  name: string
  /** The rail's colour dot, so the phone list matches the desktop at a glance. */
  color: string
  /** One short human line: "3 panes · 2 tabs". Never a path. */
  status: string
  /** Live PTY sessions whose cwd is this project. */
  panes: number
  /** Tabs in the saved workspace layout. */
  tabs: number
  /** Server ms of the newest signal we have for this project. */
  lastActivity: number
  updatedAt: number | typeof SERVER_TIMESTAMP
}

export type InboxKind = 'image' | 'message'

/**
 * `pending` is the only status the phone ever writes. Forge claims an item by
 * moving it straight to a terminal status; there is no `running`, because a
 * crash between "running" and "done" would leave an item nobody dares retry.
 */
export type InboxStatus = 'pending' | 'done' | 'failed' | 'stale'

export interface InboxItemRecord {
  kind: InboxKind
  /** Always `{'.sv':'timestamp'}` on the wire; a number once RTDB resolves it. */
  createdAt: number | typeof SERVER_TIMESTAMP
  origin: 'phone'
  status: InboxStatus

  /* --- kind: 'message' --- */
  text?: string

  /* --- kind: 'image' --- */
  /** Original file name, sanitised by the phone. Used for the file on disk. */
  name?: string
  mime?: string
  /** Full `data:image/jpeg;base64,...` URL, <= MAX_INLINE_BASE64. */
  data?: string
  /**
   * Reserved: a Firebase Storage object path for images too big to inline.
   * Nothing writes or reads it yet — see "Known gaps" in the README.
   */
  storagePath?: string

  /* --- written by Forge when it consumes the item --- */
  result?: string
  doneAt?: number | typeof SERVER_TIMESTAMP
}

export type OutboxKind = 'reply' | 'note'

export interface OutboxItemRecord {
  kind: OutboxKind
  text: string
  createdAt: number | typeof SERVER_TIMESTAMP
  origin: 'forge'
  /** The inbox item this answers, when it answers one. */
  replyTo?: string
  /**
   * Delivery ack: the phone PATCHes a client timestamp here once the reply has
   * actually been painted. Forge never writes it — that is what makes it an ack
   * rather than a second copy of `createdAt`.
   */
  seenAt?: number
}

/* ----------------------------------------------------------------- config */

/**
 * Everything the service needs to reach a Firebase project.
 *
 * `authBase` and `tokenBase` exist so the exact same code runs against the
 * emulator suite: the emulator serves Google's own REST APIs under a path
 * prefix rather than at their real hostnames, and that is the *whole*
 * difference. Leave them blank for production.
 */
export interface CompanionConfig {
  enabled: boolean
  /** Firebase Web API key. Public by design — it identifies, it does not authorise. */
  apiKey: string
  /**
   * RTDB root, e.g. `https://forge-sync-default-rtdb.europe-west1.firebasedatabase.app`.
   * Against the emulator: `http://127.0.0.1:9000?ns=forge-sync-default-rtdb`
   * — the query string is carried onto every request (see rest.ts).
   */
  databaseURL: string
  /** Identity Toolkit v1 base. Blank = `https://identitytoolkit.googleapis.com/v1`. */
  authBase: string
  /** Secure Token base. Blank = `https://securetoken.googleapis.com/v1`. */
  tokenBase: string
  /** Signed-in account. Kept after sign-out so the form can pre-fill. */
  email: string
  /** The only credential on disk. Never the password. */
  refreshToken: string
  uid: string
}

export const EMPTY_CONFIG: CompanionConfig = {
  enabled: false,
  apiKey: '',
  databaseURL: '',
  authBase: '',
  tokenBase: '',
  email: '',
  refreshToken: '',
  uid: ''
}

/** Enough to actually connect: a key, a database, and a session to restore. */
export function isConfigured(c: CompanionConfig): boolean {
  return Boolean(c.apiKey && c.databaseURL && c.refreshToken && c.uid)
}

/* ---------------------------------------------------------------- helpers */

export interface ParsedDataUrl {
  mime: string
  bytes: Uint8Array
}

/**
 * Decode a `data:<mime>;base64,<payload>` URL.
 *
 * Returns null rather than throwing for anything malformed, because the input
 * is remote and a throw here would take down the stream reader. Only images
 * are accepted: this is the one place bytes from the internet become a file on
 * Steve's disk, so the allow-list lives here rather than at the call site.
 */
export function parseImageDataUrl(url: unknown): ParsedDataUrl | null {
  if (typeof url !== 'string') return null
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(url)
  if (!m) return null
  const mime = m[1]!
  const payload = m[2]!.replace(/\s+/g, '')
  if (payload.length === 0 || payload.length > MAX_INLINE_BASE64) return null
  try {
    // Buffer in Node, atob in a browser — this file has to work in both.
    const g = globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array }; atob?(s: string): string }
    if (g.Buffer) return { mime, bytes: g.Buffer.from(payload, 'base64') }
    if (g.atob) {
      const bin = g.atob(payload)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return { mime, bytes: out }
    }
  } catch {
    /* malformed base64 */
  }
  return null
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
}

export function extensionFor(mime: string): string {
  return EXT_BY_MIME[mime] ?? '.png'
}

/**
 * A file name safe on Windows, from whatever the phone sent.
 *
 * Deliberately strict: this name is joined onto a path under the project
 * folder, so `..`, drive letters and separators all have to be gone before it
 * gets anywhere near `join()`. Falls back to a stamp rather than to an empty
 * string, because an empty stem would silently produce a dotfile.
 */
export function safeFileStem(raw: unknown, fallback: string): string {
  const base = String(raw ?? '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[^A-Za-z0-9 ._()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 60)
  return base || fallback
}

/** RTDB hands back `{'.sv':...}` unresolved on echo; coerce to a usable number. */
export function asMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * One short status line for a project, in the desktop's own vocabulary.
 *
 * "Idle" rather than "0 panes": the phone list is glanced at, not read, and a
 * zero is a worse signal than a word.
 */
export function statusLine(panes: number, tabs: number): string {
  if (panes <= 0) return tabs > 0 ? `Idle · ${tabs} ${tabs === 1 ? 'tab' : 'tabs'}` : 'Idle'
  const p = `${panes} ${panes === 1 ? 'pane' : 'panes'}`
  return tabs > 0 ? `${p} · ${tabs} ${tabs === 1 ? 'tab' : 'tabs'}` : p
}
