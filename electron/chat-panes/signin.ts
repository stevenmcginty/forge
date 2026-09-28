import { session as electronSession, type Cookie, type Session } from 'electron'
import { BROWSER_PARTITION } from '@shared/browser'
import { CHATBOT_ORDER, CHATBOTS, type ChatBotCookie, type ChatBotId } from '@shared/chatbots'
import type { ChatStatusEvent } from '@shared/api'

/**
 * Is Forge signed in to each chatbot — and signing out of one.
 *
 * "Signed in" is read off the cookies in the browser's `persist:forge-browser`
 * session, the one every chat page and browser tab shares: any cookie named in
 * CHATBOTS[bot].signIn that is present and not expired. The cookie names are
 * data in shared/chatbots.ts, best-known values rather than a contract with
 * the sites, so a wrong answer here is a one-line fix there.
 *
 * Nothing here reads a page or a cookie's value — only names and expiry.
 */

const DEBOUNCE_MS = 400

function ses(): Session {
  return electronSession.fromPartition(BROWSER_PARTITION)
}

/** Does this cookie's domain fall under `domain` (".google.com" and "google.com" both cover "accounts.google.com")? */
function underDomain(cookieDomain: string | undefined, domain: string): boolean {
  const c = (cookieDomain ?? '').replace(/^\./, '').toLowerCase()
  const d = domain.replace(/^\./, '').toLowerCase()
  return c === d || c.endsWith(`.${d}`)
}

function matches(cookie: Cookie, rule: ChatBotCookie): boolean {
  if (!underDomain(cookie.domain, rule.domain)) return false
  if (rule.name !== undefined && cookie.name !== rule.name) return false
  if (rule.prefix !== undefined && !cookie.name.startsWith(rule.prefix)) return false
  return rule.name !== undefined || rule.prefix !== undefined
}

function live(cookie: Cookie): boolean {
  return cookie.session || cookie.expirationDate === undefined || cookie.expirationDate * 1000 > Date.now()
}

/** Signed in to this bot in Forge's browser session? */
export async function chatStatus(bot: ChatBotId): Promise<boolean> {
  const rules = CHATBOTS[bot].signIn.cookies
  const domains = [...new Set(rules.map((r) => r.domain.replace(/^\./, '')))]
  for (const domain of domains) {
    const cookies = await ses().cookies.get({ domain })
    if (cookies.some((c) => live(c) && rules.some((r) => matches(c, r)))) return true
  }
  return false
}

/**
 * Sign out of one bot in Forge: every cookie under its sign-out domains goes.
 * Signing out of Gemini is signing out of Google — the Settings row says so.
 */
export async function chatSignOut(bot: ChatBotId): Promise<void> {
  const cookies = ses().cookies
  for (const domain of CHATBOTS[bot].signOutDomains) {
    const list = await cookies.get({ domain })
    for (const c of list) {
      const host = (c.domain ?? domain).replace(/^\./, '')
      const url = `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`
      await cookies.remove(url, c.name).catch(() => undefined)
    }
  }
  await cookies.flushStore().catch(() => undefined)
}

/**
 * Push a bot's status whenever its cookies change, debounced — a sign-in sets
 * a dozen cookies at once. Only changes are pushed. Returns the unsubscribe.
 */
export function watchChatStatus(push: (event: ChatStatusEvent) => void): () => void {
  const known = new Map<ChatBotId, boolean>()
  const dirty = new Set<ChatBotId>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = async (): Promise<void> => {
    timer = null
    const bots = [...dirty]
    dirty.clear()
    for (const bot of bots) {
      const signedIn = await chatStatus(bot).catch(() => known.get(bot) ?? false)
      if (known.get(bot) === signedIn) continue
      known.set(bot, signedIn)
      push({ bot, signedIn })
    }
  }

  const onChanged = (_e: unknown, cookie: Cookie): void => {
    for (const bot of CHATBOT_ORDER) {
      const entry = CHATBOTS[bot]
      const touched =
        entry.signIn.cookies.some((r) => underDomain(cookie.domain, r.domain)) ||
        entry.signOutDomains.some((d) => underDomain(cookie.domain, d))
      if (touched) dirty.add(bot)
    }
    if (dirty.size && !timer) timer = setTimeout(() => void flush(), DEBOUNCE_MS)
  }

  // Seed what is known, so the first push is a real change.
  for (const bot of CHATBOT_ORDER) {
    void chatStatus(bot)
      .then((s) => {
        if (!known.has(bot)) known.set(bot, s)
      })
      .catch(() => undefined)
  }
  const cookies = ses().cookies
  cookies.on('changed', onChanged)
  return () => {
    if (timer) clearTimeout(timer)
    cookies.off('changed', onChanged)
  }
}
