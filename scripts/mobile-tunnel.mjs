/**
 * Put the Forge Mobile link on the public internet, for a phone that is not on
 * this wifi.
 *
 *   npm run mobile:tunnel
 *
 * Runs `cloudflared` as a **quick tunnel**: it dials *out* from this machine to
 * Cloudflare and hands back a random `https://….trycloudflare.com` address, so
 * there is no port forwarding, no firewall change, and nothing new on the phone.
 * That is the same no-NAT property the Companion gets from Firebase — the whole
 * reason this shape was chosen. See docs/MOBILE.md.
 *
 * ## Read this before using it
 *
 * The URL is on the public internet. Anyone who reaches it gets a *login*, not
 * a shell: a 256-bit device token, a five-strike lockout, and single-use pairing
 * codes stand in the way. That is a real defence and it is not nothing — but it
 * is an authenticated endpoint on a machine that can spawn shells, and you
 * should be choosing that deliberately rather than discovering it.
 *
 * Two consequences worth knowing:
 *
 *  - **The URL changes every run.** Quick tunnels are anonymous and ephemeral.
 *    For a permanent setup use a *named* tunnel (needs a domain) or Tailscale
 *    (no public exposure at all, and the better answer for a shell).
 *  - **Set `mobileBindHost` to `127.0.0.1`** in Settings → Forge Mobile, or in
 *    `%APPDATA%\Forge\settings.json`, if you want the tunnel to be the *only*
 *    way in. Left at `0.0.0.0`, the LAN can still reach the port directly —
 *    which is convenient at home and one more door everywhere else.
 *
 * Ctrl+C closes the tunnel. Nothing survives it.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const PORT = Number(process.env.FORGE_MOBILE_PORT ?? 8420)

/** Where winget and the MSI put it, plus whatever is on PATH. */
const CANDIDATES = [
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
  'cloudflared'
]

const exe = CANDIDATES.find((c) => c === 'cloudflared' || existsSync(c))
if (!exe) {
  console.error('cloudflared is not installed.  winget install --id Cloudflare.cloudflared')
  process.exit(1)
}

console.log(`Opening a tunnel to http://127.0.0.1:${PORT} …\n`)

const child = spawn(exe, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'], {
  stdio: ['ignore', 'pipe', 'pipe']
})

let announced = false

/**
 * cloudflared prints the URL inside a box of drawing characters, in a wall of
 * INF lines. Pulling it out and printing it alone is the difference between an
 * address you can type into a phone and one you have to hunt for.
 */
function scan(chunk) {
  const text = String(chunk)
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)
  if (match && !announced) {
    announced = true
    console.log('\n────────────────────────────────────────────')
    console.log('  Forge Mobile is reachable at:\n')
    console.log(`  ${match[0]}`)
    console.log('\n  Paste that WHOLE url into the phone app, with the')
    console.log('  pairing code from Settings › Forge Mobile.')
    console.log('\n  Ctrl+C closes the tunnel.')
    console.log('────────────────────────────────────────────\n')
  }
  // Errors still matter; routine INF chatter does not.
  if (/ERR|error|failed/i.test(text)) process.stderr.write(text)
}

child.stdout.on('data', scan)
child.stderr.on('data', scan)

child.on('exit', (code) => {
  console.log(`\ncloudflared exited (${code}). The tunnel is closed.`)
  process.exit(code ?? 0)
})

const stop = () => child.kill()
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
