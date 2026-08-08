import { deflateRawSync } from 'node:zlib'

/**
 * A ZIP writer, in about a hundred lines.
 *
 * Written rather than installed for the same reason `scripts/icon-lib.mjs`
 * encodes its own PNGs: the format is small and stable, and the alternatives
 * (`archiver`, `adm-zip`, `jszip`) are a dependency tree apiece for one feature
 * that produces a handful of markdown files. Nothing here is clever — it is the
 * 1989 APPNOTE layout with deflate, which is what every unzipper on earth
 * opens without comment.
 *
 * ## What it deliberately does not do
 *
 * No Zip64, no encryption, no directory entries, no data descriptors. Sizes and
 * CRCs are known before each entry is written because everything is in memory,
 * so the streaming shapes those features exist for never arise. `writeZip`
 * refuses rather than silently emitting a file that needs Zip64 — a corrupt
 * archive discovered by the recipient is the one outcome worth spending code
 * to avoid.
 *
 * Directory entries are skipped on purpose. A path like `my-skill/SKILL.md`
 * creates its folders in every extractor that matters (Windows' own
 * `Expand-Archive` included, which is what scripts/pack-check.mjs uses as an
 * independent oracle rather than trusting this file to check itself).
 */

/** One file destined for the archive. Paths use forward slashes, always. */
export interface ZipEntry {
  /** Relative path inside the archive, e.g. `my-skill/SKILL.md`. */
  path: string
  bytes: Buffer
  /** Last-modified, for the entry's DOS timestamp. Defaults to now. */
  mtime?: Date
}

/** Beyond these, the format needs Zip64 and this writer refuses. */
const MAX_ENTRIES = 0xffff
const MAX_BYTES = 0xffffffff

/* ------------------------------------------------------------------ crc32 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* -------------------------------------------------------------- timestamps */

/**
 * MS-DOS date and time, which is what a ZIP entry carries.
 *
 * Two-second resolution, and the epoch is 1980 — a file older than that (or a
 * clock that has gone backwards) would encode as a negative year and produce a
 * date every extractor renders differently. Clamping is the honest fix: the
 * timestamp is a convenience, and 1980 is visibly wrong rather than subtly so.
 */
function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

/* ---------------------------------------------------------------- writing */

interface Placed {
  name: Buffer
  crc: number
  compressed: Buffer
  /** 8 = deflate, 0 = stored. */
  method: number
  size: number
  offset: number
  time: number
  date: number
}

export interface ZipResult {
  ok: boolean
  error?: string
  bytes?: Buffer
}

/**
 * Build a ZIP archive in memory.
 *
 * Each entry is deflated and then kept **only if deflating helped**. Skills are
 * markdown, which compresses to about a third — but a small PNG usually grows,
 * and an archive whose "compressed" copy is bigger than the original is a
 * quietly worse file. Per-entry choice costs one comparison.
 */
export function writeZip(entries: ZipEntry[], now: () => number = Date.now): ZipResult {
  if (entries.length > MAX_ENTRIES) {
    return { ok: false, error: `A zip here cannot hold more than ${MAX_ENTRIES} files` }
  }

  const placed: Placed[] = []
  const chunks: Buffer[] = []
  let offset = 0
  const seen = new Set<string>()

  for (const entry of entries) {
    const path = String(entry.path ?? '').replace(/\\/g, '/')
    if (!path) return { ok: false, error: 'A file in the archive had no name' }
    // Two entries on one name is a valid archive that extracts differently
    // depending on the extractor. Refuse rather than pick a winner.
    if (seen.has(path.toLowerCase())) return { ok: false, error: `Two files would be written to ${path}` }
    seen.add(path.toLowerCase())

    const name = Buffer.from(path, 'utf8')
    if (name.length > 0xffff) return { ok: false, error: `That path is too long for a zip: ${path}` }

    const raw = entry.bytes
    if (raw.length > MAX_BYTES) return { ok: false, error: `${path} is too large for this writer` }

    const deflated = deflateRawSync(raw, { level: 9 })
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const stamp = dosTime(entry.mtime ?? new Date(now()))

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // version needed
    // Bit 11 says the name is UTF-8. Without it a skill folder with an accent
    // in its name extracts as mojibake on a machine in another codepage.
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(useDeflate ? 8 : 0, 8)
    header.writeUInt16LE(stamp.time, 10)
    header.writeUInt16LE(stamp.date, 12)
    header.writeUInt32LE(crc32(raw), 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)

    placed.push({
      name,
      crc: crc32(raw),
      compressed: body,
      method: useDeflate ? 8 : 0,
      size: raw.length,
      offset,
      time: stamp.time,
      date: stamp.date
    })

    chunks.push(header, name, body)
    offset += header.length + name.length + body.length
    if (offset > MAX_BYTES) return { ok: false, error: 'That archive would be over 4GB' }
  }

  const centralStart = offset
  for (const item of placed) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4) // version made by
    header.writeUInt16LE(20, 6) // version needed
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(item.method, 10)
    header.writeUInt16LE(item.time, 12)
    header.writeUInt16LE(item.date, 14)
    header.writeUInt32LE(item.crc, 16)
    header.writeUInt32LE(item.compressed.length, 20)
    header.writeUInt32LE(item.size, 24)
    header.writeUInt16LE(item.name.length, 28)
    header.writeUInt16LE(0, 30) // extra
    header.writeUInt16LE(0, 32) // comment
    header.writeUInt16LE(0, 34) // disk
    header.writeUInt16LE(0, 36) // internal attrs
    header.writeUInt32LE(0, 38) // external attrs
    header.writeUInt32LE(item.offset, 42)
    chunks.push(header, item.name)
    offset += header.length + item.name.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4) // this disk
  end.writeUInt16LE(0, 6) // disk with the central directory
  end.writeUInt16LE(placed.length, 8)
  end.writeUInt16LE(placed.length, 10)
  end.writeUInt32LE(offset - centralStart, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20) // comment length
  chunks.push(end)

  return { ok: true, bytes: Buffer.concat(chunks) }
}
