/**
 * Generate build/icon.ico and build/icon-dev.ico — Forge's app icons.
 *
 *   node scripts/make-icon.mjs
 *
 * The mark is deliberately the simplest thing that reads at 16px: a machined
 * near-black plate with a hairline edge and a volt-lime "F" whose arms are the
 * same weight as the stem. Forge has no designer and no image toolchain, so the
 * icon is drawn here in code — a few filled rectangles rasterised into RGBA,
 * PNG-encoded with node:zlib, and packed into a multi-size .ico.
 *
 * Three things stop it looking stamped rather than made:
 *
 *   - the plate edge is lit, running from a bevel highlight at the top to the
 *     plain hairline at the bottom, so it reads as a machined face catching a
 *     light rather than a rounded rectangle with a border
 *   - the F carries its own top-to-bottom gradient (--accent-bright to
 *     --accent) instead of inheriting the plate's darkening, which is what kept
 *     the old glyph's foot looking dirty
 *   - 16/20/24px are drawn with a thinner inset and a slightly larger glyph.
 *     Optical sizing, not a bug: at 16px the plate margin costs a whole pixel
 *     of counter, and the arms close up into a bar.
 *
 * Colours come from src/theme/tokens.css (--bg-panel-raised, --accent,
 * --accent-bright, --line-strong); change them there and here together.
 *
 * The dev icon is the same drawing with the F recoloured to ember. Steve keeps
 * the everyday Forge and the dev checkout pinned side by side, and at 16px a
 * taskbar icon is a colour before it is a shape — a hue shift is legible where
 * an added badge or letter would just be three grey pixels. Nothing else moves,
 * so the two stay recognisably the same application.
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

/**
 * Sizes Windows actually asks for: tray/tab, taskbar, alt-tab, shell tiles.
 * 20 and 40 are the 125%/250% taskbar steps — without them Windows downsamples
 * 24 and 48, and a hairline edge does not survive being scaled by 0.83.
 */
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

const PLATE_TOP = [0x20, 0x23, 0x28, 0xff] // slightly lifted --bg-panel-raised
const PLATE_BOTTOM = [0x0c, 0x0d, 0x10, 0xff] // toward --bg-base
const EDGE = [0x33, 0x36, 0x3c, 0xff] // --line-strong
const BEVEL = [0x4c, 0x52, 0x5d, 0xff] // the lit top of that same edge
const VOLT = [0xc6, 0xff, 0x4a, 0xff] // --accent
const VOLT_BRIGHT = [0xd6, 0xff, 0x7d, 0xff] // --accent-bright
const EMBER = [0xff, 0x9d, 0x4a, 0xff] // the Ember theme's accent, src/theme/themes.ts
const EMBER_BRIGHT = [0xff, 0xb8, 0x7d, 0xff] // ...lifted 28% toward white, as themes.ts derives --accent-bright
const CLEAR = [0, 0, 0, 0]

/**
 * One .ico per channel. `icon.ico` is the name electron-builder stamps onto
 * Forge.exe and must keep — the dev icon is an extra file beside it, never a
 * substitution, so a packaged build cannot pick up the wrong one.
 */
const VARIANTS = [
  { file: 'icon.ico', mark: { base: VOLT, bright: VOLT_BRIGHT } },
  { file: 'icon-dev.ico', mark: { base: EMBER, bright: EMBER_BRIGHT } }
]

/**
 * The F, as fractions of the icon's side.
 *
 * The bounding box is centred on the plate in both axes, which for an F is the
 * right call — its mass sits top-left, but shifting to correct for that makes
 * the top arm look like it is falling off the edge.
 *
 * The middle arm is a hair lighter than the stem and top arm, and its centre
 * sits just above the cap's midpoint. Both are the standard corrections for
 * this letter: equal weights read as bottom-heavy, and a geometrically centred
 * crossbar reads as sagging.
 */
const CAP = 0.57 // cap height
const WIDTH = 0.475 // top arm, the widest part
const STEM = 0.125 // stem width, and the top arm's height
const MID_H = 0.113 // middle arm
const MID_W = 0.395
const MID_Y = 0.448 // top of the middle arm

/* ---------------------------------------------------------------- raster */

const lerp = (a, b, t) => a + (b - a) * t
const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(lerp(a[i], b[i], t)))

/**
 * One RGBA buffer for the icon at `size`, with the F drawn in `mark`
 * (`{ base, bright }` — the ends of the glyph's own gradient).
 *
 * Everything is expressed as a fraction of the size and then sampled 8x8 per
 * pixel, which is what stops the 16px version from turning the F's arms into
 * grey mush: coverage-based antialiasing on a shape this thin beats any attempt
 * at snapping to whole pixels. 64 samples is free at these dimensions — the
 * largest icon here is a quarter of a megapixel.
 */
function render(size, mark) {
  const px = Buffer.alloc(size * size * 4)
  const S = 8 // supersamples per axis
  const r = size * 0.215 // plate corner radius
  // See the header: the small sizes cannot afford the full margin.
  const small = size <= 24
  // Snapped to whole pixels up to 64. The plate is the only straight edge in
  // the icon, and an inset of 0.56px puts it down the middle of the first
  // column — a half-lit ring that reads as a blur rather than a border. Above
  // 64 there is enough resolution that the antialiased edge just looks smooth.
  const margin = size * (small ? 0.035 : 0.055)
  const inset = size <= 64 ? Math.max(Math.round(margin), 1) : margin
  const grow = small ? 1.09 : 1
  const edge = Math.max(size / 32, 1) // hairline width

  const left = 0.5 - WIDTH / 2
  const top = 0.5 - CAP / 2
  const bottom = top + CAP

  const inRoundRect = (x, y, x0, y0, x1, y1, rad) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false
    const cx = Math.min(Math.max(x, x0 + rad), x1 - rad)
    const cy = Math.min(Math.max(y, y0 + rad), y1 - rad)
    const dx = x - cx
    const dy = y - cy
    return dx * dx + dy * dy <= rad * rad
  }

  const inF = (u0, v0) => {
    // The optical enlargement is a scale about the plate's centre, so the F
    // grows without drifting off it.
    const u = 0.5 + (u0 - 0.5) / grow
    const v = 0.5 + (v0 - 0.5) / grow
    if (u < left || v < top || v > bottom) return false
    // stem
    if (u <= left + STEM) return true
    // top arm
    if (v <= top + STEM) return u <= left + WIDTH
    // middle arm
    return v >= MID_Y && v <= MID_Y + MID_H && u <= left + MID_W
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
      // Vertical gradients across the whole plate, so it reads as machined
      // metal catching a light from above rather than a flat square. The edge
      // gets one too — that is the bevel — and the glyph gets its own, which is
      // why the F's foot stays lime instead of going olive.
      const t = size > 1 ? y / (size - 1) : 0
      let colour = mix(PLATE_TOP, PLATE_BOTTOM, t)
      // A 1px ring is 7% of a 16px icon against 3% of a 32px one, so the same
      // contrast that reads as a machined edge up close reads as a halo down
      // there. The lift comes off with the size.
      const e = (edgeHit / plate) * (small ? 0.45 : 1)
      if (e > 0) colour = mix(colour, mix(BEVEL, EDGE, Math.min(t * 1.35, 1)), e)
      const g = glyph / total
      if (g > 0) colour = mix(colour, mix(mark.bright, mark.base, t), g)
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
    dir.writeUInt32LE(data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += data.length
  }

  return Buffer.concat([header, dir, ...images.map((i) => i.data)])
}

/* ------------------------------------------------------------------- run */

mkdirSync(OUT_DIR, { recursive: true })
for (const { file, mark } of VARIANTS) {
  const images = SIZES.map((size) => ({ size, data: png(size, render(size, mark)) }))
  const bytes = ico(images)
  const out = join(OUT_DIR, file)
  writeFileSync(out, bytes)
  console.log(`  ok   wrote ${out} — ${SIZES.join('/')} px, ${(bytes.length / 1024).toFixed(1)} KB`)
}
