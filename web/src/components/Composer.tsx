import { useEffect, useRef, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { imageFilesFromDataTransfer, isImageFile } from '../lib/image'

/**
 * The web app's input. A real `<textarea>`, so the OS cut/copy/paste and the
 * phone's long-press menu work. Attachments go through a file picker, not
 * xterm. Send writes the draft down the PTY as one shot.
 *
 * Spellcheck and autocapitalize stay on. The hidden xterm helper turns them
 * off because an IME double-fires into a TUI; this field is a normal box.
 */

export const BACK_TAB = '\x1b[Z'

export function Composer({
  draft,
  disabled,
  onDraft,
  onSend,
  onRaw,
  onImages,
  onPasteClick,
  onFocus,
  autoFocus
}: {
  draft: string
  disabled: boolean
  onDraft: (value: string) => void
  onSend: () => void
  onRaw: (data: string) => void
  onImages: (files: File[]) => void
  onPasteClick: () => void
  onFocus?: () => void
  autoFocus: boolean
}): ReactNode {
  const field = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (autoFocus) field.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const sync = (): void => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`)
    }
    vv.addEventListener('resize', sync)
    vv.addEventListener('scroll', sync)
    sync()
    return () => {
      vv.removeEventListener('resize', sync)
      vv.removeEventListener('scroll', sync)
      document.documentElement.style.removeProperty('--keyboard-inset')
    }
  }, [])

  useEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = '0px'
    const next = Math.min(Math.max(el.scrollHeight, 44), 140)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > 140 ? 'auto' : 'hidden'
  }, [draft])

  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    if (disabled || !draft.trim()) return
    onSend()
  }

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLFormElement>): void => {
    const files = imageFilesFromDataTransfer(event.clipboardData)
    if (!files.length) return
    event.preventDefault()
    onImages(files)
  }

  return (
    <form className="composer" data-region="compose" onSubmit={submit} onPaste={onPaste}>
      <div className="composer__card">
        <textarea
          ref={field}
          className="composer__input"
          rows={1}
          value={draft}
          disabled={disabled}
          placeholder="Write a message"
          enterKeyHint="send"
          autoCapitalize="sentences"
          autoCorrect="on"
          autoComplete="on"
          spellCheck
          onFocus={onFocus}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={onKey}
        />
        <div className="composer__tools">
          {/*
            A label, not a button that clicks a hidden input. iOS Safari
            refuses programmatic `.click()` on `input[hidden]`.
          */}
          <label
            className="composer__icon"
            title="Upload an image"
            aria-label="Upload an image"
            aria-disabled={disabled ? 'true' : undefined}
            onClick={(event) => {
              if (disabled) event.preventDefault()
            }}
          >
            <input
              className="composer__file"
              type="file"
              accept="image/*"
              multiple
              disabled={disabled}
              onChange={(event) => {
                const files = [...(event.target.files ?? [])].filter(isImageFile)
                event.target.value = ''
                if (files.length) onImages(files)
              }}
            />
            <Icon name="camera" size={15} />
          </label>
          <button
            type="button"
            className="composer__icon"
            disabled={disabled}
            title="Paste"
            aria-label="Paste"
            onClick={onPasteClick}
          >
            <Icon name="clipboard" size={15} />
          </button>
          <div className="composer__keys" role="toolbar" aria-label="Terminal keys">
            <Key label="Esc" onClick={() => onRaw('\x1b')} disabled={disabled} />
            <Key label="Tab" onClick={() => onRaw('\t')} disabled={disabled} />
            <Key label="Ctrl+C" onClick={() => onRaw('\x03')} disabled={disabled} />
            <Key label="Bypass" onClick={() => onRaw(BACK_TAB)} disabled={disabled} title="Shift+Tab — cycle permission mode" />
          </div>
          <button type="submit" className="composer__send" disabled={disabled || !draft.trim()} aria-label="Send">
            <Icon name="send" size={15} />
          </button>
        </div>
      </div>
    </form>
  )
}

function Key({
  label,
  onClick,
  disabled,
  title
}: {
  label: string
  onClick: () => void
  disabled: boolean
  title?: string
}): ReactNode {
  return (
    <button type="button" className="composer__key" onClick={onClick} disabled={disabled} title={title}>
      {label}
    </button>
  )
}
