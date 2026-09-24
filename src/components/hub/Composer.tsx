import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SavedPrompt, SavedPromptTarget } from '@shared/hub'
import { paneNameInTab } from '@shared/workspace'
import { useKeymap, useSavedPrompts } from '@/hooks/useHub'
import { hotkeyLabel } from '@/hooks/useDictation'
import { resolveProfile } from '@/lib/agents'
import { HUB_COMPOSER_EVENT, type HubComposerDetail } from '@/lib/hubnav'
import { runSavedPrompt } from '@/lib/hubRuntime'
import { fireComet, usePresence } from '@/lib/motion'
import { comboFromEvent } from '@/lib/keymap'
import { commandForCombo, setCommandHandler } from '@/lib/keymapRegistry'
import { relayComet } from '@/lib/relayComet'
import { composerRouteNow } from '@/lib/shellSlots'
import { findLeaf } from '@/lib/splitTree'
import { terminalHost } from '@/lib/terminals'
import { useUiCommand } from '@/lib/uiCommands'
import { useDictation } from '@/state/Dictation'
import { useActiveTab, useApp } from '@/state/AppState'
import type { HubAction, HubCaption } from '@/state/VoiceHubController'
import { Icon } from '../Icon'
import { setBarTarget, useBarTarget } from './barMode'
import { ACTION_GLYPH, hubAsk, listenState, useHubPreview, useHubView } from './hubView'
import { BrainPicker } from './BrainPicker'
import { DictateButton } from './DictateButton'
import { KeyRecorder, Keys } from './KeyRecorder'
import { ListenToggle } from './VoicePill'
import './Composer.css'

/**
 * The one bar: the only place you talk to Forge.
 *
 *   type        Enter asks Forge, the main agent, which knows the whole app and
 *               acts inside it ("Ask Forge…"). One click on the target chip
 *               aims at the pane you are in instead ("→ Everest"), typed as a
 *               hand at that prompt would; Esc in the bar comes back to Forge.
 *   Listen      one switch, off or on. On is a hands-free conversation with
 *               the main agent: it sends when you pause, answers, and listens
 *               again. Right Shift flips it too. The brain's name and what it
 *               is doing are inside the switch, in words.
 *   agent       the chip beside Listen names the voice agent that will answer
 *               and opens a menu to switch it in place (BrainPicker).
 *   D           raw dictation (DictateButton): the Dictate key (Right Alt) as
 *               a small button beside Listen — raw words into the focused
 *               pane, or into this bar when the bar has focus. It says
 *               "● Rec" while it runs.
 *   replies     what Forge says grows the bar upward, with a trail of what it
 *               did ("✓ Opened Codex pane · ✓ Typed into Everest") that opens
 *               into the whole list.
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

export function Composer({ lead, compact = false }: { lead?: ReactNode; compact?: boolean }): ReactNode {
  const { state, actions } = useApp()
  const tab = useActiveTab()
  const dictation = useDictation()
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
  const intoBar = dictating && focused
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
      if (intoBar) dictation.toggle()
      return
    }
    if (toForge) {
      hubAsk(hub, message, 'typed')
      setText('')
      if (intoBar) dictation.toggle()
      if (shellRef.current) fireComet(shellRef.current, shellRef.current.querySelector('.listen') ?? shellRef.current, 'var(--accent)')
      return
    }
    if (!paneId || !sendToPane(paneId, message)) {
      actions.setNotice('That pane has no live shell to send to')
      return
    }
    setText('')
    // Sent: the words in the bar are done with. Dictation into the bar ends with the send.
    if (intoBar) dictation.toggle()
    relayComet(paneId, shellRef.current)
  }

  const cancel = (): void => {
    setText('')
    setPaletteOpen(false)
    setSaving(null)
    if (intoBar) dictation.toggle()
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

  /* --------------------------------------------------------------- words */

  const dictateKey = hotkeyLabel(state.settings.sttHotkey || 'AltRight')
  const placeholder = dictating
    ? intoBar
      ? `Dictating into the bar — ${dictateKey} to stop`
      : `Dictating into ${paneName ?? 'the pane'} — ${dictateKey} to stop`
    : !toForge
      ? `Type straight into ${paneName}   ·   Esc for Forge`
      : ls.recording
        ? 'Listening — talk, or type'
        : 'Ask Forge…   ·   / for prompts'

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
      style={{ '--pane-accent': profile?.accent ?? 'var(--accent)' } as React.CSSProperties}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
          focusField()
        }
      }}
    >
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

      <div className="comp__row">
        {lead}
        {/* The voice unit: Listen and who answers it, one rim (VoicePill.css). */}
        <span className="vunit">
          <ListenToggle />
          <BrainPicker />
        </span>
        <DictateButton />

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
              } else if (!toForge) setBarTarget('forge')
              else backToPane()
            }
          }}
        />

        <button
          type="button"
          className="dock__target comp__target"
          data-target={toForge ? 'forge' : 'pane'}
          disabled={!paneName}
          title={
            toForge
              ? paneName
                ? `Asking Forge, the main agent (${hub.brainLabel}). Click to type straight into ${paneName} instead.`
                : `Asking Forge, the main agent (${hub.brainLabel}).`
              : `Typing straight into ${paneName}. Click (or Esc in the bar) to ask Forge instead.`
          }
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setBarTarget(toForge ? 'pane' : 'forge')}
        >
          <span className="dock__target-arrow" aria-hidden="true">
            →
          </span>
          {toForge ? <Icon name="forge" size={11} className="comp__target-mark" /> : null}
          <span className="truncate">{toForge ? 'Forge' : paneName}</span>
        </button>

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
              title={toForge ? 'Ask Forge (Enter)' : `Send to ${paneName} (Enter)`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => send(text)}
            >
              {toForge ? 'Ask' : 'Send'}
              <span aria-hidden="true">⏎</span>
            </button>
          </span>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ caption rail */

const CAPTION_WINDOW_MS = 9000
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
function CaptionRail({ captions, actions }: { captions: HubCaption[]; actions: HubAction[] }): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  const lastUser = [...captions].reverse().find((c) => c.role === 'user') ?? null
  const lastBot = [...captions].reverse().find((c) => c.role === 'assistant') ?? null
  const fresh = (c: HubCaption | null): c is HubCaption => !!c && (!c.final || now - c.at < CAPTION_WINDOW_MS)
  const lines = [lastUser, lastBot].filter(fresh).sort((a, b) => a.at - b.at)
  const recent = actions.filter((a) => a.status === 'running' || a.status === 'planned' || now - a.at < TRAIL_WINDOW_MS)
  const trail = recent.slice(-3)
  const all = actions.slice(-12).reverse()
  const open = lines.length > 0 || trail.length > 0 || (expanded && all.length > 0)
  const { mounted, closing } = usePresence(open, 220)
  useEffect(() => {
    if (!open) setExpanded(false)
  }, [open])
  if (!mounted) return null

  return (
    <div className="crail" data-state={closing ? 'closing' : 'open'} data-expanded={expanded ? 'true' : undefined} aria-live="polite">
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
