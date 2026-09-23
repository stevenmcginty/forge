import {
  BROWSER_MAX_SURFACES,
  isBrowserTabId,
  normaliseBrowserUrl,
  type BrowserAgentReply,
  type BrowserOwner,
  type BrowserSurfaceRecord
} from '@shared/browser'
import { badRef } from './snapshot'

/**
 * The seven tools' rules, over whatever actually drives the pages.
 *
 * This is where "many agents at once" is decided, and it is decided by what is
 * *absent*: there is no browser-wide lock. Every agent (a pane, the voice hub,
 * Steve) owns its own tabs, opens as many as it likes, and a call that names no
 * tab acts on the caller's own most recently used one — never somebody else's.
 * Naming another owner's tab by id is allowed, because browser_list shows every
 * tab with its owner and the user can see and use any of them.
 *
 * The one serialisation is **per tab**: two calls on the same page queue behind
 * each other, because interleaving a read with another caller's click on one
 * document is how refs point at the wrong thing. Calls on different tabs never
 * wait for each other.
 *
 * No Electron import: the driver is injected, so scripts/browser-check.mjs runs
 * these exact rules against a fake driver as well as the real one.
 */

export interface BrowserDriver {
  /** Every surface that exists, any owner, any project. */
  records: () => BrowserSurfaceRecord[]
  /** Create a surface for `owner` and load `url` in it. Resolves once the page has loaded (or failed to). */
  open: (owner: BrowserOwner, url: string, title: string, project: string) => Promise<{ id: string; text: string }>
  read: (id: string) => Promise<string>
  click: (id: string, ref: number) => Promise<string>
  type: (id: string, ref: number | null, text: string, submit: boolean) => Promise<string>
  navigate: (id: string, url: string) => Promise<string>
  /** A PNG on disk, or why not. */
  screenshot: (id: string, owner: BrowserOwner) => Promise<{ path: string } | { error: string }>
  close: (id: string) => Promise<boolean>
}

function fail(text: string, id?: string): BrowserAgentReply {
  return { ok: false, text, ...(id ? { id } : {}) }
}

function ok(text: string, id?: string, imagePath?: string): BrowserAgentReply {
  return { ok: true, text, ...(id ? { id } : {}), ...(imagePath ? { imagePath } : {}) }
}

function ownerWords(owner: BrowserOwner): string {
  return owner.agent && owner.label.toLowerCase() !== owner.agent ? `${owner.label} (${owner.agent})` : owner.label
}

export class BrowserAgentOps {
  private readonly driver: BrowserDriver
  private readonly projectFor: (owner: BrowserOwner) => string
  /** Each owner's most recently used tab: what a call with no `id` acts on. */
  private readonly lastUsed = new Map<string, string>()
  /** The tail of each tab's queue. Deleted when it drains. */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(driver: BrowserDriver, projectFor: (owner: BrowserOwner) => string = () => '') {
    this.driver = driver
    this.projectFor = projectFor
  }

  /** Run one tool call for `owner`. Never throws: every failure is a sentence. */
  async run(op: string, args: Record<string, unknown>, owner: BrowserOwner): Promise<BrowserAgentReply> {
    try {
      switch (op) {
        case 'browser_open':
          return await this.open(owner, args)
        case 'browser_list':
          return this.list(owner)
        case 'browser_read':
          return await this.onTab(owner, args, (id) => this.driver.read(id))
        case 'browser_click': {
          if (badRef(args['ref'])) return fail(`\`ref\` must be one of the numbers from your last browser_read — got ${JSON.stringify(args['ref'])}.`)
          const ref = Math.round(Number(args['ref']))
          return await this.onTab(owner, args, (id) => this.driver.click(id, ref))
        }
        case 'browser_type': {
          const text = typeof args['text'] === 'string' ? args['text'] : ''
          const submit = args['submit'] === true
          if (!text && !submit) return fail('`text` is required — there was nothing to type.')
          let ref: number | null = null
          if (args['ref'] !== undefined && args['ref'] !== null) {
            if (badRef(args['ref'])) return fail(`\`ref\` must be one of the numbers from your last browser_read — got ${JSON.stringify(args['ref'])}.`)
            ref = Math.round(Number(args['ref']))
          }
          return await this.onTab(owner, args, (id) => this.driver.type(id, ref, text, submit))
        }
        case 'browser_screenshot':
          return await this.screenshot(owner, args)
        case 'browser_close':
          return await this.close(owner, args)
        default:
          return fail(`Unknown browser tool: ${op}.`)
      }
    } catch (err) {
      return fail(`The browser could not do that: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async open(owner: BrowserOwner, args: Record<string, unknown>): Promise<BrowserAgentReply> {
    const { url, error } = normaliseBrowserUrl(String(args['url'] ?? ''))
    if (error) return fail(error)
    // An existing tab named explicitly is navigated instead of a new one opened.
    if (args['id'] !== undefined) {
      const target = this.resolve(owner, args['id'])
      if ('error' in target) return fail(target.error)
      return await this.onTab(owner, args, (id) => this.driver.navigate(id, url))
    }
    if (this.driver.records().length >= BROWSER_MAX_SURFACES) {
      return fail(
        `There are already ${BROWSER_MAX_SURFACES} browser tabs open. Close some you have finished with (browser_close) and try again — browser_list shows them.`
      )
    }
    const title = typeof args['title'] === 'string' ? args['title'].trim().slice(0, 120) : ''
    const opened = await this.driver.open(owner, url, title, this.projectFor(owner))
    this.lastUsed.set(owner.id, opened.id)
    return ok(opened.text, opened.id)
  }

  private list(owner: BrowserOwner): BrowserAgentReply {
    const all = this.driver.records()
    if (all.length === 0) return ok('No browser tabs are open. browser_open opens one of your own.')
    const current = this.lastUsed.get(owner.id)
    const mine = all.filter((r) => r.owner.id === owner.id)
    const lines = all.map((r) => {
      const whose = r.owner.id === owner.id ? 'yours' : `owned by ${ownerWords(r.owner)}`
      const star = r.id === current ? ' (your current tab)' : ''
      return `  • ${r.id} — ${r.title || '(untitled)'} — ${r.url} — ${whose}${star}`
    })
    return ok(
      [
        `${all.length} browser tab${all.length === 1 ? '' : 's'} open, ${mine.length} of them yours:`,
        ...lines,
        '',
        "Calls without an id act on your current tab. Pass another tab's id only when you mean to use that tab."
      ].join('\n')
    )
  }

  /** Which tab a call means. Explicit ids win; otherwise the caller's own current tab. */
  private resolve(owner: BrowserOwner, rawId: unknown): { id: string } | { error: string } {
    const all = this.driver.records()
    if (rawId !== undefined && rawId !== null && rawId !== '') {
      const id = String(rawId).trim()
      if (!isBrowserTabId(id) || !all.some((r) => r.id === id)) {
        const mine = all.filter((r) => r.owner.id === owner.id).map((r) => r.id)
        return {
          error: `There is no browser tab "${id}". ${mine.length ? `Your tabs: ${mine.join(', ')}.` : 'You have no tabs — browser_open opens one.'} browser_list shows every tab.`
        }
      }
      return { id }
    }
    const last = this.lastUsed.get(owner.id)
    if (last && all.some((r) => r.id === last && r.owner.id === owner.id)) return { id: last }
    const mine = all.filter((r) => r.owner.id === owner.id).sort((a, b) => b.updatedAt - a.updatedAt)
    if (mine[0]) return { id: mine[0].id }
    return { error: 'You have no browser tab open. Call browser_open with a url first — it gives you a tab of your own.' }
  }

  /** Resolve the tab, then run `work` in that tab's queue. */
  private async onTab(
    owner: BrowserOwner,
    args: Record<string, unknown>,
    work: (id: string) => Promise<string>
  ): Promise<BrowserAgentReply> {
    const target = this.resolve(owner, args['id'])
    if ('error' in target) return fail(target.error)
    const { id } = target
    this.touch(owner, id)
    const text = await this.queued(id, () => work(id))
    return ok(text, id)
  }

  private async screenshot(owner: BrowserOwner, args: Record<string, unknown>): Promise<BrowserAgentReply> {
    const target = this.resolve(owner, args['id'])
    if ('error' in target) return fail(target.error)
    const { id } = target
    this.touch(owner, id)
    const shot = await this.queued(id, () => this.driver.screenshot(id, owner))
    if ('error' in shot) return fail(shot.error, id)
    return ok(`Screenshot of tab ${id} saved to ${shot.path}`, id, shot.path)
  }

  private async close(owner: BrowserOwner, args: Record<string, unknown>): Promise<BrowserAgentReply> {
    const target = this.resolve(owner, args['id'])
    if ('error' in target) return fail(target.error)
    const { id } = target
    const record = this.driver.records().find((r) => r.id === id)
    const closed = await this.queued(id, () => this.driver.close(id))
    for (const [who, tab] of this.lastUsed) if (tab === id) this.lastUsed.delete(who)
    if (!closed) return fail(`Tab ${id} could not be closed.`, id)
    const whose = record && record.owner.id !== owner.id ? ` (it belonged to ${ownerWords(record.owner)})` : ''
    return ok(`Closed tab ${id}${whose}.`, id)
  }

  /** Remember the caller's current tab — only ever one of its own. */
  private touch(owner: BrowserOwner, id: string): void {
    if (this.driver.records().some((r) => r.id === id && r.owner.id === owner.id)) this.lastUsed.set(owner.id, id)
  }

  /** Per-tab FIFO. Different tabs never wait on each other. */
  private queued<T>(id: string, work: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(id) ?? Promise.resolve()
    const next = prev.then(work, work)
    const tail = next.catch(() => undefined)
    this.queues.set(id, tail)
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id)
    })
    return next
  }

  /** A tab was closed from outside (the user, the UI). */
  forget(id: string): void {
    for (const [who, tab] of this.lastUsed) if (tab === id) this.lastUsed.delete(who)
  }
}
