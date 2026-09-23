import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  RealtimeGeminiTokenResult,
  RealtimeOpenAIConnectRequest,
  RealtimeOpenAIConnectResult,
  RealtimeScreenshotResult
} from '@shared/realtime'
import { getSettings } from '../store'
import { captureScreen } from '../voice-agent/ipc'
import { connectOpenAI, mintGeminiToken } from './tokens'

/**
 * The Electron half of the realtime voice brains — kept as thin as the voice
 * agent's (electron/voice-agent/ipc.ts): read the key from the store, hand it
 * to ./tokens.ts, return what came back. The audio itself never passes
 * through main; the renderer holds the WebRTC call or the WebSocket.
 */

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function registerRealtimeHandlers(): void {
  ipcMain.handle(
    IPC.realtimeOpenAIConnect,
    async (_e, req: RealtimeOpenAIConnectRequest): Promise<RealtimeOpenAIConnectResult> =>
      connectOpenAI(getSettings().openaiKey, req)
  )
  ipcMain.handle(
    IPC.realtimeGeminiToken,
    async (): Promise<RealtimeGeminiTokenResult> => mintGeminiToken(getSettings().geminiKey)
  )
  // The same capture the Claude brain's take_screenshot uses. The renderer
  // shrinks it before it goes up a data channel with a 256 KB message limit.
  ipcMain.handle(IPC.realtimeScreenshot, async (): Promise<RealtimeScreenshotResult> => {
    try {
      const shot = await captureScreen()
      return shot ? { ok: true, base64: shot.base64, mime: shot.mime } : { ok: false, error: 'The screen could not be captured' }
    } catch (err) {
      return { ok: false, error: `The screen could not be captured: ${errText(err)}` }
    }
  })
}
