/*
 * Forge Web's service worker, and it does exactly one job: show a notification
 * when the desktop pushes one, and take you back to the pane that raised it.
 *
 * Plain JavaScript in `public/` rather than anything Vite compiles, because a
 * worker has to be fetched by URL from the origin root and has no import graph
 * worth bundling. Nothing here shares code with the app; what it needs to know
 * about the wire is one object shape, `WebPushPayload` in shared/web.ts.
 *
 * ## No fetch handler, on purpose
 *
 * There is no `fetch` listener below and there is not going to be one. This
 * page's update story is `lib/update.ts`: Firebase serves `index.html` with
 * `no-cache`, the bundle is content-hashed, `/version.json` says which build is
 * newest and a reload lands on it. A worker that cached anything would sit
 * between that and the network and start serving yesterday's Forge — the exact
 * failure `mobile/src/lib/pwa.ts` refuses to ship into the APK. So this worker
 * is push and nothing else: it never sees a request, and turning it off would
 * cost the page nothing but the notifications.
 *
 * ## Why a notification always appears
 *
 * Every push shows *something*, including a payload that will not parse. Chrome
 * and Firefox both police `userVisibleOnly`: a push that resolves without
 * calling `showNotification` counts against the subscription, and enough of
 * them get it revoked outright — a browser that silently stopped being
 * notified, with nothing on screen to say so. A slightly vague "Forge needs
 * you" is a much better failure than that.
 */

/** The tag every fallback notification shares, so unreadable pushes cannot stack. */
const FALLBACK_TAG = 'forge'

self.addEventListener('install', () => {
  // Nothing to pre-cache, so there is nothing to wait for: the worker that was
  // just fetched is the one that should be handling pushes, not the one that
  // happened to be installed when the tab was opened.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let payload = null
  try {
    payload = event.data ? event.data.json() : null
  } catch {
    /* fall through to the generic notification below — see the header */
  }

  let title = 'Forge needs you'
  let body = 'A pane on your desktop wants your attention.'
  let tag = FALLBACK_TAG
  let sessionId = ''

  if (payload && payload.kind === 'attention' && typeof payload.sessionId === 'string') {
    sessionId = payload.sessionId
    tag = payload.sessionId || FALLBACK_TAG
    const pane = typeof payload.title === 'string' && payload.title ? payload.title : 'A pane'
    const desktop = typeof payload.desktopName === 'string' && payload.desktopName ? payload.desktopName : 'your desktop'
    if (payload.state === 'done') {
      title = `${pane} finished`
      body = `On ${desktop}`
    } else {
      title = `${pane} is asking`
      body = typeof payload.prompt === 'string' && payload.prompt.trim() ? payload.prompt.trim() : 'Needs an answer.'
    }
  }

  // `tag` per session so a pane that asks twice replaces its own notification
  // rather than stacking; `renotify` so the replacement still buzzes, which is
  // the whole reason the second one was sent.
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      data: { sessionId }
    })
  )
})

/*
 * Coming back.
 *
 * An open Forge tab is far better than a second one: it already holds the
 * socket, the workspace and every attached pane, so the tab is focused and told
 * which session to go to rather than being reloaded. `state.tsx` listens for
 * this message and selects the project, the tab and the pane, exactly as a tap
 * on the pane would. Only when there is no window at all is one opened, and
 * then the session travels in the URL because there is nobody to message yet.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const sessionId = (event.notification.data && event.notification.data.sessionId) || ''

  event.waitUntil(
    (async () => {
      // `includeUncontrolled`, because a tab that was already open when this
      // worker first activated is not controlled by it and would otherwise be
      // invisible here — which is most tabs, most of the time.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue
        client.postMessage({ type: 'forge-open-session', sessionId })
        if ('focus' in client) return client.focus()
        return
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/')
      }
    })()
  )
})
