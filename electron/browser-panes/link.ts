import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BROWSER_LINK_FILE, BROWSER_LINK_MAX_REQUEST_BYTES, type BrowserAgentReply, type BrowserOwner } from '@shared/browser'

/**
 * How an agent CLI's MCP server (bridge/browser-tools.mjs) reaches the browser
 * in Forge's main process.
 *
 * Same transport as electron/share-link.ts, for the same reasons: the MCP server
 * is a stdio child of the agent CLI, not of Forge, so there is no inherited
 * handle — and a named pipe (a unix socket off win32) is addressable by a path,
 * reachable only from this machine, and needs no port. There is no TCP here.
 *
 * Unlike the share link it is **authenticated**: a browser that holds Steve's
 * sign-ins is worth more than a scratchpad. Every start mints a random 32-byte
 * token and writes `{ pipe, token }` to `<data dir>\browser\link.json` — a file
 * under the user's own profile. Every request must carry that token; a wrong or
 * missing one is refused before the op is even looked at, compared in constant
 * time. The pipe path is random too, so a stale link file from a previous run
 * points at nothing.
 *
 * One request per connection, newline-terminated JSON both ways — an MCP tool
 * call is a round trip, and nothing is pushed. No Electron import: the handler
 * is injected, which is what lets scripts/browser-check.mjs drive this real class
 * (including the wrong-token refusal) head-less.
 */

/** A request as it arrives on the pipe. */
export interface BrowserLinkRequest {
  token?: unknown
  op?: unknown
  args?: unknown
  /** The calling pane, as its environment describes it. Display and scoping, not auth. */
  from?: { paneId?: unknown; name?: unknown; agent?: unknown }
}

export type BrowserLinkHandler = (
  op: string,
  args: Record<string, unknown>,
  caller: BrowserOwner
) => Promise<BrowserAgentReply>

export interface BrowserLinkFile {
  v: 1
  pipe: string
  token: string
  pid: number
}

/** The owner a pane's request speaks for. A caller with no pane id is "an agent", one owner for all such. */
export function callerOf(from: BrowserLinkRequest['from']): BrowserOwner {
  const paneId = String(from?.paneId ?? '').trim().slice(0, 128)
  const name = String(from?.name ?? '').trim().slice(0, 60)
  const agent = String(from?.agent ?? '').trim().toLowerCase().slice(0, 40)
  return { id: paneId ? `pane:${paneId}` : 'agent', label: name || (agent ? agent : 'Agent'), agent }
}

function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export class BrowserLink {
  private readonly dir: string
  private readonly handler: BrowserLinkHandler
  private readonly token = randomBytes(32).toString('hex')
  private server: Server | null = null
  private pipe: string | null = null
  private readonly sockets = new Set<Socket>()

  constructor(dir: string, handler: BrowserLinkHandler) {
    this.dir = dir
    this.handler = handler
  }

  /** Where the link file is. The value of FORGE_BROWSER_LINK_FILE. */
  get linkFile(): string {
    return join(this.dir, BROWSER_LINK_FILE)
  }

  /** Start listening (idempotent) and write the link file. Resolves to the pipe path. */
  async listen(): Promise<string> {
    if (this.server && this.pipe) return this.pipe
    const name = `forge-browser-${process.pid}-${randomBytes(6).toString('hex')}`
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`)
    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((res, rej) => {
      server.once('error', rej)
      server.listen(pipe, () => {
        server.off('error', rej)
        res()
      })
    })
    this.server = server
    this.pipe = pipe
    this.writeLinkFile(pipe)
    return pipe
  }

  private writeLinkFile(pipe: string): void {
    mkdirSync(this.dir, { recursive: true })
    const body: BrowserLinkFile = { v: 1, pipe, token: this.token, pid: process.pid }
    const tmp = `${this.linkFile}.tmp`
    writeFileSync(tmp, JSON.stringify(body), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.linkFile)
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    let handled = false
    const reply = (value: BrowserAgentReply | { ok: false; error: string; text: string }): void => {
      if (socket.destroyed) return
      socket.end(`${JSON.stringify(value)}\n`)
    }
    socket.on('data', (chunk: string) => {
      if (handled) return
      buffer += chunk
      if (Buffer.byteLength(buffer, 'utf8') > BROWSER_LINK_MAX_REQUEST_BYTES) {
        handled = true
        reply({ ok: false, error: 'too-large', text: 'That request is too large for the browser link.' })
        return
      }
      const nl = buffer.indexOf('\n')
      if (nl === -1) return
      handled = true
      let req: BrowserLinkRequest
      try {
        req = JSON.parse(buffer.slice(0, nl)) as BrowserLinkRequest
      } catch {
        reply({ ok: false, error: 'bad-json', text: 'The browser link was sent something that was not JSON.' })
        return
      }
      if (!sameToken(req?.token, this.token)) {
        reply({
          ok: false,
          error: 'bad-token',
          text: "Forge refused the request: the browser link token is wrong. Forge has probably restarted since this pane opened; reopen the pane, or restart the agent's MCP server, to pick up the new link."
        })
        return
      }
      const op = String(req.op ?? '')
      const args = req.args && typeof req.args === 'object' ? (req.args as Record<string, unknown>) : {}
      this.handler(op, args, callerOf(req.from))
        .then((value) => reply(value))
        .catch((err: unknown) =>
          reply({ ok: false, error: 'failed', text: `The browser could not do that: ${err instanceof Error ? err.message : String(err)}` })
        )
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => this.sockets.delete(socket))
  }

  /** Stop listening, drop every open connection, and remove the link file. */
  close(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.server?.close()
    this.server = null
    if (this.pipe && process.platform !== 'win32' && existsSync(this.pipe)) {
      try {
        unlinkSync(this.pipe)
      } catch {
        /* gone already */
      }
    }
    this.pipe = null
    try {
      if (existsSync(this.linkFile)) unlinkSync(this.linkFile)
    } catch {
      /* next start overwrites it */
    }
  }
}
