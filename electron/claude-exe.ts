import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the Claude Agent SDK's own CLI binary lives, as a path the OS can run.
 *
 * The SDK resolves it itself in a checkout. In an installed Forge that lookup
 * lands inside app.asar, which `fs` can read but the OS cannot execute — the
 * SDK reports that as "exists but failed to launch" and blames libc. The
 * package is unpacked (electron-builder.yml, asarUnpack), so the real file is
 * in app.asar.unpacked; this points the SDK straight at it rather than
 * trusting Electron's path rewriting on the spawn.
 *
 * Null when nothing is found — the SDK's default lookup runs as before.
 */
export function claudeSdkExecutable(): string | null {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude'
  let dir: string
  try {
    dir = require.resolve(`${pkg}/package.json`).replace(/[\/]package\.json$/, '')
  } catch {
    return null
  }
  for (const candidate of [dir.replace(/app\.asar([\/])/, 'app.asar.unpacked$1'), dir]) {
    const exe = join(candidate, name)
    if (existsSync(exe)) return exe
  }
  return null
}
