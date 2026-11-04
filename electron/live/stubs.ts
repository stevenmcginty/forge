import type { LiveBrainContext, LiveConductor, LiveVoiceBrain } from './types'

/**
 * Placeholder brains so the app runs with Claude Live picked before the real
 * ones exist. The voice brain says so out loud; the Conductor takes no jobs.
 * Stop still works on a job someone else put in the ledger, because that is
 * the ledger's bookkeeping, not the Conductor's work.
 */

export const LIVE_NOT_WIRED = "Claude Live isn't wired yet."

export function createStubVoiceBrain(ctx: LiveBrainContext): LiveVoiceBrain {
  return {
    async start() {},
    async stop() {},
    async ask(turnId) {
      ctx.emit({ type: 'say', turnId, text: LIVE_NOT_WIRED, final: true })
      ctx.emit({ type: 'turn-end', turnId, ok: true })
    },
    cancel() {}
  }
}

export function createStubConductor(ctx: LiveBrainContext): LiveConductor {
  return {
    async start() {},
    async stop() {},
    async delegate() {
      return { ok: false, error: "The Conductor isn't wired yet." }
    },
    async steer() {
      return { ok: false, error: "The Conductor isn't wired yet." }
    },
    async cancel(jobId) {
      const job = ctx.ledger.setState(jobId, 'stopped', 'Stopped')
      return job ? { ok: true } : { ok: false, error: 'No such job.' }
    },
    busy: () => false
  }
}
