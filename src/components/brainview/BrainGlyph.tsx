import type { ReactNode } from 'react'

/** Forge Brain's mark, small: a brain in outline with a bolt through it. Inherits `color`. */
export function BrainGlyph({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg
      className="bmap-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M11.2 4.6C10.4 3.4 8.6 3.1 7.4 4c-1.3-.2-2.6.8-2.7 2.2-1.3.5-2 2-1.5 3.3-.9.9-1 2.4-.2 3.4-.4 1.4.4 2.9 1.8 3.3.3 1.4 1.7 2.4 3.1 2.1.9 1 2.5 1.2 3.3.4" />
      <path d="M12.8 4.6c.8-1.2 2.6-1.5 3.8-.6 1.3-.2 2.6.8 2.7 2.2 1.3.5 2 2 1.5 3.3.9.9 1 2.4.2 3.4.4 1.4-.4 2.9-1.8 3.3-.3 1.4-1.7 2.4-3.1 2.1-.9 1-2.5 1.2-3.3.4" />
      <path d="M13.4 7.2 10.2 12.4h3.4l-2.6 5" strokeWidth={1.7} />
    </svg>
  )
}
