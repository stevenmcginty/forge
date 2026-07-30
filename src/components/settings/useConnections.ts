import { useEffect, useMemo, useState } from 'react'
import type { ClaudeCliState } from '@shared/types'
import { useApp } from '@/state/AppState'
import { maskKey } from './parts'
import type { ChipTone } from './parts'

/**
 * "Connected accounts" — one honest answer per service.
 *
 * The Account section and the account chip's menu both render this, so the
 * status dot on the chip and the list you open cannot disagree about whether
 * something is set up. Two of the four are deliberately placeholders: Forge
 * does not do OAuth and has no phone companion, and a card that says so is
 * better than an empty space that implies one is coming next week.
 */

export interface Connection {
  id: 'gemini' | 'google' | 'companion' | 'claude'
  name: string
  /** One line, always true. */
  detail: string
  chip: string
  tone: ChipTone
  /** Placeholders are shown but never counted as degraded. */
  placeholder?: boolean
  /** Which settings section fixes this one. */
  section?: 'models' | 'agents'
}

/** Probe the Claude CLI once per mount, and again when asked. */
export function useClaudeCli(): { state: ClaudeCliState | null; recheck: () => void } {
  const [state, setState] = useState<ClaudeCliState | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState(null)
    void window.forge.system.claudeVersion().then((s) => {
      if (!cancelled) setState(s)
    })
    return () => {
      cancelled = true
    }
  }, [nonce])

  return { state, recheck: () => setNonce((n) => n + 1) }
}

export function useConnections(claude: ClaudeCliState | null): {
  connections: Connection[]
  /** True when everything that *can* be configured is. */
  healthy: boolean
} {
  const { state } = useApp()
  const geminiKey = state.settings.geminiKey

  return useMemo(() => {
    const connections: Connection[] = [
      {
        id: 'gemini',
        name: 'Gemini API key',
        detail: geminiKey
          ? `key ${maskKey(geminiKey)} — the voice agent's brain`
          : 'no key stored — the voice agent falls back to offline commands',
        chip: geminiKey ? `set · ${geminiKey.slice(-4)}` : 'not set',
        tone: geminiKey ? 'ok' : 'warn',
        section: 'models'
      },
      {
        id: 'google',
        name: 'Google / Antigravity',
        detail: 'Signing in would let Forge reach Drive and Antigravity on your behalf. Not built yet.',
        chip: 'coming soon',
        tone: 'soon',
        placeholder: true
      },
      {
        id: 'companion',
        name: 'Phone companion',
        detail: 'Dictate into Forge from your phone, the way DictationMic does. Not built yet.',
        chip: 'coming soon',
        tone: 'soon',
        placeholder: true
      },
      {
        id: 'claude',
        name: 'Claude CLI',
        detail:
          claude === null
            ? 'checking…'
            : claude.ok
              ? `claude ${claude.version} on your PATH`
              : `claude could not be run — ${claude.error}`,
        chip: claude === null ? 'checking' : claude.ok ? claude.version : 'not found',
        tone: claude === null ? 'off' : claude.ok ? 'ok' : 'warn',
        section: 'agents'
      }
    ]

    const healthy = connections.every((c) => c.placeholder || c.tone === 'ok' || c.tone === 'off')
    return { connections, healthy }
  }, [geminiKey, claude])
}
