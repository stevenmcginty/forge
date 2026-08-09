/**
 * Head-less proof of the "is there a Forge on this wifi?" responder.
 *
 * The real electron/mobile/discovery.ts is bundled and bound to a real UDP
 * socket, and a real client sends it real datagrams. Nothing is mocked, because
 * the things worth proving are all things a mock would grant for free: that a
 * short probe is ignored, that a stranger's datagram gets no reply, that one
 * address cannot make this machine shout, and that a stopped responder is
 * silent.
 *
 *   npm run discovery:check
 *
 * It runs on 127.0.0.1 and a port nothing else wants, so it never speaks to the
 * network it happens to be run on.
 */
import { createSocket } from 'node:dgram'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-discovery-check')
mkdirSync(scratch, { recursive: true })

const PORT = 8479

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

/* ------------------------------------------------------------- the module */

const bundle = join(scratch, 'discovery.mjs')
await build({
  entryPoints: [join(ROOT, 'scripts', 'fixtures', 'discovery-entry.ts')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['electron'],
  alias: { '@shared': join(ROOT, 'shared') }
})
const { DiscoveryResponder, DISCOVERY_MIN_PROBE_BYTES, DISCOVERY_PROBE, MOBILE_PROTO, parseDiscoveryReply } =
  await import(pathToFileURL(bundle).href)

/* -------------------------------------------------------------- a client */

/** A television. Sends a datagram, waits a beat, reports what came back. */
function probeClient() {
  const socket = createSocket('udp4')
  const replies = []
  socket.on('message', (data) => replies.push(data.toString('utf8')))
  return {
    replies,
    ready: new Promise((res) => socket.bind(0, '127.0.0.1', res)),
    /** Send `bytes` of probe, then wait `waitMs` for anything to arrive. */
    async ask(payload, waitMs = 250) {
      socket.send(Buffer.from(payload), PORT, '127.0.0.1')
      await new Promise((res) => setTimeout(res, waitMs))
      return replies.length
    },
    close: () => socket.close()
  }
}

/** A well-formed probe: the marker, then padding to the required size. */
const goodProbe = DISCOVERY_PROBE + ' '.repeat(DISCOVERY_MIN_PROBE_BYTES - DISCOVERY_PROBE.length)

/* ----------------------------------------------------------------- the run */

let origin = 'http://192.168.4.45:8420'
let clock = 1_000_000

const responder = new DiscoveryResponder({
  origin: () => origin,
  name: () => 'STEVE-PC',
  appVersion: () => '0.3.0',
  now: () => clock,
  log: () => {}
})

const bound = await responder.start(PORT)
log(bound === true, 'the responder binds its UDP port')
log(responder.port === PORT, 'and reports the port it is answering on')

const tv = probeClient()
await tv.ready

/* ------------------------------------------------------- 1. a real probe */

await tv.ask(goodProbe)
log(tv.replies.length === 1, 'a padded probe is answered exactly once')

const reply = parseDiscoveryReply(tv.replies[0] ?? '')
log(reply !== null, 'and the answer parses as a discovery reply')
log(reply?.origin === origin, 'carrying the address a television should dial')
log(reply?.name === 'STEVE-PC', 'and the name of the desktop')
log(reply?.proto === MOBILE_PROTO, 'and the protocol number, so a mismatch can be said in words')
log(
  !/token|device|project/i.test(tv.replies[0] ?? ''),
  'and nothing about devices, projects or credentials — it names a door, it does not open one'
)

/* --------------------------------------------------- 2. one answer a second */

const afterFirst = tv.replies.length
await tv.ask(goodProbe)
log(tv.replies.length === afterFirst, 'a second probe from the same address within the second is ignored')

clock += 1500
await tv.ask(goodProbe)
log(tv.replies.length === afterFirst + 1, 'and answered again once the second has passed')

/* ------------------------------------------------ 3. the shape of a probe */

const beforeShort = tv.replies.length
clock += 5000
await tv.ask(DISCOVERY_PROBE)
log(tv.replies.length === beforeShort, 'an unpadded probe is ignored — a small question must not buy a big answer')

clock += 5000
await tv.ask('hello?' + ' '.repeat(DISCOVERY_MIN_PROBE_BYTES))
log(tv.replies.length === beforeShort, 'a padded datagram that is not ours is ignored too')

clock += 5000
await tv.ask('x'.repeat(9000))
log(tv.replies.length === beforeShort, 'and an oversized one is dropped rather than read')

/* ------------------------------------------- 4. nothing to dial, nothing said */

origin = ''
clock += 5000
await tv.ask(goodProbe)
log(tv.replies.length === beforeShort, 'a desktop with no reachable address says nothing at all')

origin = 'http://192.168.4.45:8420'
clock += 5000
await tv.ask(goodProbe)
log(tv.replies.length === beforeShort + 1, 'and answers again once it has one')

/* --------------------------------------------------------- 5. off is off */

await responder.stop()
log(responder.port === 0, 'a stopped responder reports no port')
const beforeStopped = tv.replies.length
clock += 5000
await tv.ask(goodProbe)
log(tv.replies.length === beforeStopped, 'and answers nothing, because the link it advertises is gone')

tv.close()

console.log(failures === 0 ? '\ndiscovery-check: all good' : `\ndiscovery-check: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
