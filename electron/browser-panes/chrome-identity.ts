import { execFileSync } from 'node:child_process'
import { app, type Session, type WebContents } from 'electron'

/**
 * Every page in the browser session (tabs, their pop-ups, chat panes, the phone
 * copies) presents itself as plain Google Chrome of the same version Electron
 * runs — not "Chrome/… Electron/… Forge/…". Sites with a fraud check (bet365
 * refused a correct password) compare the request header, navigator.userAgent,
 * navigator.userAgentData and the Sec-CH-UA headers; one that disagrees with
 * another looks worse than no change, so all four come from here:
 *
 *   - the session's user agent: Chrome's reduced string, `Chrome/<major>.0.0.0`,
 *     the base for anything that has no page of its own (service workers);
 *   - per page, the DevTools protocol's Emulation.setUserAgentOverride with the
 *     client-hint metadata Chrome itself would report — Electron's own values
 *     with the "Google Chrome" brand added, ordered and GREASEd as Chromium's
 *     components/embedder_support/user_agent_utils.cc does it for that major —
 *     and the same on each cross-site frame and worker the page starts;
 *   - Sec-CH-UA, -Mobile and -Platform written onto every request to a secure
 *     origin: Electron sends none on a navigation, Chrome sends all three;
 *   - a UK Chrome's languages, in the header and navigator.languages alike.
 *
 * Measured on Electron 43 (Chromium 150): the override must be sent before the
 * first navigation and not awaited — the protocol answers nothing until the page
 * has a renderer — and it ends with the debugger session (the user agent stays,
 * the brands fall back to Electron's), so every attach here puts it back. Forge's own windows and the artifact session are never touched.
 */

export interface UaBrand {
  brand: string
  version: string
}

export interface UaMetadata {
  brands: UaBrand[]
  fullVersionList: UaBrand[]
  fullVersion: string
  platform: string
  platformVersion: string
  architecture: string
  model: string
  mobile: boolean
  bitness: string
  wow64: boolean
  formFactors: string[]
}

export interface ChromeIdentity {
  userAgent: string
  /** navigator.platform. */
  platform: string
  metadata: UaMetadata
}

/**
 * Chrome's brand list for a major version: GREASE, Chromium and Google Chrome,
 * shuffled by the major version (user_agent_utils.cc GenerateBrandVersionList,
 * ShuffleBrandList, GetGreasedUserAgentBrandVersion). `version` is the major
 * for Sec-CH-UA / brands, the full version for fullVersionList.
 */
export function chromeBrands(major: number, version: string, full = false): UaBrand[] {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_']
  const greaseMajor = ['8', '99', '24'][major % 3]
  const grease = {
    brand: `Not${chars[major % chars.length]}A${chars[(major + 1) % chars.length]}Brand`,
    version: full ? `${greaseMajor}.0.0.0` : greaseMajor
  }
  const list = [grease, { brand: 'Chromium', version }, { brand: 'Google Chrome', version }]
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0]
  ]
  const order = orders[major % orders.length]
  const out: UaBrand[] = new Array(list.length)
  list.forEach((bv, i) => (out[order[i]] = bv))
  return out
}

/** `"Chromium";v="150", "Google Chrome";v="150", …` — the Sec-CH-UA form. */
export function secChUa(brands: UaBrand[]): string {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ')
}

/** Chromium's Windows platformVersion: the UniversalApiContract version, "19.0.0" on Windows 11 24H2. */
function windowsPlatformVersion(): string {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\WindowsRuntime\\WellKnownContracts', '/v', 'Windows.Foundation.UniversalApiContract', '/reg:64'],
      { encoding: 'utf8', windowsHide: true, timeout: 3_000 }
    )
    const m = out.match(/0x([0-9a-f]+)/i)
    if (m) {
      const v = parseInt(m[1], 16)
      return `${v >>> 16}.${v & 0xffff}.0`
    }
  } catch {
    /* fall through to Chromium's own fallback */
  }
  // kHighestKnownUniversalApiContractVersion in user_agent_utils.cc.
  return '19.0.0'
}

let cached: ChromeIdentity | null = null

/** The identity for the Chromium this process runs. Built once. */
export function chromeIdentity(): ChromeIdentity {
  if (cached) return cached
  const full = process.versions.chrome
  const major = Number(full.split('.')[0])
  const win = process.platform === 'win32'
  const mac = process.platform === 'darwin'
  // Chrome's reduced user agent freezes the OS token on each platform.
  const osToken = win ? 'Windows NT 10.0; Win64; x64' : mac ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'
  const wow64 = win && process.arch === 'ia32' && Boolean(process.env.PROCESSOR_ARCHITEW6432)
  cached = {
    userAgent: `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    platform: win ? 'Win32' : mac ? 'MacIntel' : 'Linux x86_64',
    metadata: {
      brands: chromeBrands(major, String(major)),
      fullVersionList: chromeBrands(major, full, true),
      fullVersion: full,
      platform: win ? 'Windows' : mac ? 'macOS' : 'Linux',
      platformVersion: win ? windowsPlatformVersion() : mac ? process.getSystemVersion() : '',
      architecture: process.arch === 'arm64' || process.arch === 'arm' ? 'arm' : 'x86',
      model: '',
      mobile: false,
      bitness: process.arch === 'ia32' && !wow64 ? '32' : '64',
      wow64,
      formFactors: ['Desktop']
    }
  }
  return cached
}

/** A request Chrome would send the low-entropy client hints with: a secure origin. */
function secureUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return true
    if (u.protocol !== 'http:') return false
    return u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  } catch {
    return false
  }
}

/** Sessions given the identity (useChromeIdentity). A page anywhere else attaches without it. */
const identitySessions = new WeakSet<Session>()
/** Debugger sessions Forge closed on purpose (a page being closed) — not put back. */
const released = new WeakSet<WebContents>()
/** Extra commands a page's owner wants on every attach (Forge's tabs: focus emulation). */
const setups = new WeakMap<WebContents, Array<{ method: string; params: Record<string, unknown> }>>()
const watched = new WeakSet<WebContents>()

function send(wc: WebContents, method: string, params: Record<string, unknown>, sessionId?: string): void {
  // Not awaited: before the first navigation the protocol answers nothing, yet
  // the command still applies to that navigation. One session runs its commands in order.
  void wc.debugger.sendCommand(method, params, sessionId).catch(() => undefined)
}

/**
 * A UK Chrome's languages: navigator.languages, and the Accept-Language header
 * Chromium builds from them ("en-GB,en-US;q=0.9,en;q=0.8"). The session's
 * setting sets only the header (navigator.languages stays Electron's "en-GB"),
 * so the per-page override carries them too; that one moves the header up
 * beside User-Agent, so useChromeIdentity puts it back last, where Chrome sends it.
 */
const ACCEPT_LANGUAGES = 'en-GB,en-US,en'

function overrideParams(): Record<string, unknown> {
  const id = chromeIdentity()
  return { userAgent: id.userAgent, platform: id.platform, userAgentMetadata: id.metadata, acceptLanguage: ACCEPT_LANGUAGES }
}

/**
 * Frames in another process and workers, reported as they start. Not held at
 * their start: measured on Electron 43, a frame held that way never resumes
 * (runIfWaitingForDebugger is answered, the load hangs). The frame's target is
 * reported while its document is still being fetched, so the override is there
 * before its scripts run.
 */
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }

/**
 * A cross-site frame runs in a renderer of its own, which the page's override
 * does not reach (measured: Electron's own navigator.userAgent and brands
 * there), and so does a dedicated worker. Each gets the identity, and a frame's
 * own frames are watched the same way.
 */
function onTarget(wc: WebContents, method: string, params: { sessionId?: string; targetInfo?: { type?: string } }): void {
  if (method !== 'Target.attachedToTarget' || !params.sessionId) return
  const sid = params.sessionId
  const type = params.targetInfo?.type
  if (type === 'iframe') {
    send(wc, 'Emulation.setUserAgentOverride', overrideParams(), sid)
    send(wc, 'Target.setAutoAttach', AUTO_ATTACH, sid)
  } else if (type === 'worker') {
    send(wc, 'Network.setUserAgentOverride', overrideParams(), sid)
  }
}

/**
 * The page's DevTools session, attached if it is not, with the Chrome identity
 * (in a session given it) and any setup its owner asked for put on it at every
 * attach. Idempotent.
 */
export function attachDebugger(wc: WebContents): void {
  if (wc.isDestroyed() || wc.debugger.isAttached()) return
  wc.debugger.attach('1.3')
  released.delete(wc)
  const identity = identitySessions.has(wc.session)
  if (identity) {
    send(wc, 'Emulation.setUserAgentOverride', overrideParams())
    send(wc, 'Target.setAutoAttach', AUTO_ATTACH)
  }
  for (const s of setups.get(wc) ?? []) send(wc, s.method, s.params)
  if (watched.has(wc)) return
  watched.add(wc)
  if (identity) wc.debugger.on('message', (_e, method, params) => onTarget(wc, method, params))
  // Something else ended the session (not Forge closing the page): attach again,
  // so the page never falls back to Electron's brands. DevTools opening ends it
  // too; that page is left alone until its next use attaches again.
  wc.debugger.on('detach', () => {
    if (released.has(wc)) return
    setImmediate(() => {
      if (released.has(wc) || wc.isDestroyed() || wc.isDevToolsOpened()) return
      try {
        attachDebugger(wc)
      } catch {
        /* the page is going */
      }
    })
  })
}

/** A command to run on this page's DevTools session now and after every re-attach. */
export async function addDebuggerSetup(wc: WebContents, method: string, params: Record<string, unknown>): Promise<void> {
  const list = setups.get(wc) ?? []
  list.push({ method, params })
  setups.set(wc, list)
  if (!wc.debugger.isAttached()) return attachDebugger(wc)
  await wc.debugger.sendCommand(method, params).catch(() => undefined)
}

/** Detach on purpose (the page is being closed): the session is not put back. */
export function releaseDebugger(wc: WebContents): void {
  released.add(wc)
  if (wc.debugger.isAttached()) wc.debugger.detach()
}

/**
 * Put the identity on a session: its user agent, the client-hint
 * headers on every secure request, and the per-page override on every page made
 * in it from now on. Call once, before the session's first page.
 */
export function useChromeIdentity(ses: Session): void {
  if (identitySessions.has(ses)) return
  identitySessions.add(ses)
  const id = chromeIdentity()
  ses.setUserAgent(id.userAgent, ACCEPT_LANGUAGES)
  const hints: Record<string, string> = {
    'sec-ch-ua': secChUa(id.metadata.brands),
    'sec-ch-ua-mobile': id.metadata.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${id.metadata.platform}"`
  }
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    // Chrome's order: the three hints lead (before Upgrade-Insecure-Requests and
    // User-Agent) on a secure origin, and Accept-Language comes last everywhere.
    const secure = secureUrl(details.url)
    const requestHeaders: Record<string, string> = secure ? { ...hints } : {}
    let language: [string, string] | null = null
    for (const [k, v] of Object.entries(details.requestHeaders)) {
      const key = k.toLowerCase()
      if (key === 'accept-language') language = [k, v]
      else if (!secure || !(key in hints)) requestHeaders[k] = v
    }
    if (language) requestHeaders[language[0]] = language[1]
    callback({ requestHeaders })
  })
  app.on('web-contents-created', (_e, wc) => {
    if (wc.session !== ses) return
    try {
      attachDebugger(wc)
    } catch (err) {
      console.error('[browser] could not set the Chrome identity on a page:', err)
    }
  })
}
