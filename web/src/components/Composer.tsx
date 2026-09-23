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
  type MouseEvent,
  type PointerEvent,
  type ReactNode
} from 'react'
import { Icon } from '@/components/Icon'
import { Popover, PopoverDivider, PopoverRow, PopoverSection } from '@/components/Popover'
import { VoiceMeter } from './VoiceMeter'
import type { ClaudePermissionMode } from '@shared/types'
import type { AgentModelSpec, EffortLevel, EffortLevelSpec, PermissionModeSpec } from '@shared/agents'
import type { VoiceMode, VoiceState } from '../lib/dictate'
import { allFilesFromDataTransfer, formatFileSize, isImageFile } from '../lib/file'
import { useMobile } from '../lib/mobile'
import type { LevelMonitor } from '../lib/voice-level'
import './Composer.css'

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
 *
 * On a phone the mic is the button at the bottom right, and it becomes Send
 * the moment the box holds words (Stop while the agent works, with the mic
 * beside it). Keyboard Enter is a new line there — a soft keyboard has no
 * Shift+Enter — and only the button sends.
 */

export const BACK_TAB = '\x1b[Z'

const IDLE_VOICE: VoiceState = { phase: 'idle' }

const MAX_GROW_PX = 196

/** A press on the mic shorter than this is a tap (toggle); longer is hold-to-talk. */
export const HOLD_MS = 300
/** Sliding this far left while holding arms "Release to cancel". */
export const CANCEL_SLIDE_PX = 80
/** How long a composing keyboard gets to re-commit a chord's letter before it counts as typing. */
const CHORD_ECHO_MS = 1500

/** What the mic can be asked to do. Absent when this browser cannot record. */
export interface VoiceControls {
  /** A press began on an idle mic: open the microphone and record (tap mode). */
  start: () => void
  /** The press became a hold (≥ HOLD_MS), or a hold fell back to tap (`'tap'`). */
  mode: (mode: VoiceMode) => void
  /** Stop recording and work out the words. */
  stop: () => void
  /** Throw away the recording, or abandon the transcription — nothing is sent. */
  cancel: () => void
  /** Stop the review countdown; the words stay in the box to edit. */
  undo: () => void
}

/** "0:07" — minutes and seconds since `since`. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * A running number, re-rendered on its own a few times a second so nothing
 * above it re-renders for the clock. `to` counts down to a moment, `since`
 * counts up from one.
 */
function Ticker({ since, to }: { since?: number; to?: number }): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), to !== undefined ? 100 : 250)
    return () => window.clearInterval(id)
  }, [to])
  if (to !== undefined) {
    return <span className="composer__voice-clock">{(Math.max(0, to - now) / 1000).toFixed(1)} s</span>
  }
  return <span className="composer__voice-clock">{clock(now - (since ?? now))}</span>
}

export function Composer({
  draft,
  disabled,
  disabledReason = 'Reconnecting…',
  to,
  onDraft,
  onSend,
  onRaw,
  onStop,
  stopping = false,
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
  focusSignal = 0,
  placeholder: placeholderOverride,
  sending = null,
  onNotice,
  voice: voiceControls,
  voiceState = IDLE_VOICE,
  voiceLevel = null
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
   * Interrupt the agent. Present only while there is something to stop; with
   * the box and the attachments empty, Send wears it instead — a draft still
   * sends, so a message can be queued while the agent works.
   */
  onStop?: () => void
  /** Stop was pressed and the agent has not gone idle yet. */
  stopping?: boolean
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
  /** Focus the box when this turns true. The live app passes false and uses `focusSignal`. */
  autoFocus: boolean
  /**
   * Focus the box each time this number changes (never on mount). Bumped
   * only after a gesture — never by a reconnect, which on Android would pop
   * the keyboard over whatever Steve was reading.
   */
  focusSignal?: number
  /** The box's words when it can send and no dictation is running — "Tell Foreman…". */
  placeholder?: string
  /**
   * A send is in flight: Send stays disabled until the upload and the write
   * are done. `total` counts attachments; with any, the button reads
   * "Sending 1/2…" (`done` is the one on its way).
   */
  sending?: { done: number; total: number } | null
  onNotice?: (message: string) => void
  /**
   * The mic. Tap to toggle, hold to talk (release sends, slide left cancels).
   * Absent when this browser cannot record.
   */
  voice?: VoiceControls
  /** Where the dictation is — recording, transcribing, the review countdown. */
  voiceState?: VoiceState
  /** The open microphone's loudness while recording; the meter draws from it. */
  voiceLevel?: LevelMonitor | null
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

  useEffect(() => {
    if (focusSignal) field.current?.focus()
  }, [focusSignal])

  /*
   * The chord's letter, read from what the keyboard *typed* rather than from
   * keydown: Gboard and most Android keyboards report every soft key as
   * `Unidentified` (keyCode 229), so the letter only exists in `beforeinput`.
   * Where that event cannot be cancelled (a composing IME), `onChange` below
   * takes the letter back out of the box instead.
   */
  const ctrlRef = useRef(false)
  ctrlRef.current = ctrl
  /** The chord's letter, still inside a keyboard's composition, due to be committed again. */
  const chordEcho = useRef<{ letter: string; at: number; until: number } | null>(null)
  const onRawRef = useRef(onRaw)
  onRawRef.current = onRaw
  useEffect(() => {
    const el = field.current
    if (!el) return
    const onBeforeInput = (event: InputEvent): void => {
      if (!ctrlRef.current || !event.cancelable) return
      const letter = event.data ?? ''
      if (!/^[a-z]$/i.test(letter)) return
      event.preventDefault()
      onRawRef.current(controlCode(letter))
      setCtrl(false)
    }
    el.addEventListener('beforeinput', onBeforeInput)
    return () => el.removeEventListener('beforeinput', onBeforeInput)
  }, [])

  /** Slid left far enough while holding the mic: releasing now throws the recording away. */
  const [cancelArmed, setCancelArmed] = useState(false)
  useEffect(() => {
    if (voiceState.phase !== 'recording') setCancelArmed(false)
  }, [voiceState.phase])

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
  const busySending = sending !== null
  /**
   * The button, not the keyboard: a keyboard Enter on an empty box stays the
   * Enter key, and only a tap on the button interrupts.
   */
  const stopMode = onStop !== undefined && !hasDraft
  const phase = voiceState.phase
  const reviewing = phase === 'review'
  /**
   * The phone's bottom-right button is the mic whenever there is nothing to
   * send — and stays the mic, the same element, for as long as a dictation
   * runs, so a finger holding it keeps its pointer capture.
   */
  const micPrimary =
    mobile &&
    voiceControls !== undefined &&
    (phase === 'recording' || phase === 'transcribing' || (!hasDraft && !busySending))
  /** The desktop keeps the mic up in the chip row. */
  const micInPicks = !mobile && voiceControls !== undefined

  // One button for Enter. With words in the box it sends them; with the box
  // empty it is the Enter key itself — what confirms the option ↑/↓ landed on
  // in a menu or a permission prompt — so the bar needs no separate Enter.
  // (On a phone with a mic the empty-box button is the mic, and Enter lives in
  // the Terminal view's key row.)
  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    if (!ready || busySending) return
    const trimmed = draft.trim().toLowerCase()
    if (trimmed === '/voice' || trimmed === '/talk' || trimmed === '/dictate' || trimmed === '/record' || trimmed === '/dictation') {
      onDraft('')
      if (voiceControls) voiceControls.start()
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
    if (reviewing) voiceControls?.undo()
    // A phone's Enter is a new line: its keyboard has no Shift+Enter, so the
    // button is the only way to send there. A desktop keeps Enter-to-send.
    if (event.key === 'Enter' && !event.shiftKey && !mobile) {
      event.preventDefault()
      submit()
      return
    }
    // The chord itself, from a real keyboard. One letter, armed Ctrl, one code
    // down the PTY — and the arm clears whether or not the letter was one
    // anybody meant, because a chord is one keystroke by definition. A soft
    // keyboard's letter arrives through `beforeinput` / `onChange` instead.
    if (ctrl && /^[a-z]$/i.test(event.key)) {
      event.preventDefault()
      onRaw(controlCode(event.key))
      setCtrl(false)
    }
  }

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const next = event.target.value
    /** `next` is `draft` with one letter added at `at` — and that letter, or ''. */
    const added = (at: number): string =>
      next.length === draft.length + 1 && next.slice(0, at) + next.slice(at + 1) === draft ? (next[at] ?? '') : ''
    // A composing keyboard commits the chord's letter a second time when its
    // composition ends; that echo is not a keystroke.
    const echo = chordEcho.current
    if (echo) {
      chordEcho.current = null
      if (Date.now() < echo.until && added(echo.at).toLowerCase() === echo.letter) {
        event.target.value = draft
        return
      }
    }
    // Armed Ctrl and one letter more than before: that letter was the chord.
    if (ctrl && next.length === draft.length + 1) {
      let at = 0
      while (at < draft.length && draft[at] === next[at]) at++
      const letter = added(at)
      if (/^[a-z]$/i.test(letter)) {
        onRaw(controlCode(letter))
        setCtrl(false)
        if ((event.nativeEvent as InputEvent).inputType === 'insertCompositionText') {
          chordEcho.current = { letter: letter.toLowerCase(), at, until: Date.now() + CHORD_ECHO_MS }
        }
        event.target.value = draft
        return
      }
    }
    onDraft(next)
  }

  const armCtrl = (): void => {
    // The letter comes off the keyboard, so arming brings the keyboard up.
    if (!ctrl) field.current?.focus()
    setCtrl(!ctrl)
  }

  const onPaste = (event: ClipboardEvent<HTMLFormElement>): void => {
    const pasted = allFilesFromDataTransfer(event.clipboardData)
    if (!pasted.length) return
    event.preventDefault()
    addFiles(pasted)
  }

  const placeholder = disabled
    ? disabledReason
    : phase === 'recording'
      ? 'Listening… press the mic again to send'
      : phase === 'transcribing'
        ? 'Working out the words…'
        : placeholderOverride
          ? placeholderOverride
          : to
            ? `Message ${to}`
            : 'Write a message'

  const mic = voiceControls ? (
    <MicButton
      key="mic"
      controls={voiceControls}
      state={voiceState}
      analyser={voiceLevel?.analyser ?? null}
      disabled={disabled}
      primary={mobile}
      cancelArmed={cancelArmed}
      onCancelArmed={setCancelArmed}
    />
  ) : null

  return (
    <form
      className="composer"
      data-region="compose"
      data-disabled={disabled ? 'true' : undefined}
      data-voice={phase}
      data-voice-mode={phase === 'recording' ? voiceState.mode : undefined}
      data-cancel-armed={cancelArmed ? 'true' : undefined}
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
        {showPicks || micInPicks ? (
          <div className="composer__picks" role="toolbar" aria-label="Agent settings">
            {mobile && showPicks ? (
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
            {micInPicks ? mic : null}
          </div>
        ) : null}
        {voiceControls && phase !== 'idle' ? (
          <VoicePanel
            state={voiceState}
            controls={voiceControls}
            analyser={voiceLevel?.analyser ?? null}
            cancelArmed={cancelArmed}
          />
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
          enterKeyHint={mobile ? 'enter' : 'send'}
          autoCapitalize="sentences"
          autoCorrect="on"
          autoComplete="on"
          spellCheck
          onFocus={() => {
            // Tapping into the words while they wait to send is Undo.
            if (reviewing) voiceControls?.undo()
            onFocus?.()
          }}
          onPointerDown={reviewing ? () => voiceControls?.undo() : undefined}
          onChange={onChange}
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
          {/* Esc first: it is the key a phone needs most, and the end of a
              scrolling row is where it used to hide. Enter is here because on
              a phone the empty box's button is the mic, not Enter. */}
          <div className="composer__keys" role="toolbar" aria-label="Terminal keys">
            <Key label="Esc" onClick={() => onRaw('\x1b')} disabled={disabled} title="Esc" />
            <Key label="Tab" onClick={() => onRaw('\t')} disabled={disabled} title="Tab" />
            <Key
              label={ctrl ? 'Ctrl on' : 'Ctrl'}
              onClick={armCtrl}
              disabled={disabled}
              active={ctrl}
              title={ctrl ? 'Ctrl on — the next letter sends its control code' : 'Ctrl — tap, then a letter (C, D, L, U…)'}
            />
            <Key label="←" onClick={() => onRaw('\x1b[D')} disabled={disabled} title="Left" />
            <Key label="↑" onClick={() => onRaw('\x1b[A')} disabled={disabled} title="Up" />
            <Key label="↓" onClick={() => onRaw('\x1b[B')} disabled={disabled} title="Down" />
            <Key label="→" onClick={() => onRaw('\x1b[C')} disabled={disabled} title="Right" />
            {mobile && voiceControls ? (
              <Key label="Enter" onClick={() => onRaw('\r')} disabled={disabled} title="Enter" />
            ) : null}
          </div>
          {micPrimary && phase !== 'idle' ? null : stopMode ? (
            <button
              type="button"
              className="composer__send"
              data-draft="false"
              data-stop={stopping ? 'stopping' : 'true'}
              disabled={!ready}
              onClick={onStop}
              aria-label={stopping ? 'Stopping' : 'Stop'}
              title={stopping ? 'Stopping… — tap to send Esc again' : 'Stop — interrupt the agent (Esc)'}
            >
              <span className="composer__stop-square" aria-hidden="true" />
              <span>{stopping ? 'Stopping…' : 'Stop'}</span>
            </button>
          ) : micPrimary ? null : (
            <button
              type="submit"
              className="composer__send"
              data-draft={hasDraft ? 'true' : 'false'}
              data-sending={busySending ? 'true' : undefined}
              disabled={!ready || busySending}
              aria-label={busySending ? 'Sending' : hasDraft ? 'Send' : 'Enter'}
              title={busySending ? 'Sending…' : hasDraft ? 'Send' : 'Enter'}
            >
              {sending && sending.total > 0 ? (
                <span className="composer__send-progress">
                  Sending {sending.done}/{sending.total}…
                </span>
              ) : (
                <Icon name="send" size={16} />
              )}
            </button>
          )}
          {/* Its own slot, always last: the element survives every state a
              dictation passes through, so a hold keeps its pointer. */}
          {micPrimary ? mic : null}
        </div>
      </div>
    </form>
  )
}

/** Ctrl+letter as the byte a terminal reads: C → `\x03`. */
function controlCode(letter: string): string {
  return String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64)
}

/* --------------------------------------------------------------------- mic */

/**
 * The mic: a press shorter than HOLD_MS is a tap and toggles recording; a
 * longer one is hold-to-talk — it records while held and release stops it.
 * While holding, sliding left CANCEL_SLIDE_PX arms "Release to cancel".
 *
 * Recording starts on the press itself, not the release, so the first word of
 * a hold is not lost; a short press simply leaves it running as a tap. The
 * pointer is captured so a finger that wanders off the button still counts.
 * A cancelled pointer (the system took the gesture) never throws words away
 * and never sends: an armed cancel cancels, anything else falls back to tap
 * mode and waits for Cancel or Send.
 */
function MicButton({
  controls,
  state,
  analyser,
  disabled,
  primary,
  cancelArmed,
  onCancelArmed
}: {
  controls: VoiceControls
  state: VoiceState
  analyser: AnalyserNode | null
  disabled: boolean
  /** The phone's big bottom-right button, which says what it does in words. */
  primary: boolean
  cancelArmed: boolean
  onCancelArmed: (armed: boolean) => void
}): ReactNode {
  const press = useRef<{ x: number; fresh: boolean; hold: boolean; timer: number } | null>(null)
  const armed = useRef(false)
  armed.current = cancelArmed
  useEffect(() => () => window.clearTimeout(press.current?.timer), [])
  const phase = state.phase
  const mode = phase === 'recording' ? state.mode : null

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (disabled || (event.pointerType === 'mouse' && event.button !== 0)) return
    if (phase !== 'idle' && phase !== 'recording') return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // A pointer the browser will not capture still works while it stays on the button.
    }
    window.clearTimeout(press.current?.timer)
    if (phase === 'idle') {
      const next = { x: event.clientX, fresh: true, hold: false, timer: 0 }
      next.timer = window.setTimeout(() => {
        next.hold = true
        controls.mode('hold')
      }, HOLD_MS)
      press.current = next
      controls.start()
    } else {
      // A press on a running tap-mode recording is the tap that stops it.
      press.current = { x: event.clientX, fresh: false, hold: false, timer: 0 }
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const p = press.current
    if (!p?.hold) return
    const slid = p.x - event.clientX >= CANCEL_SLIDE_PX
    if (slid !== armed.current) onCancelArmed(slid)
  }

  const onPointerUp = (): void => {
    const p = press.current
    press.current = null
    if (!p) return
    window.clearTimeout(p.timer)
    if (!p.fresh) controls.stop()
    else if (p.hold) {
      if (armed.current) controls.cancel()
      else controls.stop()
    }
    // A fresh short press was a tap: the recording it started keeps going.
    onCancelArmed(false)
  }

  const onPointerLost = (): void => {
    const p = press.current
    press.current = null
    if (!p) return
    window.clearTimeout(p.timer)
    if (p.hold) {
      if (armed.current) controls.cancel()
      else controls.mode('tap')
    }
    onCancelArmed(false)
  }

  // Keyboard (Enter / Space) has no press to time: it toggles.
  const onClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (event.detail !== 0 || disabled) return
    if (phase === 'idle') controls.start()
    else if (phase === 'recording') controls.stop()
  }

  const label =
    phase === 'recording'
      ? mode === 'hold'
        ? cancelArmed
          ? 'Release to cancel'
          : 'Release to send'
        : 'Send'
      : phase === 'transcribing'
        ? 'Working…'
        : 'Talk'

  return (
    <button
      type="button"
      className="composer__mic"
      data-phase={phase}
      data-mode={mode ?? undefined}
      data-primary={primary ? 'true' : undefined}
      data-cancel-armed={cancelArmed ? 'true' : undefined}
      disabled={disabled}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerLost}
      onLostPointerCapture={onPointerLost}
      onClick={onClick}
      onContextMenu={(event) => event.preventDefault()}
      title={
        phase === 'recording'
          ? mode === 'hold'
            ? 'Release to send — slide left to cancel'
            : 'Stop and send'
          : phase === 'transcribing'
            ? 'Working out the words…'
            : 'Dictate — tap to talk, or hold (/voice)'
      }
      aria-label={phase === 'recording' ? label : phase === 'transcribing' ? 'Working out the words' : 'Dictate'}
      aria-pressed={phase === 'recording'}
    >
      {phase === 'recording' ? (
        primary ? (
          <>
            <span className="composer__mic-dot" />
            <span className="composer__mic-label">{label}</span>
          </>
        ) : (
          <>
            <span className="composer__mic-dot" />
            <VoiceMeter analyser={analyser} />
          </>
        )
      ) : phase === 'transcribing' ? (
        <span className="composer__mic-ring" />
      ) : (
        <Icon name="mic" size={primary ? 20 : 16} />
      )}
    </button>
  )
}

/**
 * What a dictation is doing, in words, with a way out: listening (clock,
 * meter, Cancel), working out the words (clock, Cancel), or the review
 * countdown ("Sending… Undo"). Plain on purpose — the look is a later wave's.
 */
function VoicePanel({
  state,
  controls,
  analyser,
  cancelArmed
}: {
  state: VoiceState
  controls: VoiceControls
  analyser: AnalyserNode | null
  cancelArmed: boolean
}): ReactNode {
  if (state.phase === 'review') {
    return (
      <div className="composer__voice" data-phase="review" role="status">
        <span className="composer__voice-label">
          Sending… <Ticker to={state.endsAt} />
        </span>
        <button type="button" className="composer__voice-btn" data-kind="undo" onClick={controls.undo}>
          Undo
        </button>
      </div>
    )
  }
  const hold = state.phase === 'recording' && state.mode === 'hold'
  const words =
    state.phase === 'recording'
      ? hold
        ? cancelArmed
          ? 'Release to cancel'
          : 'Listening — slide left to cancel'
        : 'Listening'
      : 'Working out the words…'
  return (
    <div className="composer__voice" data-phase={state.phase} data-cancel-armed={cancelArmed ? 'true' : undefined}>
      <button
        type="button"
        className="composer__voice-btn"
        data-kind="cancel"
        onClick={controls.cancel}
        aria-label={state.phase === 'recording' ? 'Cancel — throw this recording away' : 'Cancel — do not send'}
      >
        <Icon name="close" size={14} />
        <span>Cancel</span>
      </button>
      <span className="composer__voice-label" role="status">
        {words}
      </span>
      {state.phase === 'recording' ? <VoiceMeter analyser={analyser} /> : null}
      {state.phase === 'recording' || state.phase === 'transcribing' ? <Ticker since={state.startedAt} /> : null}
    </div>
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
      aria-pressed={active === undefined ? undefined : active}
      // Keep the box's focus, and with it the phone's keyboard: an armed Ctrl
      // waits for a letter typed on that keyboard.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
    >
      {label}
    </button>
  )
}
