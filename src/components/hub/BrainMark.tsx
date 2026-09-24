import type { ReactNode } from 'react'
import type { AgentBrainId } from '@shared/agent-brain'

/**
 * Which voice agent, as a mark: one silhouette per maker, so a brain reads at
 * a glance even when the chip has shrunk to its icon.
 *
 *   Claude       an eight-ray burst
 *   Gemini       a four-point spark     (Gemini Live, Gemini CLI, Gemini Flash)
 *   OpenAI       a hexagon              (Codex, GPT Realtime, GPT Realtime mini)
 *   Groq         a bolt
 *   OpenRouter   one node branching to two
 *
 * The same shapes as Forge Web's voice bar, drawn on the desktop icons' 16px
 * grid. Monochrome on purpose: the mark takes the ink it sits in, so it never
 * fades on a light theme and colour never carries the meaning. The brain's
 * name is always in the row, the title and the accessible name.
 */
type Maker = 'claude' | 'gemini' | 'openai' | 'groq' | 'openrouter'

const MAKER: Record<AgentBrainId, Maker> = {
  claude: 'claude',
  'codex-cli': 'openai',
  'gemini-cli': 'gemini',
  'gemini-live': 'gemini',
  'gpt-realtime-mini': 'openai',
  'gpt-realtime': 'openai',
  'gemini-flash': 'gemini',
  groq: 'groq',
  openrouter: 'openrouter'
}

export function BrainMark({ brain, size = 14 }: { brain: AgentBrainId; size?: number }): ReactNode {
  const maker = MAKER[brain] ?? 'claude'
  return (
    <svg className="bmark" data-maker={maker} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {maker === 'claude' ? (
        <path
          d="M8 1.4V5.6M8 10.4V14.6M1.4 8H5.6M10.4 8H14.6M3.33 3.33 6.3 6.3M9.7 9.7 12.67 12.67M12.67 3.33 9.7 6.3M6.3 9.7 3.33 12.67"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      ) : maker === 'gemini' ? (
        <path d="M8 1C8.6 5.3 10.7 7.4 15 8 10.7 8.6 8.6 10.7 8 15 7.4 10.7 5.3 8.6 1 8 5.3 7.4 7.4 5.3 8 1Z" fill="currentColor" />
      ) : maker === 'openai' ? (
        <path d="M8 1.7 13.45 4.85V11.15L8 14.3 2.55 11.15V4.85Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      ) : maker === 'groq' ? (
        <path d="M9.4 1.2 3.2 9.1H7.5L6.6 14.8 12.8 6.9H8.5Z" fill="currentColor" strokeLinejoin="round" />
      ) : (
        <>
          <path d="M4.6 8C8 8 8 3.7 11 3.7M4.6 8C8 8 8 12.3 11 12.3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="3.4" cy="8" r="2" fill="currentColor" />
          <circle cx="12.6" cy="3.7" r="2" fill="currentColor" />
          <circle cx="12.6" cy="12.3" r="2" fill="currentColor" />
        </>
      )}
    </svg>
  )
}
