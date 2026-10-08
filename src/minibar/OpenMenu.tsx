import { useEffect, useRef, type ReactNode } from 'react'
import type { MiniBarViewApi } from '@shared/minibar'
import { Icon } from '@/components/Icon'
import { OpenGlyph } from './glyphs'

/** Open's small menu, over the Open key: as it was, or maximised. */
export function OpenMenu({ api, onClose }: { api: MiniBarViewApi; onClose: () => void }): ReactNode {
  const first = useRef<HTMLButtonElement | null>(null)
  useEffect(() => first.current?.focus(), [])
  return (
    <div className="mb-sheet mb-openmenu" role="menu" aria-label="Open Forge">
      <button ref={first} type="button" role="menuitem" className="mb-row mb-menurow" onClick={() => void api.openMain(false)}>
        <OpenGlyph />
        <span>Open</span>
        <span className="mb-menurow__hint">as it was</span>
      </button>
      <button type="button" role="menuitem" className="mb-row mb-menurow" onClick={() => void api.openMain(true)}>
        <Icon name="expand" size={16} />
        <span>Open maximised</span>
      </button>
      <button type="button" role="menuitem" className="mb-row mb-menurow" data-quiet="true" onClick={onClose}>
        <Icon name="chevronDown" size={16} />
        <span>Keep minimised</span>
      </button>
    </div>
  )
}
