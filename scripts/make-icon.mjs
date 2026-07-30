/**
 * Generate build/icon.ico — Forge's app icon.
 *
 *   node scripts/make-icon.mjs
 *
 * The mark is deliberately the simplest thing that reads at 16px: a machined
 * near-black plate with a hairline edge and a volt-lime "F" whose arms are the
 * same weight as the stem. Forge has no designer and no image toolchain, so the
 * icon is drawn here in code — a few filled rectangles rasterised into RGBA,
 * PNG-encoded with node:zlib, and packed into a multi-size .ico.
 *
 * Colours come from src/theme/tokens.css (--bg-panel-raised, --accent,
 * --line-strong); change them there and here together.
 *
 * Why hand-rolled: an .ico is a 6-byte header plus one 16-byte directory entry
 * per image, and since Vista the images may be whole PNG files. That is ~40
 * lines, against a native-dependency image library for a file that changes once.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUT_DIR = join(ROOT, 'build')
const OUT = join(OUT_DIR, 'icon.ico')

/** Sizes Windows actually asks for: tray/tab, taskbar, alt-tab, shell tiles. */
const SIZES = [16, 24, 32, 48, 64, 128, 256]

const PLATE_TOP = [0x1e, 0x21, 0x27, 0xff] // slightly lifted --bg-panel-raised
const PLATE_BOTTOM = [0x0d, 0x0e, 0x11, 0xff] // toward --bg-base
const EDGE = [0x3a, 0x3f, 0x49, 0xff] // --line-strong, a touch brighter
const VOLT = [0xc6, 0xff, 0x4a, 0xff] // --accent
const CLEAR = [0, 0, 0, 0]

/* ---------------------------------------------------------------- raster */

/**
 * One RGBA buffer for the icon at `size`.
 *
 * Everything is expressed as a fraction of the size and then sampled 4x4 per
 * pixel, which is what stops the 16px version from turning the F's arms into
 * grey mush: coverage-based antialiasing on a shape this thin beats any attempt
 * at snapping to whole pixels.
 */
function render(size) {
  const px = Buffer.alloc(size * size * 4)
  const S = 4 // supersamples per axis
  const r = size * 0.22 // plate corner radius
  const inset = size * 0.055
  const edge = Math.max(size / 32, 1) // hairline width

  // The F, in plate-relative units (0..1 across the inner square).
  const stemX0 = 0.3
  const stemX1 = 0.44
  const armX1 = 0.73
  const midArmX1 = 0.64
  const top = 0.24
  const bottom = 0.78
  const armH = 0.14
  const midY0 = 0.44
  const midY1 = midY0 + armH * 0.92

  const inRoundRect = (x, y, x0, y0, x1, y1, rad) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false
    const cx = Math.min(Math.max(x, x0 + rad), x1 - rad)
    const cy = Math.min(Math.max(y, y0 + rad), y1 - rad)
    const dx = x - cx
    const dy = y - cy
    return dx * dx + dy * dy <= rad * rad
  }

  const inF = (u, v) => {
    // stem
    if (u >= stemX0 && u <= stemX1 && v >= top && v <= bottom) return true
    // top arm
    if (u >= stemX0 && u <= armX1 && v >= top && v <= top + armH) return true
    // middle arm
    if (u >= stemX0 && u <= midArmX1 && v >= midY0 && v <= midY1) return true
    return false
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let plate = 0
      let edgeHit = 0
      let glyph = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const fx = x + (sx + 0.5) / S
          const fy = y + (sy + 0.5) / S
          const outer = inRoundRect(fx, fy, inset, inset, size - inset, size - inset, r)
          if (!outer) continue
          plate++
          const inner = inRoundRect(
            fx,
            fy,
            inset + edge,
            inset + edge,
            size - inset - edge,
            size - inset - edge,
            Math.max(r - edge, 0)
          )
          if (!inner) {
            edgeHit++
            continue
          }
          if (inF(fx / size, fy / size)) glyph++
        }
      }
      const total = S * S
      const o = (y * size + x) * 4
      if (plate === 0) {
        px[o] = CLEAR[0]
        px[o + 1] = CLEAR[1]
        px[o + 2] = CLEAR[2]
        px[o + 3] = CLEAR[3]
        continue
      }
      // Vertical gradient across the plate, so it reads as machined metal
      // rather than a flat square.
      const t = y / (size - 1)
      const base = [0, 1, 2].map((i) => Math.round(PLATE_TOP[i] + (PLATE_BOTTOM[i] - PLATE_TOP[i]) * t))
      let colour = base
      if (edgeHit / plate > 0.5) colour = [EDGE[0], EDGE[1], EDGE[2]]
      const g = glyph / total
      if (g > 0) {
        colour = [0, 1, 2].map((i) => Math.round(colour[i] * (1 - g) + VOLT[i] * g))
      }
      px[o] = colour[0]
      px[o + 1] = colour[1]
      px[o + 2] = colour[2]
      px[o + 3] = Math.round((plate / total) * 255)
    }
  }
  return px
}

/* ------------------------------------------------------------------- png */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  // 10..12: deflate, adaptive filtering, no interlace — all zero already.

  // Filter type 0 on every scanline: these images are tiny and the gradient
  // compresses fine without paeth.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------------------------------------------- ico */

function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(images.length, 4)

  const dir = Buffer.alloc(16 * images.length)
  let offset = header.length + dir.length
  for (let i = 0; i < images.length; i++) {
    const { size, data } = images[i]
    const e = i * 16
    // 256 is stored as 0 — the field is a single byte.
    dir[e] = size >= 256 ? 0 : size
    dir[e + 1] = size >= 256 ? 0 : size
    dir[e + 2] = 0 // palette entries
    dir[e + 3] = 0 // reserved
    dir.writeUInt16LE(1, e + 4) // colour planes
    dir.writeUInt16LE(32, e + 6) // bits per pixel
    dir.writeUInt32BE(0, e + 8)
    dir.writeUInt32LE(data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += data.length
  }

  return Buffer.concat([header, dir, ...images.map((i) => i.data)])
}

/* ------------------------------------------------------------------- run */

mkdirSync(OUT_DIR, { recursive: true })
const images = SIZES.map((size) => ({ size, data: png(size, render(size)) }))
const bytes = ico(images)
writeFileSync(OUT, bytes)
console.log(`  ok   wrote ${OUT} — ${SIZES.join('/')} px, ${(bytes.length / 1024).toFixed(1)} KB`)
