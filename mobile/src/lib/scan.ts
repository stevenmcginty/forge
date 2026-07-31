import { Capacitor } from '@capacitor/core'
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner'

/**
 * The camera side of pairing: point the phone at the QR on the desktop's
 * Settings card instead of copying a 40-character hostname by hand.
 *
 * This module only *reads* the code. What the QR says — a `forge://pair?…`
 * link carrying the desktop address and the single-use pairing code — is
 * decoded by `toOrigin`/`pairTokenOf` in secure.ts, the same functions that
 * handle a typed address or a `?pair=` deep link. Parsing it again here would
 * be a second opinion about the wire format, and the day the two disagreed
 * the QR would pair against a different address than the deep link does.
 *
 * The scanner is `@capacitor/barcode-scanner` (the official plugin, on its
 * Capacitor-7 line): one call opens a native full-screen scanner activity and
 * resolves with the decoded text. Nothing to embed behind the WebView, no
 * camera lifecycle for this app to own — which matters, because this app has
 * already learned that Android reclaims graphics resources from backgrounded
 * WebViews (see the canvas-not-WebGL note in term.ts).
 *
 * Callers get a closed set of outcomes rather than a raw rejection, because
 * the three failure shapes need three different answers on screen:
 * cancelling is not an error, a denied camera needs directions to Android's
 * settings, and anything else falls back to typing. The mapping keys on the
 * plugin's stable `OS-PLUG-BARC-` codes first and only sniffs message text
 * as a fallback, so a reworded description cannot silently reclassify a
 * denial as a generic failure.
 */

export type ScanOutcome =
  | { at: 'scanned'; text: string }
  | { at: 'cancelled' }
  | { at: 'denied' }
  | { at: 'failed' }

/**
 * Native only. The plugin does ship a web implementation, but the browser
 * route is served over plain `http://<desktop>:8420`, and `getUserMedia` is a
 * secure-context API — the button would open a scanner whose camera the
 * browser refuses to start. Hiding it there is honest; that route pairs by
 * paste or `?pair=` link, as it always has.
 */
export function canScan(): boolean {
  return Capacitor.isNativePlatform()
}

/** Cancelled (6) and denied (7) per the plugin's published error table. */
const CANCELLED_CODE = 'OS-PLUG-BARC-0006'
const DENIED_CODE = 'OS-PLUG-BARC-0007'

export async function scanPairingCode(): Promise<ScanOutcome> {
  try {
    const result = await CapacitorBarcodeScanner.scanBarcode({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      scanInstructions: 'Point at the QR code in Settings › Forge Mobile.'
    })
    const text = result.ScanResult.trim()
    return text ? { at: 'scanned', text } : { at: 'failed' }
  } catch (error) {
    const { code, message } = shapeOf(error)
    if (code === CANCELLED_CODE || /cancel/i.test(message)) return { at: 'cancelled' }
    if (code === DENIED_CODE || /permission|camera access/i.test(message)) return { at: 'denied' }
    return { at: 'failed' }
  }
}

/** Capacitor rejections are plain objects, not Errors; read both shapes. */
function shapeOf(error: unknown): { code: string; message: string } {
  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; message?: unknown }
    return {
      code: typeof record.code === 'string' ? record.code : '',
      message: typeof record.message === 'string' ? record.message : ''
    }
  }
  return { code: '', message: String(error) }
}
