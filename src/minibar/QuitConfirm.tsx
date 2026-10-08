import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MiniBarQuitInfo, MiniBarViewApi } from '@shared/minibar'

/**
 * The quit confirm, grown out of the top of the bar in place (spec 4.6). No
 * native dialog: under an always-on-top window, or parented to a minimised
 * one, a dialog can hide. Cancel has the focus, so Enter is the safe answer.
 */
export function QuitConfirm({
  info,
  api,
  onCancel
}: {
  info: MiniBarQuitInfo
  api: MiniBarViewApi
  onCancel: () => void
}): ReactNode {
  const cancel = useRef<HTMLButtonElement | null>(null)
  const [dontAsk, setDontAsk] = useState(false)
  useEffect(() => cancel.current?.focus(), [])

  return (
    <div
      className="mb-bar__notice mb-quitrow"
      role="alertdialog"
      aria-label="Quit Forge?"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      <span className="mb-bar__notice-mark" data-kind="quit" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect x="1.5" y="1.5" width="7" height="7" rx="1.2" fill="currentColor" />
        </svg>
      </span>
      <span className="mb-bar__notice-word">{quitSentence(info)}</span>
      <label className="mb-check">
        <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
        <span className="mb-check__box" aria-hidden="true" />
        Don't ask again
      </label>
      <span className="mb-quitrow__acts">
        <button type="button" className="mb-btn mb-btn--danger" onClick={() => void api.quit({ dontAskAgain: dontAsk })}>
          Quit Forge
        </button>
        <button ref={cancel} type="button" className="mb-btn mb-btn--solid" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  )
}

/** "3 agents still running. 2 will resume, 1 will be lost." */
export function quitSentence({ running, resume, lost }: MiniBarQuitInfo): string {
  const head = `${running} ${running === 1 ? 'agent' : 'agents'} still running.`
  if (lost === 0) return `${head} ${running === 1 ? 'It' : 'All'} will resume.`
  if (resume === 0) return `${head} ${running === 1 ? 'It' : 'All'} will be lost.`
  return `${head} ${resume} will resume, ${lost} will be lost.`
}
