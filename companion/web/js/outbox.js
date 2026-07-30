/**
 * The offline queue: an IndexedDB store of writes that have not landed yet.
 *
 * ## Why this exists rather than "RTDB's built-in persistence"
 *
 * The Realtime Database's *web* SDK has no on-disk persistence. It queues
 * writes in memory while offline and replays them when the connection returns,
 * which covers a tunnel but not the thing that actually happens: you photograph
 * something in a car park with no signal, the phone locks, Chrome evicts the
 * tab, and the write is gone. Disk-backed offline persistence is an
 * Android/iOS-SDK feature, not a web one. (Firestore's `enableIndexedDbPersistence`
 * is a different product with a different API and would mean a second database.)
 *
 * So the durability is ours: every send is written *here first*, then flushed.
 * Nothing is removed from the queue until the server has acknowledged it. This
 * is DictationMic's design and it survives a force-quit, which is the only test
 * that counts.
 *
 * Flush triggers: the `online` event, tab refocus, a 60s timer, and every
 * enqueue. Failures back off 5s → 60s and are retried forever, because a
 * failed send that silently disappears is worse than one that is slow.
 */

const DB_NAME = 'forge-companion'
const DB_VERSION = 1
const STORE = 'outbox'

let dbPromise = null

function open() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const store = t.objectStore(STORE)
        let out
        try {
          out = fn(store)
        } catch (err) {
          reject(err)
          return
        }
        t.oncomplete = () => resolve(out?.result ?? out)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      })
  )
}

/**
 * Queue one write. `entry` is `{path, value}` — deliberately dumb: the queue
 * does not know what an image or a message is, only that a PATCH has to reach
 * a path eventually. That is what keeps it correct when the schema grows.
 */
export async function enqueue(entry) {
  await tx('readwrite', (store) => store.add({ ...entry, queuedAt: Date.now() }))
}

export async function pending() {
  const items = await tx('readonly', (store) => store.getAll())
  return (items ?? []).sort((a, b) => a.seq - b.seq)
}

export async function drop(seq) {
  await tx('readwrite', (store) => store.delete(seq))
}

export async function count() {
  return (await pending()).length
}

/**
 * Flush the queue in order, stopping at the first failure.
 *
 * In order and stopping: a message sent after an image must not overtake it,
 * and a write that failed because the token expired will fail for every
 * following entry too — so there is nothing to gain from ploughing on, and a
 * long queue of doomed requests to lose.
 *
 * `send(entry)` should throw to mean "not delivered". Returns how many landed.
 */
export async function flush(send) {
  const items = await pending()
  let sent = 0
  for (const item of items) {
    try {
      await send(item)
    } catch {
      break
    }
    await drop(item.seq)
    sent += 1
  }
  return sent
}

/**
 * Wire the usual triggers to a flush function and return a stop handle.
 *
 * `visibilitychange` matters more than it looks on a phone: a PWA that has been
 * backgrounded gets no timers at all, so refocus is often the *first* moment
 * anything can run after the signal came back.
 */
export function autoFlush(run, intervalMs = 60_000) {
  const go = () => void run()
  const timer = setInterval(go, intervalMs)
  const onVisible = () => {
    if (document.visibilityState === 'visible') go()
  }
  addEventListener('online', go)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    clearInterval(timer)
    removeEventListener('online', go)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
