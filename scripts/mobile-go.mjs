/**
 * One command. Your terminals, on your phone, from anywhere.
 *
 *   npm run mobile:go
 *
 * Starts the link, opens a public tunnel, and prints ONE address and ONE code.
 * Pair the phone once and it is remembered — on this machine in
 * `%APPDATA%\Forge\mobile-devices.json`, and on the phone in its own storage —
 * so every later run just connects with nothing to type.
 *
 * The problem this solves is not technical, it is human: a code that expires in
 * five minutes and a tunnel URL that changes every launch means re-typing two
 * things every single time, and re-typing two things every time is the same as
 * the feature not existing.
 *
 * What is still not permanent: **the tunnel URL changes every run**, because an
 * anonymous quick tunnel is anonymous. The phone keeps its token, so a new URL
 * costs you one paste rather than a re-pair — but for an address that never
 * changes you want Tailscale (a fixed 100.x on your own private network, no
 * public exposure at all) or a named Cloudflare tunnel (needs a domain). See
 * docs/MOBILE.md.
 *
 * Ctrl+C stops everything.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const WEB_ROOT = join(ROOT, 'mobile', 'dist')
const PORT = Number(process.env.FORGE_MOBILE_PORT ?? 8420)

/**
 * Paired phones live beside Forge's own data, not in the repo: a credential
 * — even a hashed one — has no business in a git working tree.
 */
const DEVICES_FILE = join(
  process.env.FORGE_DATA_DIR?.trim() || join(process.env.APPDATA ?? homedir(), 'Forge'),
  'mobile-devices.json'
)

/** Half an hour, because this code is printed into a terminal you may walk away from. */
const PAIR_TTL_MS = 30 * 60_000

const scratch = join(ROOT, 'node_modules', '.forge-mobile-go')
mkdirSync(scratch, { recursive: true })

function loadDevices() {
  try {
    const raw = JSON.parse(readFileSync(DEVICES_FILE, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function saveDevices(devices) {
  try {
    mkdirSync(dirname(DEVICES_FILE), { recursive: true })
    writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2))
  } catch (err) {
    console.error('could not save paired devices:', err.message)
  }
}

const CLOUDFLARED = [
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
  'cloudflared'
].find((c) => c === 'cloudflared' || existsSync(c))

async function main() {
  if (!existsSync(WEB_ROOT)) {
    console.error('The phone app is not built yet. Run:  npm run mobile:build')
    process.exit(1)
  }

  await build({
    entryPoints: [join(ROOT, 'scripts', 'fixtures', 'mobile-entry.ts')],
    outfile: join(scratch, 'mobile.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@lydell/node-pty', 'ws'],
    alias: { '@shared': join(ROOT, 'shared') },
    logLevel: 'silent',
    absWorkingDir: ROOT
  })

  const { MobileServer, MobileAuth, PtySessionManager } = await import(
    pathToFileURL(join(scratch, 'mobile.mjs')).href
  )

  let devices = loadDevices()
  const knownBefore = devices.length

  const auth = new MobileAuth({
    load: () => devices,
    save: (next) => {
      devices = next
      saveDevices(next)
    },
    pairTtlMs: PAIR_TTL_MS
  })

  const replay = new Map()
  const REPLAY_LIMIT = 192 * 1024
  let server = null

  const manager = new PtySessionManager({
    maxSessions: 6,
    onData: (id, data) => {
      const next = (replay.get(id) ?? '') + data
      replay.set(id, next.length > REPLAY_LIMIT ? next.slice(next.length - REPLAY_LIMIT) : next)
      server?.pushData(id, data)
    },
    onExit: (id, exitCode) => server?.pushExit(id, exitCode)
  })

  const PROFILES = [
    { id: 'pwsh', name: 'PowerShell', command: '', accent: '#5BA7FF', badge: 'PS' },
    { id: 'claude', name: 'Claude Code', command: 'claude', accent: '#C6FF4A', badge: 'CC' }
  ]
  const PROJECTS = [
    { id: 'forge', name: 'forge', path: ROOT, color: '#C6FF4A', defaultProfileId: 'pwsh', createdAt: 0 }
  ]

  const panes = [
    { id: 'go-pane-1', title: 'shell', profileId: 'pwsh', boot: '' },
    { id: 'go-pane-2', title: 'claude', profileId: 'claude', boot: 'claude' }
  ]
  for (const pane of panes) {
    const created = manager.create({
      id: pane.id,
      cwd: ROOT,
      cols: 80,
      rows: 24,
      bootstrapCommand: pane.boot
    })
    if (!created.ok) {
      console.error(`could not start ${pane.title}: ${created.error}`)
      process.exit(1)
    }
  }

  const workspace = {
    tabs: [
      {
        id: 'go-tab',
        title: 'forge',
        activePaneId: panes[0].id,
        root: {
          type: 'split',
          id: 'go-split',
          direction: 'row',
          ratio: 0.5,
          a: { type: 'leaf', id: panes[0].id, profileId: 'pwsh', title: panes[0].title },
          b: { type: 'leaf', id: panes[1].id, profileId: 'claude', title: panes[1].title }
        }
      }
    ],
    activeTabId: 'go-tab'
  }

  server = new MobileServer({
    auth,
    appVersion: 'forge',
    sessions: () => manager.list(),
    replay: (id) => replay.get(id) ?? '',
    write: (id, data) => manager.write(id, data),
    resize: (id, cols, rows) => manager.resize(id, cols, rows),
    snapshot: () => ({ projects: PROJECTS, profiles: PROFILES, workspaces: { forge: workspace } }),
    dispatchOp: async (op) => `Run Forge itself to ${op.op}.`,
    webRoot: WEB_ROOT,
    onPresence: (n) => console.log(n > 0 ? `\n  ✓ phone connected\n` : `\n  · phone disconnected\n`),
    log: () => {}
  })

  // Loopback only: cloudflared dials from this machine, so the tunnel is the
  // sole way in and the LAN cannot reach the port at all.
  await server.start({ host: '127.0.0.1', port: PORT })

  const offer = auth.offerPairing()

  if (!CLOUDFLARED) {
    console.error('cloudflared is not installed.  winget install --id Cloudflare.cloudflared')
    process.exit(1)
  }

  const tunnel = spawn(CLOUDFLARED, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let announced = false
  const onTunnelOutput = (chunk) => {
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(chunk))
    if (!match || announced) return
    announced = true
    const url = match[0]
    console.log('\n╔══════════════════════════════════════════════════════════╗')
    console.log('   FORGE MOBILE — open this on your phone\n')
    console.log(`   ${url}\n`)
    if (knownBefore > 0) {
      console.log(`   ${knownBefore} phone${knownBefore === 1 ? '' : 's'} already paired — it should connect on its own.`)
      console.log('   If it asks, paste the url above and this code:')
    } else {
      console.log('   Paste that url into BOTH the browser and the app\'s')
      console.log('   "Desktop address" box, then this code once:')
    }
    console.log(`\n   ${offer.token}\n`)
    console.log('   Good for 30 minutes. After pairing once, you never')
    console.log('   need the code again — only the url, which changes')
    console.log('   each run. Ctrl+C stops everything.')
    console.log('╚══════════════════════════════════════════════════════════╝\n')
  }
  tunnel.stdout.on('data', onTunnelOutput)
  tunnel.stderr.on('data', onTunnelOutput)

  console.log('Starting…  (two live shells: a prompt and a Claude session)')

  const shutdown = async () => {
    try {
      tunnel.kill()
    } catch {
      /* already gone */
    }
    manager.killAll()
    await server.stop()
    rmSync(scratch, { recursive: true, force: true })
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
