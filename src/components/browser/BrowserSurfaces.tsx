import { useState, type ReactNode } from 'react'
import type { AgentProfile } from '@shared/types'
import { browserBridge } from './bridge'
import { BrowserSurface } from './BrowserSurface'
import { useBrowserSurfaces } from './useBrowserSurfaces'
import './browser.css'

/**
 * Every browser surface for a project, laid out at its saved canvas position
 * inside a positioned container — the standalone mount, and what the canvas's
 * surface slot renders until it positions surfaces itself. `openBrowser` in the
 * header opens a tab that is Steve's own.
 */
export function BrowserSurfaces({
  projectId,
  profiles,
  scale = 1,
  hidden = false
}: {
  projectId: string
  profiles?: AgentProfile[]
  scale?: number
  hidden?: boolean
}): ReactNode {
  const { visible } = useBrowserSurfaces(projectId)
  const [address, setAddress] = useState('')

  const open = (): void => {
    const url = address.trim() || 'https://www.google.com'
    setAddress('')
    void browserBridge()?.open({ url, project: projectId })
  }

  return (
    <div className="browser-surfaces">
      <form
        className="browser-surfaces__new"
        onSubmit={(e) => {
          e.preventDefault()
          open()
        }}
      >
        <input
          className="browser-surface__url"
          placeholder="Open a page…"
          aria-label="Open a page"
          value={address}
          onChange={(e) => setAddress(e.currentTarget.value)}
        />
        <button type="submit" className="browser-surfaces__open">
          Open browser
        </button>
      </form>
      {visible.map((s) => (
        <div
          key={s.id}
          className="browser-surfaces__slot"
          style={{ left: s.rect.x * scale, top: s.rect.y * scale, width: s.rect.w * scale, height: s.rect.h * scale }}
        >
          <BrowserSurface
            surface={s}
            profiles={profiles}
            scale={scale}
            hidden={hidden}
            onClose={(id) => void browserBridge()?.close(id)}
          />
        </div>
      ))}
    </div>
  )
}
