import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { Icon } from '@/components/Icon'
import { imageFilesFromDataTransfer, isImageFile } from '../lib/image'
import { useMobile } from '../lib/mobile'

/**
 * The web app's input. A real `<textarea>`, so the OS cut/copy/paste, Gboard
 * dictation and the phone's long-press menu all work. Images picked, shot or
 * pasted wait as thumbnails above the box until Send, which sends them first
 * and the words after — one gesture, one turn.
 *
 * Spellcheck and autocapitalize stay on. The hidden xterm helper turns them
 * off because an IME double-fires into a TUI; this field is a normal box.
 */

export const BACK_TAB = '\x1b[Z'

const MAX_GROW_PX = 196

export function Composer({
  draft,
  disabled,
  disabledReason = 'Reconnecting…',
  to,
  onDraft,
  onSend,
  onRaw,
  onFocus,
  autoFocus
}: {
  draft: string
  disabled: boolean
  /** What the box says when it cannot send — inline, in the placeholder's place. */
  disabledReason?: string
  /** Who the words go to — "Claude Code · forge" — for the placeholder. */
  to?: string
  onDraft: (value: string) => void
  /** Send: the pending images first, then the draft. Either may be empty. */
  onSend: (images: File[]) => void
  onRaw: (data: string) => void
  onFocus?: () => void
  autoFocus: boolean
}): ReactNode {
  const field = useRef<HTMLTextAreaElement | null>(null)
  const mobile = useMobile()
  const [files, setFiles] = useState<File[]>([])

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
    const next = Math.min(Math.max(el.scrollHeight, 44), MAX_GROW_PX)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > MAX_GROW_PX ? 'auto' : 'hidden'
  }, [draft])

  const addFiles = useCallback((incoming: File[]) => {
    const images = incoming.filter(isImageFile)
    if (images.length) setFiles((current) => [...current, ...images])
  }, [])

  const hasDraft = draft.trim().length > 0 || files.length > 0
  const ready = !disabled

  // One button for Enter. With words in the box it sends them; with the box
  // empty it is the Enter key itself — what confirms the option ↑/↓ landed on
  // in a menu or a permission prompt — so the bar needs no separate Enter.
  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    if (!ready) return
    if (!hasDraft) {
      onRaw('\r')
      return
    }
    const pending = files
    setFiles([])
    onSend(pending)
  }

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLFormElement>): void => {
    const images = imageFilesFromDataTransfer(event.clipboardData)
    if (!images.length) return
    event.preventDefault()
    addFiles(images)
  }

  const placeholder = disabled ? disabledReason : to ? `Message ${to}` : 'Write a message'

  return (
    <form
      className="composer"
      data-region="compose"
      data-disabled={disabled ? 'true' : undefined}
      onSubmit={submit}
      onPaste={onPaste}
    >
      <div className="composer__card">
        {files.length ? (
          <Attachments
            files={files}
            onRemove={(index) => setFiles((current) => current.filter((_, i) => i !== index))}
          />
        ) : null}
        <textarea
          ref={field}
          className="composer__input"
          rows={1}
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
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
            Labels, not buttons that click a hidden input. iOS Safari refuses a
            programmatic `.click()` on `input[hidden]`.
          */}
          {mobile ? (
            <FilePick label="Take a photo" disabled={disabled} capture onFiles={addFiles}>
              <Icon name="camera" size={16} />
            </FilePick>
          ) : null}
          <FilePick label="Add an image" disabled={disabled} onFiles={addFiles}>
            {mobile ? <GalleryGlyph /> : <Icon name="camera" size={16} />}
          </FilePick>
          <div className="composer__keys" role="toolbar" aria-label="Terminal keys">
            <Key label="←" onClick={() => onRaw('\x1b[D')} disabled={disabled} title="Left" />
            <Key label="↑" onClick={() => onRaw('\x1b[A')} disabled={disabled} title="Up" />
            <Key label="↓" onClick={() => onRaw('\x1b[B')} disabled={disabled} title="Down" />
            <Key label="→" onClick={() => onRaw('\x1b[C')} disabled={disabled} title="Right" />
            <Key
              label="Mode"
              onClick={() => onRaw(BACK_TAB)}
              disabled={disabled}
              title="Shift+Tab — cycle permission mode"
            />
            <Key label="Tab" onClick={() => onRaw('\t')} disabled={disabled} />
            <Key label="Esc" onClick={() => onRaw('\x1b')} disabled={disabled} />
          </div>
          <button
            type="submit"
            className="composer__send"
            disabled={!ready}
            aria-label={hasDraft ? 'Send' : 'Enter'}
            title={hasDraft ? 'Send' : 'Enter'}
          >
            <Icon name="send" size={16} />
          </button>
        </div>
      </div>
    </form>
  )
}

/* ------------------------------------------------------------- attachments */

function Attachments({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }): ReactNode {
  const urls = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files])
  useEffect(() => () => urls.forEach((url) => URL.revokeObjectURL(url)), [urls])
  return (
    <div className="composer__attach" role="list" aria-label="Images to send">
      {files.map((file, i) => (
        <div className="composer__thumb" role="listitem" key={`${file.name}-${file.lastModified}-${i}`}>
          <img src={urls[i]} alt={file.name} />
          <button
            type="button"
            className="composer__thumb-x"
            aria-label={`Remove ${file.name}`}
            onClick={() => onRemove(i)}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}

function FilePick({
  label,
  disabled,
  capture,
  onFiles,
  children
}: {
  label: string
  disabled: boolean
  capture?: boolean
  onFiles: (files: File[]) => void
  children: ReactNode
}): ReactNode {
  return (
    <label
      className="composer__icon"
      title={label}
      aria-label={label}
      aria-disabled={disabled ? 'true' : undefined}
      onClick={(event) => {
        if (disabled) event.preventDefault()
      }}
    >
      <input
        className="composer__file"
        type="file"
        accept="image/*"
        multiple={!capture}
        capture={capture ? 'environment' : undefined}
        disabled={disabled}
        onChange={(event) => {
          const picked = [...(event.target.files ?? [])]
          event.target.value = ''
          if (picked.length) onFiles(picked)
        }}
      />
      {children}
    </label>
  )
}

/** A picture frame, drawn on the Icon set's 16×16 / 1.4px grid. */
function GalleryGlyph(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2.5" y="3" width="11" height="10" rx="1.6" />
      <circle cx="6" cy="6.5" r="1.1" />
      <path d="M2.8 11.6l3.2-3.1 2.3 2.1 2.2-2.6 2.7 3.4" />
    </svg>
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
    <button type="button" className="composer__key" onClick={onClick} disabled={disabled} title={title ?? label}>
      {label}
    </button>
  )
}
