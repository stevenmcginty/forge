import { useEffect, useMemo, useState } from 'react'
import type { BrowserSurfaceInfo } from '@shared/browser'
import { browserBridge } from './bridge'

/**
 * Every browser surface, kept live from main's `browser:changed` pushes, and
 * the ones that belong on screen for `projectId` (its own, plus any with no
 * project). Tells main which project is showing, so a tab opened by an agent
 * whose project is unknown lands where Steve is looking.
 */
export function useBrowserSurfaces(projectId: string): {
  all: BrowserSurfaceInfo[]
  visible: BrowserSurfaceInfo[]
} {
  const [all, setAll] = useState<BrowserSurfaceInfo[]>([])

  useEffect(() => {
    const api = browserBridge()
    if (!api) return
    let alive = true
    api
      .list()
      .then((list) => {
        if (alive) setAll(list)
      })
      .catch((err: unknown) => console.error('[browser] list failed:', err))
    const off = api.onChanged((list) => setAll(list))
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    browserBridge()?.setProject(projectId)
  }, [projectId])

  const visible = useMemo(() => all.filter((s) => !s.project || s.project === projectId), [all, projectId])
  return { all, visible }
}
