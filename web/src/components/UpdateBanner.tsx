import { type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import type { WebUpdate } from '../lib/update'

/**
 * "A newer Forge Web is deployed." The desktop's UpdateBanner, said in the
 * browser's one sentence: there is a newer build on the host, this tab is not
 * running it, and a reload is the whole of getting it — see lib/update.ts for
 * why nothing happens on its own.
 *
 * The same 30px band, in the same place, as OfflineBanner and
 * ReconnectingBanner — it pushes the app down rather than covering any of it —
 * and the same discipline as its desktop twin: panel-quiet, with the accent
 * spent exactly once, on the button that does the thing. It replaced the
 * pulsing chip that used to live in the titlebar, which sat beside the
 * connection badge and read as one more status rather than as news.
 *
 * Rendering it from Workspace rather than TopBar, because the hook is called
 * once there and handed down: two callers would be two pollers asking
 * version.json the same question on the same cadence.
 */
export function UpdateBanner({ update }: { update: WebUpdate }): ReactNode | null {
  if (!update.available) return null

  return (
    <div className="ubanner" role="status" data-testid="update-banner">
      <span className="ubanner__mark">
        <Icon name="forge" size={13} />
      </span>
      <span className="ubanner__text truncate">
        {update.version ? (
          <>
            <strong>Forge Web {update.version}</strong> is deployed — reload to run it
          </>
        ) : (
          <>
            <strong>A newer Forge Web</strong> is deployed — reload to run it
          </>
        )}
      </span>
      <div className="ubanner__actions">
        <button type="button" className="ubanner__btn ubanner__btn--go" onClick={update.apply}>
          Reload
        </button>
        {/*
          Not now, remembered per deploy: declining this build does not silence
          the next one. See lib/update.ts for what is written down.
        */}
        <button
          type="button"
          className="ghost-btn ubanner__close"
          title="Not now — hidden until the next deploy"
          aria-label="Dismiss this update"
          onClick={update.dismiss}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>
  )
}
