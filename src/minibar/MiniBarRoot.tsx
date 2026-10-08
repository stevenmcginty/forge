import { useEffect, useState, type ReactNode } from 'react'
import type { MiniBarState } from '@shared/minibar'
import { filePaths } from '@/lib/paths'
import { MiniBarView } from './MiniBarView'
import { MINIBAR_SOLID, useClickThrough } from './useClickThrough'
import { useMiniKeys } from './useMiniKeys'

/**
 * The #minibar window's whole tree (src/main.tsx): no providers, because it
 * owns nothing. It shows the state the host publishes and sends its calls
 * back, both through `window.forge.minibar` (electron/minibar-window.ts).
 *
 * Files dropped anywhere on the bar go to the host as `paths`, which puts
 * them in the box quoted, as the paperclip does. An unprevented file drop
 * would navigate the window to the file.
 *
 * The room around the bar, the stage and the toasts lets clicks through to
 * whatever is under it (useClickThrough).
 */
export function MiniBarRoot(): ReactNode {
  const api = window.forge.minibar
  const [state, setState] = useState<MiniBarState | null>(null)

  useEffect(() => {
    if (typeof api?.onState !== 'function') return undefined
    return api.onState(setState)
  }, [api])

  // Shortcuts and the talk keys while the bar has focus.
  useMiniKeys(state, api)

  // Clicks on the see-through room go to the app underneath.
  useClickThrough(MINIBAR_SOLID, api?.setClickThrough)

  useEffect(() => {
    if (!api) return undefined
    const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const over = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const paths = filePaths(e.dataTransfer?.files ?? null)
      if (paths.length > 0) api.call({ t: 'paths', paths })
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [api])

  if (!api) return null
  return <MiniBarView state={state} api={api} />
}
