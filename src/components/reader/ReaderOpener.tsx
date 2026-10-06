import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ReaderOpenRequest } from '@shared/reader'
import { usePresence } from '@/lib/motion'
import { shellMode, useShellMode } from '@/lib/shellSlots'
import { uiCommands } from '@/lib/uiCommands'
import { Icon } from '../Icon'
import { readerApi, requestFile } from './readerStore'
import './ReaderNotice.css'

/**
 * Every way a file reaches the Read view, mounted for the life of the window —
 * not inside the surface, which only exists while Read is on screen.
 *
 *   windows / terminal / app   a person asked: show the file and go to Read.
 *   agent                      an agent asked: never take the screen from
 *                              Steve. A small tile rises (the Board's "new on
 *                              the board" tile, in the same spot) with the
 *                              file, who sent it and one Open button. With Read
 *                              already up, the file simply opens.
 *
 * `onOpen` is subscribed before `takePending` is called, so an open that lands
 * between the two is never lost.
 */

const SHOW_MS = 12000

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function ReaderOpener(): ReactNode {
  const mode = useShellMode()
  const [notice, setNotice] = useState<ReaderOpenRequest | null>(null)

  useEffect(() => {
    const api = readerApi()
    if (!api) return undefined
    let live = true
    const handle = (req: ReaderOpenRequest): void => {
      if (!live || !req?.path) return
      if (req.source === 'agent' && shellMode.get() !== 'read') {
        setNotice(req)
        return
      }
      requestFile(req.path)
      if (req.source !== 'agent') uiCommands.run('set-mode', 'read')
    }
    const off = api.onOpen(handle)
    api.takePending().then(
      (reqs) => reqs.forEach(handle),
      (err: unknown) => console.error('[reader] takePending failed', err)
    )
    return () => {
      live = false
      off()
    }
  }, [])

  // Sinks by itself; and going to Read any other way answers it.
  useEffect(() => {
    if (!notice) return undefined
    const t = window.setTimeout(() => setNotice(null), SHOW_MS)
    return () => window.clearTimeout(t)
  }, [notice])
  useEffect(() => {
    if (mode === 'read') setNotice(null)
  }, [mode])

  const { mounted, closing } = usePresence(!!notice, 200)
  const last = useRef(notice)
  if (notice) last.current = notice
  const view = notice ?? last.current
  if (!mounted || !view) return null

  const open = (): void => {
    setNotice(null)
    requestFile(view.path)
    uiCommands.run('set-mode', 'read')
  }

  return createPortal(
    <div className="rnotice" data-state={closing ? 'closing' : 'open'} role="status" aria-live="polite">
      <span className="rnotice__glyph" aria-hidden="true">
        <Icon name="book" size={20} />
      </span>
      <span className="rnotice__text">
        <span className="rnotice__eyebrow truncate">Sent to Read · {view.agent?.trim() || 'an agent'}</span>
        <span className="rnotice__title truncate" title={view.path}>
          {fileName(view.path)}
        </span>
      </span>
      <button type="button" className="rnotice__open" onClick={open}>
        Open
      </button>
      <button type="button" className="rnotice__x" aria-label="Dismiss" onClick={() => setNotice(null)}>
        ×
      </button>
    </div>,
    document.querySelector('.deck') ?? document.body
  )
}
