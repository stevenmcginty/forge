import type { ReactNode } from 'react'

/**
 * A tiny hand-drawn icon set. Everything is 16×16 on a 1.4px stroke so the
 * chrome reads as one family, and nothing is loaded from the network.
 */

export type IconName =
  | 'forge'
  | 'panel'
  | 'plus'
  | 'close'
  | 'splitRight'
  | 'splitDown'
  | 'folder'
  | 'folderPlus'
  | 'gear'
  | 'dots'
  | 'restart'
  | 'chevronDown'
  | 'terminal'
  | 'camera'
  | 'clipboard'
  | 'grip'
  | 'check'
  | 'trash'
  | 'voice'
  | 'send'
  | 'viewTabs'
  | 'viewMosaic'
  | 'chevronLeft'
  | 'expand'
  | 'user'
  | 'key'
  | 'palette'
  | 'mic'
  | 'panelRight'
  | 'phone'
  | 'globe'
  | 'chevronRight'
  | 'branch'
  | 'file'
  | 'history'
  | 'refresh'
  | 'note'
  | 'pin'

const PATHS: Record<IconName, ReactNode> = {
  // A struck anvil: the mark.
  forge: (
    <>
      <path d="M2.5 6.5h7l2.5 2 1.5-1.2v3.2H4.8z" />
      <path d="M6.2 10.5v2.2M4 13.2h5" />
    </>
  ),
  panel: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.6" />
      <path d="M6.4 3v10" />
    </>
  ),
  plus: <path d="M8 3.6v8.8M3.6 8h8.8" />,
  close: <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />,
  splitRight: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.6" />
      <path d="M8 3v10" />
    </>
  ),
  splitDown: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.6" />
      <path d="M2 8h12" />
    </>
  ),
  folder: <path d="M2.2 4.6h3.6l1.2 1.4h6.8v5.6a.8.8 0 0 1-.8.8H3a.8.8 0 0 1-.8-.8z" />,
  // A folder with a plus on the flap: make a brand-new project folder.
  folderPlus: (
    <>
      <path d="M2.2 4.6h3.6l1.2 1.4h6.8v5.6a.8.8 0 0 1-.8.8H3a.8.8 0 0 1-.8-.8z" />
      <path d="M8 7.3v3.4M6.3 9h3.4" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6M4 4l1.1 1.1M10.9 10.9L12 12M12 4l-1.1 1.1M5.1 10.9L4 12" />
    </>
  ),
  dots: (
    <>
      <circle cx="4" cy="8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
  restart: (
    <>
      <path d="M13 8a5 5 0 1 1-1.7-3.8" />
      <path d="M13.2 2.6v2.6h-2.6" />
    </>
  ),
  chevronDown: <path d="M4.4 6.4L8 10l3.6-3.6" />,
  terminal: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.6" />
      <path d="M5 6.6l1.7 1.6L5 9.8M8.6 10.2h3" />
    </>
  ),
  camera: (
    <>
      <path d="M2.4 5.8h2.4l.9-1.3h4.6l.9 1.3h2.4v6.2a.7.7 0 0 1-.7.7H3.1a.7.7 0 0 1-.7-.7z" />
      <circle cx="8" cy="9" r="2" />
    </>
  ),
  clipboard: (
    <>
      <rect x="3.2" y="3.4" width="9.6" height="10.4" rx="1.4" />
      <path d="M6 3.4V2.6h4v.8M6 7.4h4M6 9.8h3" />
    </>
  ),
  grip: (
    <>
      <circle cx="6" cy="4" r=".85" fill="currentColor" stroke="none" />
      <circle cx="10" cy="4" r=".85" fill="currentColor" stroke="none" />
      <circle cx="6" cy="8" r=".85" fill="currentColor" stroke="none" />
      <circle cx="10" cy="8" r=".85" fill="currentColor" stroke="none" />
      <circle cx="6" cy="12" r=".85" fill="currentColor" stroke="none" />
      <circle cx="10" cy="12" r=".85" fill="currentColor" stroke="none" />
    </>
  ),
  check: <path d="M3.6 8.4l2.9 2.8 5.9-6.4" />,
  trash: (
    <>
      <path d="M3.4 5.2h9.2M6.2 5.2V3.8h3.6v1.4" />
      <path d="M4.6 5.2l.6 7.4h5.6l.6-7.4" />
    </>
  ),
  // A spoken waveform: the voice agent's mark.
  voice: (
    <>
      <path d="M2.4 7.2v1.6M5.2 5v6M8 2.8v10.4M10.8 5v6M13.6 7.2v1.6" />
    </>
  ),
  send: <path d="M2.8 8h8.4M7.8 4.6L11.4 8l-3.6 3.4" />,
  // One window with a tab on it: the working view.
  viewTabs: (
    <>
      <path d="M2.2 5.4V4.1a.7.7 0 0 1 .7-.7h3.4l.9 1.2" />
      <rect x="2.2" y="5.4" width="11.6" height="7.2" rx="1.3" />
    </>
  ),
  // Four little windows: the mosaic.
  viewMosaic: (
    <>
      <rect x="2.3" y="2.3" width="5" height="5" rx="1.1" />
      <rect x="8.7" y="2.3" width="5" height="5" rx="1.1" />
      <rect x="2.3" y="8.7" width="5" height="5" rx="1.1" />
      <rect x="8.7" y="8.7" width="5" height="5" rx="1.1" />
    </>
  ),
  chevronLeft: <path d="M9.6 4.4L6 8l3.6 3.6" />,
  expand: (
    <>
      <path d="M9.6 2.6h3.8v3.8M13.4 2.6L8.5 7.5" />
      <path d="M6.4 13.4H2.6V9.6M2.6 13.4l4.9-4.9" />
    </>
  ),
  // A handset: this pane can be driven from the Claude app.
  phone: (
    <>
      <rect x="4.4" y="1.8" width="7.2" height="12.4" rx="1.6" />
      <path d="M6.9 3.7h2.2" />
      <circle cx="8" cy="11.9" r=".75" fill="currentColor" stroke="none" />
    </>
  ),
  user: (
    <>
      <circle cx="8" cy="5.8" r="2.6" />
      <path d="M3 13.4a5 5 0 0 1 10 0" />
    </>
  ),
  // A globe: the same terminals, from anywhere. The meridian is an ellipse
  // rather than a straight line because at 16px a straight one reads as a clock
  // hand, and this glyph sits directly under the handset in the sidebar.
  globe: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M2.2 8h11.6" />
      <ellipse cx="8" cy="8" rx="2.6" ry="5.8" />
    </>
  ),
  // A key: the section where credentials live.
  key: (
    <>
      <circle cx="5.4" cy="5.4" r="2.8" />
      <path d="M7.4 7.4L13 13M11 11l-1.4 1.4M12.4 9.6l-1.2 1.2" />
    </>
  ),
  // A microphone: the voice agent you talk to. Deliberately not the waveform —
  // that mark belongs to the dictation pill, and two different things wearing
  // the same glyph is how you end up with three unlabelled buttons.
  mic: (
    <>
      <rect x="6" y="2.2" width="4" height="7.2" rx="2" />
      <path d="M3.8 7.6a4.2 4.2 0 0 0 8.4 0M8 11.8v1.9M5.8 13.7h4.4" />
    </>
  ),
  // A panel hinged on the right. Unused since the voice panel was deleted —
  // kept because it is the obvious glyph the day something else needs it.
  panelRight: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.6" />
      <path d="M9.6 3v10" />
    </>
  ),
  // Swatches: appearance.
  palette: (
    <>
      <rect x="2.4" y="2.4" width="5" height="5" rx="1.1" />
      <rect x="8.6" y="2.4" width="5" height="5" rx="1.1" />
      <rect x="2.4" y="8.6" width="11.2" height="5" rx="1.1" />
    </>
  ),
  // The closed twin of chevronDown. A rail section rotates one of these rather
  // than swapping glyphs, so the two must be the same arrow at two angles.
  chevronRight: <path d="M6.4 4.4L10 8l-3.6 3.6" />,
  // Two commits and a branch leaving the trunk between them: git.
  branch: (
    <>
      <circle cx="5" cy="3.9" r="1.6" />
      <circle cx="5" cy="12.1" r="1.6" />
      <circle cx="11.4" cy="6.4" r="1.6" />
      <path d="M5 5.5v5M11.4 8v.5a3 3 0 0 1-3 3H5" />
    </>
  ),
  // A page with a turned corner: one file in a tree.
  file: (
    <>
      <path d="M4 2.4h4.6L12 5.8v7.1a.9.9 0 0 1-.9.9H4a.9.9 0 0 1-.9-.9V3.3a.9.9 0 0 1 .9-.9z" />
      <path d="M8.5 2.6v3.4H12" />
    </>
  ),
  // A clock wound backwards: what has been touched, and how recently.
  history: (
    <>
      <path d="M2.8 8a5.2 5.2 0 1 0 1.8-3.9" />
      <path d="M2.6 2.9v2.7h2.7" />
      <path d="M8 5.4V8l1.9 1.2" />
    </>
  ),
  // Deliberately not `restart`, which means "start this shell again" everywhere
  // else in the app. Same family, opposite sweep, so the two never read as one.
  refresh: (
    <>
      <path d="M3 8a5 5 0 0 1 8.7-3.4" />
      <path d="M13 8a5 5 0 0 1-8.7 3.4" />
      <path d="M11.8 1.9v2.8H9" />
      <path d="M4.2 14.1v-2.8H7" />
    </>
  ),
  // A pinned note: the Share section. Deliberately not `file`, which the git
  // changes list already owns — at pip size a shape is the whole of how a
  // section is told apart, and two sections drawn as a page is one too many.
  note: (
    <>
      <rect x="3" y="2.6" width="10" height="10.8" rx="1.5" />
      <path d="M5.6 6h4.8M5.6 8.6h4.8M5.6 11.2h2.6" />
    </>
  ),
  // A drawing pin, upright: a project held at the top of the rail. Drawn head-on
  // rather than at the usual 45° so it still reads as a pin at 13px, where the
  // tilted version collapses into a smudge.
  pin: (
    <>
      <path d="M6 2.4h4" />
      <path d="M6.7 2.4v4.1L4.7 9.4h6.6L9.3 6.5V2.4" />
      <path d="M8 9.4v4.2" />
    </>
  )
}

export function Icon({
  name,
  size = 16,
  className
}: {
  name: IconName
  size?: number
  className?: string
}): ReactNode {
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
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
