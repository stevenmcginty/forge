import type { MiniBarCall, MiniBarState } from '@shared/minibar'

/**
 * One part of the mini bar's host (src/state/MiniBarHost.tsx): a hook that
 * owns some fields of the published state and some of the view's calls.
 *
 *   slice    its fields, merged over the host's own on every publish.
 *   handle   offered every call before the host's own switch; true when it
 *            took the call, so nothing else runs it.
 *
 * voice.ts (dictation, Listen, the talk keys) and news.ts (events, toasts,
 * Peek, the chat with Forge) are the two parts.
 */
export interface MiniBarPart {
  slice: Partial<MiniBarState>
  handle(call: MiniBarCall): boolean
}
