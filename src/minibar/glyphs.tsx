import type { CSSProperties, ReactNode } from 'react'
import type { AgentStatus } from '@shared/minibar'
import { AGENT_LOGOS, type AgentLogoKey } from '@shared/agent-logos'
import '@/components/AgentBadge.css'

/**
 * The mini bar's marks: the agent's maker logo, the seven state shapes, and
 * the handful of bar glyphs Icon.tsx does not carry (bell, speaker, tuck,
 * grip). Every state is a shape first; its colour only agrees with it.
 */

/* ------------------------------------------------------------------ logos */

/**
 * `brand` is the pane's agent profile id. A pure lookup, so the view never
 * needs the profile list: the built-in ids, plus the plain shells.
 */
const BRAND_LOGO: Record<string, AgentLogoKey> = {
  claude: 'claude',
  codex: 'openai',
  openai: 'openai',
  gemini: 'gemini',
  antigravity: 'antigravity',
  agy: 'antigravity',
  grok: 'grok',
  kimi: 'kimi',
  qwen: 'qwen',
  deepseek: 'deepseek',
  glm: 'zai',
  zai: 'zai',
  opencode: 'opencode',
  shell: 'shell',
  pwsh: 'shell',
  powershell: 'shell',
  cmd: 'shell',
  bash: 'shell',
  wsl: 'shell'
}

/** The maker's mark on its plate (AgentBadge.css), or two letters for a brand Forge has no logo for. */
export function AgentMark({ brand, size = 18 }: { brand: string; size?: number }): ReactNode {
  const key = BRAND_LOGO[brand.toLowerCase()]
  const box = { width: size, height: size, minWidth: size, padding: 0 } as CSSProperties
  if (!key) {
    return (
      <span className="agent-badge mb-mark" data-size="md" style={box} aria-hidden="true">
        {brand.slice(0, 2).toUpperCase()}
      </span>
    )
  }
  const logo = AGENT_LOGOS[key]
  const style = (
    logo.color ? { ...box, '--logo-on-dark': logo.color.dark, '--logo-on-light': logo.color.light } : box
  ) as CSSProperties
  return (
    <span
      className="agent-badge mb-mark"
      data-size="md"
      data-logo={logo.key}
      data-mono={logo.color ? undefined : 'true'}
      style={style}
      role="img"
      aria-label={logo.label}
    >
      <svg className="agent-badge__logo" viewBox={logo.viewBox} aria-hidden="true" focusable="false">
        {logo.paths.map((path, i) => (
          <path key={i} d={path.d} data-ink={path.ink ? 'true' : undefined} fillRule={logo.evenOdd ? 'evenodd' : undefined} />
        ))}
      </svg>
    </span>
  )
}

/* ----------------------------------------------------------------- states */

/**
 * Seven shapes, distinct in outline alone: a turning ring (Working), three
 * dots (Waiting), a question mark (Asking), a hollow ring (Idle), a dashed
 * ring (Starting), a tick (Done), a square (Stopped).
 */
export function StateMark({ status, size = 10 }: { status: AgentStatus; size?: number }): ReactNode {
  return (
    <svg className="mb-state" data-status={status} width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
      {status === 'working' ? (
        <>
          <circle cx="5" cy="5" r="3.7" fill="none" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.5" />
          <path className="mb-state__arc" d="M5 1.3 A3.7 3.7 0 0 1 8.7 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : null}
      {status === 'waiting' ? (
        <>
          <circle cx="1.6" cy="5" r="1.15" fill="currentColor" />
          <circle cx="5" cy="5" r="1.15" fill="currentColor" />
          <circle cx="8.4" cy="5" r="1.15" fill="currentColor" />
        </>
      ) : null}
      {status === 'asking' ? (
        <>
          <path d="M2.7 3.3 C2.8 1.8 3.8 0.9 5.1 0.9 C6.5 0.9 7.4 1.8 7.4 3 C7.4 4.6 5.1 4.8 5.1 6.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="5.1" cy="8.7" r="1.05" fill="currentColor" />
        </>
      ) : null}
      {status === 'idle' ? <circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.4" /> : null}
      {status === 'starting' ? (
        <circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="1.7 1.5" />
      ) : null}
      {status === 'done' ? (
        <path d="M1.3 5.4 L4 8 L8.9 2.3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
      {status === 'stopped' ? <rect x="1.5" y="1.5" width="7" height="7" rx="1.2" fill="currentColor" /> : null}
    </svg>
  )
}

/* ------------------------------------------------------------ bar glyphs */

function G({ children, size = 16 }: { children: ReactNode; size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export function GripGlyph(): ReactNode {
  return (
    <svg width="8" height="18" viewBox="0 0 8 18" aria-hidden="true" focusable="false">
      {[3, 7, 11, 15].map((y) => (
        <g key={y} fill="currentColor">
          <circle cx="2" cy={y} r="1.1" />
          <circle cx="6" cy={y} r="1.1" />
        </g>
      ))}
    </svg>
  )
}

export function BellGlyph(): ReactNode {
  return (
    <G>
      <path d="M4.1 11.2V7.3a3.9 3.9 0 0 1 7.8 0v3.9l1.2 1.3H2.9z" />
      <path d="M6.6 13.9a1.5 1.5 0 0 0 2.8 0" />
    </G>
  )
}

export function SpeakerGlyph({ on }: { on: boolean }): ReactNode {
  return (
    <G>
      <path d="M2.6 6.2h2.3L8.2 3.4v9.2L4.9 9.8H2.6z" />
      {/* Off: no waves, and a slash through the speaker. A shape, not a tint. */}
      {on ? (
        <>
          <path d="M10.4 6a2.8 2.8 0 0 1 0 4" />
          <path d="M12.2 4.3a5.2 5.2 0 0 1 0 7.4" />
        </>
      ) : (
        <path d="M2.2 13.8L13.8 2.2" strokeWidth={1.6} />
      )}
    </G>
  )
}

/** Tuck: the bar folds down to a line. */
export function TuckGlyph(): ReactNode {
  return (
    <G>
      <path d="M4 11.6h8" strokeWidth={1.8} />
    </G>
  )
}

export function OpenGlyph(): ReactNode {
  return (
    <G>
      <rect x="2.4" y="3.2" width="11.2" height="9.6" rx="1.6" />
      <path d="M2.4 6h11.2" />
    </G>
  )
}

export function QuitGlyph(): ReactNode {
  return (
    <G>
      <path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8" strokeWidth={1.6} />
    </G>
  )
}

export function ChatGlyph(): ReactNode {
  return (
    <G>
      <path d="M3 3.4h10a.9.9 0 0 1 .9.9v6a.9.9 0 0 1-.9.9H7.4L4.6 13.3v-2.1H3a.9.9 0 0 1-.9-.9v-6A.9.9 0 0 1 3 3.4z" />
    </G>
  )
}

export function ListenGlyph({ muted }: { muted: boolean }): ReactNode {
  return (
    <G>
      <path d="M2.6 8h1.2M5.2 5.4v5.2M7.8 3.2v9.6M10.4 5.4v5.2M13 7v2" />
      {muted ? <path d="M2.4 13.6L13.6 2.4" strokeWidth={1.6} /> : null}
    </G>
  )
}

export function StopSquare(): ReactNode {
  return <span className="mb-stopsq" aria-hidden="true" />
}

export function TurnArc({ size = 14 }: { size?: number }): ReactNode {
  return (
    <svg className="mb-arc" width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <path d="M9 2.5A6.5 6.5 0 1 1 2.5 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
