import { useState, type ReactNode } from 'react'
import { useDeckTheme } from '../deck/theme'
import { AskBannerView } from './AskBanner'
import './ChatPreview.css'

/**
 * `?preview=askbanner` on the dev server: the phone's heads-up banner over a
 * stand-in terminal, so it can be looked at without a desktop asking anything.
 * Compiled out of every `vite build` by the `__DEV_SERVER__` gate in main.tsx,
 * like the chat preview.
 *
 * The bar on top is harness chrome, not product: Volt and WhatsApp dark and
 * light through the real theme path, "short" to swap the long fixture for a
 * short one, and "again" to bring it back after a tap, a × or a swipe. The fuse
 * is off here so it holds still for a screenshot.
 */

const LONG = {
  label: 'mercedes-xentry-slk-ecu-dumps-and-notes — Claude 2 (ECU mapping)',
  prompt:
    'Do you want to make this edit to electron/web-host.ts? The change rewrites the push sender so each device is notified unless it is on screen. 1. Yes  2. Yes, and allow all edits this session  3. No'
}
const SHORT = { label: 'forge — Zeb', prompt: 'Run npm run typecheck?' }

export function AskBannerPreview(): ReactNode {
  const { themeId: theme, setTheme } = useDeckTheme(true)
  const [long, setLong] = useState(true)
  const [shown, setShown] = useState(true)
  const [seq, setSeq] = useState(0)
  const [last, setLast] = useState('')
  const words = long ? LONG : SHORT

  return (
    <div className="chatpreview">
      <div className="chatpreview__bar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="chatpreview__label">AskBanner</span>
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
          <button type="button" data-active={!long} onClick={() => setLong((v) => !v)}>
            short
          </button>
          <button
            type="button"
            onClick={() => {
              setShown(true)
              setSeq((n) => n + 1)
            }}
          >
            again
          </button>
        </div>
      </div>
      <div className="app" data-mobile="true" data-ready="true" data-shell="app" style={{ flex: 1, minHeight: 0 }}>
        <div className="app__display" style={{ flex: 1, minHeight: 0, background: 'var(--bg-terminal)' }}>
          <div style={{ padding: 16, fontFamily: 'var(--p-mono)', fontSize: 13, color: 'var(--p-ink-2)' }}>
            {Array.from({ length: 22 }, (_, i) => (
              <p key={i} style={{ margin: '0 0 6px', opacity: 0.6 }}>
                $ terminal line {i + 1}, the pane on screen under the banner
              </p>
            ))}
            <p style={{ margin: '12px 0 0', color: 'var(--p-ink)' }}>{last ? `last: ${last}` : ''}</p>
          </div>
          {shown ? (
            <AskBannerView
              key={seq}
              label={words.label}
              prompt={words.prompt}
              fuseMs={0}
              onOpen={() => {
                setShown(false)
                setLast('open')
              }}
              onDismiss={() => {
                setShown(false)
                setLast('dismiss')
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
