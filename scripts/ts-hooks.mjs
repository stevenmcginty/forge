/**
 * Let a plain `node scripts/x.mjs` import Forge's TypeScript directly.
 *
 * Two things stand in the way of `import '../electron/foo.ts'` from a script:
 * package.json has no `"type": "module"`, so node reads a .ts file as
 * CommonJS and chokes on `import`; and Forge's source uses the `@shared/*`
 * alias that only the bundler knows. This hook answers both, and nothing else
 * — types are stripped with node's own `stripTypeScriptTypes`, no transform.
 *
 *   import './ts-hooks.mjs'
 *   const mod = await import('../electron/foo.ts')   // dynamic: after the hook
 */
import { registerHooks, stripTypeScriptTypes } from 'node:module'

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    const importer = String(context.parentURL ?? '')
    if (!importer.includes('/node_modules/') && spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) {
      return next(`${spec}.ts`, context)
    }
    return next(spec, context)
  },
  load(url, context, next) {
    if (!url.endsWith('.ts')) return next(url, context)
    const result = next(url, { ...context, format: 'module' })
    const source = stripTypeScriptTypes(String(result.source), { mode: 'strip' })
    return { format: 'module', shortCircuit: true, source }
  }
})
