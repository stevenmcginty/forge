/**
 * The Devices preview, in its testable half.
 *
 * The view itself (src/components/DevicePreview.tsx) is chrome and sequencing;
 * everything decidable without a DOM lives here, which is where the check
 * script looks (scripts/preview-check.mjs) and where the two load-bearing
 * invariants of the whole feature are written down.
 *
 * The preview has two modes and the invariants below belong to one of them.
 * `project` — the default — points the same phone shells at whatever the open
 * project is serving, which is an ordinary page in an ordinary iframe with no
 * identity of its own. `forge` is the original: Forge Mobile itself, paired
 * through the real code door, and everything from here to `previewUrl` is about
 * that:
 *
 *  1. The two frames must load from *different hosts* — `localhost` and
 *     `127.0.0.1` are the same server but different *origins*, so each frame
 *     gets its own localStorage, its own `deviceId`, and its own device row.
 *     Same-host frames would share one identity and kick each other off the
 *     socket every time the second one reconnected (the server treats a
 *     deviceId as one session).
 *
 *  2. The pair-link host inside a frame's URL must equal that frame's own
 *     host, or the WebSocket dial fails the server's DNS-rebinding check
 *     (`originMatchesHost` in electron/mobile/server.ts compares the Origin
 *     against the Host header). `previewUrl` builds them from the same preset
 *     so they cannot drift.
 */

import { findDevServerUrl } from '@shared/devserver'
import type { PreviewDevCommand } from '@shared/types'

export type SimId = 'ios' | 'android'

/**
 * What the two frames are showing.
 *
 * `project` is the default because it is the answer to the question actually
 * being asked at this desk — "what does the thing I am building look like on a
 * phone?" `forge` is the same question about Forge Mobile, which is only ever
 * the answer while working on Forge itself.
 */
export type PreviewMode = 'project' | 'forge'

export interface DevicePreset {
  id: SimId
  /** What the frame's header says. */
  label: string
  /**
   * What the phone app reports itself as (`hardwareName` under `?sim=`), and
   * therefore the row name in Settings › Forge Mobile. The view watches for
   * this name to know a frame went live — a cross-origin iframe cannot be
   * inspected, so the devices list is the only telescope.
   */
  deviceName: string
  /** Load-bearing — see the block comment above. */
  host: 'localhost' | '127.0.0.1'
  /** The phone's CSS viewport, exactly what the iframe is sized to. */
  viewport: { w: number; h: number }
  /**
   * The system bars the mobile app reserves under `?sim=` (see `--sa-*` in
   * mobile/src/styles.css). The status bar Forge draws over the frame must be
   * exactly this tall, or it covers app content instead of sitting where the
   * real system bar would.
   */
  insets: { top: number; bottom: number }
  /** Bezel furniture, in CSS px at scale 1. */
  chrome: { bezel: number; radius: number }
}

/**
 * iPhone 15 Pro and Pixel 8. The insets must stay in step with the `--sa-*`
 * values in mobile/src/styles.css — preview-check.mjs asserts they do.
 */
export const PREVIEW_DEVICES: DevicePreset[] = [
  {
    id: 'ios',
    label: 'iPhone 15 Pro',
    deviceName: 'Preview · iPhone',
    host: 'localhost',
    viewport: { w: 393, h: 852 },
    insets: { top: 59, bottom: 34 },
    chrome: { bezel: 12, radius: 55 }
  },
  {
    id: 'android',
    label: 'Pixel 8',
    deviceName: 'Preview · Android',
    host: '127.0.0.1',
    viewport: { w: 412, h: 915 },
    insets: { top: 28, bottom: 24 },
    chrome: { bezel: 10, radius: 26 }
  }
]

/** The preset with the given sim id, or null. */
export function presetFor(id: SimId): DevicePreset | null {
  return PREVIEW_DEVICES.find((p) => p.id === id) ?? null
}

/**
 * The URL a preview frame loads: the mobile bundle on this desktop's own
 * server, with a `?sim=` platform and a `forge://pair` link carrying a fresh
 * single-use code. The app parses `pair` on boot (`App.tsx`) and dials home
 * before its first paint settles — no form, no typing, same door a QR scan
 * takes.
 *
 * The link's host is the preset's own host, never a bare copy of the server's:
 * see invariant 2 in the file header.
 */
export function previewUrl(preset: DevicePreset, port: number, code: string): string {
  const link = `forge://pair?host=${encodeURIComponent(preset.host)}&port=${port}&pt=${encodeURIComponent(code)}`
  return `http://${preset.host}:${port}/?sim=${preset.id}&pair=${encodeURIComponent(link)}`
}

/* --------------------------------------------------------- project mode */

/**
 * Make what somebody typed into a URL a frame can load.
 *
 * `localhost:3000` is what a person types and is not a URL — a browser reads a
 * bare `host:port` as a scheme it has never heard of. Anything already carrying
 * a scheme is left exactly as it was, including `https://`, because a manual URL
 * is allowed to be a deployed site rather than a dev server. Empty stays empty:
 * that is how the field says "go back to whatever you detected".
 */
export function normalizePreviewUrl(input: string): string {
  const text = input.trim()
  if (!text) return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
}

/**
 * Which URL the project frames actually load: the typed one, then the detected
 * one, then nothing.
 *
 * The order is the whole policy. A URL somebody typed is a decision, and a
 * decision is never quietly overruled by a dev server printing a banner — so a
 * detection that disagrees is offered in the view rather than applied.
 */
/**
 * The stored detected URL, re-judged on the way out rather than trusted on the
 * way in: a workspace can be carrying one persisted under an older rule (the
 * internals bug this guards against pointed both phones at a Vite deps file),
 * and re-running the scanner over the stored value applies today's rules to
 * yesterday's catch. The view uses this everywhere it says "detected" — the
 * frames, the field's placeholder, the adopt chip — so they cannot disagree.
 */
export function usableDetectedUrl(detected: string | undefined): string {
  return detected ? findDevServerUrl(detected) ?? '' : ''
}

export function resolvePreviewUrl(manual: string | undefined, detected: string | undefined): string {
  return normalizePreviewUrl(manual ?? '') || usableDetectedUrl(detected)
}

/**
 * The URL to fetch as a liveness probe, or null for "assume it is up".
 *
 * A resolved URL is not a running server. `detectedUrl` is a record of what a
 * terminal once printed, and the dev server that printed it can die at any
 * moment — at which point the frames load Chromium's connection-refused page,
 * which is white, fires the iframe's `onLoad` like any other page, and left the
 * chip saying "Live" over two blank phones. A cross-origin frame cannot be asked
 * what it loaded, so the view asks the *server* instead: a `no-cors` fetch whose
 * only question is whether the connection happened at all.
 *
 * Only the two loopback hosts are probed, and that is a CSP fact rather than a
 * preference — `connect-src` in index.html admits `http://localhost:*` and
 * `http://127.0.0.1:*`, so a fetch anywhere else would be blocked and the
 * rejection would read as a dead server. Everything else is assumed up, which is
 * also the honest answer: a deployed site is not this desk's to start or to
 * judge, and no button here could bring it back.
 */
export function probeTarget(url: string): string | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:') return null
  return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' ? url : null
}

/* ------------------------------------------------- starting the dev server */

/**
 * The command the Start button runs: the one somebody typed for this project,
 * then the one sniffed out of its package.json, then nothing.
 *
 * The same order as `resolvePreviewUrl` above and the same reason for it — a
 * decision beats a guess. The typed command is also the only door into a
 * project the sniff has nothing to say about: a static site gets `npx serve .`,
 * a python app `python app.py`, and both get the same button as a Vite project
 * without anybody opening a terminal to type it a second time.
 *
 * Empty means no button, which is honest: nothing has been typed and nothing
 * was found, so there is no command to offer.
 */
export function effectiveDevCommand(manual: string | undefined, sniffed: PreviewDevCommand | null): string {
  const typed = (manual ?? '').trim()
  if (typed) return typed
  return sniffed?.kind === 'command' ? sniffed.command : ''
}

/**
 * Should the empty state offer the Forge Mobile preview instead of a Start
 * button?
 *
 * Only for this checkout, and only while nobody has overruled it. `npm run dev`
 * in the running Forge's own tree is a second Forge fighting the first (see the
 * latch in electron/main.ts), so main refuses to guess a command there and says
 * `self` instead — and the honest offer at that point is the mode where Forge
 * previews itself, not an apology or a terminal.
 *
 * A command typed for this project by hand still wins, because the latch's job
 * was to stop a *guess*: somebody who typed `npm run mobile:build` here knows
 * something the sniff does not.
 */
export function isSelfPreview(manual: string | undefined, sniffed: PreviewDevCommand | null): boolean {
  return sniffed?.kind === 'self' && (manual ?? '').trim() === ''
}

/**
 * The iframe's box inside a project-mode shell.
 *
 * The difference between the two modes, in one function. Forge Mobile *reserves*
 * the system bars under `?sim=` (see `insets` above), so the desk draws its fake
 * bars over the top and bottom of a full-height frame and covers nothing. An
 * arbitrary website reserves nothing and knows nothing about a phone that is not
 * there, so the same overlay would sit on its header. In project mode the bars
 * are therefore part of the shell rather than over the page: the frame gets the
 * viewport minus both insets, and the phone stays exactly the same size on the
 * outside so the fit maths is untouched.
 */
export function siteViewport(preset: DevicePreset): { w: number; h: number } {
  return { w: preset.viewport.w, h: preset.viewport.h - preset.insets.top - preset.insets.bottom }
}

/**
 * The largest scale ≤ 1 at which a w×h box fits inside the available space,
 * snapped to 1/20 so the text rasterises crisply rather than to some
 * 0.8317… the renderer has to round anyway.
 *
 * 0 on a zero-sized box (the view is mounted but not laid out yet), never NaN
 * and never Infinity.
 */
export function fitScale(boxW: number, boxH: number, w: number, h: number): number {
  if (boxW <= 0 || boxH <= 0 || w <= 0 || h <= 0) return 0
  const raw = Math.min(boxW / w, boxH / h, 1)
  return Math.max(0.05, Math.floor(raw * 20) / 20)
}
