import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { MiniBarCall, MiniBarState, MiniBarViewApi } from '@shared/minibar'
import { CueGlyph } from '@/components/DictationCueView'
import { Icon } from '@/components/Icon'
import { flashBarSent } from './BarCues'
import { agentById, targetName } from './format'
import { EyeGlyph, ListenGlyph, StopSquare, TurnArc } from './glyphs'

/** The box grows as the big bar's does (Composer): one line, then a line at a time to five, then scrolls. */
const MIN_BOX_H = 34
const MAX_BOX_H = 5 * 20 + 14
const DRAFT_DEBOUNCE_MS = 250

/**
 * The words: a sunken well holding dictation's word, the text box, and the
 * keys that act on the words — attach, Screen (a look at the screen goes
 * with each send), dictate, Listen, Send (or Stop).
 *
 * The box is the view's own. It reports what it holds with `setDraft`
 * (debounced), and takes the host's draft only when the host changed it for
 * a reason of its own — the hand-off at minimise, picked paths, dictated
 * words — never an echo of what this box already said.
 */
export function TextWell({
  state,
  call,
  api
}: {
  state: MiniBarState
  call: (c: MiniBarCall) => void
  api: MiniBarViewApi
}): ReactNode {
  const [text, setText] = useState(state.draft)
  const box = useRef<HTMLTextAreaElement | null>(null)

  /* ---- the draft, both ways ---- */

  // What this box has told the host lately: an echo of one of these is not news.
  const told = useRef<string[]>([state.draft])
  const seen = useRef(state.draft)
  useEffect(() => {
    if (state.draft === seen.current) return
    seen.current = state.draft
    if (state.draft !== '' && told.current.includes(state.draft)) return
    told.current = [...told.current.slice(-7), state.draft]
    setText(state.draft)
  }, [state.draft])

  useEffect(() => {
    if (told.current[told.current.length - 1] === text) return
    const t = window.setTimeout(() => {
      told.current = [...told.current.slice(-7), text]
      call({ t: 'setDraft', text })
    }, DRAFT_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [text, call])

  // Grow with the words, up to the limit; the bar's bottom edge stays put.
  // Again when the box changes width (the chips refold), or it keeps a stale wrap.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = (): void => {
      el.style.height = '0px'
      el.style.height = `${Math.min(Math.max(MIN_BOX_H, el.scrollHeight), MAX_BOX_H)}px`
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    let width = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      fit()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [text])

  /* ---- what the end key does ---- */

  const name = targetName(state)
  const target = state.target.kind === 'pane' ? agentById(state, state.target.paneId) : undefined
  const empty = text.trim() === ''
  const canStop = empty && target?.status === 'working'

  const send = (): void => {
    if (empty) return
    call({ t: 'send', text })
    setText('')
    // The big bar's "it went": the flash, here round the bar itself.
    flashBarSent(box.current)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (text) setText('')
      else e.currentTarget.blur()
    }
  }

  const placeholder = state.target.kind === 'forge' ? 'Ask Forge…' : `Type to ${name ?? 'the agent'}…`
  const d = state.dictation

  return (
    <div className="mb-well" data-mb-well="true" data-dict={d.phase !== 'off' ? d.phase : undefined} data-empty={empty ? 'true' : undefined}>
      {d.phase !== 'off' ? <DictationWord phase={d.phase} level={d.level ?? 0} sendInMs={d.sendInMs ?? 0} call={call} /> : null}

      <textarea
        ref={box}
        className="mb-box"
        rows={1}
        value={text}
        placeholder={placeholder}
        spellCheck
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />

      <span className="mb-well__keys">
        <button
          type="button"
          className="mb-ibtn mb-ibtn--sm"
          title="Attach files — their paths go into the box"
          aria-label="Attach files"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            void api.pickFiles().then((paths) => {
              if (paths.length) call({ t: 'paths', paths })
            })
          }}
        >
          <Icon name="paperclip" size={15} />
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={state.screen}
          className="mb-ibtn mb-ibtn--sm mb-screen"
          data-on={state.screen ? 'true' : undefined}
          title={state.screen ? 'Screen: on — each send includes a look at your screen' : 'Screen: off'}
          aria-label="Screen"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => call({ t: 'screen', on: !state.screen })}
        >
          <EyeGlyph on={state.screen} />
        </button>

        <MicKey phase={d.phase} onClick={() => call({ t: 'dictate' })} />
        <ListenKey listen={state.listen} onClick={() => call({ t: 'listen' })} />

        {canStop && target ? (
          <button
            type="button"
            className="mb-send"
            data-look="stop"
            title={`Stop ${target.name}`}
            aria-label={`Stop ${target.name}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => call({ t: 'stop', paneId: target.paneId })}
          >
            <StopSquare />
          </button>
        ) : (
          <button
            type="button"
            className="mb-send"
            data-look="send"
            disabled={empty}
            title={state.target.kind === 'forge' ? 'Send to Forge (Enter)' : `Send to ${name ?? 'the agent'} (Enter)`}
            aria-label="Send"
            onMouseDown={(e) => e.preventDefault()}
            onClick={send}
          >
            <Icon name="send" size={16} />
          </button>
        )}
      </span>
    </div>
  )
}

/* -------------------------------------------------------------- dictation */

/** Listening (with the level), Writing…, or Sending… with Undo and its countdown. */
function DictationWord({
  phase,
  level,
  sendInMs,
  call
}: {
  phase: 'listening' | 'writing' | 'sending'
  level: number
  sendInMs: number
  call: (c: MiniBarCall) => void
}): ReactNode {
  // The countdown is set once, when Sending starts; later publishes do not restart it.
  const [run, setRun] = useState<{ id: number; ms: number } | null>(null)
  useEffect(() => {
    if (phase === 'sending') setRun((r) => r ?? { id: Date.now(), ms: Math.max(0, sendInMs) })
    else setRun(null)
    // Only the phase starts a countdown; sendInMs only seeds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // The big bar's own glyph (CueGlyph): its synthesizer bars, its settling dots, its draining ring.
  const levels = useRef({ mic: 0, out: 0 })
  levels.current = { mic: Math.max(0, Math.min(1, level)), out: 0 }
  const readLevels = useCallback(() => levels.current, [])
  const cue = phase === 'listening' ? 'listening' : phase === 'writing' ? 'finishing' : 'sending'

  return (
    <span key={phase} className="mb-dict" data-phase={phase}>
      <CueGlyph phase={cue} endsAt={run ? run.id + run.ms : null} readLevels={readLevels} small />
      <span className="mb-dict__word">{phase === 'listening' ? 'Listening' : phase === 'writing' ? 'Writing…' : 'Sending…'}</span>
      {phase === 'sending' && run ? <Countdown to={run.id + run.ms} /> : null}
      {phase === 'sending' ? (
        <button
          type="button"
          className="mb-dict__undo"
          title="Undo — keep the words in the box, do not send"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => call({ t: 'undoSend' })}
        >
          Undo
        </button>
      ) : null}
    </span>
  )
}

/** Seconds left before the words send, as the big bar counts them. */
function Countdown({ to }: { to: number }): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(id)
  }, [])
  return <span className="mb-dict__clock">{(Math.max(0, to - now) / 1000).toFixed(1)} s</span>
}

function MicKey({ phase, onClick }: { phase: MiniBarState['dictation']['phase']; onClick: () => void }): ReactNode {
  const look = phase === 'listening' ? 'rec' : phase === 'writing' ? 'busy' : 'idle'
  return (
    <button
      type="button"
      className="mb-mic"
      data-look={look}
      aria-pressed={phase === 'listening'}
      title={
        phase === 'listening'
          ? 'Recording — press to stop; the words go into the box, then send'
          : phase === 'writing'
            ? 'Writing the words…'
            : 'Dictate — press, talk, press again'
      }
      aria-label={phase === 'listening' ? 'Stop dictating' : 'Dictate'}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <span key={look} className="mb-mic__glyph">
        {look === 'rec' ? <StopSquare /> : look === 'busy' ? <TurnArc size={14} /> : <Icon name="mic" size={16} />}
      </span>
    </button>
  )
}

function ListenKey({ listen, onClick }: { listen: MiniBarState['listen']; onClick: () => void }): ReactNode {
  const word = !listen.on ? '' : listen.muted ? 'Muted' : listen.speaking ? 'Speaking' : 'Listening'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={listen.on}
      className="mb-listen"
      data-on={listen.on ? 'true' : undefined}
      data-look={listen.on ? (listen.muted ? 'muted' : listen.speaking ? 'speaking' : 'listening') : 'off'}
      title={listen.on ? `Listen is on — ${word}. Press to stop` : 'Listen — talk to Forge hands-free'}
      aria-label={`Listen: ${listen.on ? word : 'off'}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <ListenGlyph muted={listen.on && listen.muted} />
      {word ? (
        <span key={word} className="mb-listen__word">
          {word}
        </span>
      ) : null}
    </button>
  )
}
