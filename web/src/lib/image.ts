import { MAX_IMAGE_BASE64, WEB_IMAGE_MIMES } from '@shared/web'

/**
 * Turn a pasted or picked image into a base64 payload that fits on the wire.
 *
 * A phone camera produces several megabytes; MAX_IMAGE_BASE64 is 48 KB of
 * base64 so the whole `paste-image` frame stays inside MAX_FRAME_BYTES. The
 * ladder below is the same idea as companion/web/js/imgpack.js — draw through
 * a canvas at descending size and quality until something fits — pointed at
 * this protocol's ceiling rather than RTDB's bill limit.
 *
 * Throws an Error whose message is safe to show.
 */

const MAX_SOURCE_BYTES = 40 * 1024 * 1024
/** A small PNG screenshot should stay a PNG, not become a soft JPEG. */
const KEEP_ORIGINAL_BYTES = 32 * 1024

const LADDER = [
  { edge: 1600, q: 0.72 },
  { edge: 1280, q: 0.62 },
  { edge: 1024, q: 0.55 },
  { edge: 800, q: 0.48 },
  { edge: 640, q: 0.42 },
  { edge: 512, q: 0.38 }
]

const OK_TYPES = /^image\/(png|jpe?g|webp|gif|bmp|heic|heif)$/i

export interface PackedImage {
  mime: (typeof WEB_IMAGE_MIMES)[number]
  data: string
}

export function isImageFile(file: File): boolean {
  if (OK_TYPES.test(file.type)) return true
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(file.name)
}

/** Images off a paste or a drop, preferring `items` when `files` is empty. */
export function imageFilesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return []
  const fromFiles: File[] = []
  if (data.files?.length) {
    for (const file of data.files) {
      if (isImageFile(file)) fromFiles.push(file)
    }
  }
  if (fromFiles.length) return fromFiles
  const fromItems: File[] = []
  const items = data.items
  if (!items) return []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'file') continue
    if (item.type && !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file && isImageFile(file)) fromItems.push(file)
  }
  return fromItems
}

export async function packImage(file: File): Promise<PackedImage> {
  if (!file) throw new Error("That's not an image Forge can take.")
  if (file.size > MAX_SOURCE_BYTES) throw new Error('That image is enormous — try a smaller one.')

  const originalType = (file.type || guessType(file.name)).toLowerCase()
  if (originalType && !OK_TYPES.test(originalType)) {
    throw new Error("That's not an image Forge can take.")
  }

  if (file.size <= KEEP_ORIGINAL_BYTES && isWireMime(originalType)) {
    const data = await fileToBase64(file)
    if (data.length <= MAX_IMAGE_BASE64) return { mime: originalType, data }
  }

  const bitmap = await decode(file)
  try {
    for (const step of LADDER) {
      const data = await renderJpeg(bitmap, step.edge, step.q)
      if (data.length <= MAX_IMAGE_BASE64) return { mime: 'image/jpeg', data }
    }
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
  }
  throw new Error("Couldn't shrink that image enough to send.")
}

function isWireMime(type: string): type is PackedImage['mime'] {
  return (WEB_IMAGE_MIMES as readonly string[]).includes(type)
}

function guessType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  if (ext === 'heic' || ext === 'heif') return 'image/heic'
  return ''
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file)
  } catch {
    throw new Error("That image couldn't be read.")
  }
}

async function renderJpeg(bitmap: ImageBitmap, edge: number, quality: number): Promise<string> {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height, 1))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error("That image couldn't be read.")
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  const url = canvas.toDataURL('image/jpeg', quality)
  return payload(url)
}

function payload(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error("That image couldn't be read."))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve(payload(result))
    }
    reader.readAsDataURL(file)
  })
}
