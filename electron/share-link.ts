import { createServer, type Server, type Socket } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { stripAnsi, tailLines } from '@shared/ansi'
import {
  SHARE_BUSY_GAP_MS,
  SHARE_BUSY_ONSET_MS,
  SHARE_BUSY_QUIET_MS,
  SHARE_BUSY_WINDOW_MS,
  SHARE_CAPTURE_MAX_LINES,
  SHARE_LINK_MAX_REQUEST_BYTES,
  SHARE_READ_DEFAULT_LINES,
  SHARE_SEND_MAX_BYTES,
  shareBytes
} from '@shared/share'
import type { ShareLinkPaneView, ShareLinkRequest, ShareLinkResponse } from '@shared/share'

/**
 * One agent types into another agent's terminal.
 *
 * The shared scratchpad (electron/share-store.ts) is a noticeboard: you leave a
 * slot and hope somebody looks at it. This is the tap on the shoulder — Rex
 * tells Zora to use the Cloudflare route, right now, and Zora's Codex sees it
 * arrive as if the person at the desk had typed it.
 *
 * **Keystrokes, not an API.** Every agent CLI Forge runs — Claude Code, Codex,
 * OpenCode, Gemini, Qwen — has a different (or no) programmatic inbox, and three
 * of them change theirs between releases. All five have a terminal. So the
 * message is written into the receiving pane's PTY exactly the way a person's
 * typing is, which is the one route that cannot be broken by a vendor shipping
 * on a Tuesday.
 *
 * ## The two rules that keep it from being a menace
 *
 *  1. **It refuses while the receiver is busy.** Typing into an agent that is
 *     mid-turn is typing over somebody's shoulder: the TUI is repainting, the
 *     line editor may not have focus, and at best the message lands in the
 *     middle of a tool call. So a send is *refused* with `busy` rather than
 *     queued (see `handle`), and the caller decides whether to wait — a queue
 *     here would fire minutes later into a pane that had moved on.
 *  2. **It is scoped to the caller's project.** A pane in another project window
 *     is not addressable at all, and a caller whose own name main does not
 *     recognise is refused outright. `FORGE_SHARE_AGENT` is set by the PTY host
 *     on the pane's own environment, so a caller cannot mint a name for itself.
 *
 * ## Why a pipe
 *
 * The MCP server is a stdio child of the *agent CLI*, not of Forge — Claude Code
 * spawns it, Codex spawns its own copy — so there is no inherited handle to
 * speak over and no parent to ask. A named pipe (a unix socket off win32) is the
 * one channel that is addressable by a path in an environment variable, reachable
 * only from this machine, and needs no port, no listener on an interface and no
 * credential. There is deliberately no TCP anywhere in this file: the property
 * "nothing about the shared scratchpad is reachable from the network" is worth
 * more than the convenience.
 *
 * Deliberately free of any `electron` import — the manager and the replay buffer
 * are injected rather than imported, which is what lets scripts/share-link-check.mjs
 * drive the real class against a fake pane instead of a copy of it. The same
 * arrangement electron/share-store.ts has, for the same reason.
 */

/** A pane the link can address, as the PTY host describes it at create time. */
export interface ShareLinkPane {
  /** The session id — what `write` and `replay` are keyed by. */
  id: string
  /** The name a person would say: the pane's title. */
  title: string
  /** Which CLI is running in it — 'codex', 'claude', 'opencode'. May be empty. */
  agent: string
  /** The pane's working directory. Breaks ties between same-named panes. */
  cwd: string
  /** Forge's name for the project. The scope: a send never leaves it. */
  projectName: string
}

/**
 * A registered pane, plus the one thing a rename must not touch.
 *
 * `FORGE_SHARE_AGENT` is baked into a pane's own process at spawn and cannot
 * change for the life of that process — so a pane renamed after launch keeps
 * asking to be found by the name it started with. `launchTitle` is that name,
 * captured once and kept beside `title` so `caller()` can still recognise a
 * pane as itself after `title` (what `resolve()` and everyone else sees) has
 * moved on.
 */
interface StoredPane extends ShareLinkPane {
  launchTitle: string
}

/** What the link needs from the PTY host, and nothing more. */
export interface ShareLinkDeps {
  /**
   * Put bytes on a pane's PTY. The PTY host routes this through the same
   * `owners.noteWrite` + `manager.write` pair `IPC.ptyWrite` uses, so a send
   * moves the pane's grid ownership exactly as typing at the desk does.
   */
  write: (id: string, data: string) => boolean
  /** electron/pty-host.ts `getReplay` — the catch-up buffer for one session. */
  replay: (id: string) => string
}

/**
 * A pane's recent output, cheaply.
 *
 * Timestamps only, and only within SHARE_BUSY_WINDOW_MS — the burst rule asks
 * "was there a run of output in the last three seconds", which needs the shape
 * of the stream and not one byte of it. Trimmed on every note, so the array is
 * bounded by the flush rate (~80/s) times the window rather than by uptime.
 */
interface Activity {
  /** Last time the PTY said anything. */
  lastOutputAt: number
  /**
   * Last time anything was typed *in*. Counted as noise for the quiet clock so
   * two sends in a row cannot both pass the gate in the millisecond before the
   * receiving TUI has echoed anything.
   */
  lastInputAt: number
  /** When this pane was registered — the floor for a pane that never spoke. */
  since: number
  stamps: number[]
}

const MAX_STAMPS = 512

export class ShareLink {
  private readonly deps: ShareLinkDeps
  private readonly panes = new Map<string, StoredPane>()
  private readonly activity = new Map<string, Activity>()
  private server: Server | null = null
  private path: string | null = null
  private readonly sockets = new Set<Socket>()

  constructor(deps: ShareLinkDeps) {
    this.deps = deps
  }

  /* ---------------------------------------------------------- the registry */

  /** A pane came into existence, or was re-adopted after a renderer reload. */
  register(pane: ShareLinkPane): void {
    const id = String(pane?.id ?? '')
    if (!id) return
    const title = String(pane.title ?? '').trim()
    const existing = this.panes.get(id)
    this.panes.set(id, {
      id,
      title,
      agent: String(pane.agent ?? '').trim(),
      cwd: String(pane.cwd ?? ''),
      projectName: String(pane.projectName ?? '').trim(),
      // Set once, from whichever registration got here first, and never moved
      // afterwards — see StoredPane.
      launchTitle: existing?.launchTitle ?? title
    })
    // Re-registering an existing pane must not reset its quiet clock, or a
    // renderer reload would make every pane look freshly idle.
    if (!this.activity.has(id)) {
      const now = Date.now()
      this.activity.set(id, { lastOutputAt: 0, lastInputAt: 0, since: now, stamps: [] })
    }
  }

  /**
   * A pane was renamed in the UI, after launch.
   *
   * Updates only what `resolve()` and `share_panes` show everyone else —
   * `launchTitle` is deliberately untouched, because it is standing in for an
   * env var on a live process, and that cannot be renamed out from under it.
   * A pane nobody has registered yet is a no-op: it will show its real title
   * as soon as `register` runs.
   */
  rename(id: string, title: string): void {
    const pane = this.panes.get(String(id ?? ''))
    if (!pane) return
    pane.title = String(title ?? '').trim()
  }

  /** The pane is gone. Nothing outlives the session it describes. */
  unregister(id: string): void {
    const key = String(id ?? '')
    this.panes.delete(key)
    this.activity.delete(key)
  }

  /** The PTY said something. Called from the host's replay buffer, once per flush. */
  noteOutput(id: string, at: number = Date.now()): void {
    const a = this.activity.get(String(id ?? ''))
    if (!a) return
    a.lastOutputAt = at
    a.stamps.push(at)
    this.trim(a, at)
  }

  /** Somebody typed into the pane — the desk, a phone, or this link. */
  noteWrite(id: string, at: number = Date.now()): void {
    const a = this.activity.get(String(id ?? ''))
    if (!a) return
    a.lastInputAt = at
  }

  private trim(a: Activity, now: number): void {
    const floor = now - SHARE_BUSY_WINDOW_MS
    let cut = 0
    while (cut < a.stamps.length && (a.stamps[cut] as number) < floor) cut++
    if (cut > 0) a.stamps.splice(0, cut)
    if (a.stamps.length > MAX_STAMPS) a.stamps.splice(0, a.stamps.length - MAX_STAMPS)
  }

  /* -------------------------------------------------------------- the gate */

  /** How long since anything happened to this pane, in or out. */
  private quietFor(id: string, now: number): number {
    const a = this.activity.get(id)
    if (!a) return 0
    const last = Math.max(a.lastOutputAt, a.lastInputAt) || a.since
    return Math.max(0, now - last)
  }

  /**
   * Is this pane safe to type into?
   *
   * Quiet for long enough **and** no run of output in the window that lasted
   * long enough to be work. See SHARE_BUSY_* in shared/share.ts for why both
   * halves are needed.
   */
  private idle(id: string, now: number): boolean {
    if (this.quietFor(id, now) < SHARE_BUSY_QUIET_MS) return false
    const a = this.activity.get(id)
    if (!a) return true
    this.trim(a, now)
    let runStart = -1
    let previous = -1
    for (const at of a.stamps) {
      if (previous < 0 || at - previous > SHARE_BUSY_GAP_MS) {
        runStart = at
      } else if (at - runStart >= SHARE_BUSY_ONSET_MS) {
        return false
      }
      previous = at
    }
    return true
  }

  private viewOf(pane: ShareLinkPane, now: number): ShareLinkPaneView {
    return {
      id: pane.id,
      title: pane.title,
      agent: pane.agent,
      idle: this.idle(pane.id, now),
      quietForMs: this.quietFor(pane.id, now)
    }
  }

  /* ---------------------------------------------------------------- lookup */

  /**
   * The project a pane belongs to, as one comparable string.
   *
   * The name Forge shows, when there is one; the folder otherwise. A pane with
   * neither is in a scope of its own, which is the safe end to fail towards —
   * it can be addressed by nothing rather than by everything.
   */
  private scopeOf(pane: ShareLinkPane): string {
    const named = pane.projectName.toLowerCase()
    if (named) return `name:${named}`
    return `cwd:${resolve(pane.cwd || '.').toLowerCase()}`
  }

  /**
   * Which pane is calling.
   *
   * By name first, because that is what `FORGE_SHARE_AGENT` holds, then by id.
   * "Name" means the current title or the launch title: `FORGE_SHARE_AGENT` is
   * set once, into the pane's own environment, when its process is spawned —
   * so a pane renamed afterwards keeps announcing itself by the name it no
   * longer has, and matching only the current title would make it a stranger
   * to its own request. A name shared by two panes in two projects is broken
   * by the caller's cwd — the process asking is running *in* one of them.
   */
  private caller(from: string, cwd: string): ShareLinkPane | null {
    const needle = from.trim().toLowerCase()
    if (!needle) return null
    const all = [...this.panes.values()]
    let matches = all.filter((p) => p.title.toLowerCase() === needle || p.launchTitle.toLowerCase() === needle)
    if (matches.length === 0) matches = all.filter((p) => p.id.toLowerCase() === needle)
    if (matches.length === 0) return null
    if (matches.length === 1) return matches[0] as ShareLinkPane
    const here = resolve(String(cwd ?? '') || '.').toLowerCase()
    const inside = matches.filter((p) => {
      const root = resolve(p.cwd || '.').toLowerCase()
      return here === root || (here + sep).startsWith(root + sep)
    })
    return inside.length === 1 ? (inside[0] as ShareLinkPane) : null
  }

  /**
   * Which pane is being addressed, within one project.
   *
   * Name, then id, then agent — each step only reached when the one before it
   * matched nothing, so "Codex" resolves to the pane called Codex rather than to
   * the three panes running codex. Two matches at any step is an `ambiguous`
   * refusal naming both, never a guess: guessing which agent to interrupt is the
   * one mistake this feature must not make.
   */
  private resolve(
    scope: string,
    needle: string,
    now: number
  ): { pane: ShareLinkPane } | { error: ShareLinkResponse } {
    const known = [...this.panes.values()].filter((p) => this.scopeOf(p) === scope)
    const want = String(needle ?? '').trim().toLowerCase()
    if (!want) {
      return {
        error: { ok: false, error: '`pane` is required — name the pane to reach.', panes: known.map((p) => this.viewOf(p, now)) }
      }
    }

    for (const field of [
      (p: ShareLinkPane): string => p.title.toLowerCase(),
      (p: ShareLinkPane): string => p.id.toLowerCase(),
      (p: ShareLinkPane): string => p.agent.toLowerCase()
    ]) {
      const hits = known.filter((p) => field(p) === want)
      if (hits.length === 1) return { pane: hits[0] as ShareLinkPane }
      if (hits.length > 1) {
        return {
          error: {
            ok: false,
            error: `ambiguous: ${hits.length} panes in this project answer to "${needle}". Use a pane name from share_panes.`,
            candidates: hits.map((p) => `${p.title} (${p.agent || 'shell'})`)
          }
        }
      }
    }

    return {
      error: {
        ok: false,
        error:
          known.length === 0
            ? 'There are no other panes open in this project.'
            : `No pane in this project is called "${needle}".`,
        panes: known.map((p) => this.viewOf(p, now))
      }
    }
  }

  /* -------------------------------------------------------------- handling */

  /**
   * One request, one reply. Pure but for `deps` and the clock, which is passed
   * in so the check script can drive the idle gate without sleeping through it.
   */
  handle(request: ShareLinkRequest, now: number = Date.now()): ShareLinkResponse {
    const op = String(request?.op ?? '')
    if (op !== 'send' && op !== 'read' && op !== 'panes') {
      return { ok: false, error: `Unknown op: ${op || '(none)'}. This link speaks send, read and panes.` }
    }

    const from = String(request?.from ?? '')
    const me = this.caller(from, String(request?.cwd ?? ''))
    if (!me) {
      return {
        ok: false,
        error: from.trim()
          ? `Forge does not know a pane called "${from}", so this request cannot be placed in a project. ` +
            'FORGE_SHARE_AGENT is set by Forge on the pane it launched — a server started by hand cannot use the link.'
          : 'This request carried no pane name (FORGE_SHARE_AGENT is unset), so Forge cannot tell which project it is in.'
      }
    }
    const scope = this.scopeOf(me)

    if (op === 'panes') {
      return {
        ok: true,
        op: 'panes',
        panes: [...this.panes.values()].filter((p) => this.scopeOf(p) === scope).map((p) => this.viewOf(p, now))
      }
    }

    const found = this.resolve(scope, String(request?.pane ?? ''), now)
    if ('error' in found) return found.error
    const pane = found.pane

    if (pane.id === me.id) {
      return { ok: false, error: `"${pane.title}" is the pane you are running in. A pane cannot type into itself.` }
    }

    return op === 'send' ? this.send(me, pane, request, now) : this.read(pane, request, now)
  }

  private send(me: ShareLinkPane, pane: ShareLinkPane, request: ShareLinkRequest, now: number): ShareLinkResponse {
    /*
     * Through stripAnsi first, and not as a nicety: this text came from another
     * language model, and it is about to be written raw onto somebody's PTY. An
     * escape sequence in it would be executed by the receiving terminal rather
     * than read by the receiving agent.
     */
    const cleaned = stripAnsi(String(request?.text ?? ''))
    /*
     * Newlines collapse to spaces unless the caller says otherwise, because every
     * agent TUI submits on Enter: a three-line message typed verbatim is three
     * separate prompts, the first two of them fragments. `multiline: true` is the
     * caller saying it means that.
     */
    const body = (request?.multiline === true ? cleaned.replace(/\r\n|\n/g, '\r') : cleaned.replace(/[\r\n]+/g, ' '))
      .replace(/[ \t]+/g, ' ')
      .trim()
    if (!body) return { ok: false, error: '`text` is required and must not be empty.' }

    const size = shareBytes(body)
    if (size > SHARE_SEND_MAX_BYTES) {
      return {
        ok: false,
        error:
          `That message is ${size} bytes; the limit is ${SHARE_SEND_MAX_BYTES}. It is refused rather than cut — ` +
          'half an instruction is worse than none. Put the long version in a share slot and send the slot number.'
      }
    }

    const quietForMs = this.quietFor(pane.id, now)
    const forced = request?.force === true
    if (!forced && !this.idle(pane.id, now)) {
      return {
        ok: false,
        error:
          `busy: "${pane.title}" is working — it last printed ${quietForMs}ms ago. Nothing was sent and nothing is queued. ` +
          'Wait and try again, use pane_read to watch for it to finish, or pass force: true if it really cannot wait.',
        quietForMs
      }
    }

    /*
     * `\r`, never `\n`. node-pty, pwsh and every Ink-based TUI in the list treat
     * carriage return as the Enter key; a line feed is a literal character that
     * lands in the composer and submits nothing.
     */
    const payload = `[from ${me.title || 'another pane'}] ${body}\r`
    if (!this.deps.write(pane.id, payload)) {
      return { ok: false, error: `Forge could not write to "${pane.title}" — the pane may have just closed.` }
    }
    this.noteWrite(pane.id, now)

    return { ok: true, op: 'send', pane: pane.title, id: pane.id, bytes: size, quietForMs, forced }
  }

  private read(pane: ShareLinkPane, request: ShareLinkRequest, now: number): ShareLinkResponse {
    const asked = Number(request?.lines ?? SHARE_READ_DEFAULT_LINES)
    const want = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), SHARE_CAPTURE_MAX_LINES) : SHARE_READ_DEFAULT_LINES
    // Exactly what the rail's own pane capture does — see `captureText` in
    // electron/share-watcher.ts. One rule for turning a replay buffer into text.
    const text = tailLines(stripAnsi(this.deps.replay(pane.id)), want)
    return {
      ok: true,
      op: 'read',
      pane: pane.title,
      id: pane.id,
      text,
      idle: this.idle(pane.id, now),
      quietForMs: this.quietFor(pane.id, now),
      lines: text ? text.split('\n').length : 0
    }
  }

  /* ------------------------------------------------------------- the socket */

  /** Where this link listens. Null until `listen()` has succeeded. */
  address(): string | null {
    return this.path
  }

  /**
   * A named pipe on Windows, a socket file in the temp directory elsewhere.
   *
   * Keyed by pid so two Forges — a packaged one and a dev one, which is Steve's
   * normal Tuesday — never collide on the same path.
   */
  static addressFor(pid: number): string {
    return process.platform === 'win32' ? `\\\\.\\pipe\\forge-share-${pid}` : join(tmpdir(), `forge-share-${pid}.sock`)
  }

  /**
   * Start listening. Idempotent, and never throws at the caller: a Forge whose
   * pipe could not be created is a Forge without this one feature, not a Forge
   * that failed to start.
   */
  listen(path: string = ShareLink.addressFor(process.pid)): string | null {
    if (this.server) return this.path
    if (process.platform !== 'win32' && existsSync(path)) {
      // A socket file left by a Forge that was killed rather than quit. Removing
      // it is safe: the pid in the name says it was ours.
      try {
        unlinkSync(path)
      } catch {
        /* best effort — listen will report the real problem */
      }
    }

    const server = createServer((socket) => this.serve(socket))
    server.on('error', (err) => {
      console.error('[share-link] listen failed:', err)
      this.server = null
      this.path = null
    })
    try {
      server.listen(path)
    } catch (err) {
      console.error('[share-link] could not listen on', path, err)
      return null
    }
    this.server = server
    this.path = path
    return path
  }

  /** One connection, one newline-terminated request, one reply, closed. */
  private serve(socket: Socket): void {
    this.sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    let answered = false

    const reply = (response: ShareLinkResponse): void => {
      if (answered) return
      answered = true
      try {
        socket.end(`${JSON.stringify(response)}\n`)
      } catch {
        /* the caller hung up */
      }
    }

    socket.on('data', (chunk: string) => {
      if (answered) return
      buffer += chunk
      if (buffer.length > SHARE_LINK_MAX_REQUEST_BYTES) {
        reply({ ok: false, error: `A request may not exceed ${SHARE_LINK_MAX_REQUEST_BYTES} bytes.` })
        return
      }
      const nl = buffer.indexOf('\n')
      if (nl === -1) return
      const line = buffer.slice(0, nl)
      let request: ShareLinkRequest
      try {
        request = JSON.parse(line) as ShareLinkRequest
      } catch (err) {
        reply({ ok: false, error: `That was not JSON: ${(err as Error).message}` })
        return
      }
      try {
        reply(this.handle(request))
      } catch (err) {
        // A throw in here would otherwise take the whole main process with it,
        // to answer a message one agent sent another.
        console.error('[share-link] request failed:', err)
        reply({ ok: false, error: `The link failed: ${(err as Error).message}` })
      }
    })

    socket.on('error', () => {
      this.sockets.delete(socket)
    })
    socket.on('close', () => {
      this.sockets.delete(socket)
    })
  }

  /** Stop listening and forget every pane. Called from disposePtyHost. */
  close(): void {
    for (const socket of [...this.sockets]) {
      try {
        socket.destroy()
      } catch {
        /* best effort */
      }
    }
    this.sockets.clear()
    try {
      this.server?.close()
    } catch {
      /* best effort */
    }
    if (this.server && this.path && process.platform !== 'win32') {
      try {
        if (existsSync(this.path)) unlinkSync(this.path)
      } catch {
        /* best effort */
      }
    }
    this.server = null
    this.path = null
    this.panes.clear()
    this.activity.clear()
  }
}
