/**
 * The update manifest: what a release *says* it is, and the rules for
 * believing it.
 *
 * `latest.json` is published next to every APK by scripts/apk-build.mjs and
 * fetched by the app from the releases repo's `latest/download` URL — which
 * always redirects to the newest release's asset, so nothing has to be
 * committed to a branch to move the pointer. This file is deliberately pure
 * (no Capacitor, no DOM): scripts/apk-check.mjs bundles it with esbuild and
 * runs these exact functions in Node, so the parser that rejects a malformed
 * manifest in CI is the parser running on the phone, not a copy of it.
 *
 * Parsing is strict on purpose. This JSON decides whether the app downloads
 * and offers to install an executable; a field that is merely *missing* must
 * read as "no update", never as `undefined` flowing into a URL or a hash
 * comparison. Hence one validator returning a manifest or null, and no
 * partial acceptance.
 */

export interface UpdateManifest {
  /** Monotonic integer; the only field update decisions compare. */
  versionCode: number
  /** Human name ("0.2.0") — display only, never compared. */
  versionName: string
  /** Where the APK is. Pinned to its release tag, so the sha below is a promise about *this* URL. */
  apkUrl: string
  sizeBytes: number
  /** Lowercase hex SHA-256 of the APK. Verified natively before install — see ForgeUpdaterPlugin.kt. */
  sha256: string
  notes: string
}

/**
 * Accepts the manifest or rejects the lot. `https://` on apkUrl is part of
 * the contract: the manifest arrives over TLS, and letting it point the
 * download at plain http would quietly hand the trust chain to the network.
 */
export function parseManifest(raw: unknown): UpdateManifest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (!Number.isInteger(m.versionCode) || (m.versionCode as number) < 1) return null
  if (typeof m.versionName !== 'string' || !m.versionName) return null
  if (typeof m.apkUrl !== 'string' || !m.apkUrl.startsWith('https://')) return null
  if (!Number.isInteger(m.sizeBytes) || (m.sizeBytes as number) < 1) return null
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return null
  return {
    versionCode: m.versionCode as number,
    versionName: m.versionName,
    apkUrl: m.apkUrl,
    sizeBytes: m.sizeBytes as number,
    sha256: m.sha256,
    notes: typeof m.notes === 'string' ? m.notes : ''
  }
}

/**
 * Strictly greater, nothing else: equal is "up to date", and *older* is also
 * "up to date" — a dev build numbered ahead of the feed must not be nagged
 * into downgrading itself (Android would refuse the install anyway).
 */
export function isNewer(manifest: UpdateManifest, installedCode: number): boolean {
  return manifest.versionCode > installedCode
}

/** "34.2 MB" — for the download button and the progress line. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
