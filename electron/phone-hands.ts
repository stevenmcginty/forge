import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { HandsReqFrame, HandsResFrame, HandsStatusFrame } from '@shared/mobile'
import type { BrowserAgentReply } from '@shared/browser'
import type { PhoneHandsStatus } from '@shared/types'
import {
  PHONE_NOT_CONNECTED,
  PHONE_TIMED_OUT,
  PHONE_TIMEOUT_MS,
  PHONE_TOOL_SPECS,
  type PhoneParamSpec
} from '../shared/phone-hands-spec.mjs'
import type { HandsEvent } from './mobile/server'

/**
 * Phone hands, the desk half: Forge agents operate Steve's phone.
 *
 * The phone's native service dials the mobile link with `role: "hands"`
 * (electron/mobile/server.ts keeps those sockets apart); this module turns a
 * tool call into one `hands:req` down the most recently connected of them and
 * waits for the `hands:res` with the same id. The wire contract is
 * docs/PHONE-HANDS.md; every word an agent reads is shared/phone-hands-spec.mjs.
 *
 * Electron-free, like the server: mobile-host wires it to the live server, and
 * scripts/phone-hands-check.mjs wires a fresh instance to a standalone one.
 *
 * Three ways in, one engine:
 *  - `phoneLinkOp` — forge-bridge's phone_* tools over the pane pipe
 *    (electron/browser-panes/ipc.ts), the picture handed over as a file;
 *  - `phoneBrainTools` — the same tools for forgeToolDefs() in
 *    electron/voice-agent/host.ts, the picture inline;
 *  - `phoneOp` — the bare request, for anything else.
 */

/** What one op came back with. `error` is always words Steve can read. */
export type PhoneReply = { ok: true; text: string; image?: string; mime?: string } | { ok: false; error: string }

/** How requests leave: MobileServer.sendHands, or null while the link is down. */
export interface PhoneHandsLink {
  send: (socketId: string, frame: Omit<HandsReqFrame, 't' | 'type'>) => boolean
}

interface Pending {
  socketId: string
  timer: NodeJS.Timeout
  settle: (reply: PhoneReply) => void
}

/** The longest text answer kept from the phone. A `read` is ~150 lines; this is far past it. */
const MAX_TEXT_CHARS = 60_000

export class PhoneHands {
  private link: PhoneHandsLink | null = null
  /** Open hands sockets in connection order: the last one is the one used. */
  private sockets: Array<{ socketId: string; deviceName: string }> = []
  private pending = new Map<string, Pending>()
  private lastStatus: (HandsStatusFrame & { at: number }) | null = null
  private listeners = new Set<() => void>()
  private readonly timeoutMs: number

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? PHONE_TIMEOUT_MS
  }

  setLink(link: PhoneHandsLink | null): void {
    this.link = link
    if (!link) {
      // The server is gone, and every socket with it.
      for (const { socketId } of [...this.sockets]) this.handle({ kind: 'close', socketId })
    }
  }

  /** Told whenever the connection or the phone's status changes. Returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** One event from MobileServerHost.onHands. */
  handle(event: HandsEvent): void {
    switch (event.kind) {
      case 'open':
        this.sockets = this.sockets.filter((s) => s.socketId !== event.socketId)
        this.sockets.push({ socketId: event.socketId, deviceName: event.deviceName })
        this.changed()
        return
      case 'close': {
        const before = this.sockets.length
        this.sockets = this.sockets.filter((s) => s.socketId !== event.socketId)
        for (const [id, wait] of [...this.pending]) {
          if (wait.socketId !== event.socketId) continue
          this.pending.delete(id)
          clearTimeout(wait.timer)
          wait.settle({ ok: false, error: 'The phone disconnected before it answered. Try again in a moment.' })
        }
        if (this.sockets.length !== before) this.changed()
        return
      }
      case 'res':
        this.onResult(event.socketId, event.frame)
        return
      case 'status':
        this.lastStatus = { ...readStatus(event.frame), at: Date.now() }
        this.changed()
        return
    }
  }

  /** Is a hands socket open right now? */
  get connected(): boolean {
    return this.sockets.length > 0
  }

  /** For the desk's Settings line: connected or not, and the phone's last word on itself. */
  status(): PhoneHandsStatus {
    const newest = this.sockets[this.sockets.length - 1]
    const s = this.lastStatus
    return {
      connected: !!newest,
      deviceName: newest?.deviceName ?? '',
      ...(s
        ? {
            accessibility: s.accessibility,
            notifications: s.notifications,
            contacts: s.contacts,
            enabled: s.enabled,
            locked: s.locked,
            app: s.app,
            version: s.version,
            statusAt: s.at
          }
        : {})
    }
  }

  /** One op on the phone. Never rejects: every failure is a sentence. */
  request(op: string, args: Record<string, unknown> = {}): Promise<PhoneReply> {
    const target = this.sockets[this.sockets.length - 1]
    if (!target || !this.link) return Promise.resolve({ ok: false, error: PHONE_NOT_CONNECTED })
    const id = randomUUID()
    return new Promise<PhoneReply>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        resolve({ ok: false, error: PHONE_TIMED_OUT })
      }, this.timeoutMs)
      this.pending.set(id, { socketId: target.socketId, timer, settle: resolve })
      let sent = false
      try {
        sent = this.link?.send(target.socketId, { id, op, args }) === true
      } catch {
        sent = false
      }
      if (!sent) {
        this.pending.delete(id)
        clearTimeout(timer)
        resolve({ ok: false, error: PHONE_NOT_CONNECTED })
      }
    })
  }

  private onResult(socketId: string, frame: HandsResFrame): void {
    const id = typeof frame.id === 'string' ? frame.id : ''
    const wait = this.pending.get(id)
    // An answer to nothing — late, after the timeout, or from another socket.
    if (!wait || wait.socketId !== socketId) return
    this.pending.delete(id)
    clearTimeout(wait.timer)
    if (frame.ok !== true) {
      const error = typeof frame.error === 'string' && frame.error.trim() ? frame.error : 'The phone could not do that, and did not say why.'
      wait.settle({ ok: false, error })
      return
    }
    const text = typeof frame.text === 'string' ? frame.text.slice(0, MAX_TEXT_CHARS) : ''
    const image = typeof frame.image === 'string' && frame.image ? frame.image : undefined
    const mime = typeof frame.mime === 'string' && /^image\/[a-z0-9.+-]+$/i.test(frame.mime) ? frame.mime : 'image/jpeg'
    wait.settle({ ok: true, text, ...(image ? { image, mime } : {}) })
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        /* a listener's failure is its own */
      }
    }
  }
}

/** Only the known fields, each only when it has the right type. */
function readStatus(frame: HandsStatusFrame): HandsStatusFrame {
  const out: HandsStatusFrame = { t: 'hands:status' }
  for (const key of ['accessibility', 'notifications', 'contacts', 'enabled', 'screenOn', 'locked'] as const) {
    if (typeof frame[key] === 'boolean') out[key] = frame[key]
  }
  if (typeof frame.app === 'string') out.app = frame.app.slice(0, 200)
  if (typeof frame.version === 'string') out.version = frame.version.slice(0, 64)
  return out
}

/** The one instance Forge runs, wired to the live server by electron/mobile-host.ts. */
export const phoneHands = new PhoneHands()

/** One op on Steve's phone, through the live link. */
export function phoneOp(op: string, args: Record<string, unknown> = {}): Promise<PhoneReply> {
  return phoneHands.request(op, args)
}

export function phoneHandsStatus(): PhoneHandsStatus {
  return phoneHands.status()
}

/* ------------------------------------------------------------- the tools */

/** forge-bridge pipe ops answered here (bridge/phone-tools.mjs). Its own set, apart from DESKTOP_LINK_OPS. */
export const PHONE_LINK_OPS: readonly string[] = PHONE_TOOL_SPECS.map((spec) => spec.name)

/** Tool name → contract op (phone_open_app → open_app). */
function opOf(name: string): string | null {
  return PHONE_TOOL_SPECS.find((spec) => spec.name === name)?.op ?? null
}

/** Phone screenshots kept on disk for the pipe, newest last; older ones are removed. */
const KEEP_SHOTS = 20

function saveShot(dir: string, base64: string, mime: string): string {
  mkdirSync(dir, { recursive: true })
  const ext = mime === 'image/png' ? 'png' : 'jpg'
  const path = join(dir, `phone-${Date.now()}.${ext}`)
  writeFileSync(path, Buffer.from(base64, 'base64'))
  try {
    const old = readdirSync(dir)
      .filter((f) => f.startsWith('phone-'))
      .sort()
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_SHOTS))) rmSync(join(dir, f), { force: true })
  } catch {
    /* tidying is best effort */
  }
  return path
}

/**
 * One phone op off the authenticated pane pipe. Always an answer in words; a
 * picture is saved under `shotDir` and handed over as `imagePath`, the way
 * screen_look's is, so the pipe never carries the JPEG itself.
 */
export async function phoneLinkOp(
  name: string,
  args: Record<string, unknown>,
  options: { shotDir: string; hands?: PhoneHands }
): Promise<BrowserAgentReply> {
  const op = opOf(name)
  if (!op) return { ok: false, text: `There is no phone tool called ${name}.` }
  const reply = await (options.hands ?? phoneHands).request(op, args ?? {})
  if (!reply.ok) return { ok: false, text: reply.error }
  const text = reply.text || 'The phone did that.'
  if (!reply.image) return { ok: true, text }
  try {
    const imagePath = saveShot(options.shotDir, reply.image, reply.mime ?? 'image/jpeg')
    return { ok: true, text, imagePath }
  } catch (err) {
    return { ok: true, text: `${text}\n(The picture could not be saved: ${err instanceof Error ? err.message : String(err)}.)` }
  }
}

type ToolResult = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }

/** Typed like electron/browser-panes/brain.ts `BrainBrowserTool`, so host.ts's `tool()` map takes it unchanged. */
export interface PhoneBrainTool {
  name: string
  description: string
  shape: z.ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<ToolResult>
}

function zodOf(param: PhoneParamSpec): z.ZodType {
  const base =
    param.enum && param.enum.length > 0
      ? z.enum(param.enum as [string, ...string[]])
      : param.type === 'integer'
        ? z.number().int()
        : param.type === 'number'
          ? z.number()
          : param.type === 'boolean'
            ? z.boolean()
            : z.string()
  return base.describe(param.description)
}

/** The thirteen phone_* tools for forgeToolDefs(): Forge Brain, Telegram, the CLI brains, voice, the Conductor. */
export function phoneBrainTools(hands: PhoneHands = phoneHands): PhoneBrainTool[] {
  return PHONE_TOOL_SPECS.map((spec) => {
    const shape: Record<string, z.ZodType> = {}
    for (const [key, param] of Object.entries(spec.params)) {
      const field = zodOf(param)
      shape[key] = spec.required.includes(key) ? field : field.optional()
    }
    return {
      name: spec.name,
      description: spec.description,
      shape,
      handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
        const reply = await hands.request(spec.op, args ?? {})
        if (!reply.ok) return { content: [{ type: 'text', text: reply.error }] }
        const content: ToolResult['content'] = [{ type: 'text', text: reply.text || 'The phone did that.' }]
        if (reply.image) content.push({ type: 'image', data: reply.image, mimeType: reply.mime ?? 'image/jpeg' })
        return { content }
      }
    }
  })
}

/** Their names as the Claude session's canUseTool sees them, for host.ts's allowedTools. */
export const PHONE_BRAIN_ALLOWED: readonly string[] = PHONE_TOOL_SPECS.map((spec) => `mcp__forge__${spec.name}`)
