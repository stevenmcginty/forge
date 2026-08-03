// Kills leftover processes from a previous dev session before starting a new one.
// A crashed or half-closed Forge can leave the vite dev server (5173) and the
// mobile server (8420) alive, which blocks the next `npm run dev` from binding.
import { execSync } from 'node:child_process'

const PORTS = [5173, 8420]

function pidsOnPorts() {
  let out = ''
  try {
    out = execSync('netstat -ano -p tcp', { encoding: 'utf8' })
  } catch {
    return []
  }
  const pids = new Set()
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/)
    if (m && PORTS.includes(Number(m[1]))) pids.add(Number(m[2]))
  }
  pids.delete(process.pid)
  pids.delete(process.ppid)
  return [...pids]
}

const pids = pidsOnPorts()
for (const pid of pids) {
  try {
    // /t takes the whole zombie tree (node + electron children) down with it
    execSync(`taskkill /f /t /pid ${pid}`, { stdio: 'ignore' })
    console.log(`[predev] killed stale dev process tree (pid ${pid})`)
  } catch {
    console.warn(`[predev] could not kill pid ${pid} — if dev fails to bind, close it manually`)
  }
}
if (pids.length === 0) console.log('[predev] no stale dev processes found')
