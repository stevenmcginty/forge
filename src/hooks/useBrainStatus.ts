import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { AGENT_BRAINS, type AgentBrainSpec, type BrainTestResult, type BrainTestTarget } from '@shared/agent-brain'
import { keyOf, probeSig, type Probe } from '@/lib/brainStatus'

/**
 * The live probe behind every brain's status word, shared by Settings' Main
 * agent card and the voice bar's brain picker (lib/brainStatus.ts turns a
 * probe into the word).
 *
 * Test results are kept for the session so reopening Settings, or the picker,
 * does not probe every engine again. A probe is read-only (a model list, a
 * CLI's version and auth status — electron/agent-brain-test.ts), so running
 * them on arrival is what lets every row carry a real status word rather than
 * "untested". Keyed on the inputs that change the answer: the key, and
 * Claude's model.
 */
const probeCache = new Map<string, { sig: string; at: number; result: BrainTestResult }>()
const PROBE_TTL = 5 * 60_000

async function runTest(target: BrainTestTarget): Promise<BrainTestResult> {
  const api = (window.forge as unknown as { agentBrain?: { test(t: BrainTestTarget): Promise<BrainTestResult> } }).agentBrain
  if (!api) return { ok: false, reason: 'This Forge build cannot test yet — restart Forge' }
  try {
    return await api.test(target)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export function useBrainProbes(s: Settings): { probes: Record<string, Probe>; test: (spec: AgentBrainSpec) => void } {
  const [probes, setProbes] = useState<Record<string, Probe>>(() => {
    const out: Record<string, Probe> = {}
    for (const spec of AGENT_BRAINS) {
      const hit = probeCache.get(spec.id)
      if (hit && hit.sig === probeSig(spec, s)) out[spec.id] = { busy: false, result: hit.result }
    }
    return out
  })

  const test = (spec: AgentBrainSpec): void => {
    const sig = probeSig(spec, s)
    setProbes((p) => ({ ...p, [spec.id]: { busy: true, result: p[spec.id]?.result ?? null } }))
    void runTest({ kind: 'brain', id: spec.id }).then((result) => {
      probeCache.set(spec.id, { sig, at: Date.now(), result })
      setProbes((p) => ({ ...p, [spec.id]: { busy: false, result } }))
    })
  }

  // On arrival, and again when a key or Claude's model changes: probe every
  // engine that has what it needs and no fresh answer.
  const sigs = AGENT_BRAINS.map((spec) => probeSig(spec, s)).join('\n')
  useEffect(() => {
    for (const spec of AGENT_BRAINS) {
      if (spec.key && !keyOf(s, spec.key)) continue
      const hit = probeCache.get(spec.id)
      if (hit && hit.sig === probeSig(spec, s) && Date.now() - hit.at < PROBE_TTL) {
        setProbes((p) => (p[spec.id]?.result === hit.result ? p : { ...p, [spec.id]: { busy: false, result: hit.result } }))
        continue
      }
      test(spec)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigs])

  return { probes, test }
}
