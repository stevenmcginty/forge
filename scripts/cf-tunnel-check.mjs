/**
 * Head-less proof that the cloudflared tunnel supervisor behaves.
 *
 *   npm run cf:tunnel
 *
 * The twin of `npm run tunnel:check`, which does this for ngrok, and it exists
 * for the same reason that one does: a supervisor whose backoff, refusal and
 * teardown rules have only ever run against the real binary is a supervisor
 * nobody has tested. So this bundles the *real* electron/cloudflare-tunnel.ts
 * with esbuild and drives it the way electron/web-host.ts does, with the
 * operating-system process replaced by a scripted fake.
 *
 * What a script can honestly claim, it claims:
 *
 *   - finding the binary, including the winget/MSI spots and the
 *     FORGE_CLOUDFLARED_EXE override
 *   - the exact command line
 *   - reading cloudflared's real output. **Every log line quoted below was
 *     copied off `cloudflared 2026.5.2` on this machine**, boxed drawing
 *     characters and all — including the two failures, which were produced by
 *     handing it an argument it rejects and an origin URL it cannot parse. A
 *     parser tested against invented sample lines proves only that the author
 *     imagined the format correctly.
 *   - the refuse-don't-retry rule, and that a network wobble is *not* one
 *   - the backoff schedule, its cap, and its reset after a healthy spell
 *   - the case this whole transport turns on: an agent that dies and comes back
 *     on a **different** hostname reports the new one, with no trace of the old
 *   - that the hostname cloudflared hands out survives `normaliseHost` and
 *     becomes an address a browser can dial
 *
 * What it cannot claim: that Cloudflare's edge accepts the tunnel. That needs
 * the network, and `scripts/mobile-tunnel.mjs` is the way to watch it happen.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-cf-tunnel-check')
mkdirSync(scratch, { recursive: true })

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

/** Two addresses, because "it came back on a different one" is the point. */
const HOST_ONE = 'registration-offset-distribution-quarterly.trycloudflare.com'
const HOST_TWO = 'orlando-cannon-translation-spare.trycloudflare.com'

/**
 * The banner cloudflared prints when a quick tunnel is created, verbatim —
 * padding, pipes and all. The URL is not in a field; it is in the middle of a
 * box, which is why the parser matches on the shape of the address.
 */
const banner = (host) => `2026-08-10T16:42:54Z INF |  https://${host}                      |`

/** A scriptable stand-in for the spawned cloudflared process. */
function fakeChild(pid = 5150) {
  const listeners = { stdout: [], stderr: [], exit: [] }
  return {
    pid,
    stdout: { on: (event, cb) => event === 'data' && listeners.stdout.push(cb) },
    stderr: { on: (event, cb) => event === 'data' && listeners.stderr.push(cb) },
    on: (event, cb) => event === 'exit' && listeners.exit.push(cb),
    kill: () => {},
    // test controls. cloudflared logs to stderr, so `say` does too — a
    // supervisor that only read stdout would pass every other assertion here
    // and never see a tunnel come up.
    say: (line) => listeners.stderr.forEach((cb) => cb(line + '\n')),
    chunk: (text) => listeners.stderr.forEach((cb) => cb(text)),
    die: (code) => listeners.exit.forEach((cb) => cb(code))
  }
}

async function main() {
  await build({
    entryPoints: [join(ROOT, 'scripts', 'fixtures', 'cf-tunnel-entry.ts')],
    outfile: join(scratch, 'cf-tunnel.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { '@shared': join(ROOT, 'shared') },
    logLevel: 'silent',
    absWorkingDir: ROOT
  })

  const {
    CloudflareTunnel,
    backoffDelay,
    cloudflaredArgs,
    ensureCloudflaredExe,
    parseCloudflaredLine,
    permanentRefusal,
    resolveCloudflaredExe,
    BACKOFF_CAP_MS,
    CLOUDFLARED_EXE_URL,
    HEALTHY_RESET_MS,
    EDGE_FAILURE_LIMIT,
    EDGE_FAILURE_LINE,
    EDGE_RECOVERED_LINE,
    KILL_ESCALATE_MS,
    PROBE_INTERVAL_MS,
    PROBE_STRIKES,
    normaliseHost,
    webSocketUrl
  } = await import(pathToFileURL(join(scratch, 'cf-tunnel.mjs')).href)

  /* -------------------------------------------------- 1. finding the binary */

  const binDir = `C:${sep}data${sep}Forge${sep}bin`
  const probe = (files, env = {}) => resolveCloudflaredExe({ env, binDir, exists: (p) => files.includes(p) })

  const overridePath = `D:${sep}tools${sep}cloudflared.exe`
  log(
    probe([overridePath], { FORGE_CLOUDFLARED_EXE: overridePath }) === overridePath,
    'FORGE_CLOUDFLARED_EXE wins when it points at something real'
  )
  log(
    probe([join(binDir, 'cloudflared.exe')], { FORGE_CLOUDFLARED_EXE: `D:${sep}gone.exe` }) ===
      join(binDir, 'cloudflared.exe'),
    'an override pointing nowhere falls through instead of failing'
  )
  log(probe([join(binDir, 'cloudflared.exe')]) === join(binDir, 'cloudflared.exe'), "Forge's own bin dir is found")
  const pathDir = `C:${sep}on-path`
  log(
    probe([join(pathDir, 'cloudflared.exe')], { PATH: `C:${sep}elsewhere;${pathDir}` }) ===
      join(pathDir, 'cloudflared.exe'),
    'PATH is searched'
  )
  // Where winget and the MSI actually put it — and where this machine has it.
  const wingetExe = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'
  log(probe([wingetExe]) === wingetExe, "the installer's own directory is tried, because it is not always on PATH")
  const chocoExe = `C:${sep}ProgramData${sep}chocolatey${sep}bin${sep}cloudflared.exe`
  log(probe([chocoExe], { ProgramData: `C:${sep}ProgramData` }) === chocoExe, 'the chocolatey install spot is tried')
  log(probe([]) === '', 'nowhere at all answers with an empty string, not a throw')

  /* ------------------------------------------------- 1b. the download guard */

  log(
    /^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\//.test(CLOUDFLARED_EXE_URL) &&
      CLOUDFLARED_EXE_URL.endsWith('cloudflared-windows-amd64.exe'),
    `the download is Cloudflare's own release asset (${CLOUDFLARED_EXE_URL})`
  )

  // No network is faked: fetchBytes is injected, and what is proved is the
  // shape check and the sentence-shaped failures around it.
  const notAnExe = await ensureCloudflaredExe({
    binDir: scratch,
    fetchBytes: async () => Buffer.from('<html>portal</html>')
  })
  log(
    notAnExe.ok === false && /did not look like a Windows program/.test(notAnExe.error),
    'an HTML answer is refused rather than saved and spawned'
  )
  const refusedNet = await ensureCloudflaredExe({
    binDir: scratch,
    fetchBytes: async () => {
      throw new Error('the server answered 503')
    }
  })
  log(
    refusedNet.ok === false &&
      /Could not download cloudflared/.test(refusedNet.error) &&
      /winget install/.test(refusedNet.error),
    'a failed download is one sentence with a way out, not a stack trace'
  )
  log(
    !existsSync(join(scratch, 'cloudflared.exe')),
    'and neither failure left a file behind for the next start to find and run'
  )

  const saved = await ensureCloudflaredExe({
    binDir: scratch,
    fetchBytes: async () => Buffer.from('MZ this is a windows program')
  })
  log(
    saved.ok === true && saved.path === join(scratch, 'cloudflared.exe'),
    'a real Windows program is saved into the bin dir'
  )
  log(
    readFileSync(join(scratch, 'cloudflared.exe'), 'utf8') === 'MZ this is a windows program',
    'with the bytes that were downloaded, and no others'
  )
  log(
    !existsSync(join(scratch, 'cloudflared-download.exe')),
    'and the part-file it lands under is renamed away, not left beside it'
  )

  /* ------------------------------------------------------ 2. the invocation */

  const args = cloudflaredArgs(8421)
  log(
    JSON.stringify(args) === JSON.stringify(['tunnel', '--url', 'http://127.0.0.1:8421', '--no-autoupdate']),
    'the command line is exactly tunnel --url http://127.0.0.1:<port> --no-autoupdate'
  )
  log(
    !args.some((a) => /localhost/.test(a)),
    'and it names 127.0.0.1 rather than localhost, which can resolve to ::1 first'
  )

  /* ------------------------------------- 3. reading what cloudflared says */

  const created = parseCloudflaredLine(banner(HOST_ONE))
  log(created?.url === `https://${HOST_ONE}`, 'the boxed banner line yields the quick-tunnel URL')
  log(created?.level === 'INF', 'and its level, which is INF like everything else cloudflared narrates')

  const chatter = parseCloudflaredLine('2026-08-10T16:42:48Z INF Requesting new quick Tunnel on trycloudflare.com...')
  log(
    chatter?.url === '' && chatter?.level === 'INF',
    'the line that merely mentions trycloudflare.com is not mistaken for an address'
  )

  const banner2 = parseCloudflaredLine(
    '2026-08-10T16:42:48Z INF Thank you for trying Cloudflare Tunnel. … (https://www.cloudflare.com/website-terms/) …'
  )
  log(banner2?.url === '', 'nor is the terms-of-use link in the opening blurb')

  const err = parseCloudflaredLine(
    '2026-08-10T16:43:51Z ERR Couldn\'t start tunnel error="Error validating origin URL: parse \\"http://not%20a%20url\\": invalid URL escape \\"%20\\""'
  )
  log(err?.level === 'ERR' && /Couldn't start tunnel/.test(err.message), "an ERR line yields its level and its message")

  const usage = parseCloudflaredLine('Incorrect Usage. flag provided but not defined: -nope')
  log(
    usage?.level === '' && usage?.message === 'Incorrect Usage. flag provided but not defined: -nope',
    'a refusal printed before the logger exists — no timestamp, no level — is kept whole rather than dropped'
  )
  log(parseCloudflaredLine('   ') === null, 'and a blank line is nothing at all')

  /* --------------------------------------------- 4. the doors that stay shut */

  log(
    /flag provided but not defined/.test(permanentRefusal('Incorrect Usage. flag provided but not defined: -nope') ?? ''),
    "an argument cloudflared will not accept is a permanent refusal that repeats its own words"
  )
  log(
    /origin URL/.test(
      permanentRefusal('Couldn\'t start tunnel error="Error validating origin URL: parse \\"http://not a url\\""') ?? ''
    ),
    'and so is an origin URL it cannot parse'
  )
  log(
    permanentRefusal('Failed to serve quic connection error="timeout: no recent network activity" connIndex=0') === null,
    'a dropped edge connection is not — that one is worth retrying'
  )
  log(
    permanentRefusal('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF') === null,
    'nor is Cloudflare declining to hand out a quick tunnel this second'
  )

  /* ------------------------------------------------------------ 5. backoff */

  log(
    JSON.stringify([0, 1, 2, 3, 4, 5, 6].map(backoffDelay)) ===
      JSON.stringify([1000, 2000, 4000, 8000, 16000, 32000, 60000]),
    'the backoff schedule doubles from 1s and caps at 60s'
  )
  log(backoffDelay(50) === BACKOFF_CAP_MS, 'and stays capped however long the outage runs')

  /* --------------------------------------------------- 6. the supervisor */

  let clock = 1_000_000
  const spawned = []
  const killed = []
  const timers = []
  const statuses = []
  let child = null
  const tunnel = new CloudflareTunnel({
    exe: 'cloudflared.exe',
    port: 8421,
    onStatus: (s) => statuses.push(s),
    spawn: (exe, argv) => {
      spawned.push({ exe, argv })
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
  log(last().url === '' && /Starting cloudflared/.test(last().detail), 'with no address yet, and a sentence saying so')

  child.say(banner(HOST_ONE))
  log(last().state === 'live' && last().url === `https://${HOST_ONE}`, 'the URL in the banner makes the tunnel live')

  // The pipe delivers chunks, not lines. A banner split mid-hostname must still
  // be read — this is the failure that only ever shows up under load.
  const splitTunnel = (() => {
    const seen = []
    let c = null
    const t = new CloudflareTunnel({
      exe: 'cloudflared.exe',
      port: 8421,
      onStatus: (s) => seen.push(s),
      spawn: () => {
        c = fakeChild()
        return c
      },
      setTimer: () => 0,
      clearTimer: () => {}
    })
    t.start()
    const line = banner(HOST_TWO)
    c.chunk(line.slice(0, 40))
    const midway = seen[seen.length - 1].state
    c.chunk(`${line.slice(40)}\n`)
    return { midway, final: seen[seen.length - 1] }
  })()
  log(splitTunnel.midway === 'starting', 'half a banner is not half a tunnel — nothing is reported from an incomplete line')
  log(
    splitTunnel.final.state === 'live' && splitTunnel.final.url === `https://${HOST_TWO}`,
    'and the address is read correctly once the rest of the chunk arrives'
  )

  // A crash 5s into a live connection is still the same incident.
  clock += 5000
  child.die(1)
  log(last().state === 'retrying', 'an unexpected exit reports retrying, not silence')
  log(last().url === '', 'and drops the address it was live on, which no longer answers')
  log(runTimer() === 1000 && spawned.length === 2, 'the first retry waits 1s and really respawns')

  child.say('2026-08-10T16:42:54Z ERR Failed to serve quic connection error="timeout: no recent network activity"')
  child.die(1)
  log(
    /no recent network activity/.test(last().detail),
    "a retry detail carries cloudflared's own complaint rather than a summary of it"
  )
  log(runTimer() === 2000 && spawned.length === 3, 'the second waits 2s')
  child.die(1)
  log(runTimer() === 4000 && spawned.length === 4, 'the third waits 4s — the schedule is climbing')

  /* ------------------------- 6b. the case this whole transport turns on */

  // A quick tunnel is anonymous, so the address is new every time the process
  // is. The supervisor must report the new one and keep nothing of the old.
  child.say(banner(HOST_TWO))
  log(
    last().state === 'live' && last().url === `https://${HOST_TWO}`,
    'a tunnel that comes back on a different hostname reports the new one'
  )
  log(
    !statuses.slice(-1)[0].url.includes(HOST_ONE),
    'with no trace of the address it had before — that one now answers for nobody'
  )

  // Live for longer than HEALTHY_RESET_MS, then a drop: a fresh incident.
  clock += HEALTHY_RESET_MS + 1000
  child.die(1)
  log(runTimer() === 1000 && spawned.length === 5, 'a connection healthy for 30s resets the schedule to 1s')

  /* --------------------------------------------- 6c. and the door that shuts */

  child.say('Incorrect Usage. flag provided but not defined: -nope')
  child.die(1)
  log(
    last().state === 'error' && /flag provided but not defined/.test(last().detail),
    "a permanent refusal surfaces as error, carrying cloudflared's own text"
  )
  // Only backoff timers count here: the probe timer arms on every live banner
  // and this harness's clearTimer deliberately forgets nothing.
  log(
    timers.filter((t) => t.ms !== PROBE_INTERVAL_MS).length === 0 && spawned.length === 5,
    'and is NOT retried — no timer set, nothing respawned'
  )

  tunnel.stop()
  log(last().state === 'off', 'stop() reports off')
  statuses.length = 0
  tunnel.start()
  child.say(banner(HOST_ONE))
  tunnel.stop()
  log(killed.includes(5150), 'stopping a live tunnel kills the process tree by pid')
  log(last().state === 'off' && last().url === '', 'and the status ends off with no URL')

  /* ------------------------------------------ 6d. the watchdog: a tunnel
     that dies while its process lives.

     The incident this guards against is real and sat in dev.log for hours:
     Cloudflare deleted the quick tunnel on its side, the hostname fell out of
     DNS, and cloudflared printed `Serve tunnel error` for the rest of the
     evening without ever exiting. The supervisor saw a healthy child; every
     browser saw "desktop is asleep". Two detectors below — the log counter
     and the probe — and both must end the same way: the child killed, the
     dead address dropped at once, and a respawn that comes back on a fresh
     hostname for the rendezvous to republish. */

  // The two lines the detector turns on, exactly as this machine's dev.log
  // and cloudflared 2026.5.2 print them.
  const SERVE_ERR =
    '2026-08-11T18:19:35Z ERR Serve tunnel error error="control stream encountered a failure while serving" connIndex=0 event=0 ip=198.41.200.23'
  const REGISTERED =
    '2026-08-11T12:31:05Z INF Registered tunnel connection connIndex=0 connection=5f8d ip=198.41.200.23 location=lhr protocol=quic'
  log(
    EDGE_FAILURE_LINE.test(parseCloudflaredLine(SERVE_ERR).message),
    "the real Serve-tunnel-error line off this machine's dev.log is recognised as an edge failure"
  )
  log(
    EDGE_RECOVERED_LINE.test(parseCloudflaredLine(REGISTERED).message),
    'and the real Registered-tunnel-connection line is recognised as recovery'
  )
  log(
    !EDGE_FAILURE_LINE.test('failed to run the datagram handler error="context canceled"'),
    'the datagram-handler chatter that rides along with a failure is not counted twice'
  )

  const watchdogRig = (impl = {}) => {
    const rig = { statuses: [], spawned: 0, killed: [], timers: [], child: null }
    rig.tunnel = new CloudflareTunnel({
      exe: 'cloudflared.exe',
      port: 8421,
      onStatus: (s) => rig.statuses.push(s),
      spawn: () => {
        rig.spawned += 1
        rig.child = fakeChild(6000 + rig.spawned)
        return rig.child
      },
      killTree: (pid) => rig.killed.push(pid),
      now: () => 2_000_000,
      setTimer: (fn, ms) => {
        const handle = { fn, ms }
        rig.timers.push(handle)
        return handle
      },
      clearTimer: (handle) => {
        rig.timers = rig.timers.filter((t) => t !== handle)
      },
      probe: impl.probe ?? (async () => true),
      probeControl: impl.probeControl ?? (async () => true)
    })
    rig.last = () => rig.statuses[rig.statuses.length - 1]
    // Fire the queued timer of the given delay — the probe interval, the kill
    // escalation and the backoff schedule never share a value, so the delay
    // names the timer. A miss is the harness lying about which path it
    // exercises, and must be loud.
    rig.fire = (ms) => {
      const i = rig.timers.findIndex((t) => t.ms === ms)
      if (i < 0) throw new Error(`no ${ms}ms timer is armed`)
      const t = rig.timers.splice(i, 1)[0]
      t.fn()
    }
    rig.hasTimer = (ms) => rig.timers.some((t) => t.ms === ms)
    return rig
  }
  const settle = () => new Promise((r) => setImmediate(r))

  /* --- the log counter, confirmed by the probe --- */
  {
    let answer = false
    const dialled = []
    const rig = watchdogRig({
      probe: async (url) => {
        dialled.push(url)
        return answer
      }
    })
    rig.tunnel.start()
    rig.child.say(banner(HOST_ONE))
    log(rig.hasTimer(PROBE_INTERVAL_MS), 'going live arms the probe timer')

    for (let i = 0; i < EDGE_FAILURE_LIMIT - 1; i++) rig.child.say(SERVE_ERR)
    await settle()
    log(rig.killed.length === 0 && rig.last().state === 'live', 'serving failures below the limit change nothing')

    rig.child.say(REGISTERED)
    for (let i = 0; i < EDGE_FAILURE_LIMIT - 1; i++) rig.child.say(SERVE_ERR)
    await settle()
    log(
      rig.killed.length === 0 && rig.last().state === 'live',
      'an edge link that re-registers forgives the failures before it — the count starts over'
    )

    rig.child.say(SERVE_ERR)
    await settle()
    log(
      dialled.length === 1 && dialled[0] === `https://${HOST_ONE}` && rig.killed.includes(6001),
      `failure number ${EDGE_FAILURE_LIMIT} is confirmed by an immediate probe, then kills the process tree`
    )
    log(
      rig.last().state === 'retrying' && rig.last().url === '',
      'and the dead address is dropped immediately, not at exit — nothing republishes it meanwhile'
    )
    log(!rig.hasTimer(PROBE_INTERVAL_MS), 'the probe timer is disarmed with it')
    log(rig.hasTimer(KILL_ESCALATE_MS), 'and a watch is set on the kill itself')

    // The ordinary exit path takes over: respawn, fresh hostname, live again.
    rig.child.die(1)
    log(!rig.hasTimer(KILL_ESCALATE_MS), 'the exit arriving stands the kill-watch down')
    rig.fire(1000)
    log(rig.spawned === 2, 'the kill flows into the normal respawn')
    answer = true
    rig.child.say(banner(HOST_TWO))
    log(
      rig.last().state === 'live' && rig.last().url === `https://${HOST_TWO}`,
      'and the tunnel comes back live on the fresh address the rendezvous will publish'
    )
  }

  /* --- a grumbling edge whose address still answers is left alone --- */
  {
    const rig = watchdogRig({ probe: async () => true })
    rig.tunnel.start()
    rig.child.say(banner(HOST_ONE))
    for (let i = 0; i < EDGE_FAILURE_LIMIT; i++) rig.child.say(SERVE_ERR)
    await settle()
    log(
      rig.killed.length === 0 && rig.last().state === 'live',
      'edge failures with an address that still answers are grumbling, not death — no restart'
    )
  }

  /* --- this desktop's own connection being down pauses the watchdog --- */
  {
    const rig = watchdogRig({ probe: async () => false, probeControl: async () => false })
    rig.tunnel.start()
    rig.child.say(banner(HOST_ONE))
    for (let i = 0; i < EDGE_FAILURE_LIMIT; i++) rig.child.say(SERVE_ERR)
    await settle()
    rig.fire(PROBE_INTERVAL_MS)
    await settle()
    rig.fire(PROBE_INTERVAL_MS)
    await settle()
    log(
      rig.killed.length === 0 && rig.last().state === 'live',
      'a dead probe with the whole internet unreachable strikes nobody — the hostname survives the outage'
    )
  }

  /* --- the scheduled probe --- */
  {
    let answer = true
    const dialled = []
    const rig = watchdogRig({
      probe: async (url) => {
        dialled.push(url)
        return answer
      }
    })
    rig.tunnel.start()
    rig.child.say(banner(HOST_ONE))

    rig.fire(PROBE_INTERVAL_MS)
    await settle()
    log(
      dialled.length === 1 && dialled[0] === `https://${HOST_ONE}`,
      'the probe dials the exact public address the tunnel reported'
    )
    log(
      rig.killed.length === 0 && rig.last().state === 'live' && rig.hasTimer(PROBE_INTERVAL_MS),
      'an address that answers keeps the tunnel live and re-arms the probe'
    )

    answer = false
    rig.fire(PROBE_INTERVAL_MS)
    await settle()
    log(
      rig.killed.length === 0 && rig.hasTimer(PROBE_INTERVAL_MS),
      `one failed probe is a strike, not a verdict (${PROBE_STRIKES} are needed)`
    )
    rig.fire(PROBE_INTERVAL_MS)
    await settle()
    log(rig.killed.includes(6001), 'the second consecutive failure kills the process tree')
    log(rig.last().state === 'retrying' && rig.last().url === '', 'drops the dead address at once')

    rig.child.die(1)
    rig.fire(1000)
    answer = true
    rig.child.say(banner(HOST_TWO))
    log(
      rig.last().state === 'live' && rig.last().url === `https://${HOST_TWO}`,
      'and the respawn comes back on a fresh address here too'
    )

    // stop() must not leave a probe behind to fire on a dead rig.
    rig.tunnel.stop()
    log(!rig.hasTimer(PROBE_INTERVAL_MS), 'stop() disarms the probe along with everything else')
  }

  /* --- the kill that does not land --- */
  {
    const rig = watchdogRig({ probe: async () => false })
    rig.tunnel.start()
    rig.child.say(banner(HOST_ONE))
    const wedged = rig.child
    rig.fire(PROBE_INTERVAL_MS)
    await settle()
    rig.fire(PROBE_INTERVAL_MS)
    await settle()
    log(rig.killed.includes(6001) && rig.spawned === 1, 'the watchdog kills a child that will turn out not to die')

    // No exit arrives. The escalation must synthesise one, or the supervisor
    // is wedged at retrying with every detector disarmed — the incident back
    // again, minus the self-heal.
    rig.fire(KILL_ESCALATE_MS)
    log(rig.hasTimer(1000), 'a child that never exits is declared dead anyway, and the respawn is scheduled')
    rig.fire(1000)
    log(rig.spawned === 2, 'the supervisor is not wedged — a fresh cloudflared is spawned')
    rig.child.say(banner(HOST_TWO))
    const statusesBefore = rig.statuses.length
    const spawnedBefore = rig.spawned
    wedged.die(1)
    log(
      rig.statuses.length === statusesBefore && rig.spawned === spawnedBefore && rig.last().url === `https://${HOST_TWO}`,
      "the wedged child's late real exit is ignored — it cannot clobber its successor"
    )
  }

  /* --- stop() during an in-flight probe --- */
  {
    let resolveProbe = null
    const rig = watchdogRig({ probe: () => new Promise((r) => (resolveProbe = r)) })
    rig.tunnel.start()
    rig.child.say(banner(HOST_ONE))
    rig.fire(PROBE_INTERVAL_MS)
    rig.tunnel.stop()
    const statusesBefore = rig.statuses.length
    const killedBefore = rig.killed.length
    resolveProbe(false)
    await settle()
    log(
      rig.statuses.length === statusesBefore && rig.killed.length === killedBefore && rig.last().state === 'off',
      'a probe answering after stop() changes nothing — no kill, no report, no timer'
    )
  }

  /* ------------------------------ 7. the address reaches a browser intact */

  log(normaliseHost(`https://${HOST_ONE}`) === HOST_ONE, 'the URL cloudflared reports normalises to a bare hostname')
  log(
    webSocketUrl(normaliseHost(`https://${HOST_ONE}`)) === `wss://${HOST_ONE}/web`,
    'which becomes the address a browser dials, over TLS'
  )
  log(
    normaliseHost('https://only-a-fragment') === '',
    'while a half-address becomes nothing at all, rather than a link that fails at dial time'
  )
}

main()
  .catch((err) => {
    failures++
    console.error(`\nFAIL  ${err?.stack ?? err}`)
  })
  .finally(() => {
    rmSync(scratch, { recursive: true, force: true })
    console.log(failures === 0 ? '\ncf:tunnel — all checks passed' : `\ncf:tunnel — ${failures} FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })
