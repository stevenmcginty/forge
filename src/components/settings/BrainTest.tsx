import { useState, type ReactNode } from 'react'
import type { BrainTestResult, BrainTestTarget } from '@shared/agent-brain'

/**
 * One "Test" button and its answer, in words: "OK — Gemini key OK ·
 * gemini-3.8-live available", "Failed — Gemini: key refused". The word leads,
 * never a colour alone. Main does the probing (electron/agent-brain-test.ts);
 * nothing here sees a key.
 */
export function BrainTestButton({ target, label = 'Test' }: { target: BrainTestTarget; label?: string }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BrainTestResult | null>(null)

  const run = async (): Promise<void> => {
    const api = (window.forge as unknown as { agentBrain?: { test(t: BrainTestTarget): Promise<BrainTestResult> } }).agentBrain
    if (!api) {
      setResult({ ok: false, reason: 'This Forge build cannot test yet — restart Forge' })
      return
    }
    setBusy(true)
    setResult(null)
    try {
      setResult(await api.test(target))
    } catch (err) {
      setResult({ ok: false, reason: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="brain-test">
      <button type="button" className="ghost-btn" disabled={busy} onClick={() => void run()}>
        {busy ? 'Testing…' : label}
      </button>
      {result ? (
        <span className="brain-test__result" role="status" data-ok={result.ok ? 'true' : 'false'} title={result.detail ?? result.reason}>
          {result.ok ? 'OK — ' : 'Failed — '}
          {result.reason}
        </span>
      ) : null}
    </span>
  )
}
