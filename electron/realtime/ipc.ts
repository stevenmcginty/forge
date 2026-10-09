import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  RealtimeGeminiTokenResult,
  RealtimeOpenAIConnectRequest,
  RealtimeOpenAIConnectResult,
  RealtimeScreenshotResult
} from '@shared/realtime'
import { AGENT_BRAIN_TEST_CHANNEL, type BrainTestResult, type BrainTestTarget } from '@shared/agent-brain'
import { testBrain } from '../agent-brain-test'
import { getSettings } from '../store'
import type { ScreenLookResult } from '@shared/screen'
import type { BrowserAgentReply } from '@shared/browser'
import { captureScreen } from '../voice-agent/ipc'
import { desktopLinkOp, ensureDesktopHands, screenLook } from '../desktop-hands-ipc'
import { noteLook, pngSize } from '../desktop-hands'
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
  // Settings' Test buttons: one sentence per key or Agent brain, read-only probes.
  ipcMain.handle(AGENT_BRAIN_TEST_CHANNEL, async (_e, target: BrainTestTarget): Promise<BrainTestResult> => {
    try {
      return await testBrain(target, getSettings())
    } catch (err) {
      return { ok: false, reason: `The test could not run: ${errText(err)}` }
    }
  })
  // The same capture the Claude brain's take_screenshot uses. The renderer
  // shrinks it before it goes up a data channel with a 256 KB message limit.
  ipcMain.handle(IPC.realtimeScreenshot, async (): Promise<RealtimeScreenshotResult> => {
    try {
      const shot = await captureScreen()
      if (!shot) return { ok: false, error: 'The screen could not be captured' }
      // window_click x,y: the renderer scales them back to this picture's pixels.
      const size = pngSize(Buffer.from(shot.base64.slice(0, 64), 'base64'))
      if (size) noteLook(size.width, size.height)
      return { ok: true, base64: shot.base64, mime: shot.mime }
    } catch (err) {
      return { ok: false, error: `The screen could not be captured: ${errText(err)}` }
    }
  })
  // The mini bar's Screen button: the same capture, saved to a file, with the
  // app in front named (../desktop-hands.ts). Configuring the hands here, at
  // startup, also gives the voice agent's window_* tools Forge's process ids.
  ensureDesktopHands()
  ipcMain.handle(IPC.screenLook, async (): Promise<ScreenLookResult> => {
    try {
      return await screenLook()
    } catch (err) {
      return { ok: false, error: `The screen could not be captured: ${errText(err)}` }
    }
  })
  // The realtime voice agent's window_* tools: the same ops the forge-bridge
  // pipe answers, in words. desktopLinkOp never rejects.
  ipcMain.handle(
    IPC.desktopOp,
    async (_e, op: unknown, args: unknown): Promise<BrowserAgentReply> =>
      desktopLinkOp(String(op ?? ''), args && typeof args === 'object' ? (args as Record<string, unknown>) : {})
  )
}
