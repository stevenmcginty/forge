import { useSyncExternalStore } from 'react'

/**
 * The backdrop behind the canvas: which one, how dim, how blurred, and whether
 * it drifts.
 *
 * Kept in this window's localStorage, not settings.json, for now: it is a
 * per-machine look (a photo picked from this PC's disk means nothing to the
 * phone), and the settings schema belongs to another job this round. Moving it
 * into Settings later is a change to `load`/`save` only — every reader goes
 * through `useBackdrop`.
 *
 * The custom image is stored as a downscaled JPEG data URL under its own key, so
 * the small JSON record can be read on every launch without dragging a megabyte
 * of base64 through JSON.parse.
 */

export type BackdropId = 'deepfield' | 'nebula' | 'ridgeline' | 'calm' | 'image'

export interface BackdropSettings {
  id: BackdropId
  /** 0 (none) to 0.8 — a wash of the theme's background over the art. */
  dim: number
  /** px of blur on the art. 0 keeps it crisp. */
  blur: number
  /** Slow drift of the stars / haze. Off by default; paused when hidden. */
  drift: boolean
}

export const BACKDROPS: Array<{ id: BackdropId; name: string; blurb: string }> = [
  { id: 'deepfield', name: 'Deep field', blurb: 'Stars, and a glow in the project’s colour' },
  { id: 'nebula', name: 'Nebula', blurb: 'Soft clouds of light behind the work' },
  { id: 'ridgeline', name: 'Ridgeline', blurb: 'Mountains at dusk under a clear sky' },
  { id: 'calm', name: 'Calm', blurb: 'A quiet gradient, nothing else' },
  { id: 'image', name: 'Your image', blurb: 'Any picture from this PC' }
]

const KEY = 'forge:backdrop'
const IMAGE_KEY = 'forge:backdrop:image'

export const DEFAULT_BACKDROP: BackdropSettings = { id: 'ridgeline', dim: 0, blur: 0, drift: false }

function clampNum(n: unknown, lo: number, hi: number, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

function load(): BackdropSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<BackdropSettings> | null
    if (!raw) return DEFAULT_BACKDROP
    const id = BACKDROPS.some((b) => b.id === raw.id) ? (raw.id as BackdropId) : DEFAULT_BACKDROP.id
    return {
      id,
      dim: clampNum(raw.dim, 0, 0.8, DEFAULT_BACKDROP.dim),
      blur: clampNum(raw.blur, 0, 24, DEFAULT_BACKDROP.blur),
      drift: raw.drift === true
    }
  } catch {
    return DEFAULT_BACKDROP
  }
}

function loadImage(): string | null {
  try {
    return localStorage.getItem(IMAGE_KEY)
  } catch {
    return null
  }
}

let current = load()
let image = loadImage()
const listeners = new Set<() => void>()

function emit(): void {
  for (const cb of listeners) cb()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function setBackdrop(patch: Partial<BackdropSettings>): void {
  current = { ...current, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* storage unavailable: the choice lasts this session */
  }
  emit()
}

export function useBackdrop(): BackdropSettings {
  return useSyncExternalStore(subscribe, () => current)
}

export function useBackdropImage(): string | null {
  return useSyncExternalStore(subscribe, () => image)
}

/**
 * Read a picked file, scale it to at most 2560px on the long side, and keep it
 * as a JPEG. A 4K photo straight from a phone is 8MB; this is ~400KB and looks
 * the same behind a dimmed canvas.
 */
export async function setBackdropImage(file: File): Promise<void> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const scale = Math.min(1, 2560 / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(img, 0, 0, w, h)
    const data = canvas.toDataURL('image/jpeg', 0.86)
    image = data
    try {
      localStorage.setItem(IMAGE_KEY, data)
    } catch {
      /* too big for storage, or storage is off: still shown this session */
    }
    setBackdrop({ id: 'image' })
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function clearBackdropImage(): void {
  image = null
  try {
    localStorage.removeItem(IMAGE_KEY)
  } catch {
    /* nothing to clear */
  }
  setBackdrop({ id: current.id === 'image' ? DEFAULT_BACKDROP.id : current.id })
}
