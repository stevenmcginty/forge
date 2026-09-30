import { useId, type ReactNode } from 'react'

/**
 * Forge Brain's mark on the phone and the deck: the desktop top bar's brain
 * glyph (src/components/brain/BrainGlyph.tsx) in its idle look, drawn still —
 * the brain, the ring round it and the spark on the ring. A copy, from the
 * same paths, because Forge Web does not import the desktop's components.
 *
 * Still on purpose: nothing moves in a picker or on the Listen chip, so reduced
 * motion has nothing to stop. The ink is the mark's own (currentColor), like
 * the Gemini and ChatGPT marks beside it; the core and the spark take the
 * accent. The agent's name is always beside it or in the accessible name.
 */

const LEFT =
  'M16 8.6C14.9 7.3 12.6 7.3 11.6 8.8C9.6 8.8 8.2 10.4 8.6 12.3C7.2 13.2 7 15.4 8.2 16.5C7.4 18.2 8.3 20.1 10 20.5C10.4 22.3 12.4 23.3 14.1 22.6C14.6 23.4 15.4 23.7 16 23.3'
const RIGHT =
  'M16 8.6C17.1 7.3 19.4 7.3 20.4 8.8C22.4 8.8 23.8 10.4 23.4 12.3C24.8 13.2 25 15.4 23.8 16.5C24.6 18.2 23.7 20.1 22 20.5C21.6 22.3 19.6 23.3 17.9 22.6C17.4 23.4 16.6 23.7 16 23.3'
const SILHOUETTE = `${LEFT}V8.6Z ${RIGHT}V8.6Z`
const GYRI =
  'M11.6 8.8C12.5 9.6 12.7 10.7 12.2 11.6M8.6 12.3C10 12.5 11.2 13.3 11.5 14.6M8.2 16.5C9.7 16.4 11 17 11.6 18.2M20.4 8.8C19.5 9.6 19.3 10.7 19.8 11.6M23.4 12.3C22 12.5 20.8 13.3 20.5 14.6M23.8 16.5C22.3 16.4 21 17 20.4 18.2'
const RING_FAR = 'M1.5 16A14.5 5 0 0 1 30.5 16'
const RING_NEAR = 'M30.5 16A14.5 5 0 0 1 1.5 16'
const TILT = 'rotate(-18 16 16)'

export function BrainGlyphMark({ size = 14, className }: { size?: number; className?: string }): ReactNode {
  const mask = `wbm${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <svg className={className} data-agent="forge-brain" width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
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
