/**
 * Generate the Companion PWA's icons.
 *
 * The mark is the app's own brand-mark: three volt bars of rising height on the
 * near-black ground, which is the same shape the top bar animates when the link
 * is live. Generated rather than drawn so the geometry is one source of truth
 * and a colour change is a one-line edit, not a trip through a design tool.
 *
 *   node scripts/companion-icons.mjs
 *
 * Writes companion/web/icons/{icon-192,icon-512,icon-512-maskable}.png.
 * Committed output — this is not part of the build.
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'companion', 'web', 'icons')

const BG = [0x0b, 0x0c, 0x0e]
const VOLT = [0xc6, 0xff, 0x4a]

/* ------------------------------------------------------------------- png */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** RGBA pixel buffer -> a real PNG. */
function encodePng(width, height, rgba) {
  const stride = width * 4
  // One filter byte per scanline. Filter 0 (None) — these images are flat
  // colour, so a smarter filter would buy nothing over deflate.
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------------------------------------------ mark */

/** Signed distance to a rounded rectangle — negative inside. */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

/**
 * Three bars of rising height, centred, on a rounded-square ground.
 *
 * `inset` is the maskable safe zone: Android crops a maskable icon to whatever
 * shape the launcher likes, so the mark has to survive a circle inscribed in
 * the middle 80%. Shrinking the whole composition is the cheap way to do that.
 */
function drawIcon(size, inset) {
  const rgba = Buffer.alloc(size * size * 4)
  const scale = 1 - inset
  const pad = (size * inset) / 2

  // Ground: a rounded square filling the safe area.
  const groundR = size * scale * 0.22
  const gcx = size / 2
  const gcy = size / 2
  const ghw = (size * scale) / 2
  // Bars: three, rising, inside the ground.
  const barW = size * scale * 0.108
  const gap = size * scale * 0.072
  const heights = [0.3, 0.46, 0.62].map((h) => h * size * scale)
  const totalW = barW * 3 + gap * 2
  const barBottom = gcy + size * scale * 0.31
  const barR = barW / 2

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      const dGround = sdRoundRect(px, py, gcx, gcy, ghw, ghw, groundR)
      const groundA = clamp01(0.5 - dGround)
      if (groundA > 0) {
        ;[r, g, b] = BG
        a = groundA
      }

      let barA = 0
      for (let i = 0; i < 3; i++) {
        const bx = gcx - totalW / 2 + i * (barW + gap) + barW / 2
        const h = heights[i]
        const by = barBottom - h / 2
        const d = sdRoundRect(px, py, bx, by, barW / 2, h / 2, barR)
        barA = Math.max(barA, clamp01(0.5 - d))
      }
      if (barA > 0) {
        // Over-composite volt onto whatever is there.
        const out = a + barA * (1 - a)
        r = (VOLT[0] * barA + r * a * (1 - barA)) / (out || 1)
        g = (VOLT[1] * barA + g * a * (1 - barA)) / (out || 1)
        b = (VOLT[2] * barA + b * a * (1 - barA)) / (out || 1)
        a = out
      }

      const o = (y * size + x) * 4
      rgba[o] = Math.round(r)
      rgba[o + 1] = Math.round(g)
      rgba[o + 2] = Math.round(b)
      rgba[o + 3] = Math.round(a * 255)
    }
  }
  void pad
  return encodePng(size, size, rgba)
}

function clamp01(n) {
  return Math.min(1, Math.max(0, n))
}

/* ------------------------------------------------------------------- run */

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
