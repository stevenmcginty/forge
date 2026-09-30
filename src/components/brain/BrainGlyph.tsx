import { useId, type ReactNode } from 'react'
import { reducedMotion } from '@/lib/motion'

/**
 * Forge Brain's mark: a brain with a ring round it, and a spark going round
 * the ring. What it is doing is its shape, never its colour alone:
 *
 *   off        the brain in outline, quiet ink. No ring, no spark.
 *   starting   the ring is dashed, and the dashes march round.
 *   idle       the ring is whole, a lit core sits behind the brain, and the
 *              spark goes slowly round.
 *   busy       the brain turns from side to side, little bolts fly into it
 *              from outside, and the spark races.
 *   asking     as idle; the button adds a "!" badge (BrainButton).
 *   error      the brain in outline, no ring; the button adds an "×" badge.
 *
 * Under reduced motion nothing moves, but the states stay apart: busy keeps
 * its three bolts, drawn still beside the brain, and starting keeps its dashes.
 *
 * The ring passes behind the brain: its far half is masked by the brain's
 * silhouette, its near half is drawn over it.
 */

export type GlyphState = 'off' | 'starting' | 'idle' | 'busy' | 'asking' | 'error'

const LEFT =
  'M16 8.6C14.9 7.3 12.6 7.3 11.6 8.8C9.6 8.8 8.2 10.4 8.6 12.3C7.2 13.2 7 15.4 8.2 16.5C7.4 18.2 8.3 20.1 10 20.5C10.4 22.3 12.4 23.3 14.1 22.6C14.6 23.4 15.4 23.7 16 23.3'
const RIGHT =
  'M16 8.6C17.1 7.3 19.4 7.3 20.4 8.8C22.4 8.8 23.8 10.4 23.4 12.3C24.8 13.2 25 15.4 23.8 16.5C24.6 18.2 23.7 20.1 22 20.5C21.6 22.3 19.6 23.3 17.9 22.6C17.4 23.4 16.6 23.7 16 23.3'
/** Both halves as one closed shape, for the mask and the core. */
const SILHOUETTE = `${LEFT}V8.6Z ${RIGHT}V8.6Z`
const GYRI =
  'M11.6 8.8C12.5 9.6 12.7 10.7 12.2 11.6M8.6 12.3C10 12.5 11.2 13.3 11.5 14.6M8.2 16.5C9.7 16.4 11 17 11.6 18.2M20.4 8.8C19.5 9.6 19.3 10.7 19.8 11.6M23.4 12.3C22 12.5 20.8 13.3 20.5 14.6M23.8 16.5C22.3 16.4 21 17 20.4 18.2'

/** The ring, before its tilt: an ellipse round the centre, as two halves. */
const RING_FAR = 'M1.5 16A14.5 5 0 0 1 30.5 16'
const RING_NEAR = 'M30.5 16A14.5 5 0 0 1 1.5 16'
const RING_PATH = 'M1.5 16A14.5 5 0 1 1 30.5 16A14.5 5 0 1 1 1.5 16'
const TILT = 'rotate(-18 16 16)'

/** A bolt, centred on 0,0. */
const BOLT = 'M0.7-2.7-1.3 0.3H0.2L-0.7 2.7 1.3-0.3H-0.2Z'
/** Where each bolt lands, and where it flies in from (relative). */
const BOLTS = [
  { x: 8.6, y: 9.4, dx: -5.5, dy: -4.5 },
  { x: 25.2, y: 14, dx: 5.5, dy: -2 },
  { x: 9.4, y: 22.4, dx: -5, dy: 4.5 }
]

export function BrainGlyph({ state, size = 26 }: { state: GlyphState; size?: number }): ReactNode {
  const id = `bg${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const still = reducedMotion()
  const ring = state === 'idle' || state === 'busy' || state === 'asking' || state === 'starting'
  const spark = state === 'idle' || state === 'busy' || state === 'asking'
  const bolts = state === 'busy'

  return (
    <svg
      className="bglyph"
      data-state={state}
      data-still={still ? 'true' : undefined}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <mask id={`${id}-far`} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
          <rect width="32" height="32" fill="#fff" />
          <path d={SILHOUETTE} fill="#000" stroke="#000" strokeWidth="1.8" />
        </mask>
      </defs>

      {state !== 'off' && state !== 'error' ? <path className="bglyph__core" d={SILHOUETTE} /> : null}

      {ring ? (
        <g transform={TILT} className="bglyph__ring">
          <path d={RING_FAR} mask={`url(#${id}-far)`} />
        </g>
      ) : null}

      <g className="bglyph__brain">
        <path d={LEFT} />
        <path d={RIGHT} />
        <path className="bglyph__fissure" d="M16 8.6V23.3" />
        <path className="bglyph__gyri" d={GYRI} />
      </g>

      {ring ? (
        <g transform={TILT} className="bglyph__ring">
          <path d={RING_NEAR} />
        </g>
      ) : null}

      {spark ? (
        <g transform={TILT}>
          {still ? (
            <circle className="bglyph__spark" cx="28.2" cy="18.6" r="1.5" />
          ) : (
            <circle className="bglyph__spark" r="1.5">
              <animateMotion dur={state === 'busy' ? '1.6s' : '9s'} repeatCount="indefinite" path={RING_PATH} />
            </circle>
          )}
        </g>
      ) : null}

      {bolts
        ? BOLTS.map((b, i) => (
            <g key={i} transform={`translate(${b.x} ${b.y})`}>
              <path
                className="bglyph__bolt"
                d={BOLT}
                style={{ '--dx': `${b.dx}px`, '--dy': `${b.dy}px`, animationDelay: `${i * 0.42}s` } as React.CSSProperties}
              />
            </g>
          ))
        : null}
    </svg>
  )
}
