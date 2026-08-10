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
 *
 * The encodings below are exported because the television grew the same row
 * (see TvPaneView in TvDashboard.tsx) and two spellings of Ctrl-C in one app is
 * one spelling too many. What differs between the two surfaces is the *shape* —
 * a phone taps caps with a thumb, a television walks them with a D-pad — and
 * that is all either of them should be deciding for itself.
 */

export interface KeyBarProps {
  /** Send raw bytes to the PTY. */
  onSend: (data: string) => void
  /** Open the compose row — the escape hatch when the IME misbehaves. */
  onCompose: () => void
}

export type Sticky = 'off' | 'once' | 'locked'

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

export const ARROWS: Array<[string, string]> = [
  ['←', '\x1b[D'],
  ['↓', '\x1b[B'],
  ['↑', '\x1b[A'],
  ['→', '\x1b[C']
]

/** The punctuation a shell needs constantly and a phone buries two taps deep. */
export const SYMBOLS = ['|', '/', '-', '~', '$', '*', '.', ':']

/**
 * Shift+Tab, as a terminal hears it.
 *
 * CSI Z — "back tab" — which is what every terminal emulator sends for the
 * press and what a TUI reading the sequence expects. Here rather than at the
 * one surface that offers it, because it belongs with the other encodings: the
 * next surface that needs the press should find it spelled once.
 *
 * Claude Code is why it exists at all. Shift+Tab is how its permission mode is
 * cycled, and a keyboard that cannot produce it is a keyboard that cannot
 * answer the question that session is asking.
 */
export const BACK_TAB = '\x1b[Z'

/** Off, armed for one keypress, or locked down until pressed again. */
export function cycleSticky(current: Sticky): Sticky {
  return current === 'off' ? 'once' : current === 'once' ? 'locked' : 'off'
}

/**
 * The sticky modifiers themselves, as state and the two send functions that
 * consume them.
 *
 * A hook rather than a copied block, because "does Alt survive this keypress"
 * is behaviour, not encoding, and the two rows that ask it must not be able to
 * answer differently. The caps and their arrangement stay with each surface.
 */
export interface StickyKeys {
  ctrl: Sticky
  alt: Sticky
  cycleCtrl: () => void
  cycleAlt: () => void
  /** A literal character, with whichever modifiers are armed applied. */
  sendChar: (char: string) => void
  /** Something that is already an escape sequence — modifiers don't apply. */
  sendRaw: (data: string) => void
}

export function useStickyKeys(onSend: (data: string) => void): StickyKeys {
  const [ctrl, setCtrl] = useState<Sticky>('off')
  const [alt, setAlt] = useState<Sticky>('off')

  const spend = (): void => {
    if (ctrl === 'once') setCtrl('off')
    if (alt === 'once') setAlt('off')
  }

  return {
    ctrl,
    alt,
    cycleCtrl: () => setCtrl(cycleSticky(ctrl)),
    cycleAlt: () => setAlt(cycleSticky(alt)),
    sendChar: (char: string): void => {
      let out = char
      if (ctrl !== 'off') out = ctrlOf(char) ?? char
      if (alt !== 'off') out = `\x1b${out}`
      onSend(out)
      spend()
    },
    sendRaw: (data: string): void => {
      onSend(data)
      spend()
    }
  }
}

export function KeyBar({ onSend, onCompose }: KeyBarProps): React.JSX.Element {
  const { ctrl, alt, cycleCtrl, cycleAlt, sendChar, sendRaw } = useStickyKeys(onSend)

  return (
    <div className="keybar" role="toolbar" aria-label="Terminal keys">
      <div className="keybar-row">
        <button
          type="button"
          className={`key mod mod-${ctrl}`}
          aria-pressed={ctrl !== 'off'}
          onClick={cycleCtrl}
        >
          Ctrl
        </button>
        <button
          type="button"
          className={`key mod mod-${alt}`}
          aria-pressed={alt !== 'off'}
          onClick={cycleAlt}
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
