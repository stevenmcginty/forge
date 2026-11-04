/**
 * Claude Live's desktop UI (Design B, docs/live-agent-design/B.html).
 * Mount `<LiveSurface view={useLive()} />` once, over the canvas; everything
 * else here is its parts.
 */
export { LiveSurface } from './LiveSurface'
export type { LivePhase, LiveShowing, LiveTurn, LiveView } from './types'
