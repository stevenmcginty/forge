/**
 * Where this bundle learns which Firebase project it belongs to.
 *
 * Read from `/config.json` at startup rather than baked in by `define`, and
 * that is not a style choice. A Firebase project id, an API key and a database
 * URL are *deployment* facts: they change when the project is recreated, they
 * differ between a staging deploy and the real one, and the person who has them
 * (see "What only Steve can do" in docs/forge-web.md) is not the person
 * rebuilding the bundle. Baking them in would mean a rebuild to change a URL,
 * and a checked-in file full of somebody's project keys.
 *
 * Nothing here is secret. A Firebase web API key is a public identifier — the
 * database rules and the desktop's uid check are what actually gate anything —
 * which is precisely why it is safe to serve it beside the bundle.
 *
 * The file is fetched with `cache: 'no-store'`: Hosting caches hashed assets
 * hard, and a stale config is a page that dials the wrong project forever.
 */

export interface WebClientConfig {
  /** The Firebase web API key. Public; see above. */
  apiKey: string
  /**
   * The Realtime Database origin, e.g. `https://forge-web-default-rtdb.europe-west1.firebasedatabase.app`.
   * `webHostPath(uid)` is appended to it — no path is built by hand anywhere.
   */
  databaseUrl: string
  /** Overridable so a check script can point sign-in at a local stand-in. */
  authBase?: string
  tokenBase?: string
  /**
   * A desktop on this very machine, for `npm run web:dev` — `localhost:8420`
   * or `127.0.0.1:8420`, with the port, because a published `WebHostRecord`
   * cannot carry one (`normaliseHost` strips it).
   *
   * **Honoured only by the dev server.** See `devLoopbackHost`.
   */
  devHost?: string
}

const CONFIG_URL = '/config.json'

/**
 * The dev-only loopback escape hatch, in one place so there is one thing to
 * read when asking "can production reach this?".
 *
 * `__DEV_SERVER__` is `false` in everything `vite build` emits, so this
 * function's body constant-folds to `return ''` and every call site's
 * `allowLoopback` argument folds to `false`. It is not a runtime check a hostile
 * `/config.json` could satisfy — the branch is deleted.
 *
 * **Not `import.meta.env.DEV`.** Vite derives that from `process.env.NODE_ENV`,
 * so a build run in a shell exporting `NODE_ENV=development` stamps `true` into
 * a production bundle. `__DEV_SERVER__` comes from which Vite subcommand ran;
 * see the note beside its `define` in web/vite.config.ts.
 *
 * That distinction matters because `webSocketUrl`'s own comment is explicit:
 * `normaliseHost` rejects `localhost` but *accepts* `127.0.0.1`, so a host
 * sniffed out of the published record could otherwise steer a real session onto
 * a plaintext socket. The flag is opt-in rather than inferred, and this is the
 * only opt-in.
 */
export function devLoopbackHost(config: WebClientConfig): string {
  if (!__DEV_SERVER__) return ''
  return config.devHost ?? ''
}

/** True when this build is allowed to dial a loopback address at all. */
export const ALLOW_LOOPBACK = __DEV_SERVER__

/**
 * Load `/config.json`, or explain what is missing.
 *
 * Total on purpose: a page that cannot read its own configuration must say so
 * in a sentence rather than fail somewhere later in a way that reads like a
 * network fault. Nothing is defaulted — a client that quietly invented a
 * database URL would be a client that silently talked to the wrong project.
 */
export async function loadConfig(): Promise<{ ok: true; config: WebClientConfig } | { ok: false; error: string }> {
  let response: Response
  try {
    response = await fetch(CONFIG_URL, { cache: 'no-store' })
  } catch {
    return { ok: false, error: `Could not read ${CONFIG_URL} — check your connection and reload.` }
  }
  if (!response.ok) {
    return { ok: false, error: `${CONFIG_URL} answered ${response.status}. This deployment is not configured yet.` }
  }
  let value: unknown
  try {
    value = await response.json()
  } catch {
    return { ok: false, error: `${CONFIG_URL} is not valid JSON.` }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: `${CONFIG_URL} is not an object.` }
  }
  const raw = value as Partial<WebClientConfig>
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
  const databaseUrl = typeof raw.databaseUrl === 'string' ? raw.databaseUrl.trim().replace(/\/+$/, '') : ''
  if (!apiKey) return { ok: false, error: `${CONFIG_URL} has no apiKey, so there is no Firebase project to sign in to.` }
  if (!databaseUrl) return { ok: false, error: `${CONFIG_URL} has no databaseUrl, so this page cannot find the desktop.` }
  return {
    ok: true,
    config: {
      apiKey,
      databaseUrl,
      ...(typeof raw.authBase === 'string' && raw.authBase ? { authBase: raw.authBase.replace(/\/+$/, '') } : {}),
      ...(typeof raw.tokenBase === 'string' && raw.tokenBase ? { tokenBase: raw.tokenBase.replace(/\/+$/, '') } : {}),
      ...(typeof raw.devHost === 'string' && raw.devHost ? { devHost: raw.devHost } : {})
    }
  }
}
