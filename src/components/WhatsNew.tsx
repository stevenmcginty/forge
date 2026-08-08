import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { shouldOpenWhatsNew, whatsNew } from '@/lib/whatsnew'
import { useApp } from '@/state/AppState'
import { Icon } from './Icon'
import './WhatsNew.css'

/**
 * What changed in the version you are now running.
 *
 * Forge updates itself, which means it changes under people without asking. The
 * banner says "Update & restart" and the next thing you see is an app that is
 * subtly different from the one you were using — so this card is the other half
 * of that bargain: after each update, once, here is what moved and how to use it.
 *
 * Three decisions worth stating, because each is the reason the card is not
 * something more:
 *
 * **It carries its own text.** src/lib/whatsnew.ts is a static import of a file
 * generated at build time from the commit range, so the card works on a train and
 * needs no HTML sanitiser. electron-updater does hand over GitHub's rendered
 * release notes, and using them would have meant taking a dependency on somebody
 * else's HTML to say something Forge already knows.
 *
 * **It opens once per release, by itself.** `lastNotesVersion` in settings is the
 * whole mechanism. There is no banner, no dot, and no second chance to be
 * reminded — dismissing it is final, and the button in Settings → Updates is how
 * you get it back.
 *
 * **It does not open for a release with nothing in it.** CI cuts a release on
 * every push to master, so plenty of versions are housekeeping. A card that
 * appeared after one of those to say "nothing changed" would teach people to
 * dismiss the card without reading it, which is the only way this feature can
 * really fail.
 *
 * Modelled on src/components/Onboarding.tsx, structurally the same thing: a
 * settings key gates it, the card takes focus, Escape closes, and keystrokes stop
 * here rather than reaching the terminal behind it.
 */
export function WhatsNew(): ReactNode {
  const { state, actions } = useApp()
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [showAll, setShowAll] = useState(false)

  const notes = whatsNew()
  const version = state.info?.version ?? ''

  /*
   * Opened by an effect rather than by a derived boolean, because it is also
   * openable from Settings — one flag with two ways in beats a boolean that has to
   * agree with a button. Marking it seen happens at open time, not on dismiss: a
   * card closed by quitting the app has still been shown, and showing it again on
   * the next launch would make it feel like nagging.
   */
  const auto = state.ready && shouldOpenWhatsNew(version, state.settings.lastNotesVersion)
  useEffect(() => {
    if (!auto) return
    actions.setWhatsNewOpen(true)
    actions.patchSettings({ lastNotesVersion: version })
  }, [auto, version])

  const open = state.whatsNewOpen && notes !== null

  useEffect(() => {
    if (open) cardRef.current?.focus()
  }, [open])

  const close = useCallback(() => {
    actions.setWhatsNewOpen(false)
    setShowAll(false)
    // Also mark it seen when it was opened by hand on a version that had not been
    // seen yet — otherwise the automatic one would still be waiting to fire.
    if (version && state.settings.lastNotesVersion !== version) actions.patchSettings({ lastNotesVersion: version })
  }, [actions, version, state.settings.lastNotesVersion])

  if (!open || !notes) return null

  const shown = notes.version || version
  const changes = showAll ? notes.changes : notes.changes.slice(0, 6)
  const hidden = notes.changes.length - changes.length

  return (
    <div className="wnew" role="dialog" aria-modal="true" aria-label={`What's new in Forge ${shown}`}>
      <div
        className="wnew__card"
        ref={cardRef}
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') close()
        }}
      >
        <button type="button" className="ghost-btn wnew__dismiss" aria-label="Dismiss" onClick={close}>
          <Icon name="close" size={12} />
        </button>

        <header className="wnew__head">
          <div className="wnew__mark">
            <Icon name="forge" size={20} />
          </div>
          <div>
            <div className="eyebrow wnew__eyebrow">Updated{notes.date ? ` · ${notes.date}` : ''}</div>
            <h1 className="wnew__title">Forge {shown}</h1>
          </div>
        </header>

        {notes.highlights.length > 0 ? (
          <ul className="wnew__highlights">
            {notes.highlights.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="wnew__lede">
            No headline features in this one — the list below is everything that moved.
          </p>
        )}

        {notes.changes.length > 0 ? (
          <section className="wnew__also">
            <div className="eyebrow wnew__eyebrow">Also changed</div>
            <ul className="wnew__changes">
              {changes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {hidden > 0 ? (
              <button type="button" className="wnew__link" onClick={() => setShowAll(true)}>
                and {hidden} more
              </button>
            ) : null}
          </section>
        ) : null}

        <footer className="wnew__foot">
          {notes.url ? (
            <button
              type="button"
              className="wnew__link"
              title="Open the release on GitHub"
              onClick={() => void window.forge.openExternal(notes.url)}
            >
              Full notes on GitHub
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="cta-btn" onClick={close}>
            Got it
          </button>
        </footer>
      </div>
    </div>
  )
}
