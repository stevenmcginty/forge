/**
 * Turn a phone photo into something small enough to put in a database.
 *
 * A modern phone camera produces 4–12 MB per shot. The desktop caps an inline
 * companion image at 200 KB of base64 (`MAX_INLINE_BASE64` in
 * electron/companion/protocol.ts) — not because RTDB cannot hold more (its
 * limit is 10 MB per write) but because every byte is stored, streamed back to
 * the desktop, and billed. 200 KB of base64 is ~150 KB of JPEG, which at 1280px
 * is a perfectly readable screenshot or whiteboard photo.
 *
 * So: draw it through a canvas at descending size/quality until something fits.
 * The canvas is doing three useful jobs at once — it applies EXIF rotation for
 * free (a photo taken sideways arrives upright), it flattens transparency onto
 * white so a PNG screenshot does not become a black rectangle, and it re-encodes
 * to JPEG, which is where the actual saving is.
 *
 * If nothing on the ladder fits, we say so in a sentence rather than uploading
 * something the desktop will reject.
 */

/** Must match MAX_INLINE_BASE64 in electron/companion/protocol.ts. */
export const MAX_BASE64 = 200 * 1024

/** Refuse absurd inputs before decoding them — a 100 MB TIFF is not a photo. */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024

/**
 * Small enough already? Keep the original pixels. A UI screenshot that is
 * 40 KB of PNG should stay a pixel-exact PNG, not become a soft JPEG.
 */
const KEEP_ORIGINAL_BYTES = 120 * 1024

const LADDER = [
  { edge: 1600, q: 0.8 },
  { edge: 1600, q: 0.62 },
  { edge: 1280, q: 0.58 },
  { edge: 1024, q: 0.52 },
  { edge: 800, q: 0.46 },
  { edge: 640, q: 0.42 }
]

const OK_TYPES = /^image\/(png|jpe?g|webp|gif)$/i

/**
 * `File` → `{ dataUrl, mime, name }`, ready to PATCH into the inbox.
 * Throws an Error whose message is safe to show the user.
 */
export async function packImage(file) {
  if (!file || !OK_TYPES.test(file.type || '')) throw new Error("That's not an image Forge can take")
  if (file.size > MAX_SOURCE_BYTES) throw new Error('That image is enormous — try a smaller one')

  if (file.size <= KEEP_ORIGINAL_BYTES) {
    const asIs = await fileToDataUrl(file)
    if (payloadLength(asIs) <= MAX_BASE64) {
      return { dataUrl: asIs, mime: file.type, name: file.name || 'photo' }
    }
  }

  const bitmap = await decode(file)
  try {
    for (const step of LADDER) {
      const dataUrl = await render(bitmap, step.edge, step.q)
      if (payloadLength(dataUrl) <= MAX_BASE64) {
        return { dataUrl, mime: 'image/jpeg', name: renameToJpg(file.name) }
      }
    }
  } finally {
    bitmap.close?.()
  }
  throw new Error("Couldn't shrink that image enough to send")
}

/* ---------------------------------------------------------------- helpers */

/** Bytes of base64 payload, i.e. what the size cap is actually measured on. */
export function payloadLength(dataUrl) {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? dataUrl.length : dataUrl.length - comma - 1
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    // `from-image` honours EXIF orientation; without it a photo taken in
    // portrait arrives on the desktop lying on its side.
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      /* fall through to the <img> route */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = () => reject(new Error("That image couldn't be opened"))
      img.src = url
    })
    return img
  } finally {
    // Revoking immediately is safe: the bitmap is decoded by now.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

async function render(source, maxEdge, quality) {
  const w = source.width || source.naturalWidth
  const h = source.height || source.naturalHeight
  const scale = Math.min(1, maxEdge / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  // Flatten onto white first: JPEG has no alpha, and an un-flattened
  // transparent PNG encodes as black.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("That image couldn't be read"))
    reader.readAsDataURL(file)
  })
}

function renameToJpg(name) {
  const stem = String(name || 'photo').replace(/\.[A-Za-z0-9]{1,5}$/, '')
  return `${stem || 'photo'}.jpg`
}
