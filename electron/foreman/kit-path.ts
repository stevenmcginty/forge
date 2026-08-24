import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { FOREMAN_KIT_MANIFEST } from '@shared/foreman-kit'

/**
 * Where the bundled Foreman kit is, dev and packaged.
 *
 * The one Electron-aware line of the kit — kept out of kit.ts so that file
 * stays drivable head-less by scripts/foreman-kit-check.mjs. Same shape as
 * resolveScript() in electron/stt-sidecar.ts and scriptCandidates() in
 * electron/bridge/mcp-config.ts, and the same rule applies: if a candidate here
 * changes, the matching `to:` in electron-builder.yml changes with it.
 *
 * In dev the compiled main sits in `out/main`, so the repo root is two levels
 * up. A packaged build carries `assets/foreman-kit` as an extraResource — it is
 * *read by path* rather than imported, and `files:` ships only `out/**`, so
 * without that entry there is no kit in the installer at all.
 *
 * Existence is tested on manifest.json rather than on the folder: an empty
 * `foreman-kit/` that survived a bad build is not a kit, and finding it would
 * stop the search before the copy that works.
 */
export function foremanKitDir(): string | null {
  const appPath = app.getAppPath()
  const candidates = [
    join(__dirname, '..', '..', 'assets', 'foreman-kit'),
    join(appPath, 'assets', 'foreman-kit'),
    process.resourcesPath ? join(process.resourcesPath, 'foreman-kit') : '',
    join(`${appPath}.unpacked`, 'assets', 'foreman-kit')
  ]
  const found = candidates.find((path) => path && existsSync(join(path, FOREMAN_KIT_MANIFEST))) ?? null
  if (!found) console.error('[foreman] kit not found; tried:\n  ' + candidates.filter(Boolean).join('\n  '))
  return found
}
