/**
 * Forge's brand-mark, as pixels.
 *
 * An obsidian machined plate with a lit bevel edge and the glowing Volt Lime
 * Forge "F" monogram. Antialiased in code via signed distance fields and
 * supersampling so the geometry is pixel-crisp at every resolution.
 *
 * Shared by icon generators:
 *   scripts/companion-icons.mjs   companion/web/icons/*.png
 *   scripts/mobile-icons.mjs      mobile/public/icons/*.png, web/public/icons/*.png
 *
 * Run `npm run mobile:icons` or `node scripts/mobile-icons.mjs` to regenerate.
 */

import { deflateSync } from 'node:zlib'

/** Obsidian plate ground. */
export const BG = [0x0b, 0x0c, 0x0e]
export const PLATE_TOP = [0x20, 0x24, 0x2c]
export const PLATE_BOTTOM = [0x0a, 0x0b, 0x0e]
export const BEVEL_TOP = [0x50, 0x58, 0x68]
export const BEVEL_BOTTOM = [0x22, 0x25, 0x2c]

/** Volt accents. */
export const VOLT = [0xc6, 0xff, 0x4a]
export const VOLT_BRIGHT = [0xe6, 0xff, 0x8a]
export const VOLT_DEEP = [0x9e, 0xeb, 0x28]

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
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------------------------------------------ math */

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

const lerp = (a, b, t) => a + (b - a) * t
const mix3 = (a, b, t) => [0, 1, 2].map((i) => Math.round(lerp(a[i], b[i], t)))

/** Signed distance to the Forge "F" glyph. */
function sdForgeF(px, py, cx, cy, u) {
  const cap = 0.58 * u
  const width = 0.48 * u
  const stem = 0.128 * u
  const midH = 0.116 * u
  const midW = 0.395 * u
  const midY = cy - cap / 2 + 0.44 * cap
  const left = cx - width / 2
  const top = cy - cap / 2
  const cornerR = stem * 0.22

  const dStem = sdRoundRect(px, py, left + stem / 2, top + cap / 2, stem / 2, cap / 2, cornerR)
  const dTopArm = sdRoundRect(px, py, left + width / 2, top + stem / 2, width / 2, stem / 2, cornerR)
  const dMidArm = sdRoundRect(px, py, left + midW / 2, midY + midH / 2, midW / 2, midH / 2, cornerR)

  return Math.min(dStem, dTopArm, dMidArm)
}

/* ---------------------------------------------------------------- render */

/**
 * Render the banner for Android TV.
 */
export function drawBanner(width, height) {
  const rgba = Buffer.alloc(width * height * 4)
  const cx = width / 2
  const cy = height / 2
  const u = height * 0.85

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const tY = y / (height - 1)

      // Base background: dark metallic gradient
      let col = mix3(PLATE_TOP, PLATE_BOTTOM, tY)

      const dF = sdForgeF(px, py, cx, cy, u)

      // Ambient volt glow
      if (dF > 0 && dF < u * 0.2) {
        const glow = Math.exp(-dF / (u * 0.05)) * 0.35
        col = mix3(col, VOLT, glow)
      }

      // Glyph body
      const glyphA = clamp01(0.5 - dF)
      if (glyphA > 0) {
        const topY = cy - 0.29 * u
        const botY = cy + 0.29 * u
        const tG = clamp01((py - topY) / (botY - topY || 1))
        const glyphCol = mix3(VOLT_BRIGHT, VOLT_DEEP, tG)
        col = mix3(col, glyphCol, glyphA)
      }

      const o = (y * width + x) * 4
      rgba[o] = col[0]
      rgba[o + 1] = col[1]
      rgba[o + 2] = col[2]
      rgba[o + 3] = 255
    }
  }
  return encodePng(width, height, rgba)
}

/**
 * Draw Forge icon at `size`, with `inset` for safe margins (e.g. maskable).
 */
export function drawIcon(size, inset, { bleed = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4)
  const scale = 1 - inset
  const plateW = size * scale
  const plateR = plateW * 0.22
  const gcx = size / 2
  const gcy = size / 2
  const edgeW = Math.max(1, plateW / 36)

  // Glyph scale
  const u = plateW

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5

      // Plate geometry
      const dPlate = sdRoundRect(px, py, gcx, gcy, plateW / 2, plateW / 2, plateR)
      const plateA = bleed ? 1 : clamp01(0.5 - dPlate)

      if (plateA <= 0) {
        const o = (y * size + x) * 4
        rgba[o] = 0
        rgba[o + 1] = 0
        rgba[o + 2] = 0
        rgba[o + 3] = 0
        continue
      }

      // Ground colour gradient
      const tY = clamp01((py - (gcy - plateW / 2)) / (plateW || 1))
      let col = mix3(PLATE_TOP, PLATE_BOTTOM, tY)

      // Radial ambient highlight
      const dCenter = Math.hypot(px - gcx, py - gcy) / (plateW * 0.55)
      const radialLift = Math.max(0, 1 - dCenter) * 0.12
      col = mix3(col, [0x30, 0x38, 0x48], radialLift)

      // Plate bevel edge highlight
      if (!bleed && dPlate > -edgeW && dPlate <= 0) {
        const edgeT = clamp01((dPlate + edgeW) / edgeW)
        const bevelCol = mix3(BEVEL_TOP, BEVEL_BOTTOM, Math.min(tY * 1.3, 1))
        col = mix3(col, bevelCol, edgeT * 0.85)
      }

      // Forge "F" signed distance
      const dF = sdForgeF(px, py, gcx, gcy, u)

      // Soft ambient neon glow around the F
      if (dF > 0 && dF < u * 0.18) {
        const glow = Math.exp(-dF / (u * 0.042)) * 0.38
        col = mix3(col, VOLT, glow)
      }

      // Glyph body with crisp gradient and lighting
      const glyphA = clamp01(0.5 - dF)
      if (glyphA > 0) {
        const topY = gcy - 0.29 * u
        const botY = gcy + 0.29 * u
        const tG = clamp01((py - topY) / (botY - topY || 1))
        let glyphCol = mix3(VOLT_BRIGHT, VOLT_DEEP, tG)

        // Top edge specular sheen
        if (dF < 0 && dF > -edgeW * 0.8 && tG < 0.45) {
          glyphCol = mix3(glyphCol, [0xff, 0xff, 0xe0], 0.3)
        }

        col = mix3(col, glyphCol, glyphA)
      }

      const o = (y * size + x) * 4
      rgba[o] = col[0]
      rgba[o + 1] = col[1]
      rgba[o + 2] = col[2]
      rgba[o + 3] = Math.round(plateA * 255)
    }
  }

  return encodePng(size, size, rgba)
}
