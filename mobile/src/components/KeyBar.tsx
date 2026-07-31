import { useState } from 'react'

/**
 * The row of keys a phone keyboard does not have.
 *
 * A terminal needs Esc, Tab, Ctrl and arrows; GBoard offers none of them. This
 * bar is therefore not a convenience, it is the difference between a terminal
 * you can use and a read-only view of one.
 *
 * Ctrl and Alt are **sticky**: tap Ctrl, then C, and the bar sends `\x03`. That
 * is the only workable model on a touch screen, where you cannot hold one key
 * while pressing another. They clear after one keypress — like a shift key,
 * because that is the behaviour everyone already has in their fingers — and
 * double-tapping locks them, for the rare case of several in a row.
 */

export interface KeyBarProps {
  /** Send raw bytes to the PTY. */
  onSend: (data: string) => void
  /** Open the compose row — the escape hatch when the IME misbehaves. */
  onCompose: () => void
}

type Sticky = 'off' | 'once' | 'locked'

/** Ctrl+letter is the letter's position in the alphabet as a control code. */
function ctrlOf(key: string): string | null {
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

export function KeyBar({ onSend, onCompose }: KeyBarProps): React.JSX.Element {
  const [ctrl, setCtrl] = useState<Sticky>('off')
  const [alt, setAlt] = useState<Sticky>('off')

  /** Send a literal character, applying whichever modifiers are armed. */
  const sendChar = (char: string): void => {
    let out = char
    if (ctrl !== 'off') out = ctrlOf(char) ?? char
    if (alt !== 'off') out = `\x1b${out}`
    onSend(out)
    if (ctrl === 'once') setCtrl('off')
    if (alt === 'once') setAlt('off')
  }

  /** Send something that is already an escape sequence — modifiers don't apply. */
  const sendRaw = (data: string): void => {
    onSend(data)
    if (ctrl === 'once') setCtrl('off')
    if (alt === 'once') setAlt('off')
  }

  const cycle = (current: Sticky): Sticky =>
    current === 'off' ? 'once' : current === 'once' ? 'locked' : 'off'

  return (
    <div className="keybar" role="toolbar" aria-label="Terminal keys">
      <div className="keybar-row">
        <button
          type="button"
          className={`key mod mod-${ctrl}`}
          aria-pressed={ctrl !== 'off'}
          onClick={() => setCtrl(cycle(ctrl))}
        >
          Ctrl
        </button>
        <button
          type="button"
          className={`key mod mod-${alt}`}
          aria-pressed={alt !== 'off'}
          onClick={() => setAlt(cycle(alt))}
        >
          Alt
        </button>
        <button type="button" className="key" onClick={() => sendRaw('\x1b')}>
          Esc
        </button>
        <button type="button" className="key" onClick={() => sendRaw('\t')}>
          Tab
        </button>
        {ARROWS.map(([label, code]) => (
          <button type="button" key={label} className="key" onClick={() => sendRaw(code)}>
            {label}
          </button>
        ))}
        <button type="button" className="key key-wide" onClick={onCompose} title="Type a line and send it">
          ⌨︎
        </button>
      </div>
      <div className="keybar-row keybar-symbols">
        {SYMBOLS.map((symbol) => (
          <button type="button" key={symbol} className="key key-sym" onClick={() => sendChar(symbol)}>
            {symbol}
          </button>
        ))}
        <button type="button" className="key key-sym" onClick={() => sendRaw('\x7f')} title="Backspace">
          ⌫
        </button>
      </div>
    </div>
  )
}
