/**
 * Generate the Forge Mobile PWA's icons.
 *
 * The mark comes from scripts/icon-lib.mjs — the same three volt bars the
 * Companion PWA uses, because both end up on the same home screen and two
 * slightly different Forge icons would be a bug nobody could name.
 *
 *   node scripts/mobile-icons.mjs
 *
 * Writes mobile/public/icons/*.png, which Vite copies verbatim into
 * mobile/dist. Committed output — this is not part of the build, so a checkout
 * with no toolchain still serves a real icon.
 *
 * Four sizes, and the fourth is not decoration:
 *
 *   icon-192            the manifest's small icon; what Android's installer reads
 *   icon-512            the manifest's large icon; splash screens and stores
 *   icon-512-maskable   `purpose: maskable`, drawn inside the middle 80%
 *   apple-touch-icon    180x180, **full-bleed and fully opaque**
 *
 * iOS reads `<link rel="apple-touch-icon">` rather than the manifest when it
 * adds a page to the home screen, applies its own corner mask, and composites
 * anything transparent over white. A rounded PNG with alpha corners therefore
 * comes out as a dark squircle inside a white one. `bleed: true` fills every
 * pixel with the ground so iOS's own mask is the only rounding that happens.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drawIcon } from './icon-lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'mobile', 'public', 'icons')

mkdirSync(OUT, { recursive: true })
const files = [
  ['icon-192.png', drawIcon(192, 0.02)],
  ['icon-512.png', drawIcon(512, 0.02)],
  ['icon-512-maskable.png', drawIcon(512, 0.2)],
  ['apple-touch-icon.png', drawIcon(180, 0.02, { bleed: true })]
]
for (const [name, bytes] of files) {
  writeFileSync(join(OUT, name), bytes)
  console.log(`wrote mobile/public/icons/${name}  ${bytes.length} bytes`)
}
