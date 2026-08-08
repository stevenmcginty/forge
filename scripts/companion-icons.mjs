/**
 * Generate the Companion PWA's icons.
 *
 * The mark itself lives in scripts/icon-lib.mjs, shared with the Forge Mobile
 * PWA's generator so the two home-screen icons cannot drift apart.
 *
 *   node scripts/companion-icons.mjs
 *
 * Writes companion/web/icons/{icon-192,icon-512,icon-512-maskable}.png.
 * Committed output — this is not part of the build.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drawIcon } from './icon-lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'companion', 'web', 'icons')

mkdirSync(OUT, { recursive: true })
const files = [
  ['icon-192.png', drawIcon(192, 0.02)],
  ['icon-512.png', drawIcon(512, 0.02)],
  // Maskable: the launcher may crop to a circle, so pull everything into the
  // middle 80% (the platform's documented safe zone).
  ['icon-512-maskable.png', drawIcon(512, 0.2)]
]
for (const [name, bytes] of files) {
  writeFileSync(join(OUT, name), bytes)
  console.log(`wrote companion/web/icons/${name}  ${bytes.length} bytes`)
}
