import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentPresence, ClaudeCliState } from '@shared/types'
import { useApp } from '@/state/AppState'
import { maskKey } from './parts'
import type { ChipTone } from './parts'

/**
 * "Connected accounts" — one honest answer per service.
 *
 * The Account section and the account chip's menu both render this, so the
 * status dot on the chip and the list you open cannot disagree about whether
 * something is set up. Two of the entries are deliberately placeholders: Forge
 * does not do OAuth and has no phone companion, and a card that says so is
 * better than an empty space that implies one is coming next week.
 *
 * The CLI rows come from the same `probeAgents()` the first-run welcome uses —
 * there is one implementation of "is this command on PATH"
 * (electron/agent-probe.ts) and both surfaces read it, because the failure mode
 * of having two is that the welcome and Settings tell you different things
 * about the same machine.
 */

export interface Connection {
  id: string
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

export interface AgentProbe {
  /** Null until the first probe lands. */
  agents: AgentPresence[] | null
  /** `claude --version`, layered on top of the PATH probe. Null while checking. */
  claude: ClaudeCliState | null
  recheck: () => void
}

/**
 * Probe the machine once per mount, and again when asked.
 *
 * Both calls are cheap enough to sit behind a chip: probeAgents() only stats
 * files, and claudeVersion() no longer spawns anything unless that same probe
 * has already found `claude`.
 */
export function useAgentProbe(): AgentProbe {
  const [agents, setAgents] = useState<AgentPresence[] | null>(null)
  const [claude, setClaude] = useState<ClaudeCliState | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setAgents(null)
    setClaude(null)
    void window.forge.probeAgents().then((found) => {
      if (!cancelled) setAgents(found)
    })
    void window.forge.system.claudeVersion().then((s) => {
      if (!cancelled) setClaude(s)
    })
    return () => {
      cancelled = true
    }
  }, [nonce])

  const recheck = useCallback(() => setNonce((n) => n + 1), [])
  return { agents, claude, recheck }
}

export function useConnections(probe: AgentProbe): {
  connections: Connection[]
  /** True when everything that *can* be configured is. */
  healthy: boolean
} {
  const { state } = useApp()
  const geminiKey = state.settings.geminiKey
  const { agents, claude } = probe

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
      }
    ]

    if (agents === null) {
      connections.push({
        id: 'cli',
        name: 'Agent CLIs',
        detail: 'checking…',
        chip: 'checking',
        tone: 'off',
        section: 'agents'
      })
    } else {
      for (const agent of agents) {
        // Claude gets its version because we have it; the others get the resolved
        // path, which is the more useful fact when two installs are fighting
        // over PATH.
        const version = agent.id === 'claude' && claude?.ok ? claude.version : null
        connections.push({
          id: `cli:${agent.id}`,
          name: `${agent.name} CLI`,
          detail: agent.found
            ? `${agent.command} — ${version ? `version ${version}` : (agent.path ?? 'on your PATH')}`
            : `${agent.command} is not on your PATH — a pane using it opens onto "not recognized"`,
          chip: agent.found ? (version ?? 'installed') : 'not found',
          tone: agent.found ? 'ok' : 'warn',
          section: 'agents'
        })
      }
    }

    const healthy = connections.every((c) => c.placeholder || c.tone === 'ok' || c.tone === 'off')
    return { connections, healthy }
  }, [geminiKey, agents, claude])
}
