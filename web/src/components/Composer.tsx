import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { Icon } from '@/components/Icon'
import { Popover, PopoverDivider, PopoverRow, PopoverSection } from '@/components/Popover'
import type { ClaudePermissionMode } from '@shared/types'
import type { AgentModelSpec, EffortLevel, EffortLevelSpec, PermissionModeSpec } from '@shared/agents'
import { allFilesFromDataTransfer, formatFileSize, isImageFile } from '../lib/file'
import { useMobile } from '../lib/mobile'

/**
 * The web app's input. A real `<textarea>`, so the OS cut/copy/paste, Gboard
 * dictation and the phone's long-press menu all work. Images picked, shot or
 * pasted wait as thumbnails above the box until Send, which sends them first
 * and the words after — one gesture, one turn.
 *
 * Model, Effort and Mode sit just above the textarea — not in the arrow row —
 * and each opens a dropdown of *this* pane's own rungs. A shell has none. A
 * phone has no room for three of them, so it wears one chip — the pane's model
 * name, coloured by its permission mode — opening all three lists in one sheet.
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
  models,
  currentModelId,
  onModel,
  effortLevels,
  onEffort,
  modes,
  currentModeId,
  onMode,
  onFocus,
  autoFocus,
  onNotice,
  onVoice,
  voicePhase = 'idle'
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
  /**
   * The models this pane's CLI lists, in that CLI's own words. Empty / absent
   * means the Model chip stays off — Grok's "Grok 4.6" and Claude's "Opus"
   * are different rows of the same table.
   */
  models?: AgentModelSpec[]
  currentModelId?: string | null
  onModel?: (id: string) => void
  /**
   * The rungs this pane's CLI actually lists. Empty / absent means the Effort
   * chip stays off the composer — we do not offer Claude's words for a tool
   * that does not speak them.
   */
  effortLevels?: EffortLevelSpec[]
  onEffort?: (level: EffortLevel) => void
  /**
   * The permission ladder this pane's CLI lists, in that CLI's own words.
   * Empty / absent means the Mode chip stays off. Codex's "Full auto" and
   * Grok's "Bypass" are different rows of the same table.
   */
  modes?: PermissionModeSpec[]
  /** The rung the status strip currently reports, when Forge recognises it. */
  currentModeId?: ClaudePermissionMode | null
  onMode?: (id: ClaudePermissionMode) => void
  onFocus?: () => void
  autoFocus: boolean
  onNotice?: (message: string) => void
  /**
   * The mic button. First press records on this device's microphone, second
   * press sends the recording to the desktop for words, which then go to the
   * pane as a typed message. Absent when this browser cannot record.
   */
  onVoice?: () => void
  /** Where that round trip is — the button and placeholder say so. */
  voicePhase?: 'idle' | 'recording' | 'transcribing'
}): ReactNode {
  const field = useRef<HTMLTextAreaElement | null>(null)
  const mobile = useMobile()
  const [files, setFiles] = useState<File[]>([])
  /**
   * Armed by the key row's Ctrl and spent on the next letter typed — the one
   * chord a phone keyboard cannot send itself. Ctrl+C, Ctrl+D and the rest of
   * the TUI vocabulary travel as their control codes (`\x03`, `\x04`…), which
   * is `String.fromCharCode(letter − 64)` and nothing more.
   */
  const [ctrl, setCtrl] = useState(false)
  /**
   * Which of the chips above the box is open. One at a time — and on a phone
   * there is only one chip, `'all'`, whose sheet holds all three sections.
   */
  const [openPick, setOpenPick] = useState<'model' | 'effort' | 'mode' | 'all' | 'attach' | null>(null)
  const modelRef = useRef<HTMLButtonElement | null>(null)
  const effortRef = useRef<HTMLButtonElement | null>(null)
  const modeRef = useRef<HTMLButtonElement | null>(null)
  const allRef = useRef<HTMLButtonElement | null>(null)
  const attachRef = useRef<HTMLButtonElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [pickedEffort, setPickedEffort] = useState<EffortLevel | null>(null)
  const [pickedModel, setPickedModel] = useState<string | null>(null)

  const modelList = models ?? []
  const effortList = effortLevels ?? []
  const modeList = modes ?? []
  const showPicks =
    (onModel && modelList.length > 0) || (onEffort && effortList.length > 0) || (onMode && modeList.length > 0)
  const activeModelId = pickedModel ?? currentModelId
  const currentModel = activeModelId ? (modelList.find((m) => m.id === activeModelId) ?? null) : null
  const currentMode = currentModeId ? (modeList.find((m) => m.id === currentModeId) ?? null) : null
  const effortLabel = pickedEffort ? (effortList.find((l) => l.id === pickedEffort)?.label ?? null) : null

  useEffect(() => {
    setPickedModel(null)
  }, [currentModelId])

  /** Bypass is red, plan is blue, accept-edits is green — on whichever chip carries the mode. */
  const modeTone =
    currentModeId === 'bypass'
      ? 'bypass'
      : currentModeId === 'plan'
        ? 'plan'
        : currentModeId === 'acceptEdits'
          ? 'accept-edits'
          : undefined

  /*
   * The three lists, written once. A phone stacks all three into one sheet
   * behind a single chip; a desktop keeps a chip and a sheet per list.
   */
  const modelSection =
    onModel && modelList.length ? (
      <PopoverSection title="Model">
        {modelList.map((model) => (
          <PopoverRow
            key={model.id}
            selected={model.id === (pickedModel ?? currentModelId)}
            onClick={() => {
              setOpenPick(null)
              setPickedModel(model.id)
              onModel(model.id)
            }}
          >
            <span className="ceffort">
              <strong className="ceffort__label">{model.label}</strong>
              {model.note ? <span className="ceffort__note">{model.note}</span> : null}
            </span>
          </PopoverRow>
        ))}
      </PopoverSection>
    ) : null
  const effortSection =
    onEffort && effortList.length ? (
      <PopoverSection title="Effort">
        {effortList.map((level) => (
          <PopoverRow
            key={level.id}
            selected={level.id === pickedEffort}
            onClick={() => {
              setOpenPick(null)
              setPickedEffort(level.id)
              onEffort(level.id)
            }}
          >
            <span className="ceffort">
              <strong className="ceffort__label">{level.label}</strong>
              <span className="ceffort__note">{level.note}</span>
            </span>
          </PopoverRow>
        ))}
      </PopoverSection>
    ) : null
  const modeSection =
    onMode && modeList.length ? (
      <PopoverSection title="Mode">
        {modeList.map((mode) => (
          <PopoverRow
            key={mode.id}
            selected={mode.id === currentModeId}
            danger={mode.danger}
            onClick={() => {
              setOpenPick(null)
              onMode(mode.id)
            }}
          >
            <span className="ceffort">
              <strong className="ceffort__label">{mode.label}</strong>
              <span className="ceffort__note">{mode.note}</span>
            </span>
          </PopoverRow>
        ))}
      </PopoverSection>
    ) : null
  /*
   * What the phone's one chip says. The model is the most identifying thing a
   * pane has, so it goes first; a pane with no model roster falls back to its
   * mode, then its effort — the same words the three desktop chips wear.
   */
  const allLabel = modelSection
    ? (currentModel?.label ?? 'Model')
    : modeSection
      ? (currentMode?.label ?? 'Mode')
      : (effortLabel ?? 'Effort')

  useEffect(() => {
    if (autoFocus) field.current?.focus()
  }, [autoFocus])

  /*
   * The keyboard used to lift this dock via `--keyboard-inset` (innerHeight
   * minus the visual viewport). The shell is the visual viewport now — see
   * lib/viewport.ts — so that difference is already the height, and padding
   * it again would sit the box above a gap. `--keyboard-inset` stays 0.
   */

  useEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = '0px'
    const next = Math.min(Math.max(el.scrollHeight, 44), MAX_GROW_PX)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > MAX_GROW_PX ? 'auto' : 'hidden'
  }, [draft])

  const addFiles = useCallback((incoming: File[]) => {
    if (incoming.length) setFiles((current) => [...current, ...incoming])
  }, [])

  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const picked = [...(event.target.files ?? [])]
    event.target.value = ''
    if (picked.length) addFiles(picked)
  }

  const hasDraft = draft.trim().length > 0 || files.length > 0
  const ready = !disabled

  // One button for Enter. With words in the box it sends them; with the box
  // empty it is the Enter key itself — what confirms the option ↑/↓ landed on
  // in a menu or a permission prompt — so the bar needs no separate Enter.
  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    if (!ready) return
    const trimmed = draft.trim().toLowerCase()
    if (trimmed === '/voice' || trimmed === '/talk' || trimmed === '/dictate' || trimmed === '/record' || trimmed === '/dictation') {
      onDraft('')
      if (onVoice) onVoice()
      else onNotice?.('This browser cannot record from a microphone.')
      return
    }
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
      return
    }
    // The chord itself. One letter, armed Ctrl, one code down the PTY — and
    // the arm clears whether or not the letter was one anybody meant, because
    // a chord is one keystroke by definition.
    if (ctrl && /^[a-z]$/i.test(event.key)) {
      event.preventDefault()
      onRaw(String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64))
      setCtrl(false)
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLFormElement>): void => {
    const pasted = allFilesFromDataTransfer(event.clipboardData)
    if (!pasted.length) return
    event.preventDefault()
    addFiles(pasted)
  }

  const placeholder = disabled
    ? disabledReason
    : voicePhase === 'recording'
      ? 'Listening… press the mic again to send'
      : voicePhase === 'transcribing'
        ? 'Working out the words…'
        : to
          ? `Message ${to}`
          : 'Write a message'

  return (
    <form
      className="composer"
      data-region="compose"
      data-disabled={disabled ? 'true' : undefined}
      onSubmit={submit}
      onPaste={onPaste}
    >
      <input
        ref={cameraInputRef}
        className="composer__file"
        type="file"
        accept="image/*"
        capture="environment"
        disabled={disabled}
        onChange={onFileInputChange}
      />
      <input
        ref={imageInputRef}
        className="composer__file"
        type="file"
        accept="image/*"
        multiple
        disabled={disabled}
        onChange={onFileInputChange}
      />
      <input
        ref={fileInputRef}
        className="composer__file"
        type="file"
        accept="*/*"
        multiple
        disabled={disabled}
        onChange={onFileInputChange}
      />
      <div className="composer__card">
        {showPicks ? (
          <div className="composer__picks" role="toolbar" aria-label="Agent settings">
            {mobile ? (
              <>
                <button
                  ref={allRef}
                  type="button"
                  className="composer__pick"
                  data-active={openPick === 'all' ? 'true' : undefined}
                  data-mode={modeTone}
                  aria-haspopup="menu"
                  aria-expanded={openPick === 'all'}
                  onClick={() => setOpenPick((v) => (v === 'all' ? null : 'all'))}
                  disabled={disabled}
                  title="Model, effort and permissions for this pane"
                >
                  <span className="composer__pick-label">{allLabel}</span>
                  <Icon name="chevronDown" size={10} />
                </button>
                <Popover
                  anchor={allRef.current}
                  open={openPick === 'all'}
                  onClose={() => setOpenPick(null)}
                  align="start"
                  side="top"
                  width={272}
                  label="Agent settings"
                >
                  {modelSection}
                  {modelSection && (effortSection || modeSection) ? <PopoverDivider /> : null}
                  {effortSection}
                  {effortSection && modeSection ? <PopoverDivider /> : null}
                  {modeSection}
                </Popover>
              </>
            ) : null}
            {!mobile && onModel && modelList.length ? (
              <button
                ref={modelRef}
                type="button"
                className="composer__pick"
                data-active={openPick === 'model' ? 'true' : undefined}
                aria-haspopup="menu"
                aria-expanded={openPick === 'model'}
                onClick={() => setOpenPick((v) => (v === 'model' ? null : 'model'))}
                disabled={disabled}
                title="Model — which model this pane is talking to"
              >
                {currentModel?.label ?? 'Model'}
                <Icon name="chevronDown" size={10} />
              </button>
            ) : null}
            {!mobile && onEffort && effortList.length ? (
              <button
                ref={effortRef}
                type="button"
                className="composer__pick"
                data-active={openPick === 'effort' ? 'true' : undefined}
                aria-haspopup="menu"
                aria-expanded={openPick === 'effort'}
                onClick={() => setOpenPick((v) => (v === 'effort' ? null : 'effort'))}
                disabled={disabled}
                title="Effort — how hard the model works on the next turns"
              >
                {effortLabel ?? 'Effort'}
                <Icon name="chevronDown" size={10} />
              </button>
            ) : null}
            {!mobile && onMode && modeList.length ? (
              <button
                ref={modeRef}
                type="button"
                className="composer__pick"
                data-active={openPick === 'mode' ? 'true' : undefined}
                data-mode={modeTone}
                aria-haspopup="menu"
                aria-expanded={openPick === 'mode'}
                onClick={() => setOpenPick((v) => (v === 'mode' ? null : 'mode'))}
                disabled={disabled}
                title="Permission mode — how much this agent may do without asking"
              >
                {currentMode?.label ?? 'Mode'}
                <Icon name="chevronDown" size={10} />
              </button>
            ) : null}
            {!mobile && modelSection ? (
              <Popover
                anchor={modelRef.current}
                open={openPick === 'model'}
                onClose={() => setOpenPick(null)}
                align="start"
                side="top"
                width={272}
                label="Model"
              >
                {modelSection}
              </Popover>
            ) : null}
            {!mobile && effortSection ? (
              <Popover
                anchor={effortRef.current}
                open={openPick === 'effort'}
                onClose={() => setOpenPick(null)}
                align="start"
                side="top"
                width={272}
                label="Effort"
              >
                {effortSection}
              </Popover>
            ) : null}
            {!mobile && modeSection ? (
              <Popover
                anchor={modeRef.current}
                open={openPick === 'mode'}
                onClose={() => setOpenPick(null)}
                align="start"
                side="top"
                width={272}
                label="Mode"
              >
                {modeSection}
              </Popover>
            ) : null}
          </div>
        ) : null}
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
          <button
            ref={attachRef}
            type="button"
            className="composer__icon"
            data-active={openPick === 'attach' ? 'true' : undefined}
            disabled={disabled}
            aria-haspopup="menu"
            aria-expanded={openPick === 'attach'}
            onClick={() => setOpenPick((v) => (v === 'attach' ? null : 'attach'))}
            title="Attach a photo, image or file"
            aria-label="Attach"
          >
            <Icon name="paperclip" size={16} />
          </button>
          <Popover
            anchor={attachRef.current}
            open={openPick === 'attach'}
            onClose={() => setOpenPick(null)}
            align="start"
            side="top"
            width={168}
            label="Attach options"
          >
            <PopoverRow
              onClick={() => {
                setOpenPick(null)
                cameraInputRef.current?.click()
              }}
            >
              <Icon name="camera" size={15} />
              <span>Take photo</span>
            </PopoverRow>
            <PopoverRow
              onClick={() => {
                setOpenPick(null)
                imageInputRef.current?.click()
              }}
            >
              <Icon name="image" size={15} />
              <span>Upload image</span>
            </PopoverRow>
            <PopoverRow
              onClick={() => {
                setOpenPick(null)
                fileInputRef.current?.click()
              }}
            >
              <Icon name="file" size={15} />
              <span>Upload file</span>
            </PopoverRow>
          </Popover>
          {onVoice ? (
            <button
              type="button"
              className="composer__icon composer__mic-btn"
              data-listening={voicePhase === 'recording' ? 'true' : undefined}
              data-busy={voicePhase === 'transcribing' ? 'true' : undefined}
              disabled={disabled}
              onClick={onVoice}
              title={
                voicePhase === 'recording'
                  ? 'Stop and send'
                  : voicePhase === 'transcribing'
                    ? 'Working out the words…'
                    : 'Dictate (/voice)'
              }
              aria-label={voicePhase === 'recording' ? 'Stop dictation and send' : 'Dictate'}
              aria-pressed={voicePhase === 'recording'}
            >
              <Icon name={voicePhase === 'idle' ? 'mic' : 'voice'} size={16} />
            </button>
          ) : null}
          <div className="composer__keys" role="toolbar" aria-label="Terminal keys">
            <Key label="←" onClick={() => onRaw('\x1b[D')} disabled={disabled} title="Left" />
            <Key label="↑" onClick={() => onRaw('\x1b[A')} disabled={disabled} title="Up" />
            <Key label="↓" onClick={() => onRaw('\x1b[B')} disabled={disabled} title="Down" />
            <Key label="→" onClick={() => onRaw('\x1b[C')} disabled={disabled} title="Right" />
            <Key label="Tab" onClick={() => onRaw('\t')} disabled={disabled} />
            <Key
              label="Ctrl"
              onClick={() => setCtrl((v) => !v)}
              disabled={disabled}
              active={ctrl}
              title={ctrl ? 'Ctrl armed — next letter sends its control code' : 'Ctrl — tap, then a letter (C, D, L, U…)'}
            />
            <Key label="Esc" onClick={() => onRaw('\x1b')} disabled={disabled} />
          </div>
          <button
            type="submit"
            className="composer__send"
            data-draft={hasDraft ? 'true' : 'false'}
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
  const urls = useMemo(() => files.map((file) => (isImageFile(file) ? URL.createObjectURL(file) : '')), [files])
  useEffect(() => () => urls.forEach((url) => (url ? URL.revokeObjectURL(url) : undefined)), [urls])
  return (
    <div className="composer__attach" role="list" aria-label="Attachments to send">
      {files.map((file, i) => {
        const isImg = isImageFile(file)
        const ext = file.name.split('.').pop()?.toUpperCase() ?? 'FILE'
        return (
          <div className="composer__thumb" role="listitem" key={`${file.name}-${file.lastModified}-${i}`}>
            {isImg && urls[i] ? (
              <img src={urls[i]} alt={file.name} />
            ) : (
              <div className="composer__thumb-doc" title={`${file.name} (${formatFileSize(file.size)})`}>
                <Icon name="file" size={20} />
                <span className="composer__thumb-ext">{ext}</span>
                <span className="composer__thumb-name">{file.name}</span>
              </div>
            )}
            <button
              type="button"
              className="composer__thumb-x"
              aria-label={`Remove ${file.name}`}
              onClick={() => onRemove(i)}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

function Key({
  label,
  onClick,
  disabled,
  active,
  title
}: {
  label: string
  onClick: () => void
  disabled: boolean
  /** A latched key — armed Ctrl — rather than one that fires and is done. */
  active?: boolean
  title?: string
}): ReactNode {
  return (
    <button
      type="button"
      className="composer__key"
      data-active={active ? 'true' : undefined}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
    >
      {label}
    </button>
  )
}
