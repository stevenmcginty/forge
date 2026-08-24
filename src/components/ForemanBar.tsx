import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FOREMAN_SEED_MAX, type ForemanState } from '@shared/foreman'
import { foremanDriving, useForeman } from '@/state/Foreman'
import { Icon } from './Icon'
import './ForemanBar.css'

/**
 * Foreman, in a pane.
 *
 * Three parts, deliberately separate because they live in three places in the
 * pane's markup and share nothing but the pane id:
 *
 *  • `ForemanToggle` sits in the header next to the permission chip. It is the
 *    switch, and it is the whole of the safety story: a pane that something
 *    else is typing into must say so at a glance, from across the room, in
 *    every theme. Grey when it is yours, lit when it is not.
 *  • `ForemanSeed` is the strip that drops under the header when you switch it
 *    on — a line or a whole brief about the job, which Foreman turns into the
 *    actual concept.
 *  • `ForemanFooter` is the standing line at the bottom, and the decision log
 *    behind it. The log is the only record of *why* a pane got the answer it
 *    got, because the reasoning itself lives in a session nobody watches.
 *
 * The open/closed state of the strip and the log belongs to the pane rather
 * than to any of these, so all three are controlled — TerminalPane owns the two
 * booleans and nothing here remembers anything across a remount.
 */

/* ------------------------------------------------------------------ toggle */

/**
 * What the switch says when you rest on it.
 *
 * Always the live status line when there is one: "Answering: overwrite
 * index.html?" is the sentence that tells you whether to take the keyboard
 * back, and burying it in a log two clicks away would be the wrong place for it.
 */
function toggleTitle(state: ForemanState): string {
  if (state.status === 'off') return 'Foreman — hand this pane a job and it drives it to the end'
  if (state.status === 'done') return `Foreman finished: ${state.line || 'the job is done'}`
  if (state.status === 'error') return `Foreman stopped: ${state.line || 'something went wrong'}`
  return `Foreman is driving — ${state.line || 'working'}. Click to take the keyboard back.`
}

export function ForemanToggle({ paneId, onSeed }: { paneId: string; onSeed: () => void }): ReactNode {
  const foreman = useForeman()
  const state = foreman.paneState(paneId)
  const live = foremanDriving(state.status)

  return (
    <button
      type="button"
      className="pane__foreman"
      data-on={live ? 'true' : undefined}
      data-status={state.status}
      role="switch"
      aria-checked={live}
      title={toggleTitle(state)}
      // Off, done and failed all mean the same thing to a click: this pane is
      // yours, and you are about to hand it over. Only a running job is stopped
      // — with no confirmation, because the human taking the keyboard back is
      // not a decision anything should slow down.
      onClick={() => (live ? foreman.stop(paneId) : onSeed())}
    >
      <span className="pane__foreman-dot" />
      Foreman
    </button>
  )
}

/* -------------------------------------------------------------------- seed */

/**
 * How tall the seed textarea grows before it scrolls instead — about eight
 * lines of `.pane__seed-input`'s own font/line-height/padding, the same
 * "rows 1 to a screenful, then scroll" shape as a chat composer.
 */
const SEED_MAX_GROW_PX = 152

export function ForemanSeed({
  paneId,
  /** The pane has a live shell, so "take over what is already here" is real. */
  canTakeOver,
  onClose
}: {
  paneId: string
  canTakeOver: boolean
  onClose: () => void
}): ReactNode {
  const foreman = useForeman()
  const [seed, setSeed] = useState('')
  const field = useRef<HTMLTextAreaElement | null>(null)

  // Rows 1 through ~8 grow with the text, past that it scrolls in place — a
  // seed can be a whole pasted brief, not just the one line the placeholder
  // suggests.
  useEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = '0px'
    const next = Math.min(el.scrollHeight, SEED_MAX_GROW_PX)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > SEED_MAX_GROW_PX ? 'auto' : 'hidden'
  }, [seed])

  const go = (): void => {
    const line = seed.trim()
    // An empty seed is only meaningful over a running session: Foreman reads
    // the screen, works out what is going on and carries it. With nothing
    // running there is nothing to take over, so the field has to say something.
    if (!line && !canTakeOver) return
    onClose()
    void foreman.start(paneId, line)
  }

  return (
    <div className="pane__seed">
      <Icon name="foreman" size={13} className="pane__seed-mark" />
      <div className="pane__seed-field">
        <textarea
          ref={field}
          className="pane__seed-input"
          value={seed}
          rows={1}
          autoFocus
          spellCheck={false}
          maxLength={FOREMAN_SEED_MAX}
          placeholder="What’s the job? A line or a whole brief — both work."
          aria-label="What Foreman should do in this pane"
          onChange={(e) => setSeed(e.target.value)}
          // The global shortcut map listens in the capture phase and would read
          // a typed "w" as close-pane.
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              go()
            }
            if (e.key === 'Escape') onClose()
          }}
        />
        {canTakeOver ? (
          <span className="pane__seed-hint">Leave blank to take over the current session.</span>
        ) : null}
      </div>
      <button type="button" className="pane__seed-go" disabled={!seed.trim() && !canTakeOver} onClick={go}>
        Start
      </button>
      <button type="button" className="ghost-btn pane__seed-cancel" title="Cancel (Esc)" onClick={onClose}>
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ footer */

/** `14:07` — a timestamp you read, not one you sort by. */
function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function ForemanFooter({
  paneId,
  logOpen,
  onToggleLog
}: {
  paneId: string
  logOpen: boolean
  onToggleLog: () => void
}): ReactNode {
  const foreman = useForeman()
  const state = foreman.paneState(paneId)
  const listRef = useRef<HTMLOListElement | null>(null)
  const entries = state.log.length

  // Newest-last, so the bottom is the interesting end — the same reason a
  // terminal scrolls the way it does. Opening lands you there, and a line that
  // arrives while it is open follows.
  useEffect(() => {
    if (!logOpen) return
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logOpen, entries])

  if (state.status === 'off' || foreman.dismissed(paneId)) return null
  const finished = state.status === 'done' || state.status === 'error'

  return (
    <>
      {logOpen ? (
        <div className="pane__flog" data-status={state.status}>
          <header className="pane__flog-head">
            <span className="eyebrow">Decision log</span>
            {state.seed ? <span className="pane__flog-seed truncate">{state.seed}</span> : null}
            <button type="button" className="ghost-btn pane__flog-close" title="Close the log" onClick={onToggleLog}>
              <Icon name="close" size={12} />
            </button>
          </header>
          <ol className="pane__flog-list" ref={listRef}>
            {state.log.map((entry, i) => (
              <li className="pane__flog-row" key={`${entry.at}:${i}`}>
                <span className="pane__flog-kind mono" data-kind={entry.kind}>
                  {entry.kind}
                </span>
                <span className="pane__flog-at mono">{clock(entry.at)}</span>
                <span className="pane__flog-text">{entry.text}</span>
              </li>
            ))}
            {entries === 0 ? <li className="pane__flog-empty">Nothing decided yet.</li> : null}
          </ol>
        </div>
      ) : null}

      <footer className="pane__foot" data-status={state.status}>
        <button
          type="button"
          className="pane__foot-line"
          aria-expanded={logOpen}
          title={
            entries === 1 ? 'Show what Foreman has decided (1 entry)' : `Show what Foreman has decided (${entries} entries)`
          }
          onClick={onToggleLog}
        >
          <Icon name={state.status === 'done' ? 'check' : 'foreman'} size={12} className="pane__foot-mark" />
          <span className="pane__foot-text truncate">{state.line || 'Working'}</span>
        </button>
        {finished ? (
          <button
            type="button"
            className="ghost-btn pane__foot-dismiss"
            title="Dismiss this line"
            aria-label="Dismiss Foreman’s last line"
            onClick={() => {
              // The log goes with it: leaving it open would put a panel over a
              // pane whose footer has just been taken away from under it.
              if (logOpen) onToggleLog()
              foreman.dismiss(paneId)
            }}
          >
            <Icon name="close" size={11} />
          </button>
        ) : null}
      </footer>
    </>
  )
}
