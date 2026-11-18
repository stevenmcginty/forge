import type { ReactNode } from 'react'

/**
 * The phone's own icon set: 24×24, a 1.8px round stroke, drawn in
 * `currentColor`, sized by the parent (`.pu-*` primitives set 16 or 20px) or by
 * `size`. The shared `@/components/Icon` is the desktop's 16px / 1.4px family,
 * which reads thin and grey at a thumb's distance; use this one for phone
 * chrome. Append a glyph here (one entry in PATHS) rather than inlining SVG in a
 * component, so the set stays one family (web/PHONE-DESIGN.md, "Icons").
 */
export type PhoneIconName =
  | 'more'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'close'
  | 'plus'
  | 'working'
  | 'done'
  | 'alert'
  | 'link-live'
  | 'link-quiet'
  | 'link-reconnecting'
  | 'link-asleep'

/** Filled shapes are listed with `fill`; everything else is stroked. */
const PATHS: Record<PhoneIconName, { d: string; fill?: true }[]> = {
  more: [
    { d: 'M5 10.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 1 0 0-3.6Z', fill: true },
    { d: 'M12 10.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 1 0 0-3.6Z', fill: true },
    { d: 'M19 10.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 1 0 0-3.6Z', fill: true }
  ],
  check: [{ d: 'M5 12.5l4.5 4.5L19 7.5' }],
  'chevron-down': [{ d: 'M7 10l5 5 5-5' }],
  'chevron-right': [{ d: 'M10 7l5 5-5 5' }],
  'chevron-left': [{ d: 'M14 7l-5 5 5 5' }],
  close: [{ d: 'M7 7l10 10M17 7L7 17' }],
  plus: [{ d: 'M12 5.5v13M5.5 12h13' }],
  /** A clock: the pane is working. */
  working: [{ d: 'M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16Z' }, { d: 'M12 8v4.2l2.8 1.8' }],
  /** A tick: finished, and you have not looked yet. */
  done: [{ d: 'M5 12.8l4.2 4.2L19 7.2' }],
  /** A triangle with a bar: something failed. */
  alert: [{ d: 'M12 4.5l8.5 15h-17Z' }, { d: 'M12 10v4.2M12 17v.1' }],
  /** Live: a filled core inside a ring. */
  'link-live': [{ d: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7Z', fill: true }, { d: 'M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 1 0 0-15Z' }],
  /** Quiet: the ring, empty — connected, but nothing has come through lately. */
  'link-quiet': [{ d: 'M12 5.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13Z' }],
  /** Reconnecting: a ring broken into three arcs (CSS may turn it). */
  'link-reconnecting': [
    { d: 'M12 5.5a6.5 6.5 0 0 1 5.6 3.2' },
    { d: 'M18.3 13.6a6.5 6.5 0 0 1-4.8 4.7' },
    { d: 'M9.6 18.1a6.5 6.5 0 0 1-3.9-7.4' }
  ],
  /** Asleep: a crescent moon. */
  'link-asleep': [{ d: 'M15.5 4.8a7.6 7.6 0 1 0 3.7 11.6A6.2 6.2 0 0 1 15.5 4.8Z', fill: true }]
}

export function PhoneIcon({
  name,
  size,
  className
}: {
  name: PhoneIconName
  /** Pixels. Omit to let CSS size it. */
  size?: number
  className?: string
}): ReactNode {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((p, i) => (
        <path key={i} d={p.d} fill={p.fill ? 'currentColor' : undefined} stroke={p.fill ? 'none' : undefined} />
      ))}
    </svg>
  )
}
