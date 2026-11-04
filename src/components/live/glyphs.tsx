import type { ReactNode } from 'react'

/**
 * The live surface's own small shapes. Every state is a word and one of these;
 * colour only agrees with them (Steve is red-green colourblind).
 *
 *   arc      working        a spinning arc
 *   eye      reading
 *   diamond  needs you      a diamond with a "!" cut through it
 *   check    done           a circled check
 *   square   stopped
 *   cross    failed
 *   dashed   waiting / next a dashed ring
 */

export type GlyphName =
  | 'arc'
  | 'eye'
  | 'diamond'
  | 'check'
  | 'tick'
  | 'square'
  | 'cross'
  | 'dashed'
  | 'speaker'
  | 'mic'
  | 'go'
  | 'up'
  | 'frame'
  | 'voice'
  | 'fold'
  | 'close'
  | 'warn'

const PATHS: Record<GlyphName, ReactNode> = {
  arc: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2.2" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </>
  ),
  eye: (
    <>
      <path d="M1.2 8S3.8 3.2 8 3.2 14.8 8 14.8 8 12.2 12.8 8 12.8 1.2 8 1.2 8z" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="8" cy="8" r="2.3" fill="currentColor" />
    </>
  ),
  diamond: (
    <>
      <path d="M8 1.2 14.8 8 8 14.8 1.2 8z" fill="currentColor" />
      <path d="M8 4.6v4.2M8 10.6v.6" style={{ stroke: 'var(--live-on-warn, #1a1208)' }} strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  check: (
    <>
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="m5 8.2 2.1 2.1L11.2 6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  tick: <path d="m3.6 8.4 3 3 5.8-6.4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />,
  square: <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.8" fill="currentColor" />,
  cross: (
    <>
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="m5.6 5.6 4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </>
  ),
  dashed: <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2.6 2.4" />,
  speaker: (
    <>
      <path d="M2 6h2.6L8 3v10L4.6 10H2z" fill="currentColor" />
      <path d="M10.4 5.4a3.6 3.6 0 0 1 0 5.2M12.4 3.6a6.2 6.2 0 0 1 0 8.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  mic: (
    <>
      <rect x="5.3" y="1.5" width="5.4" height="8.6" rx="2.7" fill="currentColor" />
      <path d="M3.2 7.6a4.8 4.8 0 0 0 9.6 0M8 12.4v2.3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  go: <path d="M3 8h9M8.6 4.4 12.2 8l-3.6 3.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  up: <path d="M8 13V3.5M4.2 7.2 8 3.4l3.8 3.8" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />,
  frame: (
    <path
      d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  voice: <path d="M3 6v4M6 3.5v9M9 5v6M12 6.5v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  fold: <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />,
  close: <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />,
  warn: (
    <>
      <path d="M8 1.8 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 6.2v3.6M8 11.6v.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  )
}

export function Glyph({ name, className }: { name: GlyphName; className?: string }): ReactNode {
  return (
    <svg className={className ? `live-glyph ${className}` : 'live-glyph'} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  )
}
