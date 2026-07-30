/**
 * Head-less proof of the screenshot shelf's logic.
 *
 * Bundles the *real* electron/shots/shelf.ts with esbuild (the copy Vite
 * already ships) and drives it exactly as electron/shots-watcher.ts does:
 * catch some images, refuse the duplicates, prune the oldest, adopt a dropped
 * file, and refuse to delete anything that is not ours.
 *
 *   npm run shots:smoke
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE = join(ROOT, 'electron', 'shots', 'shelf.ts')

const scratch = join(ROOT, 'node_modules', '.forge-shots-smoke')
mkdirSync(scratch, { recursive: true })
const bundle = join(scratch, 'shelf.mjs')

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

/** Distinct bytes per call, so every "image" has its own content hash. */
let seed = 0
const image = (size = 512) => {
  seed += 1
  const buf = Buffer.alloc(size)
  buf.write(`forge-image-${seed}-`)
  buf[size - 1] = seed & 0xff
  return buf
}

const names = (dir) => readdirSync(dir).sort()

async function main() {
  await build({
    entryPoints: [SOURCE],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    absWorkingDir: ROOT
  })

  const { ShotShelf, clampKeep, contentHash, sanitiseStem, shotStamp, SHOT_EXTS, DEFAULT_KEEP } = await import(
    pathToFileURL(bundle).href
  )

  const home = mkdtempSync(join(tmpdir(), 'forge-shots-'))

  /* ------------------------------------------------------------ 1. naming */

  const stamp = shotStamp(new Date(2026, 6, 30, 14, 5, 9))
  log(stamp === 'shot-20260730-140509', `shotStamp -> ${stamp}`)
  log(DEFAULT_KEEP === 12, `default keep is ${DEFAULT_KEEP}`)
  log(sanitiseStem('  My Diagram:v2/final  ') === 'My Diagram v2 final', 'a dropped file keeps a readable name')
  log(sanitiseStem('///') === 'shot', 'a name with nothing usable in it falls back to "shot"')
  log(sanitiseStem('x'.repeat(200)).length === 60, 'long names are capped at 60 chars')
  log(clampKeep(0) === 1 && clampKeep(999) === 60 && clampKeep(undefined) === 12, 'keep is clamped to 1..60')

  /* ------------------------------------------------------------- 2. hash */

  const a = image()
  const b = image()
  log(contentHash('100x50', a) === contentHash('100x50', a), 'the same pixels hash the same')
  log(contentHash('100x50', a) !== contentHash('100x50', b), 'different pixels hash differently')
  log(
    contentHash('100x50', a) !== contentHash('50x100', a),
    'the same bytes at a different size hash differently (a resize is a new shot)'
  )

  /* -------------------------------------------------- 3. catch and dedupe */

  const shelf = new ShotShelf(join(home, 'shots'), 12)
  shelf.load()

  const png1 = image()
  const hash1 = contentHash('800x600', png1)
  log(shelf.shouldCatch(hash1), 'a brand new clipboard image is worth catching')

  const first = shelf.pinBytes(png1, hash1, new Date(2026, 6, 30, 9, 0, 1))
  log(first.ok && first.record.name === 'shot-20260730-090001.png', `caught as ${first.record?.name}`)
  log(existsSync(first.record.path), 'the PNG is a real file on disk')
  log(readFileSync(first.record.path).equals(png1), 'the bytes on disk are the bytes we caught')
  log(first.record.bytes === png1.length, `the record carries its size (${first.record.bytes} bytes)`)

  log(!shelf.shouldCatch(hash1), 'the clipboard has not changed, so there is nothing new to catch')
  const again = shelf.pinBytes(png1, hash1, new Date(2026, 6, 30, 9, 0, 2))
  log(!again.ok && again.reason === 'duplicate', 'a repeat of the same image is refused')
  log(names(shelf.folder).length === 1, 'and no second file was written')

  // Snipping Tool fires the clipboard twice per snip; the second read is the
  // same pixels, so it must not become a second shot even after other images
  // have been through the clipboard in between.
  const png2 = image()
  const hash2 = contentHash('800x600', png2)
  shelf.pinBytes(png2, hash2, new Date(2026, 6, 30, 9, 0, 3))
  log(!shelf.shouldCatch(hash1), 'an image already on the shelf is never caught twice')

  // Forge putting a shot back on the clipboard must not boomerang.
  const png3 = image()
  const hash3 = contentHash('800x600', png3)
  shelf.suppress(hash3)
  log(!shelf.shouldCatch(hash3), 'an image Forge itself copied is ignored')

  log(!shelf.shouldCatch(''), 'an empty clipboard is not a shot')
  const empty = shelf.pinBytes(Buffer.alloc(0), 'whatever')
  log(!empty.ok && empty.reason === 'empty', 'zero bytes are refused')

  /* ------------------------------------------------ 4. collisions in a second */

  const burst = shelf.pinBytes(image(), contentHash('1x1', image(0)), new Date(2026, 6, 30, 9, 0, 3))
  log(burst.ok && burst.record.name === 'shot-20260730-090003 -2.png', `two shots in one second -> ${burst.record?.name}`)

  /* -------------------------------------------------------------- 5. prune */

  const wide = new ShotShelf(join(home, 'prune'), 12)
  wide.load()
  const written = []
  for (let i = 0; i < 15; i++) {
    const bytes = image()
    const when = new Date(2026, 6, 30, 10, 0, i)
    const res = wide.pinBytes(bytes, contentHash('1920x1080', bytes), when)
    if (!res.ok) {
      log(false, `pin ${i} failed: ${res.reason}`)
      continue
    }
    // Real mtimes are the write times, all within a millisecond of each other;
    // spread them so the ordering assertions below mean something.
    utimesSync(res.record.path, when, when)
    written.push(res.record.name)
  }

  const left = names(wide.folder)
  log(left.length === 12, `15 caught, ${left.length} kept (keep = 12)`)
  log(!left.includes('shot-20260730-100000.png'), 'the oldest three were pruned')
  log(left.includes('shot-20260730-100014.png'), 'the newest survived')
  log(
    wide.list()[0].name === 'shot-20260730-100014.png' && wide.list()[11].name === 'shot-20260730-100003.png',
    'the shelf reads newest-first'
  )
  log(!names(wide.folder).some((n) => n.endsWith('.tmp')), 'no half-written .tmp files left behind')

  const dropped = wide.setKeep(5)
  log(dropped.length === 7 && names(wide.folder).length === 5, `setKeep(5) pruned ${dropped.length} and left 5`)
  log(wide.list()[0].name === 'shot-20260730-100014.png', 'pruning takes the oldest, never the newest')

  // A pruned shot is forgotten, so the same image can be caught again later.
  const revived = wide.pinBytes(image(), contentHash('1x1', Buffer.from('revived')), new Date(2026, 6, 30, 11, 0, 0))
  log(revived.ok, 'the shelf keeps catching after a prune')

  /* --------------------------------------------------- 6. adopting a file */

  const inbox = join(home, 'inbox')
  mkdirSync(inbox, { recursive: true })
  const src = join(inbox, 'Design Mock v3.png')
  writeFileSync(src, image(2048))
  const notes = join(inbox, 'notes.txt')
  writeFileSync(notes, 'not an image')

  const adopt = new ShotShelf(join(home, 'adopt'), 12)
  adopt.load()
  const taken = adopt.pinFile(src)
  log(taken.ok && taken.record.name === 'Design Mock v3.png', `a dropped image keeps its name -> ${taken.record?.name}`)
  log(existsSync(taken.record.path) && existsSync(src), 'it is copied, not moved')
  const refused = adopt.pinFile(notes)
  log(!refused.ok && refused.reason === 'unsupported', 'a text file is refused')
  const missing = adopt.pinFile(join(inbox, 'ghost.png'))
  log(!missing.ok && missing.reason === 'unsupported', 'a path that is not there is refused')
  log(SHOT_EXTS.includes('.webp'), 'the accepted extensions cover the usual image types')

  /* ------------------------------------------------- 7. remove and clear */

  log(!adopt.owns(join(home, 'inbox', 'Design Mock v3.png')), 'a file outside the shots folder is not ours')
  log(adopt.remove(join(adopt.folder, '..', 'inbox', 'notes.txt')) === false, 'remove refuses to walk out of the folder')
  log(existsSync(notes), 'and the file it was aimed at is untouched')

  log(adopt.remove(taken.record.path) === true, 'remove deletes a shot that is ours')
  log(!existsSync(taken.record.path) && adopt.count === 0, 'the file and the record are both gone')

  const doomed = new ShotShelf(join(home, 'doomed'), 12)
  doomed.load()
  for (let i = 0; i < 4; i++) {
    const bytes = image()
    doomed.pinBytes(bytes, contentHash('1x1', bytes), new Date(2026, 6, 30, 12, 0, i))
  }
  const swept = doomed.clear()
  log(swept.length === 4 && names(doomed.folder).length === 0, `clear() removed all ${swept.length}`)

  /* ---------------------------------------------------- 8. reload on boot */

  const reopened = new ShotShelf(wide.folder, 12)
  const seen = []
  const restored = reopened.load((p) => {
    seen.push(p)
    return `hash-of:${p}`
  })
  log(restored.length === names(wide.folder).length, `a restart finds all ${restored.length} shots on disk`)
  log(restored[0].name === 'shot-20260730-110000.png', 'still newest-first after a restart')
  log(seen.length === restored.length, 'every shot on disk is hashed, so a restart cannot re-catch one')
  log(!reopened.shouldCatch(`hash-of:${restored[0].path}`), 'and those hashes are live in the dedupe')
  log(reopened.shouldCatch('something-brand-new'), 'while a genuinely new image still gets through')

  // Reloading a folder that holds more than keep prunes it down.
  const shrunk = new ShotShelf(wide.folder, 3)
  log(shrunk.load().length === 3, 'a smaller keep is applied at load time')
  log(names(wide.folder).length === 3, 'and the extra files are gone from disk')

  rmSync(home, { recursive: true, force: true })
}

main()
  .then(() => {
    rmSync(scratch, { recursive: true, force: true })
    console.log(failures === 0 ? '\nShots smoke test: OK' : `\nShots smoke test: ${failures} FAILURE(S)`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    rmSync(scratch, { recursive: true, force: true })
    console.error('\nShots smoke test crashed:', err)
    process.exit(1)
  })
