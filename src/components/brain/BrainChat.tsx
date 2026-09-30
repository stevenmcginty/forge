import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { BRAIN_ENGINE_NAME, type BrainStatus } from '@shared/brain'
import { voiceSpeaker } from '@/lib/tts'
import { useApp } from '@/state/AppState'
import { MarkdownBody } from '../hub/ArtifactView'
import { Icon } from '../Icon'
import { BrainGlyph } from './BrainGlyph'
import { timeOf, toolWords, type BrainRow, type ToolBlock } from './brainRows'
import { dropSend, retrySend, sendToBrain, setBrainTab, type BrainSend } from './brainStore'
import { useBrainVoice } from './brainVoice'

/**
 * The drop-down's chat: WhatsApp's bubbles, as Forge Web's ChatView draws them
 * — the brain on the left, Steve on the right, the time in the bubble's
 * corner, ticks on his own (one: sent; two: the brain has it; a clock: queued
 * behind a busy brain) — at the drop-down's size. A speaker on every reply
 * reads it aloud in Forge's voice.
 */

/** Within this of the bottom, new words keep the view at the bottom. */
const STICK_PX = 80

export function BrainChat({ rows, status }: { rows: BrainRow[]; status: BrainStatus }): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stuck = useRef(true)
  const voice = useBrainVoice()
  const { actions } = useApp()
  const [reading, setReading] = useState<string | null>(null)
  const readingRef = useRef(reading)
  readingRef.current = reading

  useEffect(
    () =>
      voiceSpeaker.onChange((speaking) => {
        if (!speaking) setReading(null)
      }),
    []
  )
  // Shut while reading one aloud: that reading stops with it.
  useEffect(
    () => () => {
      if (readingRef.current) voiceSpeaker.cancel()
    },
    []
  )

  const read = (key: string, text: string): void => {
    if (reading === key) {
      voiceSpeaker.cancel()
      setReading(null)
      return
    }
    setReading(key)
    void voiceSpeaker.speak(text, voice, (msg) => actions.setNotice(msg)).finally(() => setReading((r) => (r === key ? null : r)))
  }

  const working = status.state === 'busy'
  // Stay at the bottom while it is there; a reader scrolled up is left alone.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [rows, working])

  const claude = status.engine === 'claude'
  const empty = rows.length === 0

  return (
    <div
      className="brainchat"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
      }}
    >
      {!claude ? (
        <p className="brainchat__note">
          <Icon name="terminal" size={13} />
          <span>
            Chat reads Claude's transcript. {BRAIN_ENGINE_NAME[status.engine]} answers in its terminal.
          </span>
          <button type="button" className="brainchat__notebtn" onClick={() => setBrainTab('cli')}>
            Show CLI
          </button>
        </p>
      ) : null}
      {empty && claude && !working ? <Welcome status={status} /> : null}
      <ol className="brainchat__rows" aria-label="Conversation with Forge Brain" aria-live="polite">
        {rows.map((row, i) => {
          const prev = rows[i - 1]
          const tail = !prev || side(prev) !== side(row)
          if (row.kind === 'note') return <NoteRow key={row.key} text={row.text} at={row.at} />
          if (row.kind === 'mine') return <MineRow key={row.key} text={row.text} time={timeOf(row.at, row.clock)} tail={tail} />
          if (row.kind === 'send') return <SendRow key={row.key} send={row.send} tail={tail} />
          return (
            <ReplyRow
              key={row.key}
              row={row}
              tail={tail}
              reading={reading === row.key}
              onRead={() => read(row.key, row.text)}
            />
          )
        })}
        {working ? <WorkingRow tail={rows.length === 0 || side(rows[rows.length - 1]!) !== 'brain'} /> : null}
      </ol>
    </div>
  )
}

function side(row: BrainRow): 'brain' | 'me' | 'none' {
  return row.kind === 'reply' ? 'brain' : row.kind === 'note' ? 'none' : 'me'
}

/* ---------------------------------------------------------------- welcome */

const SUGGESTIONS = ['What is running right now?', 'Which agents need me?', 'Open a Claude pane in this project']

function Welcome({ status }: { status: BrainStatus }): ReactNode {
  const starting = status.state === 'starting'
  return (
    <div className="brainchat__welcome">
      <BrainGlyph state={starting ? 'starting' : status.state === 'error' ? 'error' : 'idle'} size={56} />
      <p className="brainchat__welcome-title">{starting ? `Waking ${BRAIN_ENGINE_NAME[status.engine]}…` : 'Ask Forge Brain anything'}</p>
      <p className="brainchat__welcome-sub">
        {starting
          ? 'Type now if you like — your message goes in the moment it is ready.'
          : 'It sees every project and pane, opens agents, hands them work and changes settings. Try:'}
      </p>
      {!starting ? (
        <div className="brainchat__chips">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="brainchat__chip" onClick={() => sendToBrain(s)}>
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------- rows */

function NoteRow({ text, at }: { text: string; at: number }): ReactNode {
  return (
    <li className="brainchat__notice">
      <span className="brainchat__notice-pill">
        <Icon name="forge" size={11} />
        <span>{text}</span>
        {at ? <span className="brainchat__notice-time">{timeOf(at)}</span> : null}
      </span>
    </li>
  )
}

const MineRow = memo(function MineRow({ text, time, tail }: { text: string; time: string; tail: boolean }): ReactNode {
  return (
    <li className="brainchat__row" data-side="me" data-tail={tail ? 'true' : undefined}>
      <div className="brainchat__bubble">
        <p className="brainchat__words">
          {text}
          <MetaRoom time={time} extra={22} />
        </p>
        <span className="brainchat__meta">
          <span>{time}</span>
          <Ticks kind="landed" />
        </span>
      </div>
    </li>
  )
})

function SendRow({ send, tail }: { send: BrainSend; tail: boolean }): ReactNode {
  const time = timeOf(send.at)
  if (send.phase === 'failed') {
    return (
      <li className="brainchat__row" data-side="me" data-tail={tail ? 'true' : undefined} data-failed="true">
        <div className="brainchat__bubble">
          <p className="brainchat__words">{send.text}</p>
          <p className="brainchat__failed">
            <span className="brainchat__failed-mark" aria-hidden="true">
              !
            </span>
            <span>Not sent — {send.error ?? 'something went wrong.'}</span>
          </p>
          <span className="brainchat__failed-acts">
            <button type="button" onClick={() => retrySend(send.id)}>
              <Icon name="refresh" size={12} />
              Try again
            </button>
            <button type="button" onClick={() => dropSend(send.id)}>
              <Icon name="close" size={12} />
              Discard
            </button>
          </span>
        </div>
      </li>
    )
  }
  const word = send.phase === 'queued' ? 'Queued' : send.phase === 'sending' ? 'Sending' : null
  return (
    <li className="brainchat__row" data-side="me" data-tail={tail ? 'true' : undefined} data-pending={send.phase}>
      <div className="brainchat__bubble">
        <p className="brainchat__words">
          {send.text}
          <MetaRoom time={time} extra={word ? 18 + word.length * 6.4 : 22} />
        </p>
        <span className="brainchat__meta">
          <span>{time}</span>
          {word ? (
            <span className="brainchat__queued" title={send.phase === 'queued' ? 'The brain is busy — this goes in when it is free' : 'Sending'}>
              <Clock />
              {word}
            </span>
          ) : (
            <Ticks kind="sent" />
          )}
        </span>
      </div>
    </li>
  )
}

function ReplyRow({
  row,
  tail,
  reading,
  onRead
}: {
  row: Extract<BrainRow, { kind: 'reply' }>
  tail: boolean
  reading: boolean
  onRead: () => void
}): ReactNode {
  return (
    <li className="brainchat__row" data-side="brain" data-tail={tail ? 'true' : undefined}>
      <div className="brainchat__bubble">
        {row.pieces.map((piece) =>
          piece.kind === 'text' ? (
            <Prose key={piece.key} text={piece.text} />
          ) : (
            <Tools key={piece.key} tools={piece.tools} />
          )
        )}
        <span className="brainchat__meta brainchat__meta--reply">
          {row.text ? (
            <button
              type="button"
              className="brainchat__read"
              data-reading={reading ? 'true' : undefined}
              aria-pressed={reading}
              aria-label={reading ? 'Stop reading aloud' : 'Read aloud'}
              title={reading ? 'Stop reading' : 'Read aloud'}
              onClick={onRead}
            >
              {reading ? <StopRing /> : <Speaker />}
              {reading ? <span>Reading</span> : null}
            </button>
          ) : null}
          <span>{timeOf(row.at, row.clock)}</span>
        </span>
      </div>
    </li>
  )
}

const Prose = memo(function Prose({ text }: { text: string }): ReactNode {
  return <MarkdownBody source={text} className="brainchat__md" />
})

const QUIET_TOOLS = new Set(['ToolSearch'])

/** The tools a reply used, as one quiet line: "Used open agent pane, list panes". A failure says so in words. */
function Tools({ tools: all }: { tools: ToolBlock[] }): ReactNode {
  // Loading its own tool list is Claude's housekeeping, not something it did.
  const tools = all.filter((t) => !QUIET_TOOLS.has(t.name))
  if (!tools.length) return null
  const failed = tools.filter((t) => t.failed).length
  const names = [...new Set(tools.map((t) => toolWords(t.name)))]
  const title = tools.map((t) => `${toolWords(t.name)}${t.gist ? ` — ${t.gist}` : ''}${t.failed ? ' (failed)' : ''}`).join('\n')
  return (
    <p className="brainchat__tools" title={title} data-failed={failed ? 'true' : undefined}>
      <Wrench />
      <span className="brainchat__tools-text">
        Used {names.join(', ')}
        {failed ? ` · ${failed} failed` : ''}
      </span>
    </p>
  )
}

function WorkingRow({ tail }: { tail: boolean }): ReactNode {
  return (
    <li className="brainchat__row" data-side="brain" data-tail={tail ? 'true' : undefined} data-working="true">
      <div className="brainchat__bubble brainchat__working" role="status">
        <span className="brainchat__dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        Working
      </div>
    </li>
  )
}

/* ------------------------------------------------------------------ marks */

/** Room at the end of the last line for the corner meta, so words never run under it. */
function MetaRoom({ time, extra }: { time: string; extra: number }): ReactNode {
  return <span className="brainchat__room" style={{ width: `calc(${time.length} * 0.52em + ${extra}px)` }} aria-hidden="true" />
}

/** One tick: sent. Two: the brain has it. The count is the meaning; the colour only agrees. */
function Ticks({ kind }: { kind: 'sent' | 'landed' }): ReactNode {
  const landed = kind === 'landed'
  return (
    <span className="brainchat__ticks" data-landed={landed ? 'true' : undefined} role="img" aria-label={landed ? 'The brain has it' : 'Sent'}>
      <svg width="16" height="11" viewBox="0 0 18 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {landed ? (
          <>
            <path d="M1.2 6.6 4.4 9.8 11 2.4" />
            <path d="M8.6 9.4 9 9.8 15.8 2.4" />
          </>
        ) : (
          <path d="M3.6 6.6 6.8 9.8 13.4 2.4" />
        )}
      </svg>
    </span>
  )
}

function Clock(): ReactNode {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="6" cy="6" r="4.8" />
      <path d="M6 3.4V6l1.8 1.2" />
    </svg>
  )
}

function Speaker(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6h2.6L8.6 3v10L5.1 10H2.5z" />
      <path d="M11 5.6a3.4 3.4 0 0 1 0 4.8M12.9 3.8a6 6 0 0 1 0 8.4" />
    </svg>
  )
}

function StopRing(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="6.6" y="6.6" width="6.8" height="6.8" rx="1.4" fill="currentColor" />
    </svg>
  )
}

function Wrench(): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.2 2.3a3.6 3.6 0 0 0-4.4 4.7L2 10.8a1.6 1.6 0 0 0 2.3 2.3L8 9.3a3.6 3.6 0 0 0 4.7-4.4l-2.1 2.1-1.9-.5-.5-1.9z" />
    </svg>
  )
}
