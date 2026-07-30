import { useEffect, useState } from 'react'
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
