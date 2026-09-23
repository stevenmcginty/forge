import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { providerSpec, resolveVoice } from '@shared/realtime'
import type { SurfaceProps } from '@/lib/shellSlots'
import { useApp } from '@/state/AppState'
import { ACTION_GLYPH, elapsed, hubLook, isLive, LOOK_GLYPH, LOOK_WORD, PROVIDER_SHORT, useHubView } from './hubView'
import { CommandKeys } from './KeyRecorder'
import { Waveform } from './Waveform'
import './TalkSurface.css'

/**
 * Talk — the voice hub as a place (Ctrl+Shift+G, "talk" in the mode switcher).
 *
 * The dock pill is the glance; this is the room you go to when the
 * conversation is the work: the presence large enough to read across a desk,
 * the whole conversation, everything it did (and, in discussion mode,
 * everything it is holding until you say go), and every control in words.
 * It replaces the old pop-out card and the always-on-top orb.
 */
export function TalkSurface({ active }: SurfaceProps): ReactNode {
  const { state, actions } = useApp()
  const hub = useHubView()
  const live = isLive(hub.phase)
  const look = hubLook(hub.phase, hub.muted)
  const spec = providerSpec(hub.provider)
  const s = state.settings
  const voice = spec.vendor ? resolveVoice(spec.vendor, s.voiceHubVoice[spec.vendor]) : null
  const planned = hub.actions.filter((a) => a.status === 'planned')

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || !hub.sessionStartedAt) return undefined
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active, hub.sessionStartedAt])

  // The conversation follows its newest line unless you have scrolled up to read.
  const logRef = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = logRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [hub.captions])

  const noFocus = (e: React.MouseEvent): void => e.preventDefault()

  return (
    <div className="talk" data-look={look} data-live={live ? 'true' : undefined}>
      <header className="talk__head">
        <span className="talk__eyebrow">
          Live talk <span aria-hidden="true">·</span> {PROVIDER_SHORT[hub.provider]}
          {voice ? (
            <>
              {' '}
              <span aria-hidden="true">·</span> {voice}
            </>
          ) : null}
        </span>
        <span className="talk__cost">{spec.costNote}</span>
        {hub.sessionStartedAt ? (
          <span className="talk__timer mono" title="How long this session has been up">
            {elapsed(hub.sessionStartedAt, now)}
            {hub.sessionLimitMs ? ` of ${Math.round(hub.sessionLimitMs / 60000)}:00 — rolls over by itself` : ''}
          </span>
        ) : null}
      </header>

      <section className="talk__presence" aria-live="polite">
        <div className="talk__wave">
          <Waveform look={look} read={hub.readLevels} height={120} strands={4} />
        </div>
        <p className="talk__word">
          <span className="talk__glyph" aria-hidden="true">
            {LOOK_GLYPH[look]}
          </span>
          {LOOK_WORD[look]}
        </p>
        <p className="talk__sub">
          {!live
            ? `Press Start or Ctrl+Shift+Space. ${hub.realtime ? 'It listens the whole time, and you can talk over it.' : 'Parakeet hears you on this machine; Claude answers.'}`
            : hub.muted
              ? 'Quiet — the mic is off, the session is still up.'
              : hub.discussionMode
                ? 'Discussing — it can look, but nothing that changes Forge runs until you say “go”.'
                : hub.handsFree
                  ? 'Hands-free — just talk. Say “stop” or press Interrupt to cut it off.'
                  : `Press ${state.settings.sttHotkey ? 'the talk key' : 'Start'} or say “hey Jarvis”.`}
        </p>

        <div className="talk__controls">
          <button
            type="button"
            className={live ? 'talk__btn' : 'talk__btn talk__btn--go'}
            onMouseDown={noFocus}
            onClick={() => (live ? hub.stop() : hub.start())}
          >
            {live ? 'Stop' : 'Start'}
            <CommandKeys id="voice.live.toggle" />
          </button>
          <button
            type="button"
            className="talk__btn"
            data-on={hub.muted ? 'true' : undefined}
            aria-pressed={hub.muted}
            disabled={!live}
            onMouseDown={noFocus}
            onClick={() => hub.setMuted(!hub.muted)}
          >
            {hub.muted ? 'Quiet on' : 'Quiet'}
            <CommandKeys id="voice.mute" />
          </button>
          <button
            type="button"
            className="talk__btn"
            disabled={hub.phase !== 'speaking'}
            onMouseDown={noFocus}
            onClick={() => hub.interrupt()}
          >
            Interrupt
            <CommandKeys id="voice.interrupt" />
          </button>
          <button
            type="button"
            className="talk__btn"
            data-on={hub.discussionMode ? 'true' : undefined}
            aria-pressed={hub.discussionMode}
            disabled={!hub.discussionAvailable}
            title={hub.discussionAvailable ? undefined : 'Discussion mode needs Gemini Live or GPT Realtime'}
            onMouseDown={noFocus}
            onClick={() => hub.setDiscussionMode(!hub.discussionMode)}
          >
            {hub.discussionAvailable ? (hub.discussionMode ? 'Discussing' : 'Discuss') : 'Discuss — live providers only'}
          </button>
          {hub.discussionMode ? (
            <button
              type="button"
              className="talk__btn talk__btn--go"
              disabled={planned.length === 0}
              onMouseDown={noFocus}
              onClick={() => hub.go()}
            >
              Go{planned.length ? ` — run ${planned.length}` : ''}
            </button>
          ) : null}
          {!hub.realtime ? (
            <button
              type="button"
              className="talk__btn"
              data-on={hub.handsFree ? 'true' : undefined}
              aria-pressed={hub.handsFree}
              title="Listen for “hey Jarvis” so you never need the key"
              onMouseDown={noFocus}
              onClick={() => hub.setHandsFree(!hub.handsFree)}
            >
              {hub.handsFree ? 'Hands-free on' : 'Hands-free'}
            </button>
          ) : null}
        </div>

        {hub.fallbackReason || hub.error || hub.notice ? (
          <p className="talk__note" data-tone={hub.error ? 'warn' : undefined} role="status">
            <span className="talk__note-mark" aria-hidden="true">
              {hub.error ? '!' : '◆'}
            </span>
            {hub.error ?? hub.fallbackReason ?? hub.notice}
            {hub.fallbackReason ? (
              <button
                type="button"
                className="talk__link"
                onClick={() => actions.openSettings('voice')}
              >
                Add a key
              </button>
            ) : null}
          </p>
        ) : null}
      </section>

      <div className="talk__cols">
        <section className="talk__card talk__log" aria-label="Conversation">
          <header className="talk__card-head">
            <span className="talk__card-title">Conversation</span>
            <span className="talk__card-meta">{hub.captions.length ? `${hub.captions.length} lines` : ''}</span>
          </header>
          <div
            className="talk__lines"
            ref={logRef}
            onScroll={(e) => {
              const el = e.currentTarget
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
          >
            {hub.captions.length === 0 ? (
              <p className="talk__empty">
                What you say and what it answers appear here, word by word. Type to it from the bar below while live.
              </p>
            ) : null}
            {hub.captions.map((c) => (
              <p key={c.id} className="talk__line" data-role={c.role} data-final={c.final ? 'true' : undefined}>
                <span className="talk__who">{c.role === 'user' ? 'You' : PROVIDER_SHORT[hub.provider]}</span>
                <span className="talk__text">{c.text}</span>
              </p>
            ))}
          </div>
        </section>

        <section className="talk__card talk__did" aria-label="What it did">
          <header className="talk__card-head">
            <span className="talk__card-title">What it did</span>
            <span className="talk__card-meta">{planned.length ? `${planned.length} held for “go”` : ''}</span>
          </header>
          <ol className="talk__acts">
            {hub.actions.length === 0 ? (
              <li className="talk__empty">Every pane it opens, every project it switches, every prompt it sends — listed here as it happens.</li>
            ) : null}
            {[...hub.actions].reverse().map((a) => (
              <li key={a.id} className="talk__act" data-status={a.status}>
                <span className="talk__act-glyph" aria-hidden="true">
                  {ACTION_GLYPH[a.status]}
                </span>
                <span className="talk__act-text">
                  <span className="talk__act-label">{a.label}</span>
                  {a.detail ? <span className="talk__act-detail">{a.detail}</span> : null}
                </span>
                <span className="talk__act-word">{STATUS_WORD[a.status]}</span>
                <span className="talk__act-time mono">{clock(a.at)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  )
}

const STATUS_WORD: Record<'running' | 'ok' | 'failed' | 'planned', string> = {
  running: 'running',
  ok: 'done',
  failed: 'failed',
  planned: 'planned'
}

function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
