import { useState, type ReactNode } from 'react'
import { useDeckTheme } from '../deck/theme'
import { SpeechKeyCardView } from './SpeechKeyCard'
import './ChatPreview.css'

/**
 * `?preview=speechkey` on the dev server: the "Turn on dictation" card over a
 * stand-in feed, so it can be looked at without a desktop that lacks a key.
 * Compiled out of every `vite build` by the `__DEV_SERVER__` gate in main.tsx,
 * like the chat preview.
 *
 * The bar on top is harness chrome, not product: Volt and WhatsApp dark and
 * light through the real theme path, and "again" to bring the card back. Save
 * is answered here: a key with "bad" in it is refused in the desktop's words,
 * anything else is kept.
 */

const FEED = [
  'Sure — I will look at how the push sender decides which device to notify.',
  'The sender skips a device only when its page is on screen, so the phone in a pocket still buzzes.',
  'Run npm run typecheck?',
  'Typecheck is clean. Shall I commit this on the branch?'
]

export function SpeechKeyCardPreview(): ReactNode {
  const { themeId: theme, setTheme } = useDeckTheme(true)
  const [shown, setShown] = useState(true)
  const [seq, setSeq] = useState(0)
  const [last, setLast] = useState('')

  return (
    <div className="chatpreview">
      <div className="chatpreview__bar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="chatpreview__label">SpeechKeyCard</span>
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
      <div
        className="app"
        data-mobile="true"
        data-ready="true"
        data-shell="app"
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
      >
        <div
          className="app__display"
          style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', background: 'var(--bg-terminal)' }}
        >
          <div style={{ padding: 16, fontSize: 15, lineHeight: 1.45, color: 'var(--p-ink)' }}>
            {Array.from({ length: 3 }, (_, round) =>
              FEED.map((text, i) => (
                <p
                  key={`${round}-${i}`}
                  style={{
                    margin: '0 0 10px',
                    padding: '8px 12px',
                    maxWidth: '85%',
                    marginLeft: i % 2 ? 'auto' : 0,
                    background: 'var(--p-surface)',
                    borderRadius: 12,
                    opacity: 0.75
                  }}
                >
                  {text}
                </p>
              ))
            )}
            <p style={{ margin: '12px 0 0', color: 'var(--p-ink)' }}>{last ? `last: ${last}` : ''}</p>
          </div>
          {shown ? (
            <SpeechKeyCardView
              key={seq}
              onSave={(key) =>
                new Promise((resolve) =>
                  window.setTimeout(
                    () =>
                      resolve(
                        key.includes('bad')
                          ? 'Groq did not accept that key. Copy it again from console.groq.com/keys and paste the whole key.'
                          : null
                      ),
                    900
                  )
                )
              }
              onSaved={() => {
                setShown(false)
                setLast('saved')
              }}
              onClose={() => {
                setShown(false)
                setLast('closed for now')
              }}
              onNeverAgain={() => {
                setShown(false)
                setLast("don't remind me again")
              }}
            />
          ) : null}
        </div>
        <div
          style={{
            height: 64,
            flex: 'none',
            borderTop: '1px solid var(--p-line)',
            background: 'var(--p-surface)',
            color: 'var(--p-ink-2)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 13
          }}
        >
          the box and the green disc, uncovered
        </div>
      </div>
    </div>
  )
}
