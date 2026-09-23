import type {
  WebPasskeyAssertion,
  WebPasskeyCreationOptions,
  WebPasskeyInfo,
  WebPasskeyRequestOptions,
  WebRequest,
  WebResult
} from '@shared/web'
import { bufferToBase64 } from './file'
import { deviceName } from './device'

/**
 * The phone's fingerprint or face as an answer to the desktop's PIN question —
 * WebAuthn with the key in this phone's own platform authenticator.
 *
 * The desktop does all the judging (electron/web/passkey.ts); this file is only
 * the translation between its JSON (every binary value base64url) and the
 * browser's `navigator.credentials`, plus the two things this browser has to
 * remember for itself: which credential it enrolled, and that the person said
 * "Not now" to being asked. The PIN stays the fallback and the root — nothing
 * here ever stops the PIN box from working.
 */

/* ------------------------------------------------------------- base64url */

export function toBase64Url(buffer: ArrayBuffer): string {
  return bufferToBase64(buffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): ArrayBuffer {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/* ------------------------------------------------------------- detection */

function hasWebAuthn(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined' && !!navigator.credentials
}

let platform: Promise<boolean> | null = null

/** Can this browser make and use a passkey held by the phone itself? Asked once per page. */
export function platformPasskeyAvailable(): Promise<boolean> {
  if (!platform) {
    platform = (async () => {
      if (!hasWebAuthn()) return false
      try {
        return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
      } catch {
        return false
      }
    })()
  }
  return platform
}

/** What this phone's biometric is called, for the button and the row. */
export type Biometric = 'Face ID' | 'fingerprint' | 'passkey'

export function biometricName(): Biometric {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'Face ID'
  if (/Android/.test(ua)) return 'fingerprint'
  return 'passkey'
}

/** "Use Face ID" / "Use fingerprint" / "Use passkey". */
export function biometricButtonLabel(): string {
  return `Use ${biometricName()}`
}

/** "Face ID unlock" / "Fingerprint unlock" / "Passkey unlock". */
export function biometricUnlockLabel(): string {
  const name = biometricName()
  return `${name === 'Face ID' ? name : name[0].toUpperCase() + name.slice(1)} unlock`
}

/* ----------------------------------------------------------- remembering */

const CREDENTIAL_KEY = 'forge.passkey.credential'
const DECLINED_KEY = 'forge.passkey.declined'

/** The credential this browser enrolled, or '' — the desktop's list is the truth; this only says which row is ours. */
export function storedCredentialId(): string {
  try {
    return localStorage.getItem(CREDENTIAL_KEY) ?? ''
  } catch {
    return ''
  }
}

function storeCredentialId(id: string): void {
  try {
    if (id) localStorage.setItem(CREDENTIAL_KEY, id)
    else localStorage.removeItem(CREDENTIAL_KEY)
  } catch {
    // Storage refused: the passkey still works; this browser just cannot tell
    // which row of the list is its own after a reload.
  }
}

/** Said "Not now" to the offer on this device. */
export function offerDeclined(): boolean {
  try {
    return localStorage.getItem(DECLINED_KEY) === '1'
  } catch {
    return false
  }
}

export function declineOffer(): void {
  try {
    localStorage.setItem(DECLINED_KEY, '1')
  } catch {
    // Storage refused: asked again next time, which is the lesser nuisance.
  }
}

/** This browser's own row in the desktop's list, if it has one. */
export function thisDevicePasskey(list: WebPasskeyInfo[]): WebPasskeyInfo | null {
  const id = storedCredentialId()
  return id ? (list.find((p) => p.credentialId === id) ?? null) : null
}

/* ------------------------------------------------------------ unlocking */

export type AssertionOutcome =
  | { kind: 'ok'; assertion: WebPasskeyAssertion }
  /** Cancelled, timed out, or refused by the browser (including "no gesture"). Not an error to shout about. */
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string }

/** Ask the phone's biometric to sign the desktop's challenge. Never throws. */
export async function getPasskeyAssertion(options: WebPasskeyRequestOptions): Promise<AssertionOutcome> {
  if (!hasWebAuthn()) return { kind: 'failed', message: 'This browser cannot use passkeys.' }
  let credential: Credential | null
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge: fromBase64Url(options.challenge),
        rpId: options.rpId,
        allowCredentials: options.allowCredentials.map((c) => ({ type: 'public-key', id: fromBase64Url(c.id) })),
        userVerification: options.userVerification,
        timeout: options.timeout
      }
    })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'NotAllowedError' || name === 'AbortError') return { kind: 'cancelled' }
    return { kind: 'failed', message: err instanceof Error ? err.message : 'The passkey did not answer.' }
  }
  if (!(credential instanceof PublicKeyCredential)) return { kind: 'cancelled' }
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    kind: 'ok',
    assertion: {
      credentialId: toBase64Url(credential.rawId),
      authenticatorData: toBase64Url(response.authenticatorData),
      clientDataJSON: toBase64Url(response.clientDataJSON),
      signature: toBase64Url(response.signature),
      ...(response.userHandle && response.userHandle.byteLength ? { userHandle: toBase64Url(response.userHandle) } : {})
    }
  }
}

/* ----------------------------------------------------------- enrolment */

type Request = (body: WebRequest) => Promise<WebResult>

export type PasskeyList = { passkeys: WebPasskeyInfo[]; canRegister: boolean }

export type PasskeyOutcome =
  | ({ ok: true } & PasskeyList)
  | { ok: false; cancelled: boolean; message: string }

function refusal(result: WebResult, fallback: string): PasskeyOutcome {
  return { ok: false, cancelled: false, message: result.kind === 'failed' && result.message ? result.message : fallback }
}

/** This account's passkeys, and whether this socket may enrol or forget one. */
export async function listPasskeys(request: Request): Promise<PasskeyOutcome> {
  const result = await request({ kind: 'passkey-list' })
  if (result.kind !== 'passkeys') return refusal(result, 'The desktop did not list its passkeys.')
  return { ok: true, passkeys: result.passkeys, canRegister: result.canRegister }
}

/** Creation options fetched ahead of the tap, and when. */
export interface PreparedEnrolment {
  options: WebPasskeyCreationOptions
  at: number
}

/**
 * Fetch the desktop's creation options before the person taps, so the tap goes
 * straight to `navigator.credentials.create` — a browser that only lets
 * WebAuthn run inside a fresh gesture (Safari) would otherwise see a network
 * round trip between the tap and the call. Null when the desktop will not.
 */
export async function prepareEnrolment(request: Request): Promise<PreparedEnrolment | null> {
  const begun = await request({ kind: 'passkey-register-begin' })
  return begun.kind === 'passkey-options' ? { options: begun.options, at: Date.now() } : null
}

/** Options still inside their challenge's life, with a margin for the biometric itself. */
function stillFresh(prepared: PreparedEnrolment | null | undefined): prepared is PreparedEnrolment {
  return !!prepared && Date.now() - prepared.at < Math.max(0, prepared.options.timeout - 30_000)
}

/**
 * Make a passkey on this phone and hand its public half to the desktop. Only on
 * a socket that was unlocked with the PIN itself — the desktop refuses anything
 * else, and says so in its own words.
 */
export async function enrolPasskey(request: Request, prepared?: PreparedEnrolment | null): Promise<PasskeyOutcome> {
  if (!hasWebAuthn()) return { ok: false, cancelled: false, message: 'This browser cannot make passkeys.' }
  let options: WebPasskeyCreationOptions
  if (stillFresh(prepared)) {
    options = prepared.options
  } else {
    const begun = await request({ kind: 'passkey-register-begin' })
    if (begun.kind !== 'passkey-options') return refusal(begun, 'The desktop would not start that.')
    options = begun.options
  }
  let credential: Credential | null
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        challenge: fromBase64Url(options.challenge),
        rp: options.rp,
        user: { id: fromBase64Url(options.user.id), name: options.user.name, displayName: options.user.displayName },
        pubKeyCredParams: options.pubKeyCredParams,
        authenticatorSelection: options.authenticatorSelection,
        attestation: options.attestation,
        excludeCredentials: options.excludeCredentials.map((c) => ({ type: 'public-key', id: fromBase64Url(c.id) })),
        timeout: options.timeout
      }
    })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'NotAllowedError' || name === 'AbortError') return { ok: false, cancelled: true, message: '' }
    if (name === 'InvalidStateError') {
      return { ok: false, cancelled: false, message: 'This phone already has a passkey for Forge.' }
    }
    return { ok: false, cancelled: false, message: err instanceof Error ? err.message : 'The passkey was not made.' }
  }
  if (!(credential instanceof PublicKeyCredential)) return { ok: false, cancelled: true, message: '' }
  const response = credential.response as AuthenticatorAttestationResponse
  const finished = await request({
    kind: 'passkey-register-finish',
    clientDataJSON: toBase64Url(response.clientDataJSON),
    attestationObject: toBase64Url(response.attestationObject),
    deviceName: deviceName()
  })
  if (finished.kind !== 'passkeys') return refusal(finished, 'The desktop did not keep that passkey.')
  storeCredentialId(toBase64Url(credential.rawId))
  return { ok: true, passkeys: finished.passkeys, canRegister: finished.canRegister }
}

/** Stop this phone's passkey unlocking the desktop. The key stays on the phone; the desktop forgets it. */
export async function forgetPasskey(request: Request, credentialId: string): Promise<PasskeyOutcome> {
  const result = await request({ kind: 'passkey-forget', credentialId })
  if (result.kind !== 'passkeys') return refusal(result, 'The desktop did not forget it.')
  if (credentialId === storedCredentialId()) storeCredentialId('')
  return { ok: true, passkeys: result.passkeys, canRegister: result.canRegister }
}
