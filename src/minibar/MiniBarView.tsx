import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { MiniBarCall, MiniBarQuitInfo, MiniBarState, MiniBarViewApi } from '@shared/minibar'
import { applyTheme, BUILTIN_THEMES } from '@/theme/themes'
import { Bar, ConnectingBar } from './Bar'
import { Pill } from './Pill'
import { Stage, type Panel } from './Stage'
import '@/components/shell/deck-tokens.css'
import '@/components/DictationCue.css'
import './MiniBar.css'

/**
 * The mini bar: Forge's bottom bar, floating on the desktop while the main
 * window is minimised (docs/MINI-BAR.md, 4.2).
 *
 * A pure view. It renders `MiniBarState` and sends `MiniBarCall`s through
 * `api`; it owns nothing but its own text box, which panel is open, and the
 * quit confirm. The host (the main window's renderer) is the only writer of
 * the state.
 *
 * Two layers, bottom-anchored in a transparent window: the bar (one row,
 * always there) and the stage above it, where one panel opens at a time and
 * toasts stack at the right. The window is sized to the content: this file
 * measures it and reports the height; the main process keeps the bottom edge
 * still, so the bar never moves when the stage grows.
 */

/** Room around the surfaces for their shadow, inside the window. Mirrored by --mb-pad-* in MiniBar.css. */
export const MB_PAD_X = 16
/** The bar's own width limits (spec 4.2, MAX_WIDTH in electron/minibar-window.ts); the window is this plus the side room. */
export const MB_MIN_W = 640
export const MB_MAX_W = 2400

/** After this long without a publish, the host is presumed stuck. */
const STALE_MS = 6000

/* -------------------------------------------------------------- the look */

let lookKeys: string[] = []

/**
 * Put the host's `<html>` data-* attributes onto this window's `<html>`, as
 * they are. A built-in theme also gets its colours painted here (the state
 * carries the attributes, not the resolved tokens), so Paper is Paper and not
 * Volt with light glass; a custom theme keeps the stylesheet's colours.
 */
export function applyLook(look: Record<string, string>): void {
  const root = document.documentElement
  for (const key of lookKeys) if (!(key in look)) delete root.dataset[key]
  const theme = look['theme'] ? BUILTIN_THEMES.find((t) => t.id === look['theme']) : undefined
  if (theme && root.dataset['theme'] !== theme.id) applyTheme(theme)
  for (const [key, value] of Object.entries(look)) root.dataset[key] = value
  lookKeys = Object.keys(look)
}

function useLook(look: Record<string, string> | undefined): void {
  useLayoutEffect(() => {
    // The page is the window: no background anywhere (MiniBar.css).
    document.documentElement.dataset['minibarView'] = 'true'
  }, [])
  const sig = look ? JSON.stringify(look) : ''
  useLayoutEffect(() => {
    if (look) applyLook(look)
    // `sig` stands for `look`: a new object with the same attributes is no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
}

/** A clock that ticks once a second, for "not answering" and the "ago" words. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

/* ---------------------------------------------------------------- the view */

export function MiniBarView({ state, api }: { state: MiniBarState | null; api: MiniBarViewApi }): ReactNode {
  useLook(state?.look)
  const now = useNow()
  const [chosen, setChosen] = useState<Panel>(null)
  const [quit, setQuit] = useState<MiniBarQuitInfo | null>(null)
  const [replyFor, setReplyFor] = useState<string | null>(null)
  const [chatHeld, setChatHeld] = useState(false)
  // The time of the last turn when Chat was closed by hand: it stays shut until Forge speaks again.
  const [chatShut, setChatShut] = useState(0)
  const call = useCallback((c: MiniBarCall) => api.call(c), [api])

  // A Peek arriving (a chip, a toast, an Activity row) takes the stage; a
  // Peek the host closed gives it back.
  const peekPane = state?.peek?.paneId ?? null
  useEffect(() => {
    if (peekPane) setChosen('peek')
    else setChosen((p) => (p === 'peek' ? null : p))
  }, [peekPane])

  // Activity open = everything on it is seen, including what lands while it is.
  const unseen = state?.unseen ?? 0
  useEffect(() => {
    if (chosen === 'activity' && unseen > 0) call({ t: 'seen' })
  }, [chosen, unseen, call])

  /** Open one panel (or none); leaving a Peek tells the host. */
  const chosenNow = useRef<Panel>(null)
  chosenNow.current = chosen
  const open = useCallback(
    (next: Panel) => {
      if (chosenNow.current === 'peek' && next !== 'peek') call({ t: 'closePeek' })
      setChosen(next)
      if (next !== null) setQuit(null)
    },
    [call]
  )

  const askQuit = useCallback(async () => {
    const info = await api.quitInfo()
    if (info.confirm) {
      open(null)
      setQuit(info)
    } else {
      await api.quit()
    }
  }, [api, open])

  /* ---- size: measure the content, report the height when it changes ---- */

  const content = useRef<HTMLDivElement | null>(null)
  const height = useRef(0)
  useLayoutEffect(() => {
    const el = content.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const report = (): void => {
      const h = Math.ceil(el.getBoundingClientRect().height)
      if (h === height.current) return
      height.current = h
      api.resize({ height: h })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [api])

  const resizeWidth = useCallback(
    (barWidth: number) => {
      const w = Math.round(Math.min(MB_MAX_W, Math.max(MB_MIN_W, barWidth)))
      api.resize({ height: height.current, width: w + 2 * MB_PAD_X })
    },
    [api]
  )

  /* ------------------------------------------------------------- render */

  if (!state) {
    return (
      <Shell content={content}>
        <ConnectingBar api={api} onQuit={askQuit} quit={quit} onQuitCancel={() => setQuit(null)} />
      </Shell>
    )
  }

  const stale = now - state.at > STALE_MS

  // Chat shows itself while Forge is the target and has just spoken (20 s),
  // while Listen is on, or while the pointer rests on it.
  const lastTurn = state.thread[state.thread.length - 1]
  const autoChat =
    state.target.kind === 'forge' &&
    lastTurn !== undefined &&
    lastTurn.at > chatShut &&
    (state.listen.on || chatHeld || now - lastTurn.at < 20_000)
  const panel: Panel = chosen ?? (autoChat ? 'chat' : null)

  const close = (): void => {
    if (panel === 'chat') setChatShut(lastTurn?.at ?? now)
    open(null)
  }
  const toggle = (p: Exclude<Panel, null>): void => (panel === p ? close() : open(p))

  if (state.tucked) {
    return (
      <Shell content={content} tucked>
        <Stage
          state={state}
          call={call}
          api={api}
          panel={null}
          open={open}
          close={close}
          now={now}
          replyFor={null}
          onReplied={() => undefined}
          onReply={(paneId) => {
            setReplyFor(paneId)
            call({ t: 'peek', paneId })
          }}
          onChatHold={setChatHeld}
        />
        <Pill state={state} call={call} />
      </Shell>
    )
  }

  return (
    <Shell content={content}>
      <Stage
        state={state}
        call={call}
        api={api}
        panel={panel}
        open={open}
        close={close}
        now={now}
        replyFor={replyFor}
        onReplied={() => setReplyFor(null)}
        onReply={(paneId) => {
          setReplyFor(paneId)
          call({ t: 'peek', paneId })
        }}
        onChatHold={setChatHeld}
      />
      <Bar
        state={state}
        call={call}
        api={api}
        panel={panel}
        open={open}
        toggle={toggle}
        stale={stale}
        staleFor={now - state.at}
        quit={quit}
        onQuit={askQuit}
        onQuitCancel={() => setQuit(null)}
        onWidth={resizeWidth}
      />
    </Shell>
  )
}

function Shell({
  content,
  tucked = false,
  children
}: {
  content: React.RefObject<HTMLDivElement | null>
  tucked?: boolean
  children: ReactNode
}): ReactNode {
  // The stage may take up to 60% of the screen's height (spec 4.2), less the bar.
  const stageMax = Math.max(220, Math.round(window.screen.availHeight * 0.6) - 72)
  return (
    <div className="mb" data-tucked={tucked ? 'true' : undefined} style={{ '--mb-stage-max': `${stageMax}px` } as CSSProperties}>
      <div ref={content} className="mb__content">
        {children}
      </div>
    </div>
  )
}
