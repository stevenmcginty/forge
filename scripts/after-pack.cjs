/**
 * electron-builder afterPack hook: run the secrets gate on the packed app
 * *before* an installer or a zip is made from it.
 *
 * Throwing here aborts the whole build, which is the point — a leaked key that
 * only gets noticed after `Forge-0.1.0-setup.exe` exists is a key that might
 * already have been handed to somebody.
 *
 * CommonJS on purpose: the package is `"type": "commonjs"`, and electron-builder
 * `require`s this file.
 */
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  const dir = context.appOutDir
  const audit = join(__dirname, 'secrets-audit.mjs')

  console.log(`  ..   secrets audit on the packed app (${dir})`)
  const run = spawnSync(process.execPath, [audit, '--only-dir', dir], { stdio: 'inherit' })

  if (run.status !== 0) {
    throw new Error(
      `The secrets audit failed on ${dir} (exit ${run.status}). ` +
        'Nothing has been packaged. Fix what it named, then build again.'
    )
  }
}
