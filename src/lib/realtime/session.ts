import type { RealtimeToolSpec } from '@shared/realtime'

/**
 * The provider-neutral shape of a live two-way voice session.
 *
 * Gemini Live (./gemini.ts, a WebSocket plus AudioWorklets) and GPT Realtime
 * (./openai.ts, WebRTC) both implement `RealtimeSession`; the voice hub
 * controller (src/state/VoiceHubController.tsx) only ever sees this. Types
 * only, so the check script can import it without a DOM.
 */

export type RealtimeProviderId = 'gemini-live' | 'gpt-realtime' | 'gpt-realtime-mini'

export type RealtimeState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'closed' | 'error'

export interface RealtimeCaption {
  /** Stable per utterance: a partial and its final share it. */
  id: string
  role: 'user' | 'assistant'
  text: string
  final: boolean
}

/** What a tool handler answers. `image` rides along as a follow-up input. */
export interface RealtimeToolAnswer {
  ok: boolean
  text: string
  image?: { mime: string; base64: string }
}

export interface RealtimeToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface RealtimeSessionEvents {
  onState(state: RealtimeState, detail?: string): void
  onCaption(caption: RealtimeCaption): void
  /** The model called a tool. The session awaits the answer and sends it back. */
  onToolCall(call: RealtimeToolCall): Promise<RealtimeToolAnswer>
  /** The provider cancelled a call it no longer wants answered. */
  onToolCancelled?(id: string): void
  /**
   * The session is about to hit a hard limit (OpenAI's 60 minutes, or a
   * Gemini connection that could not be resumed). The controller rolls over.
   */
  onExpiring(reason: string): void
}

export interface RealtimeSessionOptions {
  provider: RealtimeProviderId
  model: string
  voice: string
  instructions: string
  tools: RealtimeToolSpec[]
  events: RealtimeSessionEvents
}

export interface RealtimeSession {
  readonly provider: RealtimeProviderId
  /** Resolves once audio can flow; rejects with a one-line reason. */
  start(): Promise<void>
  stop(): void
  setMuted(muted: boolean): void
  /** Stop the assistant talking now. */
  interrupt(): void
  /** A typed turn, answered like a spoken one. */
  sendText(text: string): void
  /**
   * A note for the model ("discussion mode is on"). No reply unless
   * `respond` — the "go" note after a plan ran wants one.
   */
  sendContext(text: string, respond?: boolean): void
  /** 0–1, cheap to call every animation frame. */
  levels(): { mic: number; out: number }
}
