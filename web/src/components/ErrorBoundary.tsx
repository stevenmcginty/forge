import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { GateError, GateFrame, GateLead } from './Connection'
import './ErrorBoundary.css'

/**
 * The last line before a blank page.
 *
 * Without this, any throw during render unmounts the whole tree and the phone
 * shows nothing at all — which is exactly what commit 4580275 did (a hook below
 * an early return, a project with no tabs). This catches it and puts the error
 * on the same doorway the connection screens use: a title, the message, a way
 * back (Reload) and a way to hand it on (Copy error). Words carry the state, so
 * it reads the same to anyone who cannot tell the colours apart.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown; stack: string }> {
  state = { error: undefined as unknown, stack: '' }

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error: error ?? new Error('Unknown error') }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Forge Web hit an error', error, info.componentStack)
    this.setState({ stack: info.componentStack ?? '' })
  }

  render(): ReactNode {
    if (this.state.error === undefined) return this.props.children
    return <Crashed error={this.state.error} stack={this.state.stack} />
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

function Crashed({ error, stack }: { error: unknown; stack: string }): ReactNode {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const message = messageOf(error)

  const onCopy = async (): Promise<void> => {
    const detail = error instanceof Error && error.stack ? error.stack : message
    try {
      await navigator.clipboard.writeText(`${detail}\n\nComponent stack:${stack || ' (none)'}`)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }

  return (
    <GateFrame reason="crash">
      <GateLead icon="restart" title="Forge Web hit an error">
        <p className="gate__body">The page stopped instead of drawing a blank. Reloading usually brings it back.</p>
      </GateLead>
      <GateError>{message}</GateError>
      <button type="button" className="cta-btn gate__go" onClick={() => location.reload()}>
        Reload
      </button>
      <button type="button" className="ghost-btn gate__copy" onClick={() => void onCopy()} aria-live="polite">
        {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Could not copy' : 'Copy error'}
      </button>
    </GateFrame>
  )
}
