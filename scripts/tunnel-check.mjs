/**
 * Head-less proof that the ngrok tunnel supervisor behaves.
 *
 * Bundles the *real* electron/mobile-tunnel.ts with esbuild and drives it the
 * way electron/mobile-host.ts does — except the ngrok process is a scripted
 * fake, because this check's job is the supervision around the process, and
 * faking a network to "test" the real agent would prove nothing anyone needs
 * proved. What a script can honestly claim, it claims:
 *
 *   - finding the binary, and the FORGE_NGROK_EXE override
 *   - the exact command line, and that the authtoken never appears in output
 *   - parsing ngrok's JSON logs for the URL and for the refusals that mean
 *     "stop knocking" — bad authtoken, someone else's domain, no sessions left
 *   - the backoff schedule, its cap, and its reset after a healthy spell
 *   - the refuse-don't-retry rule (the desktop-side twin of the phone's
 *     4001–4003 rule in mobile/src/lib/link.ts)
 *   - that pairing hands out the tunnel URL with no port appended
 *   - that the QR's forge://pair link round-trips through the phone's *own*
 *     toOrigin/pairTokenOf (bundled from mobile/src/lib/secure.ts, not
 *     re-implemented) — for both the tunnel and the LAN shape. This is the
 *     one that matters most: builder and parser drifting produces a QR that
 *     scans cleanly and then pairs against a dead address, silently.
 *
 * What it cannot claim: that a real ngrok account accepts the token and binds
 * the domain. That needs the account, and is the one part only Steve can run.
 *
 *   npm run tunnel:check
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-tunnel-check')
mkdirSync(scratch, { recursive: true })

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

/** A fake authtoken. Deliberately not shaped like any real provider's key. */
const TOKEN = '2FakeNgrokAuthtoken_ForTheCheckOnly1234'
const DOMAIN = 'forge-steve.ngrok-free.app'

/** A scriptable stand-in for the spawned ngrok process. */
function fakeChild(pid = 4242) {
  const listeners = { stdout: [], stderr: [], exit: [] }
  return {
    pid,
    stdout: { on: (event, cb) => event === 'data' && listeners.stdout.push(cb) },
    stderr: { on: (event, cb) => event === 'data' && listeners.stderr.push(cb) },
    on: (event, cb) => event === 'exit' && listeners.exit.push(cb),
    kill: () => {},
    // test controls:
    say: (line) => listeners.stdout.forEach((cb) => cb(line + '\n')),
    die: (code) => listeners.exit.forEach((cb) => cb(code))
  }
}

async function main() {
  await build({
    entryPoints: [join(ROOT, 'scripts', 'fixtures', 'tunnel-entry.ts')],
    outfile: join(scratch, 'tunnel.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { '@shared': join(ROOT, 'shared') },
    logLevel: 'silent',
    absWorkingDir: ROOT
  })

  const {
    NgrokTunnel,
    backoffDelay,
    bsdtarPath,
    ensureNgrokExe,
    ngrokArgs,
    pairEndpoint,
    parseNgrokLine,
    permanentRefusal,
    redactAuthtoken,
    resolveNgrokExe,
    BACKOFF_CAP_MS,
    HEALTHY_RESET_MS,
    normaliseNgrokDomain,
    pairLink,
    pairTokenOf,
    toOrigin
  } = await import(pathToFileURL(join(scratch, 'tunnel.mjs')).href)

  /* -------------------------------------------------- 1. finding the binary */

  const binDir = `C:${sep}data${sep}Forge${sep}bin`
  const probe = (files, env = {}) => resolveNgrokExe({ env, binDir, exists: (p) => files.includes(p) })

  const overridePath = `D:${sep}tools${sep}ngrok.exe`
  log(
    probe([overridePath], { FORGE_NGROK_EXE: overridePath }) === overridePath,
    'FORGE_NGROK_EXE wins when it points at something real'
  )
  log(
    probe([join(binDir, 'ngrok.exe')], { FORGE_NGROK_EXE: `D:${sep}gone.exe` }) === join(binDir, 'ngrok.exe'),
    'an override pointing nowhere falls through instead of failing'
  )
  log(probe([join(binDir, 'ngrok.exe')]) === join(binDir, 'ngrok.exe'), "Forge's own bin dir is found")
  const pathDir = `C:${sep}on-path`
  log(
    probe([join(pathDir, 'ngrok.exe')], { PATH: `C:${sep}elsewhere;${pathDir}` }) === join(pathDir, 'ngrok.exe'),
    'PATH is searched'
  )
  const chocoExe = `C:${sep}ProgramData${sep}chocolatey${sep}bin${sep}ngrok.exe`
  log(probe([chocoExe], { ProgramData: `C:${sep}ProgramData` }) === chocoExe, 'the chocolatey install spot is tried')
  log(probe([]) === '', 'nowhere at all answers with an empty string, not a throw')

  /* ------------------------------------------------- 1b. the download guard */

  // No network is faked: fetchBytes is injected, and what is proved is the
  // zip check and the sentence-shaped failures around it.
  const notAZip = await ensureNgrokExe({ binDir: scratch, fetchBytes: async () => Buffer.from('<html>portal</html>') })
  log(notAZip.ok === false && /did not look like a zip/.test(notAZip.error), 'an HTML answer is refused as not-a-zip')
  const refusedNet = await ensureNgrokExe({
    binDir: scratch,
    fetchBytes: async () => {
      throw new Error('the server answered 503')
    }
  })
  log(
    refusedNet.ok === false && /Could not download ngrok/.test(refusedNet.error) && /FORGE_NGROK_EXE/.test(refusedNet.error),
    'a failed download is one sentence with a way out, not a stack trace'
  )
  const extracted = await ensureNgrokExe({
    binDir: scratch,
    fetchBytes: async () => Buffer.from('PKfake'),
    extract: async (_zip, dir) => {
      writeFileSync(join(dir, 'ngrok.exe'), 'exe')
      return true
    }
  })
  log(extracted.ok === true && extracted.path === join(scratch, 'ngrok.exe'), 'a real zip is extracted into the bin dir')

  /* ------------------------------------------------------ 2. the invocation */

  const args = ngrokArgs(8420, DOMAIN, TOKEN)
  log(
    JSON.stringify(args) ===
      JSON.stringify(['http', '8420', `--url=https://${DOMAIN}`, '--authtoken', TOKEN, '--log=stdout', '--log-format=json']),
    'the command line is exactly http <port> --url=https://<domain> --authtoken <token> --log=stdout --log-format=json'
  )

  /* -------------------------------------------------------- 3. redaction */

  log(
    !redactAuthtoken(`failed to auth with ${TOKEN} against api`, TOKEN).includes(TOKEN),
    'the authtoken is scrubbed from a sentence that carries it'
  )
  log(
    redactAuthtoken('nothing secret here', TOKEN) === 'nothing secret here',
    'and a sentence without it comes back untouched'
  )

  /* ------------------------------------------------------ 4. log parsing */

  const started = parseNgrokLine(`{"lvl":"info","msg":"started tunnel","url":"https://${DOMAIN}"}`)
  log(started?.url === `https://${DOMAIN}`, 'the started-tunnel line yields the public URL')
  const eror = parseNgrokLine('{"lvl":"eror","msg":"failed to reconnect session","err":"dial tcp: i/o timeout"}')
  log(eror?.lvl === 'eror' && /i\/o timeout/.test(eror.err), "an 'eror' line yields its message and error")
  log(parseNgrokLine('t=2026 lvl=info msg=plaintext') === null, 'a non-JSON line is ignored rather than crashed on')
  log(parseNgrokLine('[1,2,3]') === null, 'and so is JSON that is not an object')

  /* --------------------------------------------- 5. the doors that stay shut */

  log(
    /authtoken/.test(permanentRefusal('authentication failed: ERR_NGROK_107') ?? ''),
    'a rejected authtoken is a permanent refusal that names the fix'
  )
  log(
    /authtoken/i.test(permanentRefusal(`The authtoken you specified is properly formed, but it is invalid. Your authtoken: ${TOKEN}`) ?? ''),
    'the invalid-authtoken phrasing is caught without its error code'
  )
  log(
    !(permanentRefusal(`Your authtoken: ${TOKEN} is invalid ERR_NGROK_107`) ?? '').includes(TOKEN),
    "and the refusal sentence never repeats the token ngrok echoed back"
  )
  log(
    /session/.test(permanentRefusal('Your account is limited to 3 simultaneous ngrok agent sessions. ERR_NGROK_108') ?? ''),
    'running out of agent sessions is a permanent refusal'
  )
  log(
    /domain/.test(permanentRefusal(`The domain '${DOMAIN}' is not reserved for your account.`) ?? ''),
    "someone else's domain is a permanent refusal"
  )
  log(
    permanentRefusal('failed to reconnect session: dial tcp 3.134.x.x:443: i/o timeout') === null,
    'a network wobble is not — that one is worth retrying'
  )

  /* ------------------------------------------------------------ 6. backoff */

  log(
    JSON.stringify([0, 1, 2, 3, 4, 5, 6].map(backoffDelay)) ===
      JSON.stringify([1000, 2000, 4000, 8000, 16000, 32000, 60000]),
    'the backoff schedule doubles from 1s and caps at 60s'
  )
  log(backoffDelay(50) === BACKOFF_CAP_MS, 'and stays capped however long the outage runs')

  /* --------------------------------------------------- 7. the supervisor */

  let clock = 1_000_000
  const spawned = []
  const killed = []
  const timers = []
  const statuses = []
  // Every string the supervisor ever emitted, never reset — the raw-token
  // check at the end must cover the whole run, including the refusal path.
  const emitted = []
  let child = null
  const tunnel = new NgrokTunnel({
    exe: 'ngrok.exe',
    port: 8420,
    domain: DOMAIN,
    authtoken: TOKEN,
    onStatus: (s) => {
      statuses.push(s)
      emitted.push(`${s.state} ${s.url} ${s.detail}`)
    },
    spawn: (exe, argv) => {
      spawned.push(argv)
      child = fakeChild()
      return child
    },
    killTree: (pid) => killed.push(pid),
    now: () => clock,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: () => {}
  })
  const last = () => statuses[statuses.length - 1]
  const runTimer = () => {
    const t = timers.pop()
    t.fn()
    return t.ms
  }

  tunnel.start()
  log(spawned.length === 1 && last().state === 'starting', 'start() spawns the agent and reports starting')

  child.say(`{"lvl":"info","msg":"started tunnel","url":"https://${DOMAIN}"}`)
  log(last().state === 'live' && last().url === `https://${DOMAIN}`, 'the URL in the log makes the tunnel live')

  // A crash 5s into a live connection is still the same incident.
  clock += 5000
  child.die(1)
  log(last().state === 'retrying', 'an unexpected exit reports retrying, not silence')
  log(runTimer() === 1000 && spawned.length === 2, 'the first retry waits 1s and really respawns')
  // ngrok echoes the token back in some failure messages; the retry detail
  // must carry the complaint with the token scrubbed out of it.
  child.say(`{"lvl":"eror","msg":"authentication failed","err":"Your authtoken: ${TOKEN}"}`)
  child.die(1)
  log(
    /authentication failed/.test(last().detail) && !last().detail.includes(TOKEN),
    "a retry detail keeps ngrok's complaint but scrubs the token from it"
  )
  log(runTimer() === 2000 && spawned.length === 3, 'the second waits 2s')
  child.die(1)
  log(runTimer() === 4000 && spawned.length === 4, 'the third waits 4s — the schedule is climbing')

  // Now a healthy spell: live for longer than HEALTHY_RESET_MS, then a drop.
  child.say(`{"lvl":"info","msg":"started tunnel","url":"https://${DOMAIN}"}`)
  clock += HEALTHY_RESET_MS + 1000
  child.die(1)
  log(runTimer() === 1000 && spawned.length === 5, 'a connection healthy for 30s resets the schedule to 1s')

  // The refusal path: ngrok names a permanent failure, then exits.
  child.say('{"lvl":"crit","msg":"accountLimited","err":"Your account is limited to 3 simultaneous ngrok agent sessions. ERR_NGROK_108"}')
  child.die(1)
  log(last().state === 'error' && /session/.test(last().detail), 'a permanent refusal surfaces as error with the fix')
  log(timers.length === 0 && spawned.length === 5, 'and is NOT retried — no timer set, nothing respawned')

  // stop() from an error state, then a full stop from running.
  tunnel.stop()
  log(last().state === 'off', 'stop() reports off')
  statuses.length = 0
  tunnel.start()
  child.say(`{"lvl":"info","msg":"started tunnel","url":"https://${DOMAIN}"}`)
  tunnel.stop()
  log(killed.includes(4242), 'stopping a live tunnel kills the process tree by pid')
  log(last().state === 'off' && last().url === '', 'and the status ends off with no URL')

  log(
    emitted.length > 0 && emitted.every((line) => !line.includes(TOKEN)),
    'no emitted status ever contained the raw authtoken'
  )

  /* ------------------------------------------------- 8. the pairing offer */

  const live = pairEndpoint({ state: 'live', url: `https://${DOMAIN}`, detail: '' }, '192.168.1.5', 8420)
  log(live.url === `wss://${DOMAIN}`, 'a live tunnel pairs against wss://<domain>')
  log(!/:\d+$/.test(live.url) && live.port === 0, 'with no port appended — toOrigin on the phone depends on that')
  const lan = pairEndpoint({ state: 'off', url: '', detail: '' }, '192.168.1.5', 8420)
  log(lan.host === '192.168.1.5' && lan.port === 8420 && lan.url === '', 'no tunnel pairs against the LAN, as before')
  const retrying = pairEndpoint({ state: 'retrying', url: '', detail: '' }, '192.168.1.5', 8420)
  log(retrying.url === '', 'a tunnel that is down does not hand out a dead URL')

  /* -------------------------------------- 8b. the QR link round-trips */

  // Built exactly as electron/mobile-host.ts builds it — from pairEndpoint's
  // output, with `port === 0` as the tunnel marker — then handed to the
  // phone's real parsers. Both sides here are the shipped functions.
  const CODE = 'k7RgV2mQ4tXz'
  const tunnelLink = pairLink(live.host, live.port, live.port === 0, CODE)
  log(
    tunnelLink === `forge://pair?host=${DOMAIN}&scheme=wss&pt=${CODE}`,
    'a live tunnel builds forge://pair?host=<domain>&scheme=wss&pt=<code> — no port param'
  )
  log(
    toOrigin(tunnelLink, 8420) === `wss://${DOMAIN}`,
    "the phone's toOrigin reads the tunnel link back as wss://<domain>, never appending :8420"
  )
  log(pairTokenOf(tunnelLink) === CODE, "and the phone's pairTokenOf recovers the exact code")

  const lanLink = pairLink(lan.host, lan.port, lan.port === 0, CODE)
  log(
    lanLink === `forge://pair?host=192.168.1.5&port=8420&pt=${CODE}`,
    'no tunnel builds forge://pair?host=<ip>&port=<port>&pt=<code>'
  )
  log(
    toOrigin(lanLink, 9999) === 'ws://192.168.1.5:8420',
    'the LAN link keeps its explicit port even against a different phone default'
  )
  log(pairTokenOf(lanLink) === CODE, 'and its code survives the trip too')

  // The encoding is not decorative: a token that happens to contain URL
  // metacharacters must still come out the other side byte-for-byte.
  const oddCode = 'a+b&c=d? e'
  const oddLink = pairLink('192.168.1.5', 8420, false, oddCode)
  log(pairTokenOf(oddLink) === oddCode, 'a code full of URL metacharacters round-trips intact')
  log(toOrigin(oddLink, 8420) === 'ws://192.168.1.5:8420', 'without disturbing the address beside it')

  log(
    pairLink('', 8420, false, CODE) === '' && pairLink(DOMAIN, 0, true, '') === '',
    'a missing host or code yields no link at all, never a half-link a QR would happily encode'
  )

  /* ----------------------------------------------------- 9. domain shape */

  log(normaliseNgrokDomain(' https://Forge-Steve.ngrok-free.app/ ') === DOMAIN, 'a pasted URL is boiled down to its hostname')
  log(normaliseNgrokDomain('name.ngrok-free.dev') === 'name.ngrok-free.dev', 'the .dev spelling passes as-is')
  log(normaliseNgrokDomain('nonsense !!;--flag') === '', 'junk becomes empty, never a command-line argument')
  log(normaliseNgrokDomain('bare-word') === '', 'a bare word with no dot is not a domain')

  /* ------------------------------------------------- 10. the right tar wins */

  // Only bsdtar reads a zip. Bare `tar` on PATH resolves to GNU tar on any
  // machine with Git, MSYS2 or WSL shims installed — including this one, where
  // it answers "This does not look like a tar archive". That failure would only
  // ever appear on first run, on the one path that has no ngrok yet, and would
  // read as a broken download rather than the wrong tar answering.
  const tarPath = bsdtarPath()
  log(tarPath !== 'tar', 'the extractor is not the bare word `tar` for PATH to resolve')
  log(/^[a-z]:[\\/]/i.test(tarPath), 'it is an absolute path')
  log(tarPath.toLowerCase().endsWith(`system32${sep}tar.exe`.toLowerCase()), 'it is System32\\tar.exe — the bsdtar Windows ships')
  log(existsSync(tarPath), 'and that binary is present on this machine')
}

main()
  .catch((err) => {
    failures++
    console.error(`\nFAIL  ${err?.stack ?? err}`)
  })
  .finally(() => {
    rmSync(scratch, { recursive: true, force: true })
    console.log(failures === 0 ? '\ntunnel:check — all checks passed' : `\ntunnel:check — ${failures} FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })
