import { useId, type CSSProperties, type ReactNode } from 'react'
import type { AgentBrainId } from '@shared/agent-brain'
import { AGENT_LOGOS, type AgentLogo } from '@shared/agent-logos'
import { GYRI, LEFT, RIGHT, RING_FAR, RING_NEAR, SILHOUETTE, TILT } from '../brain/BrainGlyph'

/**
 * Which voice agent, as a mark: the maker's own logo, so a brain reads at a
 * glance even when the chip has shrunk to its icon.
 *
 *   Claude       Anthropic's Claude spark   (shared/agent-logos.ts)
 *   Gemini       Google's Gemini sparkle    (Gemini Live, Gemini CLI, Gemini Flash)
 *   OpenAI       the OpenAI blossom         (Codex, GPT Realtime, GPT Realtime mini)
 *   Groq         a bolt        — Forge's drawing: agent-logos.ts carries no Groq mark
 *   OpenRouter   one node branching to two — Forge's drawing, for the same reason
 *   Forge Brain  the top bar's brain glyph (components/brain/BrainGlyph.tsx),
 *                idle and still: the brain, its ring and its spark
 *
 * The real marks are the ones every terminal's badge wears (AgentBadge), from
 * the same file, so Claude looks like Claude everywhere. A mark sits on a
 * round plate (`.mplate`, BrainPicker.css) washed in the maker's colour; the
 * plate reads that colour from `brandStyle`. Colour is the second cue only:
 * the shape is the identifier, and the brain's name is always in the row, the
 * title and the accessible name.
 */
type Maker = 'claude' | 'gemini' | 'openai' | 'groq' | 'openrouter' | 'forge'

const MAKER: Record<AgentBrainId, Maker> = {
  claude: 'claude',
  'codex-cli': 'openai',
  'gemini-cli': 'gemini',
  'gemini-live': 'gemini',
  'gpt-realtime-mini': 'openai',
  'gpt-realtime': 'openai',
  'gemini-flash': 'gemini',
  groq: 'groq',
  openrouter: 'openrouter',
  'forge-brain': 'forge'
}

/**
 * Forge Brain's mark: the top bar's glyph in its idle look, drawn still (no
 * spark going round, so nothing moves in a menu and reduced motion has nothing
 * to stop). The ink is the mark's own, like every other maker; the core and
 * the spark take the accent. Strokes are heavier than the 26px glyph's so it
 * holds at 13–20px.
 */
function ForgeBrainMark({ size }: { size: number }): ReactNode {
  const mask = `bm${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <svg className="bmark" data-maker="forge" width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
          <rect width="32" height="32" fill="#fff" />
          <path d={SILHOUETTE} fill="#000" stroke="#000" strokeWidth="2.6" />
        </mask>
      </defs>
      <path d={SILHOUETTE} style={{ fill: 'var(--accent)' }} opacity="0.16" />
      <g transform={TILT} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.6">
        <path d={RING_FAR} mask={`url(#${mask})`} />
      </g>
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d={LEFT} strokeWidth="2.6" />
        <path d={RIGHT} strokeWidth="2.6" />
        <path d="M16 8.6V23.3" strokeWidth="2.6" />
        <path d={GYRI} strokeWidth="1.9" opacity="0.8" />
      </g>
      <g transform={TILT} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.6">
        <path d={RING_NEAR} />
      </g>
      <g transform={TILT}>
        <circle cx="28.2" cy="18.6" r="2.4" style={{ fill: 'var(--accent)', stroke: 'var(--bg-base)' }} strokeWidth="0.8" />
      </g>
    </svg>
  )
}

const MAKER_LOGO: Partial<Record<Maker, AgentLogo>> = {
  claude: AGENT_LOGOS.claude,
  openai: AGENT_LOGOS.openai,
  gemini: AGENT_LOGOS.gemini
}

/**
 * A logo's brand colour, as the two custom properties a plate reads
 * (`--logo-on-dark` / `--logo-on-light`). Undefined for a monochrome brand,
 * which takes the theme's ink.
 */
export function logoStyle(logo: AgentLogo | null | undefined): CSSProperties | undefined {
  if (!logo?.color) return undefined
  return { '--logo-on-dark': logo.color.dark, '--logo-on-light': logo.color.light } as CSSProperties
}

/** The same, for a voice brain's maker. */
export function brandStyle(brain: AgentBrainId): CSSProperties | undefined {
  return logoStyle(MAKER_LOGO[MAKER[brain] ?? 'claude'])
}

/** A maker's real mark (shared/agent-logos.ts), in the ink of the plate it sits on. */
export function MakerLogo({ logo, size = 14 }: { logo: AgentLogo; size?: number }): ReactNode {
  return (
    <svg
      className="bmark bmark--logo"
      data-logo={logo.key}
      width={size}
      height={size}
      viewBox={logo.viewBox}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {logo.paths.map((path, i) => (
        <path key={i} d={path.d} data-ink={path.ink ? 'true' : undefined} fillRule={logo.evenOdd ? 'evenodd' : undefined} />
      ))}
    </svg>
  )
}

export function BrainMark({ brain, size = 14 }: { brain: AgentBrainId; size?: number }): ReactNode {
  const maker = MAKER[brain] ?? 'claude'
  if (maker === 'forge') return <ForgeBrainMark size={size} />
  const logo = MAKER_LOGO[maker]
  if (logo) return <MakerLogo logo={logo} size={size} />
  return (
    <svg className="bmark" data-maker={maker} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {maker === 'groq' ? (
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
