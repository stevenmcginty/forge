import type { BrowserAgentReply } from '@shared/browser'
import { CHATBOTS, chatBotFromWords, type ChatBotId } from '@shared/chatbots'
import {
  CHAT_READ_MAX_MESSAGES,
  CHAT_REPLY_QUIET_MS,
  CHAT_REPLY_WAIT_MS,
  CHAT_SEND_MAX,
  CHAT_TEXT_MAX,
  isChatTool
} from '@shared/chat-tools'
import type { Workspace } from '@shared/types'
import { focusScript, probeScript, readScript, sendScript, typeScript, type ChatMessage, type ChatProbe } from './page-scripts'

/**
 * An agent's chat_list / chat_send / chat_read (shared/chat-tools.ts), answered.
 *
 * Every caller — a pane agent over the bridge pipe, the brain, Foreman — lands
 * here through electron/browser-panes/service.ts, already resolved to the
 * project it works in. This file decides which chat tab a call means, opens one
 * when a bot is named and none exists, and drives the page through the scripts
 * in ./page-scripts.ts: type into the box, press send, wait for the reply to
 * stop moving, read it.
 *
 * No Electron in it: the page arrives as a `ChatPage` (./views.ts makes the
 * real one), the layout as injected functions — so scripts/chat-tools-check.mjs
 * drives this exact class. Answers in sentences and never throws: "the box
 * already holds words" is something an agent can act on.
 */

/** One chat page, as much of a WebContents as driving it needs. */
export interface ChatPage {
  /** Run a page script; rejects if the page does not answer. */
  run<T>(script: string): Promise<T>
  /** Electron's own text input into the focused element — the fallback for typing. */
  insertText(text: string): Promise<void>
  /** A real Enter key press — the fallback for sending. */
  pressEnter(): void
  load(url: string): Promise<void>
  /** Resolves when the page has stopped loading, or after `ms`. */
  settled(ms: number): Promise<void>
  url(): string
  alive(): boolean
}

export interface ChatAgentDeps {
  projects: () => Array<{ id: string; name: string }>
  /** A project's layout as it is now. */
  workspace: (projectId: string) => Workspace | null
  /** Add a chat tab for `bot` to a project without taking the screen. Answers the new chat's id. */
  openChatTab: (projectId: string, bot: ChatBotId) => { ok: true; leafId: string } | { ok: false; error: string }
  /** The chat's page, made (and loading) if it is not open yet. Null if it cannot be. */
  page: (leafId: string, bot: ChatBotId) => ChatPage | null
  /** The chat's page only if it is already open — chat_list never opens one. */
  openPage: (leafId: string) => { url: string; title: string } | null
  signedIn: (bot: ChatBotId) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** Who is asking, and where they work. */
export interface ChatCaller {
  /** The caller's own project ('' when it has none). */
  project: string
  /** The project on screen, the fallback. */
  screenProject: string
}

interface ChatRef {
  leafId: string
  bot: ChatBotId
  projectId: string
  projectName: string
}

/** How long a page gets to show its message box after it starts loading. */
const READY_MS = 25_000
/** How long the send button gets to become pressable after typing. */
const SEND_READY_MS = 4_000
/** How long a send gets to show it went (the box empties, the message appears). */
const SENT_MS = 6_000
const POLL_MS = 250
const REPLY_POLL_MS = 1_000

/** As much of electron/layout-engine.ts as opening a chat tab needs. */
export interface ChatLayout {
  workspace: (projectId: string) => Workspace
  apply: (
    projectId: string,
    op: { op: string; projectId: string; bot?: string; tabId?: string }
  ) => { ok: true; workspace: Workspace } | { ok: false; error: string }
}

/**
 * A chat tab an agent asked for: added to the project's strip, while the tab
 * Steve was on stays on screen — the page loads hidden (./views.ts
 * `agentPage`) and shows the moment he clicks its tab. Answers the new chat's id.
 */
export function openChatTabQuietly(
  layout: ChatLayout,
  projectId: string,
  bot: ChatBotId
): { ok: true; leafId: string } | { ok: false; error: string } {
  const was = layout.workspace(projectId).activeTabId
  const made = layout.apply(projectId, { op: 'newChatTab', projectId, bot })
  if (!made.ok) return { ok: false, error: made.error }
  const tab = made.workspace.tabs.find((t) => t.id === made.workspace.activeTabId)
  const leafId = tab?.root?.type === 'chat' ? tab.root.id : ''
  if (!leafId) return { ok: false, error: 'the new tab did not hold a chat.' }
  if (was && was !== tab?.id) layout.apply(projectId, { op: 'select-tab', projectId, tabId: was })
  return { ok: true, leafId }
}

const ok = (text: string): BrowserAgentReply => ({ ok: true, text })
const no = (text: string): BrowserAgentReply => ({ ok: false, text })

/** Letters and digits only, lower case — for "is this text in the box", whatever the editor did to spacing and marks. */
function bare(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function capText(text: string): string {
  if (text.length <= CHAT_TEXT_MAX) return text
  return `${text.slice(0, CHAT_TEXT_MAX)}\n\n[… ${text.length - CHAT_TEXT_MAX} more characters not shown]`
}

function quote(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class ChatAgentOps {
  private readonly deps: ChatAgentDeps
  /** One drive at a time per chat: two agents typing into one box would interleave. */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(deps: ChatAgentDeps) {
    this.deps = deps
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms))
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** One call. Never rejects. */
  async run(op: string, args: Record<string, unknown>, caller: ChatCaller): Promise<BrowserAgentReply> {
    if (!isChatTool(op)) return no(`There is no chat tool called ${op}.`)
    try {
      if (op === 'chat_list') return await this.list()
      if (op === 'chat_send') return await this.send(args, caller)
      return await this.read(args, caller)
    } catch (err) {
      return no(`${op} failed: ${errText(err)}`)
    }
  }

  /* ------------------------------------------------------------- the chats */

  private chats(): ChatRef[] {
    const out: ChatRef[] = []
    for (const p of this.deps.projects()) {
      for (const tab of this.deps.workspace(p.id)?.tabs ?? []) {
        const root = tab.root
        if (root?.type === 'chat') out.push({ leafId: root.id, bot: root.bot, projectId: p.id, projectName: p.name })
      }
    }
    return out
  }

  private describe(ref: ChatRef): string {
    return `${CHATBOTS[ref.bot].name} (chat ${ref.leafId}, project ${ref.projectName})`
  }

  /**
   * Which chat the words mean. An id is exact; a bot's name picks its tab in
   * the caller's project, then the one on screen, then any — and, when
   * `open` is set and there is none anywhere, opens one in the caller's project.
   */
  private resolve(words: unknown, caller: ChatCaller, open: boolean): { ref: ChatRef; opened: boolean } | { error: string } {
    const said = String(words ?? '').trim()
    const chats = this.chats()
    const listed = chats.length ? ` Chats open now: ${chats.map((c) => `${c.leafId} (${CHATBOTS[c.bot].name}, ${c.projectName})`).join(', ')}.` : ' No chat tabs are open.'
    if (!said) return { error: `Say which chat: a chat id from chat_list, or "gemini", "chatgpt" or "claude".${listed}` }

    const byId = chats.find((c) => c.leafId.toLowerCase() === said.toLowerCase())
    if (byId) return { ref: byId, opened: false }

    const bot = chatBotFromWords(said)
    if (!bot) return { error: `There is no chat called "${said}". Use a chat id from chat_list, or "gemini", "chatgpt" or "claude".${listed}` }

    const rank = (c: ChatRef): number => (c.projectId === caller.project ? 0 : c.projectId === caller.screenProject ? 1 : 2)
    const mine = chats.filter((c) => c.bot === bot).sort((a, b) => rank(a) - rank(b))
    if (mine[0]) return { ref: mine[0], opened: false }

    const name = CHATBOTS[bot].name
    if (!open) return { error: `There is no ${name} tab open in Forge.${listed}` }
    const projectId = caller.project || caller.screenProject
    const project = this.deps.projects().find((p) => p.id === projectId)
    if (!project) return { error: `There is no ${name} tab open, and no project to open one in. Nothing was sent.` }
    const made = this.deps.openChatTab(project.id, bot)
    if (!made.ok) return { error: `There is no ${name} tab open, and one could not be opened: ${made.error} Nothing was sent.` }
    return { ref: { leafId: made.leafId, bot, projectId: project.id, projectName: project.name }, opened: true }
  }

  /** Run `work` after every earlier drive of this chat has finished. */
  private queued<T>(leafId: string, work: () => Promise<T>): Promise<T> {
    const before = this.queues.get(leafId) ?? Promise.resolve()
    const next = before.catch(() => undefined).then(work)
    const tail = next.catch(() => undefined)
    this.queues.set(leafId, tail)
    void tail.then(() => {
      if (this.queues.get(leafId) === tail) this.queues.delete(leafId)
    })
    return next
  }

  private probe(page: ChatPage, bot: ChatBotId): Promise<ChatProbe> {
    return page.run<ChatProbe>(probeScript(CHATBOTS[bot].drive))
  }

  /** Wait for the page to load and show its message box. The last probe, box or not. */
  private async ready(page: ChatPage, bot: ChatBotId): Promise<ChatProbe | null> {
    const deadline = this.now() + READY_MS
    await page.settled(READY_MS)
    let last: ChatProbe | null = null
    while (this.now() < deadline) {
      if (!page.alive()) return null
      try {
        last = await this.probe(page, bot)
        if (last.composer) return last
      } catch {
        /* mid-navigation: ask again */
      }
      await this.sleep(POLL_MS * 2)
    }
    return last
  }

  private noBox(ref: ChatRef, page: ChatPage, probe: ChatProbe | null): string {
    const name = CHATBOTS[ref.bot].name
    const where = page.alive() ? ` It is on ${page.url() || 'a blank page'}${probe?.title ? ` ("${quote(probe.title, 60)}")` : ''}.` : ''
    return `${name}'s page shows no message box.${where} It may want a sign-in or a "Verify you are human" click — ask the user to look at the ${name} tab in Forge. Nothing was sent.`
  }

  /* ------------------------------------------------------------------ list */

  private async list(): Promise<BrowserAgentReply> {
    const chats = this.chats()
    if (!chats.length) {
      return ok('No chat tabs are open in Forge. chat_send with "gemini", "chatgpt" or "claude" opens one in your project.')
    }
    const bots = [...new Set(chats.map((c) => c.bot))]
    const signed = new Map<ChatBotId, boolean>()
    await Promise.all(bots.map(async (b) => signed.set(b, await this.deps.signedIn(b).catch(() => false))))
    const lines = chats.map((c) => {
      const open = this.deps.openPage(c.leafId)
      const page = open ? `on ${open.url || 'a blank page'}${open.title ? ` ("${quote(open.title, 60)}")` : ''}` : 'page not loaded yet'
      return `- ${c.leafId}: ${CHATBOTS[c.bot].name}, project ${c.projectName}, ${page}, ${signed.get(c.bot) ? 'signed in' : 'no sign-in seen'}`
    })
    return ok(`Chat tabs in Forge:\n${lines.join('\n')}`)
  }

  /* ------------------------------------------------------------------ send */

  private async send(args: Record<string, unknown>, caller: ChatCaller): Promise<BrowserAgentReply> {
    const text = String(args['text'] ?? '').replace(/\r\n?/g, '\n')
    if (!text.trim()) return no('Nothing was sent: `text` was empty.')
    if (text.length > CHAT_SEND_MAX) return no(`Nothing was sent: the message is ${text.length} characters, over the ${CHAT_SEND_MAX} a chat box takes. Shorten it, or send it in parts.`)

    const found = this.resolve(args['chat'], caller, true)
    if ('error' in found) return no(found.error)
    const { ref, opened } = found
    const wait = args['wait'] !== false
    const fresh = args['new_chat'] === true
    return this.queued(ref.leafId, () => this.drive(ref, text, { wait, fresh, opened }))
  }

  private async drive(ref: ChatRef, text: string, how: { wait: boolean; fresh: boolean; opened: boolean }): Promise<BrowserAgentReply> {
    const name = CHATBOTS[ref.bot].name
    const page = this.deps.page(ref.leafId, ref.bot)
    if (!page) return no(`The ${name} page could not be opened. Nothing was sent.`)
    if (how.fresh) await page.load(CHATBOTS[ref.bot].homeUrl)

    const start = await this.ready(page, ref.bot)
    if (!start?.composer) return no(this.noBox(ref, page, start))

    // Steve's own half-written message is his: never typed over, never sent.
    if (start.draft && bare(start.draft) !== bare(text)) {
      return no(`The ${name} box already holds unsent words ("${quote(start.draft)}"). Nothing was sent — ask the user to send or clear them first.`)
    }
    if (!start.draft) {
      const typed = await this.type(page, ref.bot, text)
      if (!typed) return no(`Could not type into ${name}'s message box. Nothing was sent — ask the user to look at the ${name} tab.`)
    }

    const before = await this.probe(page, ref.bot)
    const sent = await this.press(page, ref.bot, before)
    if (!sent) {
      return no(`Typed the message into ${name}'s box, but it would not send — the words are waiting there. Ask the user to press send on the ${name} tab.`)
    }

    const signedIn = await this.deps.signedIn(ref.bot).catch(() => true)
    const note = signedIn ? '' : `\n(Forge sees no ${name} sign-in, so this chat may not be saved to the user's account. They can sign in from Settings → Chatbots.)`
    const head = `Sent to ${this.describe(ref)}${how.opened ? ', in a chat tab opened for it' : ''}${how.fresh ? ', as a new conversation' : ''}.`
    if (!how.wait) return ok(`${head} Not waiting for the reply: chat_read "${ref.leafId}" collects it.${note}`)

    const reply = await this.awaitReply(page, ref.bot, before)
    if (reply.done) return ok(`${head} ${name} replied:\n\n${capText(reply.text)}${note}`)
    if (reply.text) {
      return ok(`${head} ${name} is still writing after ${CHAT_REPLY_WAIT_MS / 1000} seconds. So far:\n\n${capText(reply.text)}\n\nchat_read "${ref.leafId}" collects the rest.${note}`)
    }
    return ok(`${head} No reply has started yet. chat_read "${ref.leafId}" collects it later.${note}`)
  }

  /** Type into the box, and check it landed. The page's own editing command first, Electron's input second. */
  private async type(page: ChatPage, bot: ChatBotId, text: string): Promise<boolean> {
    const want = bare(text).slice(0, 60)
    const landed = (box: string | null): boolean => !!box && bare(box).includes(want)
    const drive = CHATBOTS[bot].drive
    try {
      if (landed(await page.run<string | null>(typeScript(drive, text)))) return true
    } catch {
      /* try the other road */
    }
    try {
      const probe = await this.probe(page, bot)
      // A first try that half-landed is not typed twice.
      if (probe.draft) return landed(probe.draft)
      if (!(await page.run<boolean>(focusScript(drive)))) return false
      await page.insertText(text)
      await this.sleep(POLL_MS)
      return landed((await this.probe(page, bot)).draft)
    } catch {
      return false
    }
  }

  /** Press send, and check it went: the box emptied, a message or a reply appeared, or the bot is busy. */
  private async press(page: ChatPage, bot: ChatBotId, before: ChatProbe): Promise<boolean> {
    const went = (p: ChatProbe): boolean => !p.draft || p.users > before.users || p.replies > before.replies || (p.busy && !before.busy)
    const watch = async (ms: number): Promise<boolean> => {
      const deadline = this.now() + ms
      while (this.now() < deadline) {
        await this.sleep(POLL_MS)
        try {
          if (went(await this.probe(page, bot))) return true
        } catch {
          /* a send can navigate (a new chat gets its own address): ask again */
        }
      }
      return false
    }

    // A send button often stays disabled for a beat after the words land.
    const deadline = this.now() + SEND_READY_MS
    let probe = before
    while (!probe.canSend && this.now() < deadline) {
      await this.sleep(POLL_MS)
      probe = await this.probe(page, bot)
    }
    const how = await page.run<string>(sendScript(CHATBOTS[bot].drive))
    if (how === 'none') return false
    if (await watch(SENT_MS)) return true
    page.pressEnter()
    return watch(SENT_MS)
  }

  /** Wait for a reply that is new since `before` to finish: nothing busy, and its text still for a while. */
  private async awaitReply(page: ChatPage, bot: ChatBotId, before: ChatProbe): Promise<{ done: boolean; text: string }> {
    const deadline = this.now() + CHAT_REPLY_WAIT_MS
    let text = ''
    let since = this.now()
    while (this.now() < deadline) {
      await this.sleep(REPLY_POLL_MS)
      if (!page.alive()) return { done: false, text }
      let p: ChatProbe
      try {
        p = await this.probe(page, bot)
      } catch {
        continue
      }
      const started = p.replies > before.replies || (!!p.lastReply && p.lastReply !== before.lastReply)
      if (!started) continue
      if (p.lastReply !== text) {
        text = p.lastReply
        since = this.now()
      }
      if (text && !p.busy && this.now() - since >= CHAT_REPLY_QUIET_MS) return { done: true, text }
    }
    return { done: false, text }
  }

  /* ------------------------------------------------------------------ read */

  private async read(args: Record<string, unknown>, caller: ChatCaller): Promise<BrowserAgentReply> {
    const found = this.resolve(args['chat'], caller, false)
    if ('error' in found) return no(found.error)
    const { ref } = found
    const name = CHATBOTS[ref.bot].name
    const raw = args['messages']
    const count = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(CHAT_READ_MAX_MESSAGES, Math.max(1, Math.floor(raw))) : 0

    return this.queued(ref.leafId, async () => {
      const page = this.deps.page(ref.leafId, ref.bot)
      if (!page) return no(`The ${name} page could not be opened.`)
      const probe = await this.ready(page, ref.bot)
      const busy = probe?.busy ? `\n(${name} is still writing — read again in a moment for the rest.)` : ''
      const shot = await page.run<{ messages: ChatMessage[]; page: string }>(readScript(CHATBOTS[ref.bot].drive, count || CHAT_READ_MAX_MESSAGES))
      if (!shot.messages.length) {
        if (!shot.page) return ok(`${this.describe(ref)} has no messages yet.`)
        return ok(`${this.describe(ref)}: no messages found by their usual marks. The page says:\n\n${capText(shot.page)}`)
      }
      if (!count) {
        const last = [...shot.messages].reverse().find((m) => m.role === 'bot')
        if (!last) return ok(`${this.describe(ref)} has no reply yet.${busy}`)
        return ok(`${this.describe(ref)}, latest reply:\n\n${capText(last.text)}${busy}`)
      }
      const body = shot.messages.map((m) => `${m.role === 'user' ? 'User' : name}:\n${m.text}`).join('\n\n')
      return ok(`${this.describe(ref)}, last ${shot.messages.length} message${shot.messages.length === 1 ? '' : 's'}:\n\n${capText(body)}${busy}`)
    })
  }
}
