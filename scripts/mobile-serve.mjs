/**
 * Run the Forge Mobile link on its own, with real shells, and no Electron.
 *
 *   npm run mobile:serve
 *
 * Why this exists: `mobile-host.ts` only starts the link inside a running
 * Forge, and a main-process change needs an app restart to take effect. That is
 * a slow loop for something you are testing on a phone in your other hand. This
 * harness drives the *same* MobileServer and the *same* PtySessionManager the
 * app does — the only things it fakes are the settings store (in memory) and
 * the renderer (layout ops are answered with a sentence saying so).
 *
 * It spawns two real pwsh sessions in this repo so there is something to look
 * at, serves `mobile/dist`, and prints the address and pairing code.
 *
 * This is a test rig, not a way to run Forge Mobile for real: the pairing code
 * is printed to a terminal rather than shown behind a settings switch, and it
 * has no access to your projects or profiles beyond the two panes below. Use
 * Settings › Forge Mobile for the real thing.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const WEB_ROOT = join(ROOT, 'mobile', 'dist')
const PORT = Number(process.env.FORGE_MOBILE_PORT ?? 8420)

const scratch = join(ROOT, 'node_modules', '.forge-mobile-serve')
mkdirSync(scratch, { recursive: true })

function addresses() {
  const found = []
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) found.push(net.address)
    }
  }
  const tailnet = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)
  return [...found.filter(tailnet), ...found.filter((ip) => !tailnet(ip))]
}

async function main() {
  if (!existsSync(WEB_ROOT)) {
    console.error('mobile/dist is not built. Run:  npm run mobile:build')
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

  // In memory: a rig must not write a device into your real settings.json.
  let devices = []
  const auth = new MobileAuth({ load: () => devices, save: (d) => (devices = d) })

  const replay = new Map()
  const REPLAY_LIMIT = 192 * 1024
  let server = null

  const manager = new PtySessionManager({
    maxSessions: 4,
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
    { id: 'rig', name: 'forge (test rig)', path: ROOT, color: '#C6FF4A', defaultProfileId: 'pwsh', createdAt: 0 }
  ]

  // Two real shells, so the pane list has something in it and the terminal has
  // something to paint.
  const panes = [
    { id: 'rig-pane-1', title: 'shell one', profileId: 'pwsh' },
    { id: 'rig-pane-2', title: 'shell two', profileId: 'pwsh' }
  ]
  for (const pane of panes) {
    const created = manager.create({ id: pane.id, cwd: ROOT, cols: 80, rows: 24 })
    if (!created.ok) {
      console.error(`could not spawn ${pane.id}: ${created.error}`)
      process.exit(1)
    }
  }

  const workspace = {
    tabs: [
      {
        id: 'rig-tab',
        title: 'Test rig',
        activePaneId: panes[0].id,
        root: {
          type: 'split',
          id: 'rig-split',
          direction: 'row',
          ratio: 0.5,
          a: { type: 'leaf', id: panes[0].id, profileId: 'pwsh', title: panes[0].title },
          b: { type: 'leaf', id: panes[1].id, profileId: 'pwsh', title: panes[1].title }
        }
      }
    ],
    activeTabId: 'rig-tab'
  }

  server = new MobileServer({
    auth,
    appVersion: 'test-rig',
    sessions: () => manager.list(),
    replay: (id) => replay.get(id) ?? '',
    write: (id, data) => manager.write(id, data),
    resize: (id, cols, rows) => manager.resize(id, cols, rows),
    snapshot: () => ({ projects: PROJECTS, profiles: PROFILES, workspaces: { rig: workspace } }),
    dispatchOp: async (op) => `The test rig cannot ${op.op} — run Forge itself for that.`,
    webRoot: WEB_ROOT,
    log: (line) => console.log(line)
  })

  // `FORGE_MOBILE_HOST=127.0.0.1` when a tunnel is in front of this: the tunnel
  // dials from loopback, so binding loopback-only means the tunnel is the sole
  // way in — the LAN cannot reach it and neither can a mis-forwarded router.
  await server.start({ host: process.env.FORGE_MOBILE_HOST ?? '0.0.0.0', port: PORT })

  // Re-offered every ninety seconds, so there is always a live code in this
  // log to read. The code itself is exactly as strong as the real one —
  // 128 bits, single-use, five-minute life — because this rig is reachable
  // through whatever tunnel is pointed at it, and a test fixture on the public
  // internet is not the place to relax a credential.
  const showCode = () => {
    const offer = auth.offerPairing()
    console.log('\n────────────────────────────────────────────')
    console.log('  Forge Mobile — test rig')
    console.log('')
    for (const address of addresses()) console.log(`  open   http://${address}:${PORT}`)
    console.log(`  code   ${offer.token}`)
    console.log('')
    console.log('  Ctrl+C to stop. Two real pwsh sessions are running.')
    console.log('────────────────────────────────────────────\n')
  }
  showCode()
  const codeTimer = setInterval(showCode, 90_000)

  const shutdown = async () => {
    clearInterval(codeTimer)
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
