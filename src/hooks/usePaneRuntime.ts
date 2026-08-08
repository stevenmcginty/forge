import { useEffect, useReducer, useState } from 'react'
import { terminalHost, type PaneRuntime } from '@/lib/terminals'

/**
 * A pane's shell status, kept live off terminalHost.
 *
 * Shared by the full-size pane and the mosaic tile, which need exactly the same
 * answer to "is this thing still alive" — and must not disagree about it.
 */
export function usePaneRuntime(paneId: string): PaneRuntime {
  const [runtime, setRuntime] = useState<PaneRuntime>(() => terminalHost.runtime(paneId))

  useEffect(() => {
    setRuntime(terminalHost.runtime(paneId))
    return terminalHost.subscribeRuntime(paneId, setRuntime)
  }, [paneId])

  return runtime
}

/**
 * True while any of these panes is working — sustainedly producing output, as
 * opposed to merely having said something. See the BUSY_* rules in terminals.ts.
 *
 * Subscribes to the host's one global busy signal and re-reads the ids on
 * render, rather than holding a subscription per pane: the flag only moves on a
 * 600ms onset and a 1.2s quiet, so the re-render is rare, and the set of panes a
 * caller cares about changes every time a tab is split or closed.
 */
export function useAnyBusy(paneIds: string[]): boolean {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => terminalHost.subscribeBusy(bump), [])
  return terminalHost.anyBusy(paneIds)
}

/** True when any pane has settled on a likely question or approval prompt. */
export function useAnyAttention(paneIds: string[]): boolean {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => terminalHost.subscribeAttention(bump), [])
  return terminalHost.anyAttention(paneIds)
}

/** True once the shell is gone and the pane is showing a corpse. */
export function isPaneDead(runtime: PaneRuntime): boolean {
  return runtime.status === 'exited' || runtime.status === 'error'
}

/** The terse right-aligned note in a pane header. Empty means "say nothing". */
export function paneStatusLabel(runtime: PaneRuntime): string {
  switch (runtime.status) {
    case 'exited':
      return `exited ${runtime.exitCode ?? ''}`.trim()
    case 'error':
      return 'failed'
    case 'starting':
      return 'starting'
    case 'live':
      return runtime.pid && runtime.pid > 0 ? `pid ${runtime.pid}` : 'live'
    default:
      return ''
  }
}
