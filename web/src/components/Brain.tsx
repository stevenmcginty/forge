import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  BRAIN_ENGINE_NAME,
  BRAIN_ENGINES,
  type BrainConfirmRequest,
  type BrainEngine,
  type BrainStatus
} from '@shared/brain'
import { Icon } from '@/components/Icon'
import { usePresence } from '@/lib/motion'
import { deckSheet, useDeckSheet } from '../deck/sheet'
import { useBackClose } from '../lib/back-stack'
import { applyChatUpdate, EMPTY_CHAT, type ChatFeed } from '../lib/chat-turns'
import { announcePaneSent, usePendingSends } from '../lib/pane-sent'
import { useForge } from '../state'
import { BrainComposer } from './BrainComposer'
import { BrainGlyph, brainGlyphState } from './BrainGlyph'
import { BrainTerm } from './BrainTerm'
import { ChatView } from './ChatView'
import './Brain.css'

/**
 * Forge Brain on Forge Web: its mark in the phone's top bar and in the deck's,
 * and — on a tap — the brain itself: a full-height sheet on the phone, a
 * drop-down under the mark on the deck. The same body in both:
 *
 *   - a header: the mark, "Forge Brain", what it is doing in words and who runs
 *     it, and Chat | CLI (the conversation, or the brain pane's own terminal);
 *   - the conversation in the WhatsApp bubbles every pane's Chat view wears;
 *   - its Yes / No questions as cards, each with its risk as a shape and a word;
 *   - the phone's own composer, aimed at the brain.
 *
 * Off, the body is a short intro, who runs it, and Turn on. A desktop too old
 * to have a brain sends no `brain` at all, and then no mark is drawn.
 */

export type BrainFace = 'phone' | 'deck'
type BrainTab = 'chat' | 'cli'

const STATE_WORD: Record<BrainStatus['state'], string> = {
  off: 'Off',
  starting: 'Starting…',
  idle: 'Ready',
  busy: 'Working…',
  asking: 'Needs you',
  error: 'Stopped'
}

/** Only Claude keeps a transcript Forge reads; the other engines are their terminal. */
function hasChat(status: BrainStatus): boolean {
  return status.engine === 'claude'
}

/** The words for the mark: everything the badge and the glyph say, said. */
function buttonWords(status: BrainStatus): string {
  if (!status.enabled) return 'Forge Brain — off. Tap to see what it is'
  if (status.confirms.length || status.state === 'asking') return 'Forge Brain needs you'
  if (status.state === 'error') return `Forge Brain stopped${status.error ? ` — ${status.error}` : ''}`
  if (status.state === 'busy') return 'Forge Brain — working'
  if (status.state === 'starting') return 'Forge Brain — starting'
  return 'Forge Brain — ready'
}

/* ================================================================ the mark */

/**
 * The mark in a top bar, and what it opens. Draws nothing for a desktop with
 * no brain, or while the desktop is asleep (there is nothing it could do).
 */
export function BrainButton({ face }: { face: BrainFace }): ReactNode {
  const { state } = useForge()
  const status = state.picture?.brain ?? null
  const offline = state.stage.kind === 'offline'
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const close = useCallback(() => setOpen(false), [])

  // The deck keeps one pop-up at a time: opening the brain puts a sheet away,
  // and a sheet opening puts the brain away.
  const sheet = useDeckSheet()
  useEffect(() => {
    if (face === 'deck' && sheet) setOpen(false)
  }, [face, sheet])

  if (!status || offline) return null

  const glyph = brainGlyphState(status)
  const on = status.enabled
  const needs = on && (status.confirms.length > 0 || status.state === 'asking')
  const stopped = on && status.state === 'error'
  const words = buttonWords(status)

  return (
    <span className="brainbtn-wrap" data-face={face}>
      <button
        ref={btnRef}
        type="button"
        className={face === 'phone' ? 'ptop__btn brainbtn' : 'brainbtn'}
        data-face={face}
        data-state={glyph}
        data-open={open ? 'true' : undefined}
        aria-label={words}
        title={face === 'deck' ? words : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (face === 'deck' && !open) deckSheet.set(null)
          setOpen((v) => !v)
        }}
        data-testid={face === 'phone' ? 'phone-brain' : 'deck-brain'}
      >
        <BrainGlyph state={glyph} size={face === 'phone' ? 28 : 24} />
        {needs ? (
          <span className="brainbtn__badge" data-kind="needs" aria-hidden="true">
            !
          </span>
        ) : stopped ? (
          <span className="brainbtn__badge" data-kind="error" aria-hidden="true">
            ×
          </span>
        ) : null}
      </button>
      {face === 'phone' ? (
        <BrainSheet open={open} onClose={close} status={status} />
      ) : (
        <BrainDrop open={open} onClose={close} status={status} anchor={btnRef} />
      )}
    </span>
  )
}

/* ============================================================ the phone */

/** How long the sheet takes to go, matching `--p-dur-sheet`. */
const SHEET_EXIT_MS = 280

function appLayer(): HTMLElement {
  return (document.querySelector('.app[data-shell="app"]') as HTMLElement | null) ?? document.body
}

/**
 * The whole screen, risen from the bottom edge like WhatsApp's chat: the
 * phone's bars are covered, not moved, so closing it puts every pane back
 * exactly where it was. Android Back closes it.
 */
function BrainSheet({ open, onClose, status }: { open: boolean; onClose: () => void; status: BrainStatus }): ReactNode {
  const { mounted, closing } = usePresence(open, SHEET_EXIT_MS)
  useBackClose(open, onClose)
  if (!mounted) return null
  return createPortal(
    <div className="brainsheet" data-state={closing ? 'closing' : 'open'} role="dialog" aria-modal="true" aria-label="Forge Brain">
      <BrainPanel face="phone" status={status} onClose={onClose} />
    </div>,
    appLayer()
  )
}

/* ============================================================= the deck */

/**
 * Hangs from the mark, opaque like every deck sheet over live terminals. Esc
 * or a click anywhere else puts it away — but Esc inside the brain's own
 * terminal is the terminal's (it interrupts the agent), and a popover or a
 * bottom sheet it opened takes its own clicks.
 */
function BrainDrop({
  open,
  onClose,
  status,
  anchor
}: {
  open: boolean
  onClose: () => void
  status: BrainStatus
  anchor: RefObject<HTMLButtonElement | null>
}): ReactNode {
  const { mounted, closing } = usePresence(open, 160)
  const ref = useRef<HTMLDivElement | null>(null)
  const [focus, setFocus] = useState(0)

  useEffect(() => {
    if (open) setFocus((n) => n + 1)
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t?.closest?.('.brainterm')) return
      if (document.querySelector('.popover')) return
      // Dictated words counting down: Esc is their Undo, in the box.
      if (ref.current?.querySelector('.composer[data-voice="review"]')) return
      e.preventDefault()
      onClose()
      anchor.current?.focus()
    }
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Element | null
      if (!t || ref.current?.contains(t) || anchor.current?.contains(t)) return
      if (t.closest('.popover, .bsheet-layer')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [open, onClose, anchor])

  if (!mounted) return null
  return (
    <div ref={ref} className="braindrop" data-state={closing ? 'closing' : 'open'} role="dialog" aria-label="Forge Brain">
      <BrainPanel face="deck" status={status} onClose={onClose} focusSignal={focus} />
    </div>
  )
}

/* ============================================================ the body */

function BrainPanel({
  face,
  status,
  onClose,
  focusSignal
}: {
  face: BrainFace
  status: BrainStatus
  onClose: () => void
  focusSignal?: number
}): ReactNode {
  const [picked, setPicked] = useState<BrainTab>('chat')
  const on = status.enabled
  const chatOk = hasChat(status)
  const tab: BrainTab = chatOk ? picked : 'cli'
  const needs = status.confirms.length > 0 || status.state === 'asking'
  const word = !on ? 'Off' : needs && status.state !== 'asking' ? 'Needs you' : STATE_WORD[status.state]

  return (
    <div className="brainpanel" data-face={face} data-tab={on ? tab : undefined}>
      <header className="brainpanel__head">
        {face === 'phone' ? (
          <button type="button" className="brainpanel__back" aria-label="Close Forge Brain" onClick={onClose}>
            <Icon name="chevronDown" size={22} />
          </button>
        ) : null}
        <span className="brainpanel__mark">
          <BrainGlyph state={brainGlyphState(status)} size={face === 'phone' ? 30 : 26} />
        </span>
        <span className="brainpanel__titles">
          <span className="brainpanel__title">Forge Brain</span>
          <span className="brainpanel__sub">
            <span className="brainpanel__state" data-state={on ? status.state : 'off'} data-needs={needs && on ? 'true' : undefined}>
              {word}
            </span>
            {on ? <span className="brainpanel__engine">· {BRAIN_ENGINE_NAME[status.engine]}</span> : null}
          </span>
        </span>
        {on ? <TabSwitch tab={tab} chatOk={chatOk} onTab={setPicked} /> : null}
        {face === 'deck' ? (
          <button type="button" className="brainpanel__close" aria-label="Close Forge Brain" title="Close (Esc)" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        ) : null}
      </header>

      {!on ? (
        <div className="brainpanel__body brainpanel__body--intro">
          <BrainIntro status={status} onLater={onClose} />
        </div>
      ) : (
        <>
          {status.state === 'error' ? <Stopped status={status} /> : null}
          <div className="brainpanel__body">
            {tab === 'chat' ? (
              <BrainChat status={status} />
            ) : (
              <>
                {!chatOk ? (
                  <p className="brainpanel__note">
                    <Icon name="terminal" size={14} />
                    {BRAIN_ENGINE_NAME[status.engine]} keeps no chat Forge can read — this is its terminal.
                  </p>
                ) : null}
                {status.paneId ? (
                  <div className="brainpanel__term">
                    <BrainTerm paneId={status.paneId} />
                  </div>
                ) : (
                  <p className="brainpanel__wait">
                    <Icon name="terminal" size={16} />
                    The brain's terminal shows here once it has started.
                  </p>
                )}
              </>
            )}
          </div>
          {status.confirms.length ? <Confirms confirms={status.confirms} /> : null}
          {status.state === 'asking' && !status.confirms.length && tab === 'chat' ? (
            <p className="brainpanel__asking" role="status">
              <span className="brainpanel__bang" aria-hidden="true">
                !
              </span>
              <span>It is asking something on its screen.</span>
              <button type="button" onClick={() => setPicked('cli')}>
                Show CLI
              </button>
            </p>
          ) : null}
          {status.queued > 0 ? <Queued count={status.queued} /> : null}
          {/* `session-composer` so the box keeps the pane box's rules — its key
              row shows in the CLI and hides in Chat; `dk-composer` so the deck
              draws the dock's own card. */}
          <div className={face === 'deck' ? 'brainpanel__compose dk-composer' : 'brainpanel__compose'}>
            <div className="session-composer" data-view={tab === 'cli' ? 'term' : 'chat'} data-keys="shown">
              <BrainComposer status={status} focusSignal={focusSignal} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ Chat | CLI */

/** Two segments, each an icon and its word. The one on screen is filled and pressed. */
function TabSwitch({ tab, chatOk, onTab }: { tab: BrainTab; chatOk: boolean; onTab: (tab: BrainTab) => void }): ReactNode {
  return (
    <div className="brainpanel__tabs" role="tablist" aria-label="Chat, or the brain's terminal">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'chat'}
        data-on={tab === 'chat' ? 'true' : undefined}
        disabled={!chatOk}
        title={chatOk ? 'The conversation' : 'Chat needs Claude — this engine keeps no transcript'}
        onClick={() => onTab('chat')}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.5 3.5h11v7.2H7.4L4.2 13.3v-2.6H2.5Z" />
        </svg>
        <span>Chat</span>
      </button>
      <button type="button" role="tab" aria-selected={tab === 'cli'} data-on={tab === 'cli' ? 'true' : undefined} title="The brain's terminal" onClick={() => onTab('cli')}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 4.5 6.5 8 3 11.5M8.5 11.8H13" />
        </svg>
        <span>CLI</span>
      </button>
    </div>
  )
}

/* ------------------------------------------------------------ the chat */

const SUGGESTIONS = ['What is running right now?', 'Which agents need me?', 'Open a Claude pane in this project']

/**
 * The brain pane's conversation, read like any pane's: `transcript-watch` on
 * its pane id. Asked again whenever the brain's state moves while there was
 * nothing to read yet — a fresh brain has written no transcript until its
 * first turn, and the turn is exactly what moves its state.
 */
function BrainChat({ status }: { status: BrainStatus }): ReactNode {
  const { state, actions } = useForge()
  const live = state.stage.kind !== 'offline' && state.connection.state === 'live'
  const paneId = status.paneId
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const feedRef = useRef<ChatFeed>(EMPTY_CHAT)
  const [feed, setFeed] = useState<ChatFeed>(EMPTY_CHAT)
  const [refused, setRefused] = useState(false)

  useEffect(() => {
    feedRef.current = EMPTY_CHAT
    setFeed(EMPTY_CHAT)
    if (!paneId || !live) return undefined
    let stopped = false
    const act = actionsRef.current
    const off = act.onTranscript(paneId, (update) => {
      feedRef.current = applyChatUpdate(feedRef.current, update)
      setFeed(feedRef.current)
    })
    void act.watchTranscript(paneId).then((refusal) => {
      if (!stopped) setRefused(Boolean(refusal))
    })
    return () => {
      stopped = true
      off()
      act.stopTranscript(paneId)
    }
  }, [paneId, status.sessionId, live])

  useEffect(() => {
    if (!refused || !paneId || !live) return
    void actionsRef.current.watchTranscript(paneId).then((refusal) => setRefused(Boolean(refusal)))
  }, [status.state, status.queued, refused, paneId, live])

  // Words on their way (one tick) are the conversation too: the first one sent
  // puts the bubbles up before the transcript has anything to say.
  const pending = usePendingSends(paneId ?? undefined)
  const ask = (text: string): void => {
    void actions.brain({ kind: 'brain-send', text }).then((why) => {
      if (why) actions.setNotice(why)
      else if (paneId) announcePaneSent(paneId, text)
    })
  }

  const ready = status.state !== 'starting' && Boolean(paneId) && live
  if (!feed.turns.length && !pending.length) {
    return (
      <div className="brainchat__empty">
        <BrainGlyph state={brainGlyphState(status)} size={60} />
        <h2 className="brainchat__title">{status.state === 'starting' ? 'Forge Brain is waking up' : 'Ask Forge Brain anything'}</h2>
        <p className="brainchat__line">It sees every project and pane, opens agents, hands them work and changes settings.</p>
        <div className="brainchat__chips">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="brainchat__chip" disabled={!ready} onClick={() => ask(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="brainchat">
      <ChatView
        turns={feed.turns}
        truncated={feed.truncated}
        busy={status.state === 'busy'}
        asking={status.state === 'asking'}
        agentName="Forge Brain"
        paneId={paneId ?? undefined}
      />
    </div>
  )
}

/* -------------------------------------------------------------- states */

function Stopped({ status }: { status: BrainStatus }): ReactNode {
  const { actions } = useForge()
  const [busy, setBusy] = useState(false)
  return (
    <div className="brainpanel__stopped" role="alert">
      <span className="brainpanel__stopped-mark" aria-hidden="true">
        ×
      </span>
      <span className="brainpanel__stopped-text">
        <strong>Stopped.</strong> {status.error ?? 'Forge Brain is not running.'}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void actions.brain({ kind: 'brain-enable', on: true }).then((why) => {
            setBusy(false)
            if (why) actions.setNotice(why)
          })
        }}
      >
        {busy ? 'Starting…' : 'Start again'}
      </button>
    </div>
  )
}

/** Words waiting for the brain to be free: an hourglass, and how many, in words. */
function Queued({ count }: { count: number }): ReactNode {
  return (
    <p className="brainpanel__queued" role="status">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 2h8M4 14h8M5 2c0 3.2 6 4.2 6 6s-6 2.8-6 6M11 2c0 3.2-6 4.2-6 6s6 2.8 6 6" />
      </svg>
      <span>
        <strong>Queued</strong> — {count === 1 ? 'one message goes' : `${count} messages go`} in when Forge Brain is free
      </span>
    </p>
  )
}

/* ------------------------------------------------------------- confirms */

const RISK_WORD: Record<BrainConfirmRequest['risk'], string> = {
  low: 'Low risk',
  medium: 'Check this',
  high: 'Careful — hard to undo'
}

/** A risk by shape: a circle, a triangle, an octagon. The word beside it says the same. */
function RiskMark({ risk }: { risk: BrainConfirmRequest['risk'] }): ReactNode {
  return (
    <svg className="brainconfirm__risk" data-risk={risk} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {risk === 'low' ? (
        <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      ) : risk === 'medium' ? (
        <path d="M8 1.8 14.6 13.6H1.4Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      ) : (
        <path d="M5.3 1.5h5.4l3.8 3.8v5.4l-3.8 3.8H5.3l-3.8-3.8V5.3Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      )}
      <path d={risk === 'medium' ? 'M8 6.2v3.2' : 'M8 4.9v3.6'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy={risk === 'medium' ? 11.4 : 10.9} r="0.95" fill="currentColor" />
    </svg>
  )
}

function Confirms({ confirms }: { confirms: BrainConfirmRequest[] }): ReactNode {
  const { actions } = useForge()
  const [answering, setAnswering] = useState<string | null>(null)
  const answer = (id: string, allow: boolean): void => {
    setAnswering(id)
    void actions.brain({ kind: 'brain-confirm', id, allow }).then((why) => {
      setAnswering(null)
      if (why) actions.setNotice(why)
    })
  }
  return (
    <div className="brainconfirms" role="group" aria-label="Forge Brain is asking">
      {confirms.map((c) => (
        <section key={c.id} className="brainconfirm" data-risk={c.risk} aria-label={`Forge Brain asks: ${c.summary}`}>
          <p className="brainconfirm__eyebrow">
            <RiskMark risk={c.risk} />
            <span>Forge Brain wants to</span>
            <span className="brainconfirm__riskword">{RISK_WORD[c.risk]}</span>
          </p>
          <p className="brainconfirm__summary">{c.summary}</p>
          <p className="brainconfirm__tool">{c.tool}</p>
          <div className="brainconfirm__acts">
            <button type="button" className="brainconfirm__yes" disabled={answering === c.id} onClick={() => answer(c.id, true)}>
              <Icon name="check" size={15} />
              Yes, do it
            </button>
            <button type="button" className="brainconfirm__no" disabled={answering === c.id} onClick={() => answer(c.id, false)}>
              <Icon name="close" size={13} />
              No
            </button>
          </div>
        </section>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------- intro */

/** What each engine is, in a few words. */
const ENGINE_LINE: Record<BrainEngine, string> = {
  claude: 'Claude Code, on your subscription',
  codex: 'OpenAI Codex CLI',
  gemini: 'Google Gemini CLI',
  local: 'A free model on the desktop, via Ollama'
}

/**
 * Who runs it, as a mark: the desktop's maker silhouettes (src/components/hub/
 * BrainMark.tsx — Claude's burst, OpenAI's hexagon, Gemini's spark), drawn here
 * on the same 16px grid, and a chip for the model that runs on the desktop.
 */
function EngineMark({ engine }: { engine: BrainEngine }): ReactNode {
  if (engine === 'claude') {
    return (
      <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 1.4V5.6M8 10.4V14.6M1.4 8H5.6M10.4 8H14.6M3.33 3.33 6.3 6.3M9.7 9.7 12.67 12.67M12.67 3.33 9.7 6.3M6.3 9.7 3.33 12.67"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (engine === 'codex') {
    return (
      <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.7 13.45 4.85V11.15L8 14.3 2.55 11.15V4.85Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    )
  }
  if (engine === 'gemini') {
    return (
      <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1C8.6 5.3 10.7 7.4 15 8 10.7 8.6 8.6 10.7 8 15 7.4 10.7 5.3 8.6 1 8 5.3 7.4 7.4 5.3 8 1Z" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.6" />
      <rect x="6.2" y="6.2" width="3.6" height="3.6" rx="0.6" fill="currentColor" stroke="none" />
      <path d="M6 1.2v2.3M10 1.2v2.3M6 12.5v2.3M10 12.5v2.3M1.2 6h2.3M1.2 10h2.3M12.5 6h2.3M12.5 10h2.3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The brain while it is off: what it is, who runs it, Turn on. Only ever seen
 * because it was opened — off never nags.
 */
function BrainIntro({ status, onLater }: { status: BrainStatus; onLater: () => void }): ReactNode {
  const { state, actions } = useForge()
  const live = state.stage.kind !== 'offline' && state.connection.state === 'live'
  const [busy, setBusy] = useState<'on' | BrainEngine | null>(null)
  const [error, setError] = useState('')
  const blocked = status.unavailable[status.engine]

  const run = (what: 'on' | BrainEngine): void => {
    setBusy(what)
    setError('')
    const op = what === 'on' ? ({ kind: 'brain-enable', on: true } as const) : ({ kind: 'brain-engine', engine: what } as const)
    void actions.brain(op).then((why) => {
      setBusy(null)
      if (why) setError(why)
    })
  }

  return (
    <div className="brainintro">
      <div className="brainintro__hero">
        <BrainGlyph state={busy === 'on' ? 'starting' : 'idle'} size={64} />
        <div>
          <p className="brainintro__eyebrow">One agent for all of Forge</p>
          <h2 className="brainintro__title">Forge Brain</h2>
        </div>
      </div>
      <p className="brainintro__para">
        One agent that sees the whole of Forge — every project, every pane, your settings. Tell it what you want, typed
        or spoken: it opens agents, hands them work, tells you when they finish, and asks before anything risky. It runs
        in a terminal of its own, so you can always watch it. Forge works just the same with it off.
      </p>
      <p className="brainintro__label">Who runs it</p>
      <div className="brainengines" role="radiogroup" aria-label="Who runs Forge Brain">
        {BRAIN_ENGINES.map((engine) => {
          const why = status.unavailable[engine]
          const here = engine === status.engine
          return (
            <button
              key={engine}
              type="button"
              role="radio"
              aria-checked={here}
              className="brainengine"
              data-on={here ? 'true' : undefined}
              disabled={!live || busy !== null || Boolean(why)}
              onClick={() => run(engine)}
            >
              <span className="brainengine__mark">
                <EngineMark engine={engine} />
              </span>
              <span className="brainengine__text">
                <span className="brainengine__name">{BRAIN_ENGINE_NAME[engine]}</span>
                <span className="brainengine__line">{why ? `Not available — ${why}` : ENGINE_LINE[engine]}</span>
              </span>
              <span className="brainengine__tick" aria-hidden="true">
                {here ? <Icon name="check" size={14} /> : null}
              </span>
            </button>
          )
        })}
      </div>
      {error ? (
        <p className="brainintro__error" role="alert">
          <span aria-hidden="true">×</span> {error}
        </p>
      ) : null}
      <div className="brainintro__acts">
        <button type="button" className="brainintro__on" disabled={!live || busy !== null || Boolean(blocked)} onClick={() => run('on')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
            <path d="M8 1.8v5.4M4.6 3.9a5.2 5.2 0 1 0 6.8 0" />
          </svg>
          {busy === 'on' ? 'Turning on…' : 'Turn on'}
        </button>
        <button type="button" className="brainintro__later" onClick={onLater}>
          Not now
        </button>
      </div>
      <p className="brainintro__foot">Change who runs it, or turn it off, any time in the desktop's Settings → Forge Brain.</p>
    </div>
  )
}
