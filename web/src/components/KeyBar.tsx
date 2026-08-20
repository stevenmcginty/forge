import { useState, type ReactNode } from 'react'

/**
 * The row of keys a phone keyboard does not have.
 *
 * A terminal needs Esc, Tab, Ctrl and arrows; GBoard offers none of them, so on
 * a phone this bar is the difference between a terminal you can use and a
 * read-only view of one. It is Forge Mobile's `KeyBar` (mobile/src/components/
 * KeyBar.tsx) with the same encodings and the same sticky-modifier model,
 * carried over rather than imported because the two clients are built by two
 * tsconfigs and neither should have to see the other's tree to compile. The
 * *bytes* must not drift — Ctrl-C is `\x03` on every surface — so anything
 * added here should be added there in the same breath.
 *
 * Ctrl and Alt are **sticky**: tap Ctrl, then C, and the bar sends `\x03`. A
 * thumb cannot hold one cap while pressing another. They clear after one
 * keypress like a shift key, and a second tap locks them for a run.
 *
 * Where the bytes go is the caller's business: `onSend` is `actions.write` bound
 * to whichever pane is on screen, and a bar with no live pane is simply not
 * drawn (see `Workspace`).
 */

type Sticky = 'off' | 'once' | 'locked'

/** Ctrl+letter is the letter's position in the alphabet as a control code. */
export function ctrlOf(key: string): string | null {
  const upper = key.toUpperCase()
  if (upper.length === 1 && upper >= 'A' && upper <= 'Z') {
    return String.fromCharCode(upper.charCodeAt(0) - 64)
  }
  if (key === '[') return '\x1b'
  if (key === '\\') return '\x1c'
  if (key === ']') return '\x1d'
  return null
}

const ARROWS: Array<[string, string]> = [
  ['←', '\x1b[D'],
  ['↓', '\x1b[B'],
  ['↑', '\x1b[A'],
  ['→', '\x1b[C']
]

/** The punctuation a shell needs constantly and a phone buries two taps deep. */
const SYMBOLS = ['|', '/', '-', '~', '$', '*', '.', ':']

/**
 * Shift+Tab as a terminal hears it — CSI Z, "back tab". Claude Code cycles its
 * permission mode on it, and a keyboard that cannot produce it cannot answer
 * the question that session is asking.
 */
const BACK_TAB = '\x1b[Z'

function cycleSticky(current: Sticky): Sticky {
  return current === 'off' ? 'once' : current === 'once' ? 'locked' : 'off'
}

export function KeyBar({ onSend, onCompose }: { onSend: (data: string) => void; onCompose: () => void }): ReactNode {
  const [ctrl, setCtrl] = useState<Sticky>('off')
  const [alt, setAlt] = useState<Sticky>('off')

  const spend = (): void => {
    if (ctrl === 'once') setCtrl('off')
    if (alt === 'once') setAlt('off')
  }
  const sendChar = (char: string): void => {
    let out = char
    if (ctrl !== 'off') out = ctrlOf(char) ?? char
    if (alt !== 'off') out = `\x1b${out}`
    onSend(out)
    spend()
  }
  const sendRaw = (data: string): void => {
    onSend(data)
    spend()
  }

  // `onPointerDown` + preventDefault rather than `onClick`, so a tap on a cap
  // never steals focus from the terminal — the soft keyboard must stay up while
  // somebody taps Ctrl, C, ↑, Enter.
  const press =
    (fn: () => void) =>
    (e: React.PointerEvent): void => {
      e.preventDefault()
      fn()
    }

  return (
    <div className="mkeys" role="toolbar" aria-label="Terminal keys">
      <div className="mkeys__row">
        <button
          type="button"
          className="mkeys__key mkeys__mod"
          data-sticky={ctrl}
          aria-pressed={ctrl !== 'off'}
          onPointerDown={press(() => setCtrl(cycleSticky(ctrl)))}
        >
          Ctrl
        </button>
        <button
          type="button"
          className="mkeys__key mkeys__mod"
          data-sticky={alt}
          aria-pressed={alt !== 'off'}
          onPointerDown={press(() => setAlt(cycleSticky(alt)))}
        >
          Alt
        </button>
        <button type="button" className="mkeys__key" onPointerDown={press(() => sendRaw('\x1b'))}>
          Esc
        </button>
        <button type="button" className="mkeys__key" onPointerDown={press(() => sendRaw('\t'))}>
          Tab
        </button>
        <button
          type="button"
          className="mkeys__key"
          title="Shift+Tab"
          onPointerDown={press(() => sendRaw(BACK_TAB))}
        >
          ⇤
        </button>
        {ARROWS.map(([label, code]) => (
          <button type="button" key={label} className="mkeys__key" onPointerDown={press(() => sendRaw(code))}>
            {label}
          </button>
        ))}
        <button
          type="button"
          className="mkeys__key mkeys__key--wide"
          title="Type a line and send it"
          onPointerDown={press(onCompose)}
        >
          ⌨
        </button>
      </div>
      <div className="mkeys__row">
        {SYMBOLS.map((symbol) => (
          <button
            type="button"
            key={symbol}
            className="mkeys__key mkeys__key--sym mono"
            onPointerDown={press(() => sendChar(symbol))}
          >
            {symbol}
          </button>
        ))}
        <button
          type="button"
          className="mkeys__key mkeys__key--sym"
          title="Backspace"
          onPointerDown={press(() => sendRaw('\x7f'))}
        >
          ⌫
        </button>
        <button
          type="button"
          className="mkeys__key mkeys__key--sym"
          title="Enter"
          onPointerDown={press(() => sendRaw('\r'))}
        >
          ⏎
        </button>
      </div>
    </div>
  )
}

/**
 * A line at a time, for when the IME will not cooperate with xterm's hidden
 * textarea — autocorrect rewriting a path, swipe-typing landing as one
 * composition event, a keyboard that refuses to raise for a contenteditable it
 * does not understand. Plain `<input>`, so the phone treats it as the form
 * field it is; Enter or Send ships the draft with a carriage return.
 */
export function ComposeRow({ onSend, onClose }: { onSend: (data: string) => void; onClose: () => void }): ReactNode {
  const [draft, setDraft] = useState('')
  const send = (): void => {
    onSend(`${draft}\r`)
    setDraft('')
  }
  return (
    <div className="mcompose">
      <input
        className="mcompose__input mono"
        value={draft}
        autoFocus
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Type a line, then send"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            send()
          }
        }}
      />
      <button type="button" className="cta-btn mcompose__send" onClick={send}>
        Send
      </button>
      <button type="button" className="ghost-btn mcompose__close" aria-label="Close" onClick={onClose}>
        ✕
      </button>
    </div>
  )
}
