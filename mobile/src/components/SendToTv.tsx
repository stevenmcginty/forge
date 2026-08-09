import { useState } from 'react'
import { videoIdOf } from '@shared/mobile'

/**
 * "Send to TV" — a YouTube link off the clipboard, onto the television.
 *
 * The whole feature is one field, because the interaction it replaces is
 * already one gesture: share a video out of the YouTube app, come here, paste,
 * send. Anything more — a search box, a queue, a picker — would be re-building
 * YouTube on a phone in order to avoid typing on a remote, and the television
 * has YouTube on it already.
 *
 * The id is extracted by `videoIdOf` in shared/mobile.ts, the same function the
 * desktop re-derives with before relaying, so a link this sheet accepts is one
 * the desktop cannot refuse for a different reason. Refusal happens *here*,
 * with the text still on screen and fixable, rather than as a notice four
 * seconds later on a screen the user has already left.
 */

export interface SendToTvSheetProps {
  onCancel: () => void
  /** Called with an id already held to the 11-character shape. */
  onSend: (video: string) => void
}

export function SendToTvSheet({ onCancel, onSend }: SendToTvSheetProps): React.JSX.Element {
  const [text, setText] = useState('')
  const [trouble, setTrouble] = useState('')
  const video = videoIdOf(text)

  return (
    <div className="sheet-scrim" onClick={onCancel}>
      <div className="sheet" role="dialog" aria-label="Send to TV" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <strong>Send to TV</strong>
          <span className="sheet-version">{video || 'paste a link'}</span>
        </div>

        <p className="sheet-notes">
          Paste a YouTube link — Share, then Copy link, in the YouTube app. The television plays it beside the
          wall.
        </p>

        <label className="field">
          <span>YouTube link or id</span>
          <input
            value={text}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://youtu.be/…"
            onChange={(e) => {
              setText(e.target.value)
              setTrouble('')
            }}
          />
        </label>

        {trouble && <p className="sheet-detail">{trouble}</p>}

        <button
          type="button"
          className="primary"
          disabled={text.trim() === ''}
          onClick={() => {
            if (!video) {
              setTrouble('No video id in there. A watch link, a youtu.be link, or the 11-character id itself.')
              return
            }
            onSend(video)
          }}
        >
          Send to TV
        </button>

        <button type="button" className="sheet-close" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
