import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useKeymap } from '@/hooks/useHub'
import { usePresence } from '@/lib/motion'
import { shellSheet, useShellSheet } from '@/lib/shellSlots'
import { uiCommands, useUiCommand } from '@/lib/uiCommands'
import { openBrainMap } from '../brainview'
import { BrainContextNotice, ContextRing, contextWords, useBrainContext } from './BrainContext'
import { BrainGlyph, glyphStateOf } from './BrainGlyph'
import { BrainIntro } from './BrainIntro'
import { brainSnapshot, startBrainFeed, useBrain } from './brainStore'
import './Brain.css'

/**
 * Forge Brain in the top bar: its mark, turning and taking in bolts while it
 * works. Click it, or press the shortcut (Ctrl+Shift+F, rebindable as "Forge
 * Brain"), and the map opens (components/brainview) — every project and agent
 * around the brain, its questions answered on its card there.
 *
 * While it is off the same press opens a small pop-over from the icon instead
 * (BrainIntro): the first time it explains itself, after that it is one line;
 * Turn on takes him straight on to the map. Esc or a click elsewhere puts it
 * away, and it lifts out on the menus' exit. Off never nags: nothing opens by
 * itself.
 *
 * Talking to it is not here: that is the voice agent box, with Forge Brain
 * picked as the voice agent.
 *
 * The badge says what needs saying, by shape: "!" when it is asking Steve (a
 * Yes / No it is waiting on, or a question on its screen), "×" when it has
 * stopped. Off, it says nothing at all. Beside the mark, while it is on, how
 * full its context window is (./BrainContext): a ring and the %, "?" before
 * there is a number, a triangle past Steve's line — and, once per
 * conversation, a notice offering a fresh start.
 */

const COMMAND = 'toggle-brain'

export function BrainButton(): ReactNode {
  const { status } = useBrain()
  const [intro, setIntro] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const popId = useId()
  const { commands } = useKeymap()
  const combo = commands.find((c) => c.id === `ui.${COMMAND}`)?.keys[0]

  useEffect(() => startBrainFeed(), [])
  // The id stays `toggle-brain` so a key Steve already rebound keeps working.
  useEffect(() => uiCommands.define({ id: COMMAND, title: 'Forge Brain (the map)', group: 'Shell', defaultKey: 'Ctrl+Shift+F' }), [])

  const press = (): void => {
    if (brainSnapshot().status?.enabled) {
      setIntro(false)
      openBrainMap()
      return
    }
    setIntro((v) => !v)
  }
  useUiCommand(COMMAND, press)

  // Turned on from somewhere else (Settings, the phone): nothing left to explain.
  const on = Boolean(status?.enabled)
  useEffect(() => {
    if (on) setIntro(false)
  }, [on])

  // One pop-up at a time: the pop-over puts a sheet away, and a sheet puts it away.
  const sheet = useShellSheet()
  useEffect(() => {
    if (intro) shellSheet.set(null)
  }, [intro])
  useEffect(() => {
    if (sheet) setIntro(false)
  }, [sheet])

  // Esc, or a press anywhere that is not the pop-over or its button.
  useEffect(() => {
    if (!intro) return undefined
    const onDown = (e: PointerEvent): void => {
      const t = e.target as HTMLElement | null
      if (!t || wrapRef.current?.contains(t)) return
      if (t.closest('.popover')) return
      setIntro(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      setIntro(false)
      btnRef.current?.focus()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [intro])

  // Kept on screen for the length of its exit (Brain.css), then unmounted.
  const pop = usePresence(intro && !on, 160)

  const needs = on && status ? status.state === 'asking' || status.confirms.length > 0 : false
  const stopped = on && status?.state === 'error'
  const glyph = glyphStateOf(status)
  const context = useBrainContext()

  const words = !status
    ? 'Forge Brain'
    : !on
      ? 'Forge Brain — off. Click to see what it is'
      : needs
        ? 'Forge Brain needs you — open the map to answer'
        : stopped
          ? `Forge Brain stopped${status.error ? ` — ${status.error}` : ''}`
          : status.state === 'busy'
            ? 'Forge Brain — working. Click for the map'
            : status.state === 'starting'
              ? 'Forge Brain — starting'
              : 'Forge Brain — ready. Click for the map'

  const label = on && context.shown ? `${words} — ${contextWords(context)}` : words

  return (
    <span className="brainbtn-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="brainbtn"
        data-state={glyph}
        data-open={intro ? 'true' : undefined}
        aria-label={label}
        aria-haspopup={on ? undefined : 'dialog'}
        aria-expanded={on ? undefined : intro}
        aria-controls={intro ? popId : undefined}
        title={combo ? `${label} (${combo})` : label}
        onClick={press}
      >
        <BrainGlyph state={glyph} />
        {on ? <ContextRing view={context} /> : null}
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
      {pop.mounted ? (
        <div
          id={popId}
          className="brainpop"
          data-state={pop.closing ? 'closing' : 'open'}
          role="dialog"
          aria-label="Forge Brain"
          data-shell-overlay=""
        >
          <BrainIntro
            status={status}
            onOn={() => {
              setIntro(false)
              openBrainMap()
            }}
            onClose={() => setIntro(false)}
          />
        </div>
      ) : null}
      <BrainContextNotice />
    </span>
  )
}
