/**
 * Forge's brand-mark, as pixels.
 *
 * Three volt bars of rising height on the near-black ground — the same shape
 * the mobile top bar animates when the link is live. Drawn in code rather than
 * exported from a design tool so the geometry has one source of truth and a
 * colour change is a one-line edit.
 *
 * Shared by two generators that both write committed output:
 *
 *   scripts/companion-icons.mjs   companion/web/icons/*.png
 *   scripts/mobile-icons.mjs      mobile/public/icons/*.png
 *
 * Neither runs as part of a build. Regenerate deliberately, commit the result,
 * and `npm run pwa:check` will tell you if the bytes on disk stopped matching
 * what this file draws.
 *
 * Dependency-free on purpose: a PNG encoder is a hundred lines and `sharp` is a
 * native module. Forge ships exactly one of those already and a second, pulled
 * in for three icons that change once a year, would be a packaging risk with no
 * payoff.
 */

import { deflateSync } from 'node:zlib'

/** Near-black ground. Matches `--bg` in mobile/src/styles.css. */
export const BG = [0x0b, 0x0c, 0x0e]
/** Volt accent. Matches `--volt`. */
export const VOLT = [0xc6, 0xff, 0x4a]

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
export function encodePng(width, height, rgba) {
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

function clamp01(n) {
  return Math.min(1, Math.max(0, n))
}

/**
 * The same mark on a wide, opaque plate — Android TV's `android:banner`.
 *
 * A TV launcher shows one 320x180 tile per app and no icon and no label beside
 * it, so this is the whole of Forge's presence on a Fire TV home row. Written
 * into the android tree by scripts/apk-init.mjs rather than committed as an
 * asset next to the PWA icons, because it is a property of the *package*, not
 * of the web app: nothing outside the APK ever loads it.
 */
export function drawBanner(width, height) {
  const rgba = Buffer.alloc(width * height * 4)

  // The mark at the same proportions drawIcon uses, sized off the short edge
  // and centred. Full-bleed ground, no rounded corners: Android TV draws the
  // banner inside its own card and rounds it there, so alpha corners here would
  // come back as a dark rectangle inside a lighter one — the same trap the
  // apple-touch-icon's `bleed` exists for.
  const u = height
  const cx = width / 2
  const cy = height / 2
  const barW = u * 0.108
  const gap = u * 0.072
  const heights = [0.3, 0.46, 0.62].map((h) => h * u)
  const totalW = barW * 3 + gap * 2
  const barBottom = cy + u * 0.31
  const barR = barW / 2

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5
      const py = y + 0.5
      let barA = 0
      for (let i = 0; i < 3; i++) {
        const bx = cx - totalW / 2 + i * (barW + gap) + barW / 2
        const h = heights[i]
        const by = barBottom - h / 2
        barA = Math.max(barA, clamp01(0.5 - sdRoundRect(px, py, bx, by, barW / 2, h / 2, barR)))
      }
      const o = (y * width + x) * 4
      rgba[o] = Math.round(VOLT[0] * barA + BG[0] * (1 - barA))
      rgba[o + 1] = Math.round(VOLT[1] * barA + BG[1] * (1 - barA))
      rgba[o + 2] = Math.round(VOLT[2] * barA + BG[2] * (1 - barA))
      rgba[o + 3] = 255
    }
  }
  return encodePng(width, height, rgba)
}

/**
 * Three bars of rising height, centred, on a rounded-square ground.
 *
 * `inset` is the maskable safe zone: Android crops a maskable icon to whatever
 * shape the launcher likes, so the mark has to survive a circle inscribed in
 * the middle 80%. Shrinking the whole composition is the cheap way to do that.
 *
 * `bleed` fills every pixel with the ground instead of drawing a rounded square
 * into transparency. That is what iOS wants from an `apple-touch-icon`: it
 * applies its own corner mask and composites anything transparent over white,
 * so a rounded PNG with alpha corners comes out as a dark squircle sitting in a
 * white one. The bars are unaffected — only the ground changes shape.
 */
export function drawIcon(size, inset, { bleed = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4)
  const scale = 1 - inset

  // Ground: a rounded square filling the safe area (or the whole canvas).
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

      const groundA = bleed ? 1 : clamp01(0.5 - sdRoundRect(px, py, gcx, gcy, ghw, ghw, groundR))
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
  return encodePng(size, size, rgba)
}
