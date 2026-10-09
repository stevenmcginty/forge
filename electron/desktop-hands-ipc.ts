import { app } from 'electron'
import type { BrowserAgentReply } from '@shared/browser'
import type { ScreenLookResult } from '@shared/screen'
import { getDataDir } from './store'
import { captureScreen } from './voice-agent/ipc'
import {
  click,
  configureDesktopHands,
  formatWindowList,
  key,
  listWindows,
  look,
  pngSize,
  readWindow,
  type
} from './desktop-hands'

/**
 * The Electron half of ./desktop-hands.ts, and only that: the data dir, the
 * same primary-display capture take_screenshot uses, and Forge's own process
 * ids. Then the two doors in — the forge-bridge pipe ops (from
 * ./browser-panes/ipc.ts) and `window.forge.screen.look()` (from
 * ./realtime/ipc.ts, beside the realtime screenshot).
 */

let configured = false

export function ensureDesktopHands(): void {
  if (configured) return
  configured = true
  configureDesktopHands({
    dataDir: getDataDir(),
    capture: async () => {
      const shot = await captureScreen()
      if (!shot) return null
      const png = Buffer.from(shot.base64, 'base64')
      const size = pngSize(png)
      return size ? { png, ...size } : null
    },
    ownPids: () => app.getAppMetrics().map((m) => m.pid)
  })
}

/** `window.forge.screen.look()`. */
export async function screenLook(): Promise<ScreenLookResult> {
  ensureDesktopHands()
  return look()
}

/** One desktop op off the authenticated pipe. Always an answer in words. */
export async function desktopLinkOp(op: string, args: Record<string, unknown>): Promise<BrowserAgentReply> {
  ensureDesktopHands()
  try {
    switch (op) {
      case 'screen_look': {
        const res = await look()
        if (!res.ok) return { ok: false, text: res.error }
        let windows = ''
        try {
          windows = formatWindowList(await listWindows())
        } catch (err) {
          windows = `(the window list failed: ${err instanceof Error ? err.message : String(err)})`
        }
        const front = res.front ? `${res.front.app} — ${res.front.title}` : 'nothing (no window apart from Forge)'
        return {
          ok: true,
          imagePath: res.path,
          text: [
            `Saved a look at the screen: ${res.path} (${res.width}×${res.height}; window_click x,y are in this picture).`,
            `In front: ${front}.`,
            'Open windows, front first:',
            windows
          ].join('\n')
        }
      }
      case 'window_list': {
        const list = await listWindows()
        return { ok: true, text: `${formatWindowList(list)}\nUse a number or words from this list as window in window_read or window_key.` }
      }
      case 'window_read':
        return await readWindow({ window: args['window'] })
      case 'window_click':
        return await click({ ref: args['ref'], x: args['x'], y: args['y'] })
      case 'window_type':
        return await type({ ref: args['ref'], text: args['text'], enter: args['enter'] })
      case 'window_key':
        return await key({ keys: args['keys'], window: args['window'] })
      default:
        return { ok: false, text: `There is no desktop op called ${op}.` }
    }
  } catch (err) {
    return { ok: false, text: `The desktop tool failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
