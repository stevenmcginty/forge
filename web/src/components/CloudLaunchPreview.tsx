import { useState, type ReactNode } from 'react'
import type { Project } from '@shared/types'
import { useDeckTheme } from '../deck/theme'
import { cloudProjects, CloudLaunchSheet } from './CloudLaunch'
import './ChatPreview.css'

/**
 * `?preview=cloud` on the dev server: the "Work in the cloud" sheet over a
 * stand-in screen, fed three fixture projects, so it can be looked at without
 * a desktop. Compiled out of every `vite build` by the `__DEV_SERVER__` gate
 * in main.tsx, like the chat preview.
 *
 * The bar on top is harness chrome, not product: Volt and WhatsApp dark and
 * light through the real theme path, and "open" to bring the sheet back.
 */

const PROJECTS: Project[] = [
  {
    id: 'forge',
    name: 'forge',
    path: 'C:\\Users\\steve\\Desktop\\forge',
    color: '#c6f432',
    defaultProfileId: 'claude',
    createdAt: 0,
    repoUrl: 'https://github.com/stevenmcginty/forge.git'
  },
  {
    id: 'coffee',
    name: 'coffee-shop-claude',
    path: 'C:\\Users\\steve\\Desktop\\coffee-shop-claude',
    color: '#f4a432',
    defaultProfileId: 'claude',
    createdAt: 0,
    repoUrl: 'git@github.com:stevenmcginty/coffee-shop-claude.git'
  },
  {
    id: 'notes',
    name: 'notes',
    path: 'C:\\Users\\steve\\Desktop\\notes',
    color: '#32a4f4',
    defaultProfileId: 'claude',
    createdAt: 0
  }
]

export function CloudLaunchPreview(): ReactNode {
  const { themeId: theme, setTheme } = useDeckTheme(true)
  const [open, setOpen] = useState(true)

  return (
    <div className="chatpreview">
      <div className="chatpreview__bar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="chatpreview__label">CloudLaunch</span>
        <div className="chatpreview__controls" style={{ flexWrap: 'wrap' }}>
          <button type="button" data-active={theme === 'volt'} onClick={() => setTheme('volt')}>
            Volt
          </button>
          <button type="button" data-active={theme === 'whatsapp-dark'} onClick={() => setTheme('whatsapp-dark')}>
            WA dark
          </button>
          <button type="button" data-active={theme === 'whatsapp-light'} onClick={() => setTheme('whatsapp-light')}>
            WA light
          </button>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
        </div>
      </div>
      <div className="app" data-mobile="true" data-ready="true" data-shell="app" style={{ flex: 1, minHeight: 0 }}>
        <div className="app__display" style={{ flex: 1, minHeight: 0, background: 'var(--bg-terminal)' }} />
        <CloudLaunchSheet open={open} projects={cloudProjects(PROJECTS)} onClose={() => setOpen(false)} />
      </div>
    </div>
  )
}
