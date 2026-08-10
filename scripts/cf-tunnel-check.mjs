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
  log(timers.length === 0 && spawned.length === 5, 'and is NOT retried — no timer set, nothing respawned')

  tunnel.stop()
  log(last().state === 'off', 'stop() reports off')
  statuses.length = 0
  tunnel.start()
  child.say(banner(HOST_ONE))
  tunnel.stop()
  log(killed.includes(5150), 'stopping a live tunnel kills the process tree by pid')
  log(last().state === 'off' && last().url === '', 'and the status ends off with no URL')

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
