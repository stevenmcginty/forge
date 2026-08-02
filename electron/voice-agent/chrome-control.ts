import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext, type ElementHandle, type Page } from 'playwright-core'

/**
 * The voice agent's hands on the web — tier four of the JARVIS build-out.
 *
 * Tier two gave it the desktop and tier three the file system, and both of
 * those stop at the edge of the browser. What Steve actually asks for — "book a
 * table", "where is my order" — happens on sites he is *already signed in to*,
 * which is the whole difficulty: a scraper that fetches a URL sees a login
 * page, and a screenshot-and-SendKeys loop over his own Chrome window is
 * guesswork about pixels. So this drives a real browser, through the same
 * DevTools protocol a developer uses, and reads it as structure rather than as
 * an image.
 *
 * ## Why a dedicated profile, and not his
 *
 * Chrome will not hand its remote-debugging port to a profile that is already
 * running, so attaching to the browser he has open is not on offer — the whole
 * thing would depend on him having quit Chrome first, and it would put an agent
 * inside the session that holds his bank. Instead this launches a *persistent*
 * context of its own, in a folder Forge owns: Jarvis's own Chrome window, with
 * its own cookies and its own sign-ins. Persistent is the load-bearing word.
 * The profile survives Forge closing, so Steve signs in to a site once, in that
 * window, and every later session is still signed in. The cost is honest and
 * worth saying out loud: the first time a site wants an account, he has to log
 * in there himself, and the persona tells the model to say so.
 *
 * `playwright-core` (not `playwright`) downloads no browsers; `channel:
 * 'chrome'` drives the Google Chrome already installed on the machine. Nothing
 * is bundled and nothing is fetched at runtime.
 *
 * ## Deliberately Electron-free
 *
 * Same rule as ../desktop-control.ts and ./file-tools.ts, which sit beside it:
 * plain Node only, so voice-agent/host.ts stays loadable head-less. The profile
 * directory is a parameter on every entry point rather than a lookup, because
 * only the Electron half knows the real data dir.
 *
 * ## Safety shape
 *
 * Every export answers in one human sentence, success or failure, and expected
 * failures — no Chrome installed, a dead ref, a page that will not load — come
 * back as prose rather than as an exception, exactly like the two modules
 * beside it. Everything here is bounded by its own timeout, so a page that
 * never finishes loading cannot hang a voice turn.
 *
 * Nothing in this file asks permission, and nothing in it can. It is a browser:
 * clicking is clicking, and the click that buys the tickets looks the same from
 * here as the click that opens the menu. The rule that the last click before
 * money, a message or a booking needs Steve's spoken yes lives in the persona
 * and in the tool descriptions the model reads — the layers that know what the
 * click means. This layer's job is that nothing it does is beyond what a person
 * sitting at that window could do themselves.
 */

/* ------------------------------------------------------------------ limits */

/** A page that has not loaded in twenty seconds is a page to report, not wait on. */
const NAV_TIMEOUT_MS = 20_000

/** Clicking and typing are instant when they work at all. */
const ACTION_TIMEOUT_MS = 10_000

/** How long to let a click's navigation settle before describing where we are. */
const SETTLE_MS = 5_000

/** Keystroke spacing. Fast, but not the instant paste that trips form scripts. */
const TYPE_DELAY_MS = 25

/** Roughly the budget a page snapshot may spend of the model's attention. */
const MAX_REPLY_CHARS = 6_000

/** Beyond this many clickable things the list is noise, not a map. */
const MAX_REFS = 120

/** A label longer than this is a paragraph that happens to be inside a link. */
const MAX_LABEL_CHARS = 80

/* ------------------------------------------------------- the page-side world
 *
 * The functions handed to `page.evaluate` below are serialised and run inside
 * Chrome, not in this process — but the type checker still reads them, and the
 * Electron tsconfig has no DOM library in it, because main-process code has no
 * business with one. These ambient declarations are the smallest stand-in that
 * lets the checker read those functions: only the members they actually touch.
 * Nothing declared here exists at runtime on this side.
 */

interface PageElement {
  readonly tagName: string
  readonly isConnected: boolean
  readonly innerText: string
  readonly value?: string
  getAttribute(name: string): string | null
  getBoundingClientRect(): { width: number; height: number }
}

interface PageElementList {
  readonly length: number
  [index: number]: PageElement
}

declare const document: {
  querySelectorAll(selector: string): PageElementList
}

/**
 * The refs themselves live on the page, keyed by position, and die with the
 * document — which is exactly the lifetime we want to promise the model: a
 * number is good until the next read or the next navigation, and no longer.
 */
declare const window: { __jarvisRefs?: PageElement[] }

declare function getComputedStyle(el: PageElement): { visibility: string; opacity: string }

/* ------------------------------------------------------------------- paths */

/**
 * Where Jarvis's own Chrome profile lives when nobody tells us.
 *
 * Mirrors `defaultAssetsDir()` in ./file-tools.ts, and for the same reason: the
 * real answer is `<data dir>\chrome-jarvis`, the data dir is Electron's to
 * know, and this is the guess for the head-less case. It is only wrong under a
 * non-default --data-dir, where the host's injected value is right instead.
 */
export function defaultChromeProfileDir(): string {
  const appData = process.env['APPDATA']
  if (appData) return join(appData, 'Forge', 'chrome-jarvis')
  return join(homedir(), '.forge', 'chrome-jarvis')
}

/* ------------------------------------------------------------- the browser */

/** The live browser, or null when there is not one. */
let context: BrowserContext | null = null

/** The tab we are working in — the last one used, or opened, or adopted. */
let currentPage: Page | null = null

/** The profile the live context was launched from, so a change can relaunch. */
let launchedFrom = ''

function errText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // Playwright's launch failures are a page of ASCII art and install advice.
  // The first line is the part that says what went wrong.
  return message.split('\n')[0]?.trim().slice(0, 300) || 'no reason given'
}

/**
 * Close the browser and forget it. Never throws: a context that has already
 * gone away is the state this wanted anyway.
 */
export async function closeBrowser(): Promise<void> {
  const live = context
  context = null
  currentPage = null
  launchedFrom = ''
  if (!live) return
  try {
    await live.close()
  } catch {
    // Already dead, or refusing to die tidily. Either way it is not ours now.
  }
}

/** The live context, launching one if there is not one. */
async function ensureContext(profileDir: string): Promise<{ ctx: BrowserContext | null; error: string }> {
  const dir = (profileDir ?? '').trim() || defaultChromeProfileDir()

  // Two profiles at once is not a thing a voice agent needs, and Chrome will
  // not share a profile directory between two running browsers anyway.
  if (context && dir !== launchedFrom) await closeBrowser()
  if (context) return { ctx: context, error: '' }

  try {
    const ctx = await chromium.launchPersistentContext(dir, {
      channel: 'chrome',
      headless: false,
      // A real window, sized by the window manager rather than by us: this is a
      // browser Steve looks at and sometimes types into, not a test harness.
      viewport: null
    })
    ctx.setDefaultTimeout(ACTION_TIMEOUT_MS)
    ctx.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)
    // He closed the window, or Chrome fell over. Drop the reference so the next
    // call launches a fresh one instead of talking to a corpse.
    ctx.on('close', () => {
      if (context === ctx) {
        context = null
        currentPage = null
        launchedFrom = ''
      }
    })
    // A link with target=_blank, or a site that opens its checkout in a new
    // tab. The newest tab is what a person would be looking at, so it becomes
    // the one we read and click in.
    ctx.on('page', (page) => {
      currentPage = page
    })
    context = ctx
    launchedFrom = dir
    return { ctx, error: '' }
  } catch (err) {
    return {
      ctx: null,
      error: `I could not start Chrome: ${errText(err)}. It has to be installed on this machine for me to browse.`
    }
  }
}

/**
 * The tab to act in — mirrors ../desktop-control.ts's `findWindow`: a hit and a
 * ready-made sentence, so every caller is two lines of the same shape.
 *
 * Two passes, because "the browser is gone" only ever announces itself as a
 * thrown call: the first failure closes the dead context and the second pass
 * launches a new one.
 */
async function ensurePage(profileDir: string): Promise<{ page: Page | null; error: string }> {
  let failure = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const { ctx, error } = await ensureContext(profileDir)
    if (!ctx) return { page: null, error }
    try {
      let page = currentPage && !currentPage.isClosed() ? currentPage : null
      if (!page) {
        // The persistent context always opens with one tab; this is also where
        // a tab Steve closed himself gets replaced.
        const open = ctx.pages().filter((p) => !p.isClosed())
        page = open.length ? (open[open.length - 1] as Page) : await ctx.newPage()
      }
      page.setDefaultTimeout(ACTION_TIMEOUT_MS)
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)
      currentPage = page
      return { page, error: '' }
    } catch (err) {
      failure = errText(err)
      await closeBrowser()
    }
  }
  return { page: null, error: `Chrome closed under me and would not come back: ${failure}` }
}

/* ---------------------------------------------------------------- speaking */

/** The bit of a URL a person would say. */
function hostOf(url: string): string {
  if (!url || url.startsWith('about:')) return 'a blank tab'
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** The title, or '' — a page mid-navigation is allowed to have no answer yet. */
async function pageTitle(page: Page): Promise<string> {
  try {
    return (await page.title()).trim()
  } catch {
    return ''
  }
}

/** "example.com — Example Domain", the phrase every result ends with. */
async function whereWeAre(page: Page): Promise<string> {
  const where = hostOf(page.url())
  const title = await pageTitle(page)
  return title ? `${where} — "${title}"` : where
}

/** Let a click's navigation land before describing what it did. */
async function settle(page: Page): Promise<void> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: SETTLE_MS })
  } catch {
    // Still loading, or never was. Either way, describe what is there now
    // rather than waiting out the whole navigation timeout.
  }
}

/**
 * What was actually asked for. A bare "example.com" is what a spoken URL sounds
 * like, so a missing scheme is normal rather than an error — but anything that
 * is not http(s) is refused here, the same posture openDesktopTarget takes.
 */
function normaliseUrl(raw: string): { url: string; error: string } {
  const target = (raw ?? '').trim()
  if (!target) return { url: '', error: '' }
  if (/^https?:\/\//i.test(target)) return { url: target, error: '' }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return { url: '', error: `I can only open http and https pages, not "${target.split(':')[0]}" links.` }
  }
  return { url: `https://${target}`, error: '' }
}

/* -------------------------------------------------------------- open a page */

/**
 * Bring up the browser, and go somewhere if asked.
 *
 * With no URL this is "is there a browser, and what is on it" — the cheap way
 * to find out where a previous turn left off.
 */
export async function browserOpen(profileDir: string, url?: string): Promise<string> {
  const { url: target, error: urlError } = normaliseUrl(url ?? '')
  if (urlError) return urlError

  const { page, error } = await ensurePage(profileDir)
  if (!page) return error

  if (!target) return `Chrome is open on ${await whereWeAre(page)}.`

  try {
    // domcontentloaded rather than load: an ad-heavy page can spend half a
    // minute on trailing requests that change nothing anyone can read.
    await page.goto(target, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
  } catch (err) {
    return `I could not open ${hostOf(target)}: ${errText(err)}`
  }
  await settle(page)
  return `Opened ${await whereWeAre(page)}. Read the page to see what is on it.`
}

/* ------------------------------------------------------------------ the eyes */

/**
 * Read the page: where we are, what can be clicked, and what it says.
 *
 * The numbered list is the whole interface between the model and the browser.
 * Every clickable thing gets a number, the elements behind those numbers are
 * parked on the page as `window.__jarvisRefs`, and browser_click and
 * browser_type take nothing else. That is deliberate: a CSS selector invented
 * by a model is a guess, whereas a number it was just handed is a thing it
 * actually saw. The refs die with the document, and they restart at 1 on every
 * read — the tool descriptions say so in those words.
 */
export async function browserRead(profileDir: string): Promise<string> {
  const { page, error } = await ensurePage(profileDir)
  if (!page) return error

  let snapshot: { items: string[]; dropped: number; text: string }
  try {
    snapshot = await page.evaluate((limits: { refs: number; label: number }) => {
      const SELECTOR = [
        'a',
        'button',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        '[role="link"]',
        '[role="tab"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="combobox"]',
        '[role="menuitem"]',
        '[onclick]'
      ].join(', ')

      const clean = (value: string): string => value.replace(/\s+/g, ' ').trim()

      // Zero-sized covers display:none and everything collapsed; the style
      // check catches what is laid out but deliberately invisible.
      const visible = (el: PageElement): boolean => {
        const box = el.getBoundingClientRect()
        if (box.width < 1 || box.height < 1) return false
        const style = getComputedStyle(el)
        return style.visibility !== 'hidden' && style.opacity !== '0'
      }

      const kindOf = (el: PageElement): string => {
        const tag = el.tagName.toLowerCase()
        const role = clean(el.getAttribute('role') ?? '')
        if (tag === 'a') return 'link'
        if (tag === 'input') return `input ${clean(el.getAttribute('type') ?? 'text')}`
        if (tag === 'button' || tag === 'select' || tag === 'textarea') return tag
        return role || tag
      }

      // In the order a person would look for the name of the thing: what it
      // says, what it is labelled, what it is asking for, what is in it.
      const labelOf = (el: PageElement): string => {
        const candidates = [
          el.innerText,
          el.getAttribute('aria-label'),
          el.getAttribute('placeholder'),
          el.value,
          el.getAttribute('title'),
          el.getAttribute('alt'),
          el.getAttribute('name')
        ]
        for (const candidate of candidates) {
          const text = clean(String(candidate ?? ''))
          if (text) return text.slice(0, limits.label)
        }
        return ''
      }

      const refs: PageElement[] = []
      const items: string[] = []
      const all = Array.from(document.querySelectorAll(SELECTOR))
      let dropped = 0
      for (const el of all) {
        if (!visible(el)) continue
        if (refs.length >= limits.refs) {
          dropped++
          continue
        }
        refs.push(el)
        items.push(`[${refs.length}] ${kindOf(el)} "${labelOf(el)}"`)
      }
      window.__jarvisRefs = refs

      // Headings and prose, in document order, deduplicated: a heading nested
      // inside a list item otherwise arrives twice and reads as a stutter.
      const seen = new Set<string>()
      const blocks: string[] = []
      for (const el of Array.from(document.querySelectorAll('h1, h2, h3, h4, p, li'))) {
        if (!visible(el)) continue
        const text = clean(el.innerText ?? '')
        if (!text || seen.has(text)) continue
        seen.add(text)
        blocks.push(text)
      }

      return { items, dropped, text: blocks.join('\n') }
    }, { refs: MAX_REFS, label: MAX_LABEL_CHARS })
  } catch (err) {
    return `I could not read that page: ${errText(err)}`
  }

  const lines = [
    `${page.url()} — "${await pageTitle(page)}"`,
    '',
    'Things you can click or type into. These numbers are good only until you read or navigate again, and they start at 1 every time:',
    snapshot.items.length ? snapshot.items.join('\n') : 'Nothing on this page is clickable.'
  ]
  if (snapshot.dropped) lines.push(`…and ${snapshot.dropped} more, past the limit of ${MAX_REFS}.`)

  let out = lines.join('\n')
  if (out.length > MAX_REPLY_CHARS) return `${out.slice(0, MAX_REPLY_CHARS)}\n…truncated`

  // Whatever budget the element list left over goes to the page's own words.
  const heading = 'What the page says:'
  const room = MAX_REPLY_CHARS - out.length - heading.length - 16
  const body = snapshot.text.length > room ? `${snapshot.text.slice(0, Math.max(0, room))}\n…truncated` : snapshot.text
  if (body.trim()) out = `${out}\n\n${heading}\n${body}`
  return out
}

/* ----------------------------------------------------------------- the hands */

/** What the model should hear when a number no longer points at anything. */
function staleRef(ref: number): string {
  return `There is no element ${ref} on this page any more — the page has changed or moved on. Read it again to get fresh numbers.`
}

/** The ref's label, or null when the ref has gone. Also the existence check. */
async function refLabel(page: Page, ref: number): Promise<string | null> {
  return await page.evaluate((index: number) => {
    const refs = window.__jarvisRefs
    const el = refs ? refs[index] : undefined
    if (!el || !el.isConnected) return null
    const text = String(el.innerText ?? el.getAttribute('aria-label') ?? el.value ?? el.tagName)
    return text.replace(/\s+/g, ' ').trim().slice(0, 60)
  }, ref - 1)
}

/** A real handle on the ref's element, or null. Dispose it when finished. */
async function elementForRef(page: Page, ref: number): Promise<ElementHandle | null> {
  const handle = await page.evaluateHandle((index: number) => {
    const refs = window.__jarvisRefs
    const el = refs ? refs[index] : undefined
    return el && el.isConnected ? el : null
  }, ref - 1)
  const element = handle.asElement()
  if (!element) {
    await handle.dispose()
    return null
  }
  return element as ElementHandle
}

/** 1, 2, 3 — and nothing else. */
function badRef(ref: number): boolean {
  return !Number.isFinite(ref) || Math.round(ref) < 1
}

/**
 * Click one of the numbered elements.
 *
 * Playwright's own `click` rather than a synthetic DOM event, on purpose: it
 * scrolls the element into view, waits for it to be stable and hit-able, and
 * then presses the real mouse at its centre. A site whose button only works
 * through a listener on a parent — which is most of them — cannot tell the
 * difference between this and Steve's hand.
 */
export async function browserClick(profileDir: string, ref: number): Promise<string> {
  if (badRef(ref)) return `${ref} is not one of the numbers from reading the page.`
  const index = Math.round(ref)

  const { page, error } = await ensurePage(profileDir)
  if (!page) return error

  let label: string | null
  let element: ElementHandle | null
  try {
    label = await refLabel(page, index)
    if (label === null) return staleRef(index)
    element = await elementForRef(page, index)
    if (!element) return staleRef(index)
  } catch (err) {
    return `I could not find element ${index} on the page: ${errText(err)}`
  }

  try {
    await element.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
    await element.click({ timeout: ACTION_TIMEOUT_MS })
  } catch (err) {
    return `I could not click ${label ? `"${label}"` : `element ${index}`}: ${errText(err)}`
  } finally {
    await element.dispose()
  }

  // A click that opened a tab made that tab current; describe where we ended up
  // rather than where the click started.
  const landed = currentPage && !currentPage.isClosed() ? currentPage : page
  await settle(landed)
  return `Clicked "${label}". Now on ${await whereWeAre(landed)}. Read the page again to see what changed.`
}

/**
 * Type into the page.
 *
 * With a ref the field is cleared first, because typing into a box that already
 * holds a date or a search term appends to it, and appending is never what was
 * meant. Without one the keys go wherever the focus already is, which is what
 * you want for a dialog that grabbed it or a field that was just tabbed to.
 */
export async function browserType(
  profileDir: string,
  text: string,
  ref?: number,
  pressEnter?: boolean
): Promise<string> {
  const body = String(text ?? '')
  const enter = Boolean(pressEnter)
  if (!body && !enter) return 'There was nothing to type.'

  const { page, error } = await ensurePage(profileDir)
  if (!page) return error

  let label: string | null = null
  if (ref !== undefined) {
    if (badRef(ref)) return `${ref} is not one of the numbers from reading the page.`
    const index = Math.round(ref)
    let element: ElementHandle | null
    try {
      label = await refLabel(page, index)
      if (label === null) return staleRef(index)
      element = await elementForRef(page, index)
      if (!element) return staleRef(index)
    } catch (err) {
      return `I could not find element ${index} on the page: ${errText(err)}`
    }

    try {
      await element.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
      try {
        // fill focuses and empties an editable field in one go. It refuses on
        // anything that is not one — a div that merely takes keystrokes — and
        // that refusal is fine: the click below still puts the focus there.
        await element.fill('', { timeout: ACTION_TIMEOUT_MS })
      } catch {
        await element.click({ timeout: ACTION_TIMEOUT_MS })
      }
      await element.type(body, { delay: TYPE_DELAY_MS, timeout: ACTION_TIMEOUT_MS })
    } catch (err) {
      return `I could not type into ${label ? `"${label}"` : `element ${index}`}: ${errText(err)}`
    } finally {
      await element.dispose()
    }
  } else if (body) {
    try {
      await page.keyboard.type(body, { delay: TYPE_DELAY_MS })
    } catch (err) {
      return `I could not type into the page: ${errText(err)}`
    }
  }

  if (!enter) {
    return label ? `Typed that into "${label}".` : 'Typed that into whatever had the focus.'
  }

  try {
    await page.keyboard.press('Enter')
  } catch (err) {
    return `I typed it, but pressing Enter failed: ${errText(err)}`
  }
  const landed = currentPage && !currentPage.isClosed() ? currentPage : page
  await settle(landed)
  const where = label ? `Typed that into "${label}" and pressed Enter.` : 'Typed that and pressed Enter.'
  return `${where} Now on ${await whereWeAre(landed)}. Read the page again to see what changed.`
}

/* ------------------------------------------------------------- a photograph */

/** A screenshot, already encoded. Shaped like the host's own `VoiceAgentShot`. */
export interface ChromeShot {
  /** Base64 PNG, no data-url prefix — the MCP image block wants raw base64. */
  base64: string
  mime: string
}

/**
 * The browser window as it looks, for the questions text cannot answer: a seat
 * map, a date picker, a page that says it worked while showing an error.
 */
export async function browserScreenshot(profileDir: string): Promise<ChromeShot | null> {
  const { page, error } = await ensurePage(profileDir)
  if (!page) {
    console.error(`[chrome-control] no page to photograph: ${error}`)
    return null
  }
  try {
    const png = await page.screenshot({ type: 'png', timeout: ACTION_TIMEOUT_MS })
    return { base64: png.toString('base64'), mime: 'image/png' }
  } catch (err) {
    console.error(`[chrome-control] screenshot failed: ${errText(err)}`)
    return null
  }
}
