/**
 * Forge Companion — the desktop half of the phone link.
 *
 * What it does, in one paragraph: publishes Steve's project list (name, colour,
 * a one-line status) into his own Firebase Realtime Database; watches an inbox
 * under the same account; turns an inbox *image* into a file on the screenshot
 * shelf and in the project's `assets/inbox/`; turns an inbox *message* into a
 * `companion:utterance` event for whoever owns the voice pipeline; and writes
 * replies back into an outbox the phone renders as a feed.
 *
 * Off by default. Nothing here runs, connects or reads a credential unless
 * `companionEnabled` is true *and* a session has been signed in.
 *
 * ## Electron-free on purpose
 *
 * This module imports `node:fs` and `node:path` and nothing else. Everything
 * Electron-shaped — settings, the shots shelf, sending an IPC event — arrives
 * through the `CompanionHost` interface below. That is what lets
 * `scripts/companion-smoke.mjs` drive the real class against the real Firebase
 * emulator with a temp data directory, instead of testing a mock and hoping.
 * The Electron wiring lives next door in electron/companion-host.ts.
 *
 * ## What is deliberately NOT here
 *
 * The voice pipeline. A message from the phone becomes a `companion:utterance`
 * event and the service's job ends. Hooking that to the voice agent belongs to
 * whoever owns VoicePanel; the contract they need is documented in
 * companion/README.md and is a single event shape plus `companionReply()`.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  asMs,
  EMPTY_CONFIG,
  extensionFor,
  isConfigured,
  MAX_INLINE_BASE64,
  OUTBOX_KEEP,
  parseImageDataUrl,
  paths,
  PURGE_AGE_MS,
  safeFileStem,
  safeKey,
  SERVER_TIMESTAMP,
  sortableId,
  STALE_MS,
  statusLine,
  type CompanionConfig,
  type CompanionProjectRecord,
  type InboxItemRecord,
  type OutboxItemRecord
} from './companion/protocol'
import { describe, FirebaseRest, OfflineError, RevokedError, type StreamHandle } from './companion/rest'
// Type-only, so this module still bundles standalone for the smoke test — an
// `import type` is erased before any resolver sees the `@shared` alias.
import type { CompanionSignInResult, CompanionStatus, CompanionUtteranceEvent } from '@shared/types'

/* ------------------------------------------------------------------- host */

/** A project as the desktop knows it. `path` never leaves the machine. */
export interface CompanionProjectInfo {
  id: string
  name: string
  color: string
  /** Absolute folder. Used for `assets/inbox/`; never published. */
  path: string
}

/** The light status Forge can derive without asking the renderer anything. */
export interface CompanionProjectStatus {
  /** Live PTY sessions whose cwd is this project's folder. */
  panes: number
  /** Tabs in the saved workspace layout. */
  tabs: number
  /** Epoch ms of the newest signal — a session start, or the layout's mtime. */
  lastActivity: number
}

export type CompanionEvent =
  /** A typed or dictated message from the phone. THE voice-pipeline hookup. */
  | ({ type: 'utterance' } & CompanionUtteranceEvent)
  /** Images from the phone have landed on the shelf and in the project. */
  | { type: 'image'; projectId: string; itemId: string; paths: string[] }
  /** Connection/auth state changed. */
  | { type: 'status'; status: CompanionStatus }

/**
 * Everything the service needs from the outside world.
 *
 * Small on purpose: four reads, one write, one side effect, one emit. If this
 * interface grows a method that needs a BrowserWindow, the design has gone
 * wrong — put it in companion-host.ts instead.
 */
export interface CompanionHost {
  getConfig(): CompanionConfig
  saveConfig(patch: Partial<CompanionConfig>): void
  listProjects(): CompanionProjectInfo[]
  statusOf(projectId: string): CompanionProjectStatus
  /** Copy image files onto the screenshot shelf. Returns how many landed. */
  adoptShots(paths: string[]): number
  emit(event: CompanionEvent): void
  log?(line: string, ...rest: unknown[]): void
  now?(): number
  /** Injectable for the smoke test. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch
}

/* ------------------------------------------------------------- the service */

/** How often the project list is republished while the link is up. */
const PUBLISH_TICK_MS = 30_000

/** Nested plain object mirroring `users/<uid>/inbox`. */
type InboxTree = Record<string, Record<string, InboxItemRecord>>

export class CompanionSync {
  private readonly host: CompanionHost
  private rest: FirebaseRest | null = null
  private inboxStream: StreamHandle | null = null
  private publishTimer: NodeJS.Timeout | null = null

  /** Local mirror of the inbox, folded from the SSE events. */
  private tree: InboxTree = {}
  /** `projectId/itemId` of everything we have already claimed. */
  private handled = new Set<string>()
  /** itemId -> projectId, so `reply(id, text)` knows where to write. */
  private replyRoutes = new Map<string, string>()
  private purgedOnce = false

  private status: CompanionStatus = {
    enabled: false,
    configured: false,
    state: 'off',
    email: '',
    uid: '',
    detail: '',
    projects: 0,
    lastInboxAt: 0
  }

  constructor(host: CompanionHost) {
    this.host = host
  }

  private get now(): number {
    return this.host.now?.() ?? Date.now()
  }

  private log(line: string, ...rest: unknown[]): void {
    if (this.host.log) this.host.log(line, ...rest)
    else console.log(`[companion] ${line}`, ...rest)
  }

  getStatus(): CompanionStatus {
    return { ...this.status }
  }

  private setStatus(patch: Partial<CompanionStatus>): void {
    const next = { ...this.status, ...patch }
    const changed = (Object.keys(next) as Array<keyof CompanionStatus>).some((k) => next[k] !== this.status[k])
    this.status = next
    if (changed) this.host.emit({ type: 'status', status: this.getStatus() })
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Bring the link up if — and only if — it is switched on and has a session.
   *
   * Safe to call repeatedly: it tears down whatever was running first. That is
   * what makes "the settings changed" a one-line handler rather than a state
   * machine.
   */
  start(): void {
    this.stop()
    const cfg = this.host.getConfig()
    if (!cfg.enabled) {
      this.setStatus({ enabled: false, configured: isConfigured(cfg), state: 'off', detail: '', email: cfg.email })
      return
    }
    if (!isConfigured(cfg)) {
      this.setStatus({
        enabled: true,
        configured: false,
        state: 'signed-out',
        email: cfg.email,
        uid: '',
        detail: cfg.apiKey && cfg.databaseURL ? 'Sign in to link a phone' : 'Firebase project not configured yet'
      })
      return
    }

    this.rest = this.makeRest(cfg)
    // `expiresAt: 0` on a restored session forces a refresh on the first call,
    // which is also how we discover a revoked credential without a round trip
    // to the database.
    this.rest.adopt({ uid: cfg.uid, email: cfg.email, idToken: '', refreshToken: cfg.refreshToken, expiresAt: 0 })

    this.setStatus({
      enabled: true,
      configured: true,
      state: 'connecting',
      email: cfg.email,
      uid: cfg.uid,
      detail: ''
    })

    void this.publishProjects()
    this.publishTimer = setInterval(() => void this.publishProjects(), PUBLISH_TICK_MS)
    this.watchInbox(cfg.uid)
  }

  stop(): void {
    this.inboxStream?.stop()
    this.inboxStream = null
    if (this.publishTimer) clearInterval(this.publishTimer)
    this.publishTimer = null
    this.rest = null
    this.tree = {}
    this.handled.clear()
    this.replyRoutes.clear()
    this.purgedOnce = false
  }

  dispose(): void {
    this.stop()
    this.setStatus({ state: 'off', detail: '' })
  }

  private makeRest(cfg: CompanionConfig): FirebaseRest {
    const rest = new FirebaseRest({
      apiKey: cfg.apiKey,
      databaseURL: cfg.databaseURL,
      authBase: cfg.authBase,
      tokenBase: cfg.tokenBase,
      fetch: this.host.fetch,
      now: () => this.now
    })
    // Rotated refresh tokens have to reach disk immediately: the rotation
    // invalidates the old one, so a crash before saving locks the app out.
    rest.onRefreshToken = (refreshToken) => this.host.saveConfig({ refreshToken })
    return rest
  }

  /* ----------------------------------------------------------------- auth */

  /**
   * Sign in (creating the account if it is new) and start the link.
   *
   * The password is used for exactly one HTTPS POST and then dropped on the
   * floor — what reaches disk is the refresh token, which Steve can revoke from
   * the Firebase console without changing any password he uses elsewhere.
   */
  async signIn(email: string, password: string): Promise<CompanionSignInResult> {
    const cfg = this.host.getConfig()
    if (!cfg.apiKey || !cfg.databaseURL) {
      return { ok: false, error: 'Set the Firebase API key and database URL first (see companion/GO-LIVE.md)' }
    }
    const rest = this.makeRest(cfg)
    try {
      const result = await rest.signIn(email.trim(), password)
      this.host.saveConfig({
        email: result.email,
        uid: result.uid,
        refreshToken: result.refreshToken,
        enabled: true
      })
      this.start()
      return { ok: true, uid: result.uid, created: result.created }
    } catch (err) {
      const error = describe(err)
      this.setStatus({ state: 'error', detail: error })
      return { ok: false, error }
    }
  }

  /** Drop the session. Keeps the email so the form pre-fills, like DictationMic. */
  signOut(): void {
    this.stop()
    this.host.saveConfig({ refreshToken: '', uid: '', enabled: false })
    const cfg = this.host.getConfig()
    this.setStatus({
      enabled: false,
      configured: false,
      state: 'signed-out',
      uid: '',
      email: cfg.email,
      detail: 'Signed out'
    })
  }

  /* ------------------------------------------------------------ publishing */

  /**
   * Publish the project list.
   *
   * A whole-map PUT rather than per-project PATCHes, because deleting a project
   * on the desktop has to delete it on the phone, and a PATCH cannot express
   * "and nothing else". The map is small (a handful of short strings), so the
   * simplicity is free.
   *
   * Note what is *not* in the payload: `path`. The phone has no use for
   * `C:\Users\steve\Desktop\...` and there is no reason to put Steve's folder
   * layout in a cloud database.
   */
  async publishProjects(): Promise<number> {
    const rest = this.rest
    if (!rest || !rest.uid) return 0
    const projects = this.host.listProjects()
    const payload: Record<string, CompanionProjectRecord> = {}
    for (const p of projects) {
      const st = this.host.statusOf(p.id)
      payload[safeKey(p.id)] = {
        name: p.name,
        color: p.color,
        status: statusLine(st.panes, st.tabs),
        panes: st.panes,
        tabs: st.tabs,
        lastActivity: st.lastActivity,
        updatedAt: SERVER_TIMESTAMP
      }
    }
    try {
      await rest.put(paths.projects(rest.uid), payload)
      await rest.patch(paths.presence(rest.uid), { device: 'forge', at: SERVER_TIMESTAMP })
      this.setStatus({ projects: projects.length })
      return projects.length
    } catch (err) {
      this.noteError(err, 'publish')
      return 0
    }
  }

  /* --------------------------------------------------------------- replies */

  /**
   * Send text back to the phone.
   *
   * `inboxItemId` is the id from the `companion:utterance` event, which is how
   * a reply gets threaded under the message that caused it. Passing an id we
   * have never seen is not an error — the reply just lands unthreaded in the
   * project it names, which is what you want for an unprompted notification.
   */
  async reply(inboxItemId: string, text: string, projectIdHint?: string): Promise<boolean> {
    const rest = this.rest
    if (!rest || !rest.uid) return false
    const body = String(text ?? '').trim()
    if (!body) return false

    const projectId = projectIdHint ? safeKey(projectIdHint) : this.replyRoutes.get(inboxItemId)
    if (!projectId) {
      this.log(`reply: no project known for inbox item ${inboxItemId}`)
      return false
    }

    const id = sortableId(this.now)
    const record: OutboxItemRecord = {
      kind: 'reply',
      text: body.slice(0, 4000),
      createdAt: SERVER_TIMESTAMP,
      origin: 'forge',
      replyTo: inboxItemId || undefined
    }
    try {
      await rest.patch(paths.outbox(rest.uid, projectId, id), record)
      await this.trimOutbox(projectId)
      return true
    } catch (err) {
      this.noteError(err, 'reply')
      return false
    }
  }

  /** Keep the phone's feed bounded — it is a feed, not an archive. */
  private async trimOutbox(projectId: string): Promise<void> {
    const rest = this.rest
    if (!rest || !rest.uid) return
    try {
      const all = await rest.get<Record<string, OutboxItemRecord>>(paths.outbox(rest.uid, projectId))
      const keys = Object.keys(all ?? {}).sort()
      if (keys.length <= OUTBOX_KEEP) return
      for (const key of keys.slice(0, keys.length - OUTBOX_KEEP)) {
        await rest.remove(paths.outbox(rest.uid, projectId, key))
      }
    } catch (err) {
      this.log('outbox trim failed (harmless):', describe(err))
    }
  }

  /* ----------------------------------------------------------------- inbox */

  private watchInbox(uid: string): void {
    const rest = this.rest
    if (!rest) return
    this.inboxStream = rest.stream(paths.inboxAll(uid), {
      onEvent: (e) => {
        try {
          this.applyInboxEvent(e.event, e.path, e.data)
        } catch (err) {
          // A malformed record must never kill the stream reader — that would
          // take the whole link down until the next restart.
          this.log('inbox event failed:', describe(err))
        }
        void this.sweep()
      },
      onState: (state, detail) => {
        if (state === 'revoked') {
          this.setStatus({ state: 'signed-out', configured: false, detail: 'Sign in again — the session was revoked' })
          return
        }
        this.setStatus({ state, detail: detail ?? '' })
      }
    })
  }

  /**
   * Fold one SSE event into the local mirror.
   *
   * RTDB's five shapes, at the node we stream (`users/<uid>/inbox`):
   *   put   /                       whole snapshot  — also the *initial* one
   *   put   /<projectId>            that project's whole inbox (null = gone)
   *   put   /<projectId>/<itemId>   one item (null = deleted)
   *   patch /<projectId>            changed items only
   *   patch /<projectId>/<itemId>   changed fields of one item
   *
   * A deeper path than that (a single field moving) is possible and is folded
   * the same way — the sweep only cares about complete-looking items.
   */
  private applyInboxEvent(kind: 'put' | 'patch', path: string, data: unknown): void {
    const parts = path.split('/').filter(Boolean)

    if (parts.length === 0) {
      if (kind === 'put') this.tree = (data as InboxTree) ?? {}
      else Object.assign(this.tree, (data as InboxTree) ?? {})
      return
    }

    const projectId = parts[0]!
    if (parts.length === 1) {
      if (kind === 'put') {
        if (data === null) delete this.tree[projectId]
        else this.tree[projectId] = data as Record<string, InboxItemRecord>
      } else {
        this.tree[projectId] = { ...(this.tree[projectId] ?? {}), ...((data as Record<string, InboxItemRecord>) ?? {}) }
      }
      return
    }

    const itemId = parts[1]!
    const bucket = (this.tree[projectId] ??= {})
    if (parts.length === 2) {
      if (kind === 'put') {
        if (data === null) delete bucket[itemId]
        else bucket[itemId] = data as InboxItemRecord
      } else {
        bucket[itemId] = { ...(bucket[itemId] ?? ({} as InboxItemRecord)), ...((data as object) ?? {}) }
      }
      return
    }

    // Single field, e.g. /<projectId>/<itemId>/status
    const field = parts.slice(2).join('/')
    const item = (bucket[itemId] ??= {} as InboxItemRecord)
    ;(item as unknown as Record<string, unknown>)[field] = data
  }

  /**
   * Run every pending item we have not claimed yet, oldest first.
   *
   * Serialised, because SSE events arrive in bursts and every one triggers a
   * sweep: without the guard we would be saving two images concurrently and
   * interleaving their acks.
   *
   * But *serialised* is not *skipped*, and getting that wrong is a real bug
   * rather than a theoretical one. Sending a photo and a message together
   * produces two events milliseconds apart; the first starts a sweep that takes
   * as long as a file write and two HTTP round trips, and the second arrives
   * while it is running. Simply returning early there loses the message
   * permanently — the item is in the tree, marked pending, with nothing left to
   * wake anybody up. So a sweep requested during a sweep sets `sweepAgain`, and
   * the loop below picks up whatever landed in the meantime.
   */
  private sweeping = false
  private sweepAgain = false

  private async sweep(): Promise<void> {
    if (this.sweeping) {
      this.sweepAgain = true
      return
    }
    this.sweeping = true
    try {
      let ranAnything = false
      do {
        this.sweepAgain = false
        const pending: Array<{ projectId: string; itemId: string; item: InboxItemRecord }> = []
        for (const [projectId, bucket] of Object.entries(this.tree)) {
          for (const [itemId, item] of Object.entries(bucket ?? {})) {
            const key = `${projectId}/${itemId}`
            if (this.handled.has(key)) continue
            if (!item || typeof item !== 'object') continue
            if (item.status !== 'pending') {
              // Already terminal — remember it so we never look again.
              this.handled.add(key)
              continue
            }
            pending.push({ projectId, itemId, item })
          }
        }
        // Server timestamps make this ordering trustworthy across devices.
        pending.sort((a, b) => (asMs(a.item.createdAt) ?? 0) - (asMs(b.item.createdAt) ?? 0))
        for (const p of pending) await this.consume(p.projectId, p.itemId, p.item)
        if (pending.length > 0) ranAnything = true
      } while (this.sweepAgain)

      if (!this.purgedOnce && !ranAnything) {
        this.purgedOnce = true
        await this.purge()
      }
    } finally {
      this.sweeping = false
    }
  }

  private async consume(projectId: string, itemId: string, item: InboxItemRecord): Promise<void> {
    // Claim BEFORE doing anything. A reconnect re-delivers the whole pending
    // snapshot, and an image saved twice is a bug you only notice later.
    this.handled.add(`${projectId}/${itemId}`)

    const created = asMs(item.createdAt)
    if (created !== null && this.now - created > STALE_MS) {
      await this.ack(projectId, itemId, 'stale', 'Forge saw this too late')
      return
    }

    const project = this.host.listProjects().find((p) => safeKey(p.id) === projectId)
    if (!project) {
      await this.ack(projectId, itemId, 'failed', 'That project is not open in Forge any more')
      return
    }

    this.replyRoutes.set(itemId, projectId)
    this.setStatus({ lastInboxAt: this.now })

    if (item.kind === 'image') {
      await this.consumeImage(project, projectId, itemId, item)
      return
    }
    if (item.kind === 'message') {
      const text = String(item.text ?? '').trim()
      if (!text) {
        await this.ack(projectId, itemId, 'failed', 'Empty message')
        return
      }
      // The whole voice-pipeline hookup, in one line. See companion/README.md.
      this.host.emit({ type: 'utterance', projectId: project.id, projectName: project.name, itemId, text })
      await this.ack(projectId, itemId, 'done', `Sent to ${project.name}`)
      return
    }
    await this.ack(projectId, itemId, 'failed', `Unknown kind: ${String(item.kind)}`)
  }

  /**
   * An image from the phone becomes two things: a real file in the project's
   * `assets/inbox/`, and an entry on the screenshot shelf.
   *
   * Both, not either. The shelf is where Steve drags it into a prompt; the
   * project folder is where it still is next week, after the shelf has pruned
   * itself down to the newest twelve.
   */
  private async consumeImage(
    project: CompanionProjectInfo,
    projectId: string,
    itemId: string,
    item: InboxItemRecord
  ): Promise<void> {
    if (item.storagePath) {
      await this.ack(projectId, itemId, 'failed', 'Storage-backed images are not supported yet')
      return
    }
    const parsed = parseImageDataUrl(item.data)
    if (!parsed) {
      const size = typeof item.data === 'string' ? item.data.length : 0
      await this.ack(
        projectId,
        itemId,
        'failed',
        size > MAX_INLINE_BASE64 ? 'That image is too big to sync' : 'That image could not be read'
      )
      return
    }

    const dir = join(project.path, 'assets', 'inbox')
    const stem = safeFileStem(item.name, `phone-${itemId}`)
    const target = join(dir, `${stem}${extensionFor(parsed.mime)}`)
    try {
      mkdirSync(dir, { recursive: true })
      // tmp + rename would be nicer, but the shelf's adopt path copies the file
      // and a rename across the same directory is atomic enough for a write we
      // are about to read back ourselves.
      writeFileSync(target, parsed.bytes)
    } catch (err) {
      this.log('could not write inbox image:', describe(err))
      await this.ack(projectId, itemId, 'failed', 'Could not save that image')
      return
    }

    const adopted = this.host.adoptShots([target])
    this.host.emit({ type: 'image', projectId: project.id, itemId, paths: [target] })
    await this.ack(
      projectId,
      itemId,
      'done',
      adopted > 0 ? `On the tray in ${project.name}` : `Saved into ${project.name}`
    )
  }

  /** Terminal status + a short sentence the phone shows under the item. */
  private async ack(projectId: string, itemId: string, status: InboxItemRecord['status'], result: string): Promise<void> {
    const rest = this.rest
    if (!rest || !rest.uid) return
    try {
      await rest.patch(paths.inbox(rest.uid, projectId, itemId), {
        status,
        result: result.slice(0, 300),
        doneAt: SERVER_TIMESTAMP
      })
      const bucket = this.tree[projectId]
      if (bucket?.[itemId]) bucket[itemId].status = status
    } catch (err) {
      // Losing the ack is survivable: `handled` stops us re-running it in this
      // process, and the stale window stops the next process running it at all.
      this.noteError(err, 'ack')
    }
  }

  /** Once per link, delete inbox items that finished more than a day ago. */
  private async purge(): Promise<void> {
    const rest = this.rest
    if (!rest || !rest.uid) return
    const cutoff = this.now - PURGE_AGE_MS
    for (const [projectId, bucket] of Object.entries(this.tree)) {
      for (const [itemId, item] of Object.entries(bucket ?? {})) {
        const when = asMs(item?.doneAt) ?? asMs(item?.createdAt)
        if (when === null || when > cutoff) continue
        try {
          await rest.remove(paths.inbox(rest.uid, projectId, itemId))
          delete bucket[itemId]
        } catch (err) {
          this.log('purge failed (harmless):', describe(err))
        }
      }
    }
  }

  /* --------------------------------------------------------------- errors */

  private noteError(err: unknown, where: string): void {
    if (err instanceof RevokedError) {
      this.setStatus({ state: 'signed-out', configured: false, detail: 'Sign in again — the session was revoked' })
      return
    }
    if (err instanceof OfflineError) {
      this.setStatus({ state: 'offline', detail: '' })
      return
    }
    this.log(`${where} failed: ${describe(err)}`)
    this.setStatus({ state: 'error', detail: describe(err) })
  }
}

/* --------------------------------------------------------------- defaults */

export { EMPTY_CONFIG }
export type { CompanionConfig }
