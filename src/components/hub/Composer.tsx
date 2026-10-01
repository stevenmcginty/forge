import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { agentLogoFor } from '@shared/agent-logos'
import type { SavedPrompt, SavedPromptTarget } from '@shared/hub'
import { paneNameInTab } from '@shared/workspace'
import { useKeymap, useSavedPrompts } from '@/hooks/useHub'
import { hotkeyLabel, useQuietDictation } from '@/hooks/useDictation'
import { resolveProfile } from '@/lib/agents'
import { publishDictationReview, setBarDictationSink, useBarDictationPhase } from '@/lib/barDictation'
import { HUB_COMPOSER_EVENT, type HubComposerDetail } from '@/lib/hubnav'
import { runSavedPrompt } from '@/lib/hubRuntime'
import { fireComet, usePresence } from '@/lib/motion'
import { PATH_DRAG_TYPE } from '@/lib/mosaicLayout'
import { droppedFilePaths, maybeFiles } from '@/lib/paths'
import { comboFromEvent } from '@/lib/keymap'
import { commandForCombo, setCommandHandler } from '@/lib/keymapRegistry'
import { relayComet } from '@/lib/relayComet'
import { composerRouteNow } from '@/lib/shellSlots'
import { findLeaf } from '@/lib/splitTree'
import { terminalHost } from '@/lib/terminals'
import { useUiCommand } from '@/lib/uiCommands'
import { useActiveTab, useApp } from '@/state/AppState'
import type { HubAction, HubCaption } from '@/state/VoiceHubController'
import { readCueLevels, useBarCue } from '../DictationCue'
import { CueGlyph, type CuePhase } from '../DictationCueView'
import { DictationEdge } from '../DictationEdge'
import { Icon } from '../Icon'
import { setBarTarget, useBarTarget } from './barMode'
import { ACTION_GLYPH, hubAsk, listenState, useHubPreview, useHubView } from './hubView'
import { logoStyle, MakerLogo } from './BrainMark'
import { BrainPicker } from './BrainPicker'
import { DictateButton, type DictateSend } from './DictateButton'
import { KeyRecorder, Keys } from './KeyRecorder'
import { ModelPicker, UsageStrip } from './ModelPicker'
import { ListenToggle } from './VoicePill'
import './Composer.css'

/**
 * The one bar: the only place you talk to Forge.
 *
 *   type        Enter types into the pane you are in ("→ Everest"), as a hand
 *               at that prompt would — the default. One click on the target
 *               chip asks Forge instead, the main agent, which knows the whole
 *               app and acts inside it ("Ask Forge…"); Esc in the bar comes
 *               back to the pane.
 *   Listen      one switch, off or on. On is a hands-free conversation with
 *               the main agent: it sends when you pause, answers, and listens
 *               again. Right Shift flips it too. The brain's name and what it
 *               is doing are inside the switch, in words.
 *   agent       the chip beside Listen names the voice agent that will answer
 *               and opens a menu to switch it in place (BrainPicker).
 *   mic / send  the bar's end button (DictateButton). Empty bar: a mic, the
 *               phone's mic — press, talk, press again; the words land in
 *               this bar, "Sending… 1.5 s" with Undo (Esc undoes too), then
 *               they send as Enter would. Undo keeps them here to edit. A
 *               stop square while it records. Words in the bar: Send, the
 *               same as Enter. The Dictate key (Right Alt) stays raw words
 *               into the focused pane, or into this bar when it has focus.
 *               The press that stops decides: the key stops it raw; the mic
 *               stops it and sends — the same countdown and Undo, then Enter
 *               in the pane the words went to (or this bar's send).
 *   replies     what Forge says grows the bar upward, with a trail of what it
 *               did ("✓ Opened Codex pane · ✓ Typed into Everest") that opens
 *               into the whole list.
 *   palette     "/" (or Ctrl+K) turns the bar into the palette: saved prompts
 *               and every command, each with its keys. Ctrl+S saves the text
 *               in the bar as a new prompt.
 */

/** The Enter waits for the pane's echo of the words, then this much quiet. */
const ECHO_QUIET_MS = 150
/** The most the Enter waits: a pane that never goes quiet still gets it. */
const ECHO_MAX_MS = 1500
const ECHO_POLL_MS = 30

/**
 * Fire the keys a hand at the prompt would: the text, then Enter once the pane
 * has drawn it.
 *
 * The words go in as a paste, never as typing. Typed raw, a long line reached
 * Claude Code as one fast burst it guesses is a paste — and when the Enter
 * arrived in the same read as the words, it was taken in as part of that
 * paste, a new line rather than a send, so the words sat on the prompt until
 * Steve pressed Enter himself. xterm's paste wraps the words in bracketed-
 * paste markers whenever the agent asked for them (Claude Code, Codex and
 * Gemini CLI all do), so the agent knows exactly where the words end: an
 * Enter after the end marker is an Enter, and one that lands while it is still
 * taking the paste in is held and pressed after it. A shell that never asked
 * for the markers gets the plain words, as before.
 *
 * The Enter still waits for the echo — output after the words went in, then a
 * short quiet — so it follows the words rather than racing them.
 */
function sendToPane(paneId: string, text: string): boolean {
  if (!terminalHost.has(paneId) || terminalHost.runtime(paneId).status === 'exited') return false
  const before = terminalHost.readiness(paneId).outputBytes
  terminalHost.paste(paneId, text)
  const started = performance.now()
  const tick = (): void => {
    const r = terminalHost.readiness(paneId)
    const echoed = r.outputBytes > before && r.quietForMs >= ECHO_QUIET_MS
    if (echoed || performance.now() - started >= ECHO_MAX_MS) {
      terminalHost.submit(paneId)
      return
    }
    window.setTimeout(tick, ECHO_POLL_MS)
  }
  window.setTimeout(tick, ECHO_POLL_MS)
  return true
}

/** How long dictated words wait, with Undo, before they send — the phone's (web SessionComposer). */
const REVIEW_MS = 1500

/** The bar, dictating: the word where the placeholder was, and the chip's shorter one beside words already in. */
const MIC_WORD: Record<CuePhase, { full: string; chip: string }> = {
  starting: { full: 'Getting the mic ready…', chip: 'Mic…' },
  listening: { full: 'Listening…', chip: 'Listening' },
  finishing: { full: 'Finishing…', chip: 'Finishing' },
  sending: { full: 'Sending…', chip: 'Sending' }
}

/**
 * What the bar sent, oldest first, for this run of the app: Up in an empty bar
 * brings the last one back to edit or send again, as a shell does. Kept in
 * memory only, so nothing typed here is written to disk.
 */
const sentHistory: string[] = []
const HISTORY_MAX = 40

function rememberSent(message: string): void {
  const at = sentHistory.indexOf(message)
  if (at >= 0) sentHistory.splice(at, 1)
  sentHistory.push(message)
  if (sentHistory.length > HISTORY_MAX) sentHistory.shift()
}

type PaletteItem =
  | { kind: 'save'; key: string; title: string }
  | { kind: 'prompt'; key: string; prompt: SavedPrompt }
  | { kind: 'command'; key: string; id: string; title: string; group: string; keys: string[] }

const NO_ITEMS: PaletteItem[] = []

export function Composer({ lead, compact = false }: { lead?: ReactNode; compact?: boolean }): ReactNode {
  const { state, actions } = useApp()
  const tab = useActiveTab()
  // The quiet view: the bar reads the mic level in its canvas, never through React.
  const dictation = useQuietDictation()
  const hub = useHubView()
  const preview = useHubPreview()
  const target = useBarTarget()
  const [text, setText] = useState('')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [saving, setSaving] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const fieldRef = useRef<HTMLTextAreaElement | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)

  const paneId = tab?.activePaneId ?? null
  const leaf = tab && paneId ? findLeaf(tab.root, paneId) : null
  const profile = leaf ? resolveProfile(state.settings.agentProfiles, leaf.profileId) : null
  // The terminal's one name ("Zeb", "Zeb 2") — see shared/terminal-names.ts.
  const paneName = tab && leaf && profile ? paneNameInTab(tab, leaf.id) : null

  // No pane to aim at means Forge, whatever the chip last said.
  const toForge = target === 'forge' || !paneId || !paneName
  const ls = listenState(hub)
  // The Dictate key's own session — not the agent's, which shares the sidecar.
  const dictating = (preview?.dictating ?? dictation.listening) && !state.agentListening && !ls.on
  // The bar's mic started it (src/lib/barDictation.ts): its words come here, whatever has focus.
  const barDictating = useBarDictationPhase() !== 'off'
  const intoBar = dictating && (focused || barDictating)
  // Dictation into the bar — its mic button, or the key with the bar focused — from the press on.
  const mic = useBarCue()
  const micCue = mic?.phase ?? null
  // The agent's voice on the bar's edge: listening moves with the mic, speaking with his voice.
  const agentEdge: { phase: CuePhase; feed: 'mic' | 'out' } | null =
    ls.on || state.agentListening
      ? ls.look === 'listening'
        ? { phase: 'listening', feed: 'mic' }
        : ls.look === 'speaking'
          ? { phase: 'listening', feed: 'out' }
          : ls.look === 'connecting'
            ? { phase: 'starting', feed: 'mic' }
            : { phase: 'finishing', feed: 'mic' }
      : null
  const slash = text.startsWith('/')
  // The palette belongs to the bar: it shows while you are in the bar.
  const showPalette = (paletteOpen || slash) && focused
  const query = slash ? text.slice(1).trim().toLowerCase() : ''

  // Grow with the text, one line at a time, to five; then scroll. At the
  // bottom edge the bar grows upward; in the top bar (compact) it drops down,
  // over the stage, and goes back to one slim line when the text does.
  const [tall, setTall] = useState(false)
  useLayoutEffect(() => {
    const el = fieldRef.current
    if (!el) return
    const min = compact ? 28 : 34
    el.style.height = '0px'
    const h = Math.min(Math.max(min, el.scrollHeight), 5 * 20 + 14)
    el.style.height = `${h}px`
    setTall(h > min + 4)
  }, [text, compact])

  /** Where Up / Down is in what the bar sent; -1 while the words are his own. */
  const historyAt = useRef(-1)

  const focusField = (): void => fieldRef.current?.focus()
  const backToPane = (): void => {
    fieldRef.current?.blur()
    if (paneId) terminalHost.focus(paneId)
  }
  useUiCommand('focus-composer', focusField)
  useUiCommand('blur-composer', backToPane)
  useUiCommand('toggle-composer', () => {
    if (document.activeElement === fieldRef.current) backToPane()
    else focusField()
  })

  /* ---------------------------------------------------------------- send */

  /**
   * Dictated words, waiting to send: when the countdown ends, and where. `pane`
   * null is the bar's words (the bar's send); a pane id is a key dictation the
   * mic stopped, whose words are already on that pane's prompt (its Enter).
   */
  const [review, setReview] = useState<{ endsAt: number; pane: string | null } | null>(null)
  const reviewing = review !== null
  const reviewPane = review?.pane ?? null
  const reviewTimer = useRef(0)
  /** The bar mic's dictation said something this time. */
  const heard = useRef(false)
  /** A send or a cancel came first: the bar mic's last words, still on their way, are dropped. */
  const dropping = useRef(false)
  const textRef = useRef(text)
  textRef.current = text
  /** Where a send goes now; a review sends only if that has not moved. */
  const aim = toForge ? 'forge' : `pane:${paneId}`
  const aimRef = useRef(aim)
  aimRef.current = aim
  const noticeRef = useRef(actions.setNotice)
  noticeRef.current = actions.setNotice

  const endReview = (): void => {
    window.clearTimeout(reviewTimer.current)
    setReview(null)
  }

  /** Dictation into the bar ends with a send or a cancel; the bar mic's unsent tail goes with it. */
  const endBarWords = (): void => {
    if (barDictating) dropping.current = true
    if (intoBar) dictation.toggle()
  }

  const send = (raw: string): void => {
    const message = raw.replace(/\s+$/, '')
    if (!message.trim()) return
    endReview()
    historyAt.current = -1
    const route = composerRouteNow()
    if (route?.({ text: message, paneId })) {
      rememberSent(message)
      setText('')
      endBarWords()
      return
    }
    if (toForge) {
      hubAsk(hub, message, 'typed')
      rememberSent(message)
      setText('')
      endBarWords()
      if (shellRef.current) fireComet(shellRef.current, shellRef.current.querySelector('.listen') ?? shellRef.current, 'var(--accent)')
      return
    }
    if (!paneId || !sendToPane(paneId, message)) {
      actions.setNotice('That pane has no live shell to send to')
      return
    }
    rememberSent(message)
    setText('')
    // Sent: the words in the bar are done with. Dictation into the bar ends with the send.
    endBarWords()
    relayComet(paneId, shellRef.current)
  }

  const cancel = (): void => {
    endReview()
    setText('')
    setPaletteOpen(false)
    setSaving(null)
    endBarWords()
    focusField()
  }

  /**
   * Undo: no send. The bar's words stay in the bar, and the bar takes the focus
   * to edit them; a pane's stay on its prompt line, and focus stays put.
   */
  const undoReview = (): void => {
    endReview()
    if (reviewPane === null) focusField()
  }

  const sendRef = useRef(send)
  sendRef.current = send

  /**
   * The words in the bar, a 1.5 s countdown, then the same send Enter makes.
   * With a pane: the words already on its prompt, the countdown, then its
   * Enter. The aim does not matter there — the words went to that pane —
   * only that it still has a live terminal.
   */
  const startReview = (pane: string | null = null): void => {
    window.clearTimeout(reviewTimer.current)
    const aimed = aimRef.current
    setReview({ endsAt: Date.now() + REVIEW_MS, pane })
    reviewTimer.current = window.setTimeout(() => {
      setReview(null)
      if (pane !== null) {
        if (!terminalHost.has(pane) || !terminalHost.submit(pane)) {
          noticeRef.current('Not sent — the words are waiting in the pane.')
        }
        return
      }
      if (aimRef.current !== aimed) {
        noticeRef.current('Not sent — the words are waiting in the box.')
        return
      }
      sendRef.current(textRef.current)
    }, REVIEW_MS)
  }
  const startReviewRef = useRef(startReview)
  startReviewRef.current = startReview

  // The bar takes the bar mic's words while it is mounted. Its end starts the
  // review. So does the end of a key dictation the mic stopped.
  useEffect(
    () =>
      setBarDictationSink({
        phrase: (words) => {
          if (dropping.current) return
          heard.current = true
          setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')} ${words}` : words))
        },
        done: (ok) => {
          const said = heard.current
          heard.current = false
          if (dropping.current) {
            dropping.current = false
            return
          }
          if (!ok) return
          if (!said) {
            noticeRef.current('Heard nothing — nothing to send.')
            return
          }
          startReviewRef.current()
        },
        ownsField: (el) => el === fieldRef.current,
        sendKeyWords: (landing) => {
          if (landing.kind === 'bar') startReviewRef.current()
          else if (landing.kind === 'pane') startReviewRef.current(landing.paneId)
          else if (landing.kind === 'none') noticeRef.current('Heard nothing — nothing to send.')
        }
      }),
    []
  )
  useEffect(() => () => window.clearTimeout(reviewTimer.current), [])
  // The pane the words wait in shows the countdown too (DictationCue); this only tells it.
  useEffect(() => (review ? publishDictationReview({ paneId: review.pane, endsAt: review.endsAt }) : undefined), [review])

  // Esc undoes the countdown wherever focus is — and never reaches a pane,
  // where it would interrupt the agent the words are for.
  const undoRef = useRef(undoReview)
  undoRef.current = undoReview
  useEffect(() => {
    if (!reviewing) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopImmediatePropagation()
      undoRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [reviewing])

  // A dictation into the bar that starts over the countdown holds it: more
  // words are coming, and half a sentence must not go. Over a pane's
  // countdown, any dictation holds it: its words may be going to that pane.
  const holdReview = intoBar || (dictating && reviewPane !== null)
  useEffect(() => {
    if (!holdReview) return
    window.clearTimeout(reviewTimer.current)
    setReview(null)
  }, [holdReview])

  // A saved prompt aimed at the composer lands here (B2's saved prompts).
  useEffect(() => {
    const on = (e: Event): void => {
      const detail = (e as CustomEvent<HubComposerDetail>).detail
      if (!detail || typeof detail.text !== 'string') return
      if (detail.submit) {
        sendRef.current(detail.text)
        return
      }
      setText(detail.text)
      requestAnimationFrame(() => fieldRef.current?.focus())
    }
    window.addEventListener(HUB_COMPOSER_EVENT, on)
    return () => window.removeEventListener(HUB_COMPOSER_EVENT, on)
  }, [])

  /* ------------------------------------------------------------- palette */

  const { prompts } = useSavedPrompts()
  const keymap = useKeymap()
  const items = useMemo<PaletteItem[]>(() => {
    // Built only while the palette is up: typing in the plain bar builds nothing.
    if (!showPalette) return NO_ITEMS
    const out: PaletteItem[] = []
    const draft = !slash && text.trim()
    if (draft) out.push({ kind: 'save', key: 'save', title: 'Save this as a prompt' })
    const match = (s: string): boolean => !query || s.toLowerCase().includes(query)
    for (const p of prompts) {
      if (match(p.title) || match(p.text)) out.push({ kind: 'prompt', key: `p:${p.id}`, prompt: p })
    }
    const cmds = keymap.commands.filter(
      (c) => c.available && !c.id.startsWith('prompt.') && (match(c.title) || match(c.group))
    )
    for (const c of cmds.slice(0, query ? 12 : 8)) {
      out.push({ kind: 'command', key: `c:${c.id}`, id: c.id, title: c.title, group: c.group, keys: c.keys })
    }
    return out
  }, [showPalette, prompts, keymap.commands, query, slash, text])

  useEffect(() => setCursor(0), [query, showPalette])

  /** What the bar's own keys do, fresh every render; the text box's keydown and the registry both call these. */
  const barKeys = useRef<Record<string, () => void>>({})
  barKeys.current = {
    'bar.palette': () => setPaletteOpen((v) => !v),
    'bar.saveDraft': () => {
      if (text.trim() && !slash) setSaving(text.trim())
    }
  }
  useEffect(() => {
    const offs = Object.keys(barKeys.current).map((id) => setCommandHandler(id, () => barKeys.current[id]?.()))
    return () => offs.forEach((off) => off())
  }, [])

  const runItem = (item: PaletteItem | undefined): void => {
    if (!item) return
    if (item.kind === 'save') {
      setSaving(text.trim())
      setPaletteOpen(false)
      return
    }
    setPaletteOpen(false)
    setText('')
    if (item.kind === 'prompt') {
      // Through the keymap command when it is registered, so a click and the
      // hotkey do exactly the same thing; straight to the runtime otherwise.
      if (!keymap.run(`prompt.${item.prompt.id}`)) {
        const r = runSavedPrompt(item.prompt, { source: 'ui' })
        if (!r.ok) actions.setNotice(r.summary)
      }
      if (item.prompt.target === 'active-pane' && paneId) requestAnimationFrame(() => terminalHost.focus(paneId))
      return
    }
    backToPane()
    requestAnimationFrame(() => keymap.run(item.id))
  }

  // A click anywhere else puts the palette and the save form away, as a menu
  // would; the text in the bar stays where it was.
  const risen = saving !== null || paletteOpen
  useEffect(() => {
    if (!risen) return undefined
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null
      if (t && shellRef.current?.contains(t)) return
      setSaving(null)
      setPaletteOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [risen])

  /* --------------------------------------------------------- dropped files */

  /**
   * A file dropped on the bar (Explorer, the screenshot pop-up or tray, a rail
   * row) goes into the words as its quoted path, at the caret — the way a pane
   * takes one. maybeFiles (lib/paths) says why acceptance is generous: a drag
   * declined on dragover is a drop that never fires. And an unprevented file
   * drop navigates the whole window to the file.
   */
  /** How many files are held over the bar; 0 is none. */
  const [fileOver, setFileOver] = useState(0)
  /**
   * A drag that ends without a dragleave (cancelled with Esc, or the window
   * loses it) must not leave the cover up: dragover repeats while a file is
   * held over the bar, so a second without one means it has gone.
   */
  const dropWatch = useRef(0)
  useEffect(() => () => window.clearTimeout(dropWatch.current), [])
  const acceptDrop = (e: React.DragEvent): void => {
    const tracked = e.dataTransfer.types.includes(PATH_DRAG_TYPE)
    if (!maybeFiles(e) && !tracked) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    window.clearTimeout(dropWatch.current)
    dropWatch.current = window.setTimeout(() => setFileOver(0), 1000)
    // A drag shows how many it carries, never their names; a count is what there is to say.
    const held = tracked ? 1 : Array.from(e.dataTransfer.items ?? []).filter((i) => i.kind === 'file').length
    const n = Math.max(1, held)
    if (fileOver !== n) setFileOver(n)
  }
  const onDropFiles = (e: React.DragEvent): void => {
    e.preventDefault()
    window.clearTimeout(dropWatch.current)
    setFileOver(0)
    const tracked = e.dataTransfer.getData(PATH_DRAG_TYPE)
    const paths = tracked ? [tracked] : droppedFilePaths(e)
    if (paths.length === 0) return
    const quoted = paths.map((p) => `"${p}"`).join(' ')
    const field = fieldRef.current
    const from = field?.selectionStart ?? text.length
    const to = field?.selectionEnd ?? from
    const before = text.slice(0, from)
    const gap = before && !/\s$/.test(before) ? ' ' : ''
    const head = `${before}${gap}${quoted} `
    setText(head + text.slice(to).replace(/^\s+/, ''))
    // Into the words, caret after the path: a drop is a deliberate act, and
    // focusing the box also stops a send that was counting down.
    requestAnimationFrame(() => {
      field?.focus()
      field?.setSelectionRange(head.length, head.length)
    })
  }

  /* --------------------------------------------------------------- words */

  const dictateKey = hotkeyLabel(state.settings.sttHotkey || 'AltRight')
  const placeholder = dictating
    ? intoBar
      ? `Dictating into the bar — ${barDictating ? 'press the mic again' : dictateKey} to stop`
      : `Dictating into ${paneName ?? 'the pane'} — ${dictateKey} to stop`
    : !toForge
      ? `Type straight into ${paneName}   ·   click the chip to ask Forge`
      : ls.recording
        ? 'Listening — talk, or type'
        : paneName
          ? 'Ask Forge…   ·   Esc for the pane'
          : 'Ask Forge…   ·   / for prompts'

  // The pane's agent, as its maker's mark on the target chip.
  const paneLogo = profile ? agentLogoFor(profile) : null

  // The end button's job, stable while nothing about it changes, so a keystroke
  // in the box does not re-render the button.
  const hasWords = text.trim().length > 0
  const runHighlighted = useRef<() => void>(() => undefined)
  runHighlighted.current = () => runItem(items[cursor])
  const endSend = useMemo<DictateSend | null>(() => {
    if (!hasWords) return null
    if (showPalette) return { label: 'Run', title: 'Run the highlighted item (Enter)', onSend: () => runHighlighted.current() }
    return {
      label: toForge ? 'Ask Forge' : `Send to ${paneName}`,
      title: toForge ? 'Ask Forge (Enter)' : `Send to ${paneName} (Enter)`,
      onSend: () => sendRef.current(textRef.current)
    }
  }, [hasWords, showPalette, toForge, paneName])

  return (
    <div
      ref={shellRef}
      className="dock__composer comp"
      data-listening={ls.recording || dictating ? 'true' : undefined}
      data-live={ls.on ? 'true' : undefined}
      data-look={ls.look}
      data-target={toForge ? 'forge' : 'pane'}
      data-empty={text ? undefined : 'true'}
      data-palette={showPalette ? 'true' : undefined}
      data-tall={tall ? 'true' : undefined}
      data-dropping={fileOver ? 'true' : undefined}
      data-mic={agentEdge ? undefined : (micCue ?? undefined)}
      data-edge={agentEdge ? 'agent' : micCue || review ? 'dictation' : undefined}
      style={{ '--pane-accent': profile?.accent ?? 'var(--accent)' } as React.CSSProperties}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
          focusField()
        }
      }}
      onDragEnter={acceptDrop}
      onDragOver={acceptDrop}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileOver(0)
      }}
      onDrop={onDropFiles}
    >
      {/* The bar's outline is the synthesizer: one voice at a time. The agent's
          (Jarvis listening or speaking) wins while he has the mic: his volt, a
          lesser edge. Otherwise dictation's violet, from the press, through the
          words, to the send countdown draining it away. */}
      {agentEdge ? (
        <DictationEdge
          key="agent"
          variant="agent"
          phase={agentEdge.phase}
          feed={agentEdge.feed}
          readLevels={hub.readLevels}
          compact={compact}
        />
      ) : (
        <DictationEdge
          key="dictation"
          phase={micCue ?? (review ? 'sending' : null)}
          endsAt={review?.endsAt ?? null}
          readLevels={readCueLevels}
          compact={compact}
        />
      )}

      {showPalette && !saving ? (
        <Palette
          items={items}
          cursor={cursor}
          query={query}
          onHover={setCursor}
          onPick={(i) => runItem(items[i])}
        />
      ) : null}

      {saving !== null ? (
        <SavePrompt
          text={saving}
          onDone={(ok) => {
            setSaving(null)
            if (ok) {
              setText('')
              actions.setNotice('Saved — find it with / in the bar')
            }
            focusField()
          }}
        />
      ) : null}

      {/* What Forge says, and what it did, grow the bar upward. */}
      <CaptionRail captions={hub.captions} actions={hub.actions} />

      {fileOver ? (
        // A file held over the bar: what a drop will do, in words, over the row.
        <div className="comp__drop" aria-hidden="true">
          <Icon name="file" size={15} />
          <span className="comp__drop-word">{fileOver > 1 ? `Drop ${fileOver} files` : 'Drop the file'}</span>
          <span className="comp__drop-hint">{fileOver > 1 ? 'their paths go' : 'its path goes'} in at the caret</span>
        </div>
      ) : null}

      <div className="comp__row">
        {lead}
        {/* Cohesive on/off microphone button with built-in synthesizer indicator and agent picker */}
        <span
          className="vunit"
          data-listening={ls.on ? 'true' : undefined}
          data-recording={ls.recording ? 'true' : undefined}
          data-look={ls.look}
          aria-label="Agent voice controls"
        >
          <ListenToggle />
          <BrainPicker />
        </span>

        {micCue ? (
          // The bar says it is listening, in a word and a shape: in the placeholder's
          // place while the box is empty, as a slim chip beside words already in.
          <span className="comp__mic" data-phase={micCue} data-chip={text ? 'true' : undefined} role="status" aria-live="polite">
            <CueGlyph phase={micCue} readLevels={readCueLevels} small />
            <span className="comp__mic-word">{text ? MIC_WORD[micCue].chip : MIC_WORD[micCue].full}</span>
            {!text && mic && micCue === 'listening' ? (
              <span className="comp__mic-hint truncate">
                {mic.into ? <span className="comp__mic-into">{mic.into}</span> : null}
                <span aria-hidden="true">—</span>
                <kbd className="dcue__key">{mic.keyLabel || 'the Dictate key'}</kbd>
                {mic.sends ? 'to stop and send' : 'to stop'}
              </span>
            ) : !text && mic?.into ? (
              <span className="comp__mic-hint truncate">
                <span className="comp__mic-into">{mic.into}</span>
              </span>
            ) : null}
          </span>
        ) : null}

        <textarea
          ref={fieldRef}
          className="dock__field"
          rows={1}
          value={text}
          spellCheck
          placeholder={micCue ? '' : placeholder}
          aria-label={placeholder}
          onFocus={() => {
            // Coming into the words while they wait to send is Undo.
            if (reviewing) endReview()
            setFocused(true)
          }}
          onBlur={() => setFocused(false)}
          onPointerDown={reviewing ? undoReview : undefined}
          onChange={(e) => {
            historyAt.current = -1
            setText(e.target.value)
            if (!e.target.value) setPaletteOpen(false)
          }}
          onKeyDown={(e) => {
            // A key in the words while they wait: Undo, then the key does its own job (Enter sends now).
            if (reviewing) endReview()
            if (e.nativeEvent.isComposing) return
            if (showPalette && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              const step = e.key === 'ArrowDown' ? 1 : -1
              setCursor((c) => (items.length ? (c + step + items.length) % items.length : 0))
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (showPalette) runItem(items[cursor])
              else send(text)
              return
            }
            // Up in an empty bar: the last thing it sent, to edit or send again;
            // Up again goes further back, Down comes forward and out to empty.
            if (!showPalette && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
              const at = historyAt.current
              if (e.key === 'ArrowUp' && sentHistory.length > 0 && (text === '' || at >= 0)) {
                e.preventDefault()
                const next = at < 0 ? sentHistory.length - 1 : Math.max(0, at - 1)
                historyAt.current = next
                setText(sentHistory[next]!)
                return
              }
              if (e.key === 'ArrowDown' && at >= 0) {
                e.preventDefault()
                const next = at + 1
                historyAt.current = next < sentHistory.length ? next : -1
                setText(next < sentHistory.length ? sentHistory[next]! : '')
                return
              }
            }
            // The bar's own keys (Ctrl+K, Ctrl+S by default), from Settings › Shortcuts.
            const combo = comboFromEvent(e.nativeEvent)
            const barCommand = combo ? commandForCombo(combo) : null
            if (barCommand?.scope === 'bar') {
              e.preventDefault()
              barKeys.current[barCommand.id]?.()
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              if (saving !== null) setSaving(null)
              else if (showPalette) {
                setPaletteOpen(false)
                if (slash) setText('')
              } else if (toForge && paneName) setBarTarget('pane')
              else backToPane()
            }
          }}
        />

        {/* Where the words go: the pane (or Forge), and what that pane's agent runs. One well. */}
        <span className="comp__dest" data-target={toForge ? 'forge' : 'pane'}>
          <button
            type="button"
            className="dock__target comp__target"
            data-target={toForge ? 'forge' : 'pane'}
            disabled={!paneName}
            title={
              toForge
                ? paneName
                  ? `Asking Forge, the main agent (${hub.brainLabel}). Click (or Esc in the bar) to type straight into ${paneName} instead.`
                  : `Asking Forge, the main agent (${hub.brainLabel}).`
                : `Typing straight into ${paneName}. Click to ask Forge, the main agent, instead.`
            }
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setBarTarget(toForge ? 'pane' : 'forge')}
          >
            <span className="dock__target-arrow" aria-hidden="true">
              →
            </span>
            {/* Keyed by where it aims, so a switch glides the new name in. */}
            <span key={toForge ? 'forge' : 'pane'} className="comp__target-face">
              {toForge ? (
                <Icon name="forge" size={12} className="comp__target-mark" />
              ) : paneLogo ? (
                <span className="comp__target-plate mplate" style={logoStyle(paneLogo)} aria-hidden="true">
                  <MakerLogo logo={paneLogo} size={10} />
                </span>
              ) : null}
              <span className="truncate">{toForge ? 'Forge' : paneName}</span>
            </span>
          </button>

          <ModelPicker />
        </span>

        {review ? (
          // Dictated words, waiting: in words, with the time left and a way out.
          <span className="comp__review" role="status">
            <span className="comp__review-words">
              Sending… <Countdown to={review.endsAt} />
            </span>
            <button
              type="button"
              className="comp__act comp__act--word"
              title={review.pane ? 'Undo — no Enter; the words stay in the pane (Esc)' : 'Undo — keep the words to edit (Esc)'}
              aria-label={review.pane ? 'Undo — no Enter; the words stay in the pane' : 'Undo — keep the words to edit'}
              onMouseDown={(e) => e.preventDefault()}
              onClick={undoReview}
            >
              Undo
            </button>
            <span
              key={review.endsAt}
              className="comp__review-drain"
              aria-hidden="true"
              style={{ animationDuration: `${REVIEW_MS}ms` }}
            />
          </span>
        ) : text && !slash ? (
          <span className="comp__acts">
            <button
              type="button"
              className="comp__act"
              title="Save this as a prompt (Ctrl+S)"
              aria-label="Save as a prompt"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setSaving(text.trim())}
            >
              <Icon name="pin" size={13} />
            </button>
            <button
              type="button"
              className="comp__act"
              title="Cancel — clear the bar"
              aria-label="Cancel"
              onMouseDown={(e) => e.preventDefault()}
              onClick={cancel}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        ) : null}

        {/* Always last: the mic while the bar is empty, Send once it has words. */}
        <DictateButton send={endSend} />
      </div>

      {/* The aimed-at pane's context and plan limits, once it has reported them. */}
      <UsageStrip />
    </div>
  )
}

/** "1.2 s": what is left of the review countdown, as the phone shows it. */
function Countdown({ to }: { to: number }): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(id)
  }, [])
  return <span className="comp__review-clock">{(Math.max(0, to - now) / 1000).toFixed(1)} s</span>
}

/* ------------------------------------------------------------ caption rail */

const CAPTION_WINDOW_MS = 9000
/** A reply still marked "speaking" this long after it started is stuck, not speaking. */
const CAPTION_STUCK_MS = 60_000
const TRAIL_WINDOW_MS = 30_000

const STATUS_WORD: Record<HubAction['status'], string> = {
  running: 'running',
  ok: 'done',
  failed: 'failed',
  planned: 'planned'
}

function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Inside the bar, above its row: the last thing he said (italic), the last
 * thing Forge said (upright), each fading a few seconds after it settles, and
 * the trail of what it did — which opens into the whole list. The bar grows
 * upward to hold it. Pointer-transparent except for the trail's own toggle and
 * list, so a click there always means the trail.
 */
const CaptionRail = memo(function CaptionRail({ captions, actions }: { captions: HubCaption[]; actions: HubAction[] }): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState(false)
  // Hide: everything up to this moment goes away; anything newer shows again.
  const [hiddenAt, setHiddenAt] = useState(0)
  // The clock runs only while something on the rail can still expire: from the
  // newest caption or action until the longest window past it. A quiet bar
  // ticks nothing.
  const newest = Math.max(
    captions.reduce((m, c) => Math.max(m, c.at), 0),
    actions.reduce((m, a) => Math.max(m, a.at), 0)
  )
  useEffect(() => {
    if (!newest) return undefined
    const t = window.setInterval(() => {
      const at = Date.now()
      setNow(at)
      if (at - newest > CAPTION_STUCK_MS + 2000) window.clearInterval(t)
    }, 1000)
    return () => window.clearInterval(t)
  }, [newest])

  const lastUser = [...captions].reverse().find((c) => c.role === 'user') ?? null
  const lastBot = [...captions].reverse().find((c) => c.role === 'assistant') ?? null
  const fresh = (c: HubCaption | null): c is HubCaption =>
    !!c && c.at > hiddenAt && now - c.at < (c.final ? CAPTION_WINDOW_MS : CAPTION_STUCK_MS)
  const lines = [lastUser, lastBot].filter(fresh).sort((a, b) => a.at - b.at)
  const recent = actions.filter(
    (a) => a.at > hiddenAt && (a.status === 'running' || a.status === 'planned' || now - a.at < TRAIL_WINDOW_MS)
  )
  const trail = recent.slice(-3)
  const all = actions.filter((a) => a.at > hiddenAt).slice(-12).reverse()
  const open = lines.length > 0 || trail.length > 0 || (expanded && all.length > 0)
  const { mounted, closing } = usePresence(open, 220)
  useEffect(() => {
    if (!open) setExpanded(false)
  }, [open])
  if (!mounted) return null

  return (
    <div className="crail" data-state={closing ? 'closing' : 'open'} data-expanded={expanded ? 'true' : undefined} aria-live="polite">
      <button
        type="button"
        className="crail__hide"
        title="Hide this box. It comes back when Forge says something new."
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setExpanded(false)
          setHiddenAt(Date.now())
        }}
      >
        <Icon name="close" size={10} />
        Hide
      </button>
      {lines.map((c) => (
        <p key={c.id + (c.final ? ':f' : '')} className="crail__line" data-role={c.role} data-final={c.final ? 'true' : undefined}>
          <span className="crail__who">{c.role === 'user' ? 'You' : 'Forge'}</span>
          <span className="crail__text">{c.text}</span>
        </p>
      ))}
      {trail.length || expanded ? (
        <div className="crail__trail">
          <button
            type="button"
            className="crail__toggle"
            aria-expanded={expanded}
            title={expanded ? 'Fold the list away' : 'Everything Forge did lately'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setExpanded((v) => !v)}
          >
            Did
            <span className="crail__chev" aria-hidden="true">
              {expanded ? '▾' : '▸'}
            </span>
          </button>
          <span className="crail__acts">
          {!expanded
            ? trail.map((a, i) => (
                <span key={a.id} className="crail__act" data-status={a.status}>
                  {i > 0 ? <span className="crail__sep" aria-hidden="true">·</span> : null}
                  <span className="crail__glyph" aria-hidden="true">
                    {ACTION_GLYPH[a.status]}
                  </span>
                  {a.label}
                  {a.status === 'planned' ? <span className="crail__tag">planned</span> : null}
                  {a.status === 'failed' ? <span className="crail__tag">failed</span> : null}
                </span>
              ))
            : <span className="crail__count">{all.length} lately — newest first</span>}
          </span>
        </div>
      ) : null}
      {expanded ? (
        <ol className="crail__log">
          {all.map((a) => (
            <li key={a.id} className="crail__row" data-status={a.status}>
              <span className="crail__glyph" aria-hidden="true">
                {ACTION_GLYPH[a.status]}
              </span>
              <span className="crail__row-text">
                <span className="crail__row-label">{a.label}</span>
                {a.detail ? <span className="crail__row-detail">{a.detail}</span> : null}
              </span>
              <span className="crail__row-word">{STATUS_WORD[a.status]}</span>
              <span className="crail__row-time mono">{clock(a.at)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
})

/* ---------------------------------------------------------------- palette */

function Palette({
  items,
  cursor,
  query,
  onHover,
  onPick
}: {
  items: PaletteItem[]
  cursor: number
  query: string
  onHover: (i: number) => void
  onPick: (i: number) => void
}): ReactNode {
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i='${cursor}']`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const firstPrompt = items.findIndex((i) => i.kind === 'prompt')
  const firstCommand = items.findIndex((i) => i.kind === 'command')

  return (
    <div className="cpal" role="listbox" aria-label="Prompts and commands" onMouseDown={(e) => e.preventDefault()}>
      <div className="cpal__list" ref={listRef}>
        {items.length === 0 ? (
          <div className="cpal__empty">
            Nothing matches “{query}”. Type a prompt in the bar and press <Keys combo="Ctrl+S" size="sm" /> to save one.
          </div>
        ) : null}
        {items.map((item, i) => (
          <div key={item.key}>
            {i === firstPrompt ? <div className="cpal__eyebrow">Saved prompts</div> : null}
            {i === firstCommand ? <div className="cpal__eyebrow">Commands</div> : null}
            <button
              type="button"
              role="option"
              aria-selected={i === cursor}
              data-i={i}
              data-cursor={i === cursor ? 'true' : undefined}
              data-kind={item.kind}
              className="cpal__row"
              onPointerEnter={() => onHover(i)}
              onClick={() => onPick(i)}
            >
              {item.kind === 'save' ? (
                <>
                  <span className="cpal__glyph" aria-hidden="true">
                    <Icon name="pin" size={12} />
                  </span>
                  <span className="cpal__title">{item.title}</span>
                  <span className="cpal__meta">name it, give it a hotkey</span>
                  <Keys combo="Ctrl+S" size="sm" />
                </>
              ) : item.kind === 'prompt' ? (
                <>
                  <span className="cpal__glyph" aria-hidden="true">
                    {item.prompt.target === 'composer' ? '⌁' : '›'}
                  </span>
                  <span className="cpal__title">{item.prompt.title}</span>
                  <span className="cpal__meta truncate">{item.prompt.text.replace(/\s+/g, ' ')}</span>
                  {item.prompt.hotkey ? <Keys combo={item.prompt.hotkey} size="sm" /> : <span className="cpal__nokey">no key</span>}
                </>
              ) : (
                <>
                  <span className="cpal__glyph" aria-hidden="true">
                    ⌘
                  </span>
                  <span className="cpal__title">{item.title}</span>
                  <span className="cpal__meta">{item.group}</span>
                  {item.keys[0] ? <Keys combo={item.keys[0]} size="sm" /> : <span className="cpal__nokey">no key</span>}
                </>
              )}
            </button>
          </div>
        ))}
      </div>
      <div className="cpal__foot">
        <span>
          <Keys combo="↑" size="sm" />
          <Keys combo="↓" size="sm" /> pick
        </span>
        <span>
          <Keys combo="Enter" size="sm" /> run
        </span>
        <span>
          <Keys combo="Ctrl+S" size="sm" /> save the bar as a prompt
        </span>
        <span>
          <Keys combo="Esc" size="sm" /> close
        </span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ save prompt */

function SavePrompt({ text, onDone }: { text: string; onDone: (ok: boolean) => void }): ReactNode {
  const { save } = useSavedPrompts()
  const [title, setTitle] = useState(() => text.replace(/\s+/g, ' ').split(' ').slice(0, 6).join(' ').slice(0, 60))
  const [hotkey, setHotkey] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [target, setTarget] = useState<SavedPromptTarget>('active-pane')
  const [submit, setSubmit] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const titleRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [])

  const commit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    const r = await save({ title: title.trim() || 'Untitled prompt', text, hotkey, target, submit })
    setBusy(false)
    if (r.ok) onDone(true)
    else setError(r.error)
  }

  return (
    <form
      className="csave"
      onSubmit={(e) => {
        e.preventDefault()
        void commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !recording) {
          e.preventDefault()
          e.stopPropagation()
          onDone(false)
        }
      }}
    >
      <div className="csave__head">
        <span className="cpal__eyebrow">Save as a prompt</span>
        <span className="csave__preview truncate">{text.replace(/\s+/g, ' ')}</span>
      </div>
      <label className="csave__row">
        <span className="csave__label">Name</span>
        <input
          ref={titleRef}
          className="csave__input"
          value={title}
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <div className="csave__row">
        <span className="csave__label">Hotkey</span>
        {recording ? (
          <KeyRecorder
            value={hotkey}
            onRecord={(c) => {
              setHotkey(c)
              setRecording(false)
            }}
            onCancel={() => setRecording(false)}
            onClear={() => {
              setHotkey(null)
              setRecording(false)
            }}
          />
        ) : (
          <span className="csave__keys">
            {hotkey ? <Keys combo={hotkey} /> : <span className="cpal__nokey">none</span>}
            <button type="button" className="csave__link" onClick={() => setRecording(true)}>
              {hotkey ? 'Change' : 'Record one'}
            </button>
            {hotkey ? (
              <button type="button" className="csave__link" onClick={() => setHotkey(null)}>
                Clear
              </button>
            ) : null}
          </span>
        )}
      </div>
      <div className="csave__row">
        <span className="csave__label">Goes to</span>
        <span className="csave__seg" role="group" aria-label="Where the prompt goes">
          <button type="button" data-on={target === 'active-pane' ? 'true' : undefined} onClick={() => setTarget('active-pane')}>
            The pane you are in
          </button>
          <button type="button" data-on={target === 'composer' ? 'true' : undefined} onClick={() => setTarget('composer')}>
            This bar, to edit
          </button>
        </span>
        <label className="csave__check">
          <input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} />
          Press Enter after
        </label>
      </div>
      {error ? (
        <p className="csave__error" role="alert">
          <span aria-hidden="true">✕</span> {error}
        </p>
      ) : null}
      <div className="csave__foot">
        <button type="button" className="ghost-btn" onClick={() => onDone(false)}>
          Cancel
        </button>
        <button type="submit" className="cta-btn" disabled={busy}>
          {busy ? 'Saving…' : 'Save prompt'}
        </button>
      </div>
    </form>
  )
}
