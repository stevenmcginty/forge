import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useMobile } from '../lib/mobile'
import { mountTerm, type TermHost } from '../lib/term'
import { useForge } from '../state'

/**
 * Forge Brain's own terminal: its pane attached like any pane's (`attach` with
 * the brain's pane id, which the desktop re-adopts and launches the brain's
 * way). Keys typed here go straight down it — that is how a question on its
 * screen gets answered — and it follows the desktop's grid like a pane does.
 */
export function BrainTerm({ paneId }: { paneId: string }): ReactNode {
  const { state, actions } = useForge()
  const mobile = useMobile()
  const holder = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<TermHost | null>(null)
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const live = state.stage.kind !== 'offline' && state.connection.state === 'live'

  useLayoutEffect(() => {
    const el = holder.current
    if (!el) return undefined
    const act = actionsRef.current
    let attached = false
    const accent = getComputedStyle(el).getPropertyValue('--accent').trim() || '#b6f04a'
    const host = mountTerm(el, {
      fontSize: mobile ? 12 : 13,
      fontFamily: mobile
        ? "'Cascadia Mono', ui-monospace, SFMono-Regular, Menlo, 'Roboto Mono', Consolas, monospace"
        : "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
      accent,
      minimumContrastRatio: mobile ? 4.5 : undefined,
      drawBoldTextInBrightColors: true,
      fontWeight: mobile ? '500' : undefined,
      fontWeightBold: mobile ? '700' : undefined,
      onData: (data) => act.write(paneId, data),
      onResize: (cols, rows) => {
        if (attached) act.resize(paneId, cols, rows)
      }
    })
    hostRef.current = host
    // The catch-up buffer repaints; live bytes append (see PaneView).
    const stop = act.onData(paneId, (data, replay) => (replay ? host.repaint(data) : host.write(data)))
    act.attach(paneId, host.fit())
    attached = true
    return () => {
      stop()
      act.detach(paneId)
      host.dispose()
      hostRef.current = null
    }
  }, [paneId, mobile])

  // A terminal that cannot reach its shell does not take keys.
  useLayoutEffect(() => {
    hostRef.current?.setReadOnly(!live)
  }, [live, paneId])

  // Drawn at the desktop's grid, whatever that takes — the rule every pane keeps.
  const session = state.picture?.sessions.find((s) => s.id === paneId)
  const cols = session?.cols ?? 0
  const rows = session?.rows ?? 0
  useLayoutEffect(() => {
    hostRef.current?.follow(cols > 0 && rows > 0 ? { cols, rows } : null)
  }, [cols, rows, paneId])

  return <div className="brainterm" ref={holder} />
}
