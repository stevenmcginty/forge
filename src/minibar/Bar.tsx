import { useRef, type ReactNode } from 'react'
import type { MiniBarCall, MiniBarQuitInfo, MiniBarState, MiniBarViewApi } from '@shared/minibar'
import { Icon } from '@/components/Icon'
import { barEdge, BarCues } from './BarCues'
import { Chips } from './Chips'
import { BellGlyph, GripGlyph, OpenGlyph, QuitGlyph, SpeakerGlyph, StateMark, TuckGlyph } from './glyphs'
import { fmtDuration } from './format'
import { QuitConfirm } from './QuitConfirm'
import type { Panel } from './Stage'
import { TextWell } from './TextWell'

/**
 * The bar: one row, always there.
 *
 *   ends     drag to set the width (both ends, symmetric)
 *   who      grip, project pill, the agent chips (Forge first), +
 *   words    the text well: dictation's word, the box, clip, mic, Listen, Send
 *   news     bell (Activity), speaker (spoken updates)
 *   window   tuck, Open (with Open maximised), a gap, then Quit
 *
 * The bar's own surface is a drag region; every control opts out
 * (MiniBar.css). Rows that are about the whole app (quit confirm, "not
 * answering") grow out of the top of the same surface, in place. Its outline
 * carries the big bar's live cues (BarCues.tsx): the voice edge and the sent flash.
 */
export function Bar({
  state,
  call,
  api,
  panel,
  open,
  toggle,
  stale,
  staleFor,
  quit,
  onQuit,
  onQuitCancel,
  onWidth
}: {
  state: MiniBarState
  call: (c: MiniBarCall) => void
  api: MiniBarViewApi
  panel: Panel
  open: (p: Panel) => void
  toggle: (p: Exclude<Panel, null>) => void
  stale: boolean
  staleFor: number
  quit: MiniBarQuitInfo | null
  onQuit: () => void
  onQuitCancel: () => void
  onWidth: (barWidth: number) => void
}): ReactNode {
  const bar = useRef<HTMLDivElement | null>(null)
  const noProject = state.project === null
  const edge = barEdge(state)

  return (
    <div
      ref={bar}
      className="mb-bar"
      data-stale={stale ? 'true' : undefined}
      data-confirm={quit ? 'true' : undefined}
      data-edge={edge?.variant}
    >
      <BarCues state={state} edge={edge} />
      <WidthEnd side="left" bar={bar} onWidth={onWidth} />

      {quit ? (
        <QuitConfirm info={quit} api={api} onCancel={onQuitCancel} />
      ) : stale ? (
        <div className="mb-bar__notice" role="alert">
          <span className="mb-bar__notice-mark" aria-hidden="true">
            !
          </span>
          <span className="mb-bar__notice-word">Forge is not answering</span>
          <span className="mb-bar__notice-sub">Nothing from the main window for {fmtDuration(staleFor)}.</span>
          <button type="button" className="mb-btn mb-btn--solid" onClick={() => void api.openMain(false)}>
            Open Forge
          </button>
        </div>
      ) : null}

      <div className="mb-bar__row" inert={quit ? true : undefined}>
        <Grip />

        {noProject ? (
          <div className="mb-empty">
            <span className="mb-empty__word">No projects yet</span>
            <button type="button" className="mb-btn mb-btn--solid" onClick={() => void api.openMain(false)}>
              <Icon name="folderPlus" size={14} />
              Add a project
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="mb-proj"
              data-open={panel === 'projects' ? 'true' : undefined}
              aria-expanded={panel === 'projects'}
              title={`Project: ${state.project?.name ?? ''} — switch project`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggle('projects')}
            >
              <Icon name="folder" size={14} />
              <span className="mb-proj__name">{state.project?.name}</span>
              <Icon name="chevronDown" size={12} className="mb-proj__chev" />
            </button>

            <Chips state={state} call={call} panel={panel} open={open} toggle={toggle} />

            <button
              type="button"
              className="mb-ibtn mb-new"
              title="New agent in this project"
              aria-label="New agent"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => call({ t: 'newAgent' })}
            >
              <Icon name="plus" size={16} />
            </button>

            <TextWell state={state} call={call} api={api} />
          </>
        )}

        <div className="mb-cluster">
          <button
            type="button"
            className="mb-ibtn mb-bell"
            data-open={panel === 'activity' ? 'true' : undefined}
            aria-expanded={panel === 'activity'}
            title={state.unseen ? `Activity — ${state.unseen} new` : 'Activity'}
            aria-label={state.unseen ? `Activity, ${state.unseen} new` : 'Activity'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggle('activity')}
          >
            <BellGlyph />
            {state.unseen > 0 ? (
              <span key={state.unseen} className="mb-bell__count" aria-hidden="true">
                {state.unseen > 99 ? '99+' : state.unseen}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={state.speakUpdates}
            className="mb-ibtn mb-speak"
            data-on={state.speakUpdates ? 'true' : undefined}
            title={state.speakUpdates ? 'Speak updates: on — Forge says when agents finish' : 'Speak updates: off (Quiet)'}
            aria-label="Speak updates"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => call({ t: 'speakUpdates', on: !state.speakUpdates })}
          >
            <SpeakerGlyph on={state.speakUpdates} />
          </button>
        </div>

        <span className="mb-seam" aria-hidden="true" />

        <div className="mb-window">
          <button
            type="button"
            className="mb-ibtn"
            title="Tuck into a small pill"
            aria-label="Tuck"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => call({ t: 'tuck', on: true })}
          >
            <TuckGlyph />
          </button>
          <OpenSplit api={api} panel={panel} toggle={toggle} />
          <button
            type="button"
            className="mb-ibtn mb-quit"
            title="Quit Forge - closes every agent"
            aria-label="Quit Forge"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onQuit}
          >
            <QuitGlyph />
          </button>
        </div>
      </div>

      <WidthEnd side="right" bar={bar} onWidth={onWidth} />
    </div>
  )
}

/** "Open" restores Forge as it was; the chevron offers "Open maximised". */
function OpenSplit({
  api,
  panel,
  toggle
}: {
  api: MiniBarViewApi
  panel: Panel
  toggle: (p: Exclude<Panel, null>) => void
}): ReactNode {
  return (
    <span className="mb-open">
      <button
        type="button"
        className="mb-open__main"
        title="Open Forge as it was"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void api.openMain(false)}
      >
        <OpenGlyph />
        <span className="mb-open__word">Open</span>
      </button>
      <button
        type="button"
        className="mb-open__more"
        data-open={panel === 'open' ? 'true' : undefined}
        aria-expanded={panel === 'open'}
        title="More ways to open"
        aria-label="More ways to open"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => toggle('open')}
      >
        <Icon name="chevronDown" size={12} />
      </button>
    </span>
  )
}

/** Drag to move. (A drag region never hands the page a double-click on Windows.) */
function Grip(): ReactNode {
  return (
    <span className="mb-grip" title="Drag to move">
      <GripGlyph />
    </span>
  )
}

/**
 * An end of the bar: drag to set the width. Both ends move together (the
 * width changes by twice the drag), so the bar stays centred where it is and
 * the main process never has to know which end was pulled.
 */
function WidthEnd({
  side,
  bar,
  onWidth
}: {
  side: 'left' | 'right'
  bar: React.RefObject<HTMLDivElement | null>
  onWidth: (barWidth: number) => void
}): ReactNode {
  const onPointerDown = (e: React.PointerEvent<HTMLSpanElement>): void => {
    const el = bar.current
    if (!el || e.button !== 0) return
    e.preventDefault()
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const startX = e.screenX
    const startW = el.getBoundingClientRect().width
    let frame = 0
    let pending = startW
    const move = (ev: PointerEvent): void => {
      const dx = (ev.screenX - startX) * (side === 'right' ? 1 : -1)
      pending = startW + 2 * dx
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0
          onWidth(pending)
        })
      }
    }
    const up = (): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      if (frame) cancelAnimationFrame(frame)
      onWidth(pending)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }
  return <span className="mb-end" data-side={side} title="Drag to make the bar wider or narrower" onPointerDown={onPointerDown} />
}

/** No state yet: a quiet bar that can still open or quit Forge. */
export function ConnectingBar({
  api,
  onQuit,
  quit,
  onQuitCancel
}: {
  api: MiniBarViewApi
  onQuit: () => void
  quit: MiniBarQuitInfo | null
  onQuitCancel: () => void
}): ReactNode {
  return (
    <div className="mb-bar" data-quiet="true" data-confirm={quit ? 'true' : undefined}>
      {quit ? <QuitConfirm info={quit} api={api} onCancel={onQuitCancel} /> : null}
      <div className="mb-bar__row">
        <Grip />
        <span className="mb-connecting">
          <StateMark status="starting" size={11} />
          Connecting…
        </span>
        <div className="mb-window">
          <OpenSplitless api={api} />
          <button type="button" className="mb-ibtn mb-quit" title="Quit Forge - closes every agent" aria-label="Quit Forge" onClick={onQuit}>
            <QuitGlyph />
          </button>
        </div>
      </div>
    </div>
  )
}

function OpenSplitless({ api }: { api: MiniBarViewApi }): ReactNode {
  return (
    <span className="mb-open">
      <button type="button" className="mb-open__main" data-solo="true" title="Open Forge" onClick={() => void api.openMain(false)}>
        <OpenGlyph />
        <span className="mb-open__word">Open</span>
      </button>
    </span>
  )
}
