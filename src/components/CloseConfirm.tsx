import { useSyncExternalStore, type ReactNode } from 'react'
import { Popover } from './Popover'

/**
 * "This agent is working — close it anyway?", for the tile X.
 *
 * One close at a time, asked from anywhere (useCloseTerminal in MosaicView,
 * which both the Wall and the wall strip call) and drawn by the single host
 * AppStateProvider mounts — a hook cannot draw, and neither caller should have
 * to. Cancel is the default, as in electron/quit-guard.ts: it has the focus,
 * so Enter, Escape and a click anywhere else all leave the agent running.
 */
export interface CloseAsk {
  /** What the pane is called on its tile. */
  name: string
  /** Why it is worth asking: "is working", "is being driven by Foreman". */
  why: string
  /** The X that was pressed, or the tile — where the question appears. */
  anchor: HTMLElement
  /** The close itself, run only on a yes. */
  close: () => void
}

let current: CloseAsk | null = null
const listeners = new Set<() => void>()

function publish(next: CloseAsk | null): void {
  current = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Ask before closing. A second ask replaces the first. */
export function askToClose(ask: CloseAsk): void {
  publish(ask)
}

export function CloseConfirmHost(): ReactNode {
  const ask = useSyncExternalStore(subscribe, () => current)
  if (!ask) return null
  const cancel = (): void => publish(null)
  return (
    <Popover anchor={ask.anchor} open onClose={cancel} align="end" width={280} label={`Close ${ask.name}?`}>
      <div className="popover__hint">
        {ask.name} {ask.why}. Closing it stops the agent mid-task.
      </div>
      <div className="popover__actions">
        <button type="button" className="ghost-btn" autoFocus onClick={cancel}>
          Cancel
        </button>
        <button
          type="button"
          className="ghost-btn"
          data-danger="true"
          onClick={() => {
            publish(null)
            ask.close()
          }}
        >
          Close it
        </button>
      </div>
    </Popover>
  )
}
