import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ChatViewState, ForgeApi } from '@shared/api'
import { CHATBOT_ORDER, CHATBOTS, type ChatBotId } from '@shared/chatbots'
import { MAX_TABS_PER_PROJECT } from '@shared/ipc'

/**
 * The renderer's half of chat tabs: the preload's `window.forge.chat` (guarded
 * — the desktop hot-reloads the renderer but not the preload, and a call to a
 * method the running preload lacks unmounts the whole renderer), each bot's
 * sign-in status as a hook, and opening a chat tab.
 */

type ChatApi = NonNullable<ForgeApi['chat']>

let warned = false

/** `window.forge.chat`, or null on a preload older than chat tabs. */
export function chatBridge(): ChatApi | null {
  const api = (window as unknown as { forge?: Partial<ForgeApi> }).forge?.chat ?? null
  if (!api && !warned) {
    warned = true
    console.error('[chat] window.forge.chat is missing — the preload is older than chat tabs. Restart Forge.')
  }
  return api
}

/* ------------------------------------------------------------- sign-in */

/** 'checking' until main has answered once. */
export type ChatSignIn = 'checking' | 'signed-in' | 'signed-out'

const status = new Map<ChatBotId, ChatSignIn>(CHATBOT_ORDER.map((bot) => [bot, 'checking']))
const listeners = new Set<() => void>()
let started = false

function notify(): void {
  for (const l of listeners) l()
}

function set(bot: ChatBotId, signedIn: boolean): void {
  const next: ChatSignIn = signedIn ? 'signed-in' : 'signed-out'
  if (status.get(bot) === next) return
  status.set(bot, next)
  notify()
}

/** Ask main for every bot once, then follow its pushes. Idempotent. */
function start(): void {
  if (started) return
  const api = chatBridge()
  if (!api) return
  started = true
  api.onStatus?.((e) => {
    if (e && CHATBOTS[e.bot]) set(e.bot, Boolean(e.signedIn))
  })
  refreshChatStatus()
}

/** Re-read every bot's status from main — after a sign-out, say. */
export function refreshChatStatus(): void {
  const api = chatBridge()
  for (const bot of CHATBOT_ORDER) {
    void api
      ?.status?.(bot)
      .then((s) => set(bot, s))
      .catch(() => undefined)
  }
}

/** One bot's sign-in status, live. */
export function useChatSignIn(bot: ChatBotId): ChatSignIn {
  useEffect(start, [])
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => status.get(bot) ?? 'checking'
  )
}

/** The words for a status. Never colour alone. */
export function signInWord(s: ChatSignIn): string {
  return s === 'signed-in' ? 'Signed in' : s === 'signed-out' ? 'Not signed in' : 'Checking…'
}

/* ------------------------------------------------------------ page state */

const EMPTY_STATE = { loading: false, canGoBack: false, error: '' }

/** What main last said about a chat page: loading, can go back, failed. */
export function useChatViewState(leafId: string): Omit<ChatViewState, 'leafId'> {
  const [state, setState] = useState(EMPTY_STATE)
  useEffect(() => {
    setState(EMPTY_STATE)
    return chatBridge()?.onViewState?.((s) => {
      if (s?.leafId === leafId) setState({ loading: Boolean(s.loading), canGoBack: Boolean(s.canGoBack), error: String(s.error ?? '') })
    })
  }, [leafId])
  return state
}

/* ------------------------------------------------------------- new chat */

/**
 * Open a chat tab in a project, through main's layout engine (`newChatTab`).
 * Refuses the tenth tab with the words the CLI path uses. Resolves to the new
 * tab's id, or null with the reason already shown through `notice`.
 */
export async function openChatTab(
  projectId: string,
  bot: ChatBotId,
  tabCount: number,
  notice: (message: string) => void
): Promise<string | null> {
  if (tabCount >= MAX_TABS_PER_PROJECT) {
    notice(`A project holds at most ${MAX_TABS_PER_PROJECT} tabs`)
    return null
  }
  const api = chatBridge()
  if (!api?.newTab) {
    notice('Restart Forge to open chat tabs')
    return null
  }
  try {
    const result = await api.newTab(projectId, bot)
    if (result.ok) return result.tabId
    notice(result.error)
  } catch (err) {
    notice(`Could not open ${CHATBOTS[bot].name}: ${err instanceof Error ? err.message : String(err)}`)
  }
  return null
}
