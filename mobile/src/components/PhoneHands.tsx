import { useCallback, useEffect, useState } from 'react'
import { ForgeHands, type HandsStatus } from '../lib/hands'

/**
 * The "Phone hands" settings card.
 *
 * It only ever shows in the native app — a browser has no accessibility
 * service to grant — so App gates it on isNativeApp(), the same test the
 * updater uses. The card is a checklist: the master switch, the two restricted
 * settings (accessibility, notification access), two runtime permissions
 * (contacts, notifications), the battery opt-out, and the desk link. Each row
 * says where it stands right now and carries the one button that moves it on.
 *
 * Status is polled every two seconds while the card is open, because the
 * things it tracks (a permission granted in Settings, the socket coming up)
 * change behind the WebView's back and there is no event for most of them.
 */
export function PhoneHandsSheet({
  deviceId,
  deviceName,
  onClose
}: {
  deviceId: string
  deviceName: string
  onClose: () => void
}): React.JSX.Element {
  const [status, setStatus] = useState<HandsStatus | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await ForgeHands.getStatus())
    } catch {
      /* non-native or plugin missing: the card stays on its "unavailable" line */
    }
  }, [])

  useEffect(() => {
    // Tell the native side who we are, so its socket names the device the same
    // way the app's own socket does, then read the first status.
    void ForgeHands.syncIdentity({ id: deviceId, name: deviceName }).catch(() => {})
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => window.clearInterval(timer)
  }, [deviceId, deviceName, refresh])

  const toggle = useCallback(
    async (on: boolean) => {
      try {
        setStatus(await ForgeHands.setEnabled({ on }))
      } catch {
        /* ignore */
      }
    },
    []
  )

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch {
        /* ignore */
      }
      void refresh()
    },
    [refresh]
  )

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet hands" role="dialog" aria-label="Phone hands" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <strong>Phone hands</strong>
          <span className="sheet-version">Let Forge agents use this phone</span>
        </div>

        {status === null ? (
          <p className="sheet-line">Phone hands are only available in the installed app.</p>
        ) : (
          <>
            <div className="hands-master">
              <div>
                <div className="hands-row-label">Let Forge use this phone</div>
                <div className="hands-row-sub">{status.enabled ? 'On' : 'Off'} · default off</div>
              </div>
              <button
                type="button"
                className={`hands-switch${status.enabled ? ' is-on' : ''}`}
                role="switch"
                aria-checked={status.enabled}
                onClick={() => void toggle(!status.enabled)}
              >
                {status.enabled ? 'On' : 'Off'}
              </button>
            </div>

            <Row
              label="Accessibility"
              ok={status.accessibility}
              value={status.accessibility ? 'On' : 'Off — Forge cannot see or tap the screen'}
              button="Open"
              onClick={() => void run(() => ForgeHands.openAccessibilitySettings())}
            />
            <Row
              label="Notification access"
              ok={status.notifications}
              value={status.notifications ? 'On' : 'Off — cannot read or reply to notifications'}
              button="Open"
              onClick={() => void run(() => ForgeHands.openNotificationAccess())}
            />
            <Row
              label="Contacts"
              ok={status.contacts}
              value={status.contacts ? 'Granted' : 'Not granted'}
              button="Allow"
              onClick={() => void run(() => ForgeHands.requestContacts())}
            />
            <Row
              label="Notifications"
              ok={status.postNotifications}
              value={status.postNotifications ? 'Allowed' : 'Not allowed — no ongoing banner'}
              button="Allow"
              onClick={() => void run(() => ForgeHands.requestNotifications())}
            />
            <Row
              label="Battery"
              ok={status.batteryUnrestricted}
              value={status.batteryUnrestricted ? 'Unrestricted' : 'Restricted — may drop the link in Doze'}
              button="Fix"
              onClick={() => void run(() => ForgeHands.requestIgnoreBattery())}
            />
            <Row
              label="Desk link"
              ok={status.linked}
              value={
                status.linked
                  ? `Connected${status.desktopName ? ` to ${status.desktopName}` : ''}`
                  : status.paired
                    ? 'Not connected'
                    : 'Not paired — pair Forge first'
              }
            />

            <p className="hands-help">
              If Android says “Restricted setting”, open App info, tap the three dots, then “Allow
              restricted settings”.
            </p>
            <button type="button" className="ghost" onClick={() => void run(() => ForgeHands.openAppInfo())}>
              Open App info
            </button>
          </>
        )}

        <button type="button" className="sheet-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

function Row({
  label,
  value,
  ok,
  button,
  onClick
}: {
  label: string
  value: string
  ok: boolean
  button?: string
  onClick?: () => void
}): React.JSX.Element {
  return (
    <div className="hands-row">
      <div className="hands-row-main">
        <div className="hands-row-label">{label}</div>
        <div className={`hands-row-sub${ok ? ' is-ok' : ''}`}>{value}</div>
      </div>
      {button && onClick && (
        <button type="button" className="hands-btn" onClick={onClick}>
          {button}
        </button>
      )}
    </div>
  )
}
