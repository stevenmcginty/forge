import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SavedPrompt, SavedPromptTarget } from '@shared/hub'
import { useCallSign, useKeymap, useSavedPrompts } from '@/hooks/useHub'
import { hotkeyLabel } from '@/hooks/useDictation'
import { paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { HUB_COMPOSER_EVENT, type HubComposerDetail } from '@/lib/hubnav'
import { runSavedPrompt } from '@/lib/hubRuntime'
import { fireComet, usePresence } from '@/lib/motion'
import { composerRouteNow, useShellMode } from '@/lib/shellSlots'
import { findLeaf } from '@/lib/splitTree'
import { terminalHost } from '@/lib/terminals'
import { useUiCommand } from '@/lib/uiCommands'
import { useDictation } from '@/state/Dictation'
import { useActiveTab, useApp } from '@/state/AppState'
import type { HubAction, HubCaption } from '@/state/VoiceHubController'
import { DictationSetup } from '../DictationSetup'
import { Icon } from '../Icon'
import { Popover } from '../Popover'
import { toggleSheet } from '../shell/Sheet'
import { ACTION_GLYPH, isLive, PROVIDER_SHORT, setComposerAim, useComposerAim, useHubPreview, useHubView } from './hubView'
import { KeyRecorder, Keys } from './KeyRecorder'
import './Composer.css'

/**
 * The composer: the one bar at the bottom that is both type and speak — and
 * the palette.
 *
 *   type        Enter sends to the pane you are in, the keystrokes a hand at
 *               that prompt would make (unchanged from the dock's first cut).
 *   dictate     the mic, or the talk key, opens Parakeet. Pressed here, the
 *               bar takes the words: each phrase lands in the field as it is
 *               transcribed, so you can read and fix it, then Send or Cancel.
 *               The talk key pressed in a pane still dictates into that pane.
 *   live        with live talk on, what you type goes to the voice brain (one
 *               click on the target chip points it back at the pane), its
 *               captions rise above the bar and fade, and a short trail says
 *               what it just did.
 *   palette     "/" (or Ctrl+K) turns the bar into the palette: saved prompts
 *               and every command, each with its keys. Ctrl+S saves the text
 *               in the bar as a new prompt.
 */

/** Fire the keys a hand at the prompt would: the text, a beat, then Enter. */
function sendToPane(paneId: string, text: string): boolean {
  if (!terminalHost.has(paneId)) return false
  const ok = text.includes('\n') ? (terminalHost.paste(paneId, text), true) : terminalHost.type(paneId, text)
  if (!ok) return false
  // A beat between the text and the Enter: a TUI that has just taken a paste
  // needs a frame to settle before a carriage return means "send" to it.
  window.setTimeout(() => terminalHost.submit(paneId), 70)
  return true
}

type PaletteItem =
  | { kind: 'save'; key: string; title: string }
  | { kind: 'prompt'; key: string; prompt: SavedPrompt }
  | { kind: 'command'; key: string; id: string; title: string; group: string; keys: string[] }

export function Composer(): ReactNode {
  const { state, actions } = useApp()
  const tab = useActiveTab()
  const dictation = useDictation()
  const hub = useHubView()
  const preview = useHubPreview()
  const aim = useComposerAim()
  // The Talk view shows the whole conversation; the rail would only repeat it.
  const onTalk = useShellMode() === 'talk'
  const [text, setText] = useState('')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [saving, setSaving] = useState<string | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const fieldRef = useRef<HTMLTextAreaElement | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const micRef = useRef<HTMLButtonElement | null>(null)

  const paneId = tab?.activePaneId ?? null
  const leaf = tab && paneId ? findLeaf(tab.root, paneId) : null
  const profile = leaf ? resolveProfile(state.settings.agentProfiles, leaf.profileId) : null
  const callSign = useCallSign(paneId ?? '')
  const paneName = leaf && profile ? (callSign ?? paneDisplayTitle(profile, leaf.title)) : null

  const live = isLive(hub.phase)
  const toHub = live && aim === 'hub'
  const provider = PROVIDER_SHORT[hub.provider]
  const listening = preview?.dictating ?? dictation.listening
  // The mic's bars meter dictation; while live they rest at a steady mid height
  // (the pill beside the bar carries the live meter).
  const level = listening
    ? Math.min(1, Math.max(0, preview?.dictating ? (preview.dictationLevel ?? 0.5) : dictation.status.level))
    : live && !hub.muted
      ? 0.4
      : 0
  const slash = text.startsWith('/')
  // The palette belongs to the bar: it shows while you are in the bar.
  const showPalette = (paletteOpen || slash) && focused
  const query = slash ? text.slice(1).trim().toLowerCase() : ''

  // Grow upward with the text, one line at a time, to five; then scroll.
  useLayoutEffect(() => {
    const el = fieldRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(Math.max(34, el.scrollHeight), 5 * 20 + 14)}px`
  }, [text])

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

  const send = (raw: string): void => {
    const message = raw.replace(/\s+$/, '')
    if (!message.trim()) return
    const route = composerRouteNow()
    if (route?.({ text: message, paneId })) {
      setText('')
      if (listening) dictation.toggle()
      const pill = document.querySelector('.vpill')
      if (pill && shellRef.current) fireComet(shellRef.current, pill, 'var(--accent)')
      return
    }
    if (!paneId) {
      actions.setNotice('Open a pane first — the composer types into the pane you are in')
      return
    }
    if (!sendToPane(paneId, message)) {
      actions.setNotice('That pane has no live shell to send to')
      return
    }
    setText('')
    // Sent: the mic's job is done too. Dictation into the bar ends with the send.
    if (listening) dictation.toggle()
    const target = document.querySelector(`.pane[data-pane-id="${paneId}"], .mtile[data-pane-id="${paneId}"]`)
    if (target && shellRef.current) fireComet(shellRef.current, target, profile?.accent ?? '#c6ff4a')
  }

  const cancel = (): void => {
    setText('')
    setPaletteOpen(false)
    setSaving(null)
    if (listening) dictation.toggle()
    focusField()
  }

  // A saved prompt aimed at the composer lands here (B2's saved prompts).
  const sendRef = useRef(send)
  sendRef.current = send
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
  }, [prompts, keymap.commands, query, slash, text])

  useEffect(() => setCursor(0), [query, showPalette])

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

  /* ---------------------------------------------------------------- mic */

  const hotkey = hotkeyLabel(state.settings.sttHotkey || 'ControlRight')
  const onMic = (): void => {
    if (dictation.needsSetup) {
      setSetupOpen((v) => !v)
      return
    }
    if (live) {
      hub.setMuted(!hub.muted)
      return
    }
    // Pressed here, the bar takes the words — focus it first so each phrase
    // lands in the field, ready to edit, instead of straight into the pane.
    if (!listening) focusField()
    dictation.toggle()
  }

  /* --------------------------------------------------------------- words */

  const placeholder = listening
    ? 'Listening — speak, then fix anything and send'
    : toHub
      ? `Talking with ${provider} — or type to it`
      : paneName
        ? `Type or speak to ${paneName}   ·   / for prompts`
        : 'Type or speak   ·   / for prompts'

  const micTitle = dictation.needsSetup
    ? 'Dictation needs setting up — click to fix it'
    : live
      ? hub.muted
        ? 'Quiet — the mic is off. Click to listen again (Ctrl+Shift+M)'
        : 'Mute the mic for a moment (Ctrl+Shift+M)'
      : listening
        ? 'Stop dictation'
        : `Dictate into this bar (or ${hotkey} anywhere)`

  const micOn = live ? !hub.muted : listening

  return (
    <div
      ref={shellRef}
      className="dock__composer comp"
      data-listening={listening || (live && hub.phase === 'listening' && !hub.muted) ? 'true' : undefined}
      data-live={live ? 'true' : undefined}
      data-empty={text ? undefined : 'true'}
      data-palette={showPalette ? 'true' : undefined}
      style={{ '--pane-accent': profile?.accent ?? 'var(--accent)', '--lvl': level } as React.CSSProperties}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
          focusField()
        }
      }}
    >
      {live && !onTalk && !showPalette && !saving ? <CaptionRail captions={hub.captions} actions={hub.actions} provider={provider} /> : null}

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
              actions.setNotice('Saved — find it with / in the composer')
            }
            focusField()
          }}
        />
      ) : null}

      <button
        ref={micRef}
        type="button"
        className="dock__mic comp__mic"
        data-on={micOn ? 'true' : undefined}
        data-setup={dictation.needsSetup ? 'true' : undefined}
        aria-pressed={micOn}
        title={micTitle}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onMic}
      >
        {dictation.needsSetup ? (
          <span className="comp__mic-setup" aria-hidden="true">
            !
          </span>
        ) : (
          <span className="dock__bars" aria-hidden="true">
            {[0.55, 0.85, 1, 0.75, 0.5].map((w, i) => (
              <span key={i} style={{ '--w': w } as React.CSSProperties} />
            ))}
          </span>
        )}
        {listening ? <span className="dock__mic-word">Listening</span> : null}
        {live && hub.muted ? <span className="dock__mic-word">Quiet</span> : null}
      </button>
      <Popover
        anchor={micRef.current}
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        align="start"
        side="top"
        width={330}
        label="Dictation setup"
      >
        <DictationSetup
          problem={dictation.needsSetup ? (dictation.status.error?.msg ?? null) : null}
          onRetry={() => setSetupOpen(false)}
          compact
        />
      </Popover>

      <textarea
        ref={fieldRef}
        className="dock__field"
        rows={1}
        value={text}
        spellCheck
        placeholder={placeholder}
        aria-label={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value)
          if (!e.target.value) setPaletteOpen(false)
        }}
        onKeyDown={(e) => {
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
          if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyK') {
            e.preventDefault()
            setPaletteOpen((v) => !v)
            return
          }
          if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyS') {
            e.preventDefault()
            if (text.trim() && !slash) setSaving(text.trim())
            return
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            if (saving !== null) setSaving(null)
            else if (showPalette) {
              setPaletteOpen(false)
              if (slash) setText('')
            } else backToPane()
          }
        }}
      />

      {live ? (
        <button
          type="button"
          className="dock__target comp__aim"
          data-aim={aim}
          title={toHub ? `Typing to ${provider}. Click to type to ${paneName ?? 'the pane'} instead.` : `Typing to ${paneName ?? 'the pane'}. Click to type to ${provider}.`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setComposerAim(toHub ? 'pane' : 'hub')}
        >
          <span className="dock__target-arrow" aria-hidden="true">
            →
          </span>
          <span className="truncate">{toHub ? provider : (paneName ?? 'pane')}</span>
        </button>
      ) : paneName ? (
        <button
          type="button"
          className="dock__target"
          title="Sending to this pane — click to pick another"
          data-sheet-toggle="panes"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggleSheet('panes')}
        >
          <span className="dock__target-arrow" aria-hidden="true">
            →
          </span>
          <span className="truncate">{paneName}</span>
        </button>
      ) : null}

      {text && !slash ? (
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
          <button
            type="button"
            className="comp__send"
            title={toHub ? `Send to ${provider} (Enter)` : `Send to ${paneName ?? 'the pane'} (Enter)`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => send(text)}
          >
            Send
            <span aria-hidden="true">⏎</span>
          </button>
        </span>
      ) : listening ? (
        <span className="comp__acts">
          <button
            type="button"
            className="comp__act comp__act--word"
            title="Stop dictation"
            onMouseDown={(e) => e.preventDefault()}
            onClick={cancel}
          >
            Cancel
          </button>
        </span>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------ caption rail */

const CAPTION_WINDOW_MS = 9000
const TRAIL_WINDOW_MS = 30_000

/**
 * Above the bar while live talk is on: the last thing he said (italic) and the
 * last thing it said (upright), each fading a few seconds after it settles,
 * and the trail of what it did. Opaque and pointer-transparent: it never
 * blurs a terminal and never takes a click.
 */
function CaptionRail({
  captions,
  actions,
  provider
}: {
  captions: HubCaption[]
  actions: HubAction[]
  provider: string
}): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  const lastUser = [...captions].reverse().find((c) => c.role === 'user') ?? null
  const lastBot = [...captions].reverse().find((c) => c.role === 'assistant') ?? null
  const fresh = (c: HubCaption | null): c is HubCaption => !!c && (!c.final || now - c.at < CAPTION_WINDOW_MS)
  const lines = [lastUser, lastBot].filter(fresh).sort((a, b) => a.at - b.at)
  const trail = actions.filter((a) => a.status === 'running' || a.status === 'planned' || now - a.at < TRAIL_WINDOW_MS).slice(-3)
  const open = lines.length > 0 || trail.length > 0
  const { mounted, closing } = usePresence(open, 220)
  if (!mounted) return null

  return (
    <div className="crail" data-state={closing ? 'closing' : 'open'} aria-live="polite">
      {lines.map((c) => (
        <p key={c.id + (c.final ? ':f' : '')} className="crail__line" data-role={c.role} data-final={c.final ? 'true' : undefined}>
          <span className="crail__who">{c.role === 'user' ? 'You' : provider}</span>
          <span className="crail__text">{c.text}</span>
        </p>
      ))}
      {trail.length ? (
        <p className="crail__trail">
          {trail.map((a, i) => (
            <span key={a.id} className="crail__act" data-status={a.status}>
              {i > 0 ? <span className="crail__sep" aria-hidden="true">·</span> : null}
              <span className="crail__glyph" aria-hidden="true">
                {ACTION_GLYPH[a.status]}
              </span>
              {a.label}
              {a.status === 'planned' ? <span className="crail__tag">planned</span> : null}
              {a.status === 'failed' ? <span className="crail__tag">failed</span> : null}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  )
}

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
