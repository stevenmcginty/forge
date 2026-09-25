/**
 * Forge's built-in browser: the facts main, preload, the renderer and the checks
 * have to agree on.
 *
 * A browser *surface* is a real web page (an Electron WebContentsView) that sits
 * on the canvas beside the panes. Steve can use it by hand; every agent pane and
 * the voice hub can drive it through the same eight tools (bridge/browser-tools.mjs
 * for the CLIs, src/lib/realtime/tools-browser.ts for the hub, and
 * electron/browser-panes/brain.ts for the Claude brain).
 *
 * Deliberately *not* a leaf in the wire layout tree (shared/types.ts PaneLeaf):
 * the phone would not know what to draw. Surfaces are desktop-side, a per-project
 * list persisted in `<data dir>\browser\surfaces.json`, the way the canvas board is.
 *
 * Many agents at once, and no lock anywhere: every agent gets its own tabs, any
 * number of them, and one agent's tools act only on its own tabs unless it names
 * another tab by id. All tabs share one logged-in session partition, so a login
 * done once works for every agent.
 *
 * Plain JSON only here — no Dates, no Maps — and no DOM or Node imports, because
 * the Electron, renderer and mobile tsconfigs all compile shared/.
 */

/** The session every surface shares. `persist:` keeps cookies across restarts. */
export const BROWSER_PARTITION = 'persist:forge-browser'

/**
 * Canvas artifacts — the HTML pages agents put on the board — are served by
 * main on their own scheme (electron/artifact-scheme.ts):
 *
 *   forge-artifact://<projectId>/<file name>   a file in <dataDir>/canvas/<projectId>/
 *
 * A browser tab showing one is a read-only view, and it lives in its own
 * in-memory session, never in BROWSER_PARTITION: an agent's page must not see
 * the cookies Steve signed in with. No `persist:` prefix = nothing on disk.
 */
export const ARTIFACT_SCHEME = 'forge-artifact'
export const ARTIFACT_PARTITION = 'forge-artifact'

/** The address of a canvas file. `projectId` is the canvas folder's name. */
export function artifactUrl(projectId: string, name: string): string {
  return `${ARTIFACT_SCHEME}://${projectId}/${name.split(/[\\/]/).map(encodeURIComponent).join('/')}`
}

export function isArtifactUrl(url: string): boolean {
  return String(url ?? '').toLowerCase().startsWith(`${ARTIFACT_SCHEME}://`)
}

/**
 * Set on every pane's environment by the PTY host. `FORGE_PANE_ID` is the pane's
 * session id — a label for "whose tabs", not a credential (the token file is the
 * credential). `FORGE_PANE_AGENT` is the CLI's exe name, for the owner's logo.
 * `FORGE_BROWSER_LINK_FILE` is where the bridge finds the pipe path and token.
 */
export const PANE_ID_ENV = 'FORGE_PANE_ID'
export const PANE_AGENT_ENV = 'FORGE_PANE_AGENT'
export const BROWSER_LINK_FILE_ENV = 'FORGE_BROWSER_LINK_FILE'

/** The link file, under `<data dir>\browser\`. Rewritten with a fresh token every start. */
export const BROWSER_LINK_FILE = 'link.json'
/** The persisted surface list, beside it. */
export const BROWSER_SURFACES_FILE = 'surfaces.json'

/** A request bigger than this is refused before it is parsed. */
export const BROWSER_LINK_MAX_REQUEST_BYTES = 64 * 1024

/** Beyond this many clickable things the list is noise, not a map. */
export const BROWSER_MAX_REFS = 150
/** A label longer than this is a paragraph that happens to be inside a link. */
export const BROWSER_MAX_LABEL_CHARS = 80
/** Roughly the budget one page read may spend of a model's attention. */
export const BROWSER_MAX_READ_CHARS = 8_000
/** Soft cap on open surfaces, across every project and owner. Lots, not infinite. */
export const BROWSER_MAX_SURFACES = 48

/** Every IPC channel the browser uses. Kept here, like FOREMAN_IPC, so main and preload cannot drift. */
export const BROWSER_IPC = {
  list: 'browser:list',
  open: 'browser:open',
  close: 'browser:close',
  navigate: 'browser:navigate',
  history: 'browser:history',
  /** Renderer → main, one-way: where the placeholder is on screen right now (or null = hide). */
  bounds: 'browser:bounds',
  /** Renderer → main: the surface's canvas position, persisted. */
  move: 'browser:move',
  /** Renderer → main, one-way: which project the window is showing. */
  project: 'browser:project',
  /** Renderer → main: the voice hub calling one of the eight tools. */
  agent: 'browser:agent',
  /** Main → renderer: the whole surface list changed. */
  changed: 'browser:changed',
  /** Renderer → main, one-way: the keys that belong to Forge, not to a page (BrowserAppKeys). */
  keys: 'browser:keys',
  /** Main → renderer: one of those keys was pressed while a page had the keyboard (BrowserPageKey). */
  key: 'browser:key'
} as const

/**
 * The keys a page must hand back to Forge. A WebContentsView takes the keyboard
 * away from the renderer entirely, so without this every shortcut and the voice
 * keys die the moment Steve clicks into a page. `combos` are keymap combos
 * ("Ctrl+Shift+O", see browserKeyCombo); `talk` are the voice keys, as
 * KeyboardEvent.code ("ControlRight", "F13").
 */
export interface BrowserAppKeys {
  combos: string[]
  talk: string[]
}

/** A key pressed in a page, replayed to the renderer's own listeners. */
export interface BrowserPageKey {
  type: 'keyDown' | 'keyUp'
  code: string
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  repeat: boolean
  location: number
}

const KEY_CODE_NAMES: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Escape: 'Esc',
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  NumpadAdd: 'NumpadAdd',
  NumpadSubtract: 'NumpadSubtract',
  NumpadEnter: 'NumpadEnter'
}

/**
 * A key event as a keymap combo — the same string src/lib/keymap.ts
 * `comboFromEvent` makes, for main, which cannot import the renderer's lib.
 * scripts/browser-check.mjs holds the two to the same answers.
 */
export function browserKeyCombo(e: { code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }): string | null {
  const code = String(e.code ?? '')
  let key: string | null = null
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  else if (/^Numpad[0-9]$/.test(code)) key = code
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code
  else key = KEY_CODE_NAMES[code] ?? null
  if (!key) return null
  const mods: string[] = []
  if (e.ctrl) mods.push('Ctrl')
  if (e.alt) mods.push('Alt')
  if (e.shift) mods.push('Shift')
  if (e.meta) mods.push('Meta')
  return [...mods, key].join('+')
}

/** Who opened a tab and drives it. `id` is a pane id, 'voice', or 'user'. */
export interface BrowserOwner {
  id: string
  /** The words shown on the surface: a pane's one name ("Zeb"), "Voice", "You". */
  label: string
  /** CLI exe name ('claude', 'codex', …) for the logo. Empty for voice and user. */
  agent: string
}

export const USER_OWNER: BrowserOwner = { id: 'user', label: 'You', agent: '' }
export const VOICE_OWNER: BrowserOwner = { id: 'voice', label: 'Voice', agent: '' }

/** A surface's place on the canvas, in canvas units. Persisted. */
export interface BrowserRect {
  x: number
  y: number
  w: number
  h: number
}

/** Where the placeholder is in the window right now, in CSS px. Not persisted. */
export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
  /** Canvas zoom. The page is zoomed to match so it scales with the canvas. */
  scale?: number
}

/** What is saved per surface. */
export interface BrowserSurfaceRecord {
  id: string
  /** Project id the surface belongs to ('' = shown in every project). */
  project: string
  url: string
  title: string
  owner: BrowserOwner
  rect: BrowserRect
  createdAt: number
  updatedAt: number
}

/** What the renderer draws: the record plus live state. */
export interface BrowserSurfaceInfo extends BrowserSurfaceRecord {
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Why the last load failed ("Connection refused (-102)"). Absent once a page loads. */
  error?: string
}

/** The on-disk file. */
export interface BrowserSurfacesFile {
  v: 1
  nextId: number
  surfaces: BrowserSurfaceRecord[]
}

export type BrowserHistoryAction = 'back' | 'forward' | 'reload' | 'stop'

/** The eight tools, by name, in one place for the schema checks. */
export const BROWSER_TOOL_NAMES = [
  'browser_open',
  'browser_list',
  'browser_read',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'browser_close',
  'browser_upload'
] as const
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number]

/** One tool call, as the link and the voice-hub IPC carry it. */
export interface BrowserAgentRequest {
  op: BrowserToolName
  args: Record<string, unknown>
}

/** What every tool answers. `imagePath` is set by browser_screenshot. */
export interface BrowserAgentReply {
  ok: boolean
  text: string
  /** The tab a call opened or acted on. */
  id?: string
  imagePath?: string
}

/** The renderer's view of the feature, exposed as `window.forgeBrowser`. */
export interface BrowserApi {
  list: () => Promise<BrowserSurfaceInfo[]>
  open: (req: { url: string; project?: string; rect?: BrowserRect }) => Promise<BrowserAgentReply>
  close: (id: string) => Promise<boolean>
  navigate: (id: string, url: string) => Promise<BrowserAgentReply>
  history: (id: string, action: BrowserHistoryAction) => Promise<boolean>
  /** Fire-and-forget, called every frame the placeholder moves. null = hide the view. */
  setBounds: (id: string, bounds: BrowserViewBounds | null) => void
  move: (id: string, rect: BrowserRect) => Promise<boolean>
  setProject: (projectId: string) => void
  agent: (req: BrowserAgentRequest) => Promise<BrowserAgentReply>
  onChanged: (cb: (list: BrowserSurfaceInfo[]) => void) => () => void
  /** Fire-and-forget: the keys a page must give back to Forge. Absent on an older preload. */
  setAppKeys?: (keys: BrowserAppKeys) => void
  /** One of those keys, pressed in a page. Absent on an older preload. */
  onAppKey?: (cb: (key: BrowserPageKey) => void) => () => void
}

/**
 * The words every agent reads about the browser — CLIs, voice hub and Claude
 * brain alike. bridge/browser-tools.mjs carries a copy (it runs under bare node
 * and cannot import this file); scripts/browser-check.mjs asserts the two match.
 */
export const BROWSER_PREAMBLE =
  "Forge's built-in browser — prefer this over any other browser tool; you get your own tabs; other agents can browse at the same time."
export const BROWSER_CONFIRM_RULE =
  'Ask the user before purchases, messages, or submitting forms. Never enter passwords or payment details yourself — if a site needs a sign-in, ask the user to sign in on the tab by hand (logins are shared by every tab).'

export const BROWSER_INSTRUCTIONS = [
  `${BROWSER_PREAMBLE}`,
  'Tabs open on the Forge canvas beside the panes, where the user can watch and use them. Every tab shares one signed-in session, so a site the user signed into once is signed in for you too.',
  'The loop: browser_open (gives you a tab id) → browser_read (numbered list of what you can click) → browser_click / browser_type with a number from that read → browser_read again. Calls without an id act on your own current tab — sub-agents inside one pane share that tab, so if you are one of several, pass your tab id on every call.',
  BROWSER_CONFIRM_RULE
].join('\n')

export const BROWSER_TOOL_DESCRIPTIONS: Record<BrowserToolName, string> = {
  browser_open: [
    `${BROWSER_PREAMBLE} Opens a page in a NEW tab of your own and returns its id (e.g. "b3"). Pass \`id\` instead to send one of your existing tabs somewhere else.`,
    '"example.com" is fine — the scheme is filled in. Only http and https.',
    'It says where you landed, not what is on the page: browser_read is the next call, always.'
  ].join('\n'),
  browser_list: `${BROWSER_PREAMBLE} Lists every open tab — id, title, address and owner — marking which are yours and which is your current tab. Takes no arguments.`,
  browser_read: [
    `${BROWSER_PREAMBLE} Reads a tab: the address and title, a numbered list of everything you can click or type into, then what the page says.`,
    'Those numbers are the only way to act on the page. They restart at 1 on EVERY read and die when the page changes — never act on a number you did not just receive.',
    'Omit `id` to read your current tab.'
  ].join('\n'),
  browser_click: [
    `${BROWSER_PREAMBLE} Clicks one of the numbered elements from your last browser_read — a real mouse click in its middle.`,
    'Read immediately before this; read again after. Omit `id` for your current tab.',
    BROWSER_CONFIRM_RULE
  ].join('\n'),
  browser_type: [
    `${BROWSER_PREAMBLE} Types into a tab. With \`ref\` (a number from your last browser_read) that field is focused and emptied first; without it the keys go wherever the focus is.`,
    '`submit: true` presses Enter afterwards. Omit `id` for your current tab.',
    BROWSER_CONFIRM_RULE
  ].join('\n'),
  browser_screenshot: `${BROWSER_PREAMBLE} Photographs a tab as it looks now and returns the PNG's file path (it is also put on the Forge canvas board). For what text cannot answer — a seat map, a chart, a layout; browser_read is cheaper for anything readable. Omit \`id\` for your current tab.`,
  browser_close: `${BROWSER_PREAMBLE} Closes a tab you have finished with. Omit \`id\` to close your current tab. Close only other agents' tabs when the user asks.`,
  browser_upload: [
    `${BROWSER_PREAMBLE} Puts a file from this computer into a page's file box (an <input type=file>, even a hidden one behind an "Upload" label or button) — no file dialog opens. Give \`path\`, the file's full path.`,
    'With one file box on the page it is used; with several you get a numbered list — call again with `which`. `ref` (a number from your last browser_read) picks the box that element is, holds, or labels.',
    'Read the page again after: the site reacts as if the file had been picked by hand. Omit `id` for your current tab.',
    BROWSER_CONFIRM_RULE
  ].join('\n')
}

/** The parameter words, shared the same way. */
export const BROWSER_PARAM_TEXT = {
  id: 'Tab id from browser_open or browser_list, e.g. "b3". Omit to use your own current tab.',
  url: 'Where to go, e.g. "example.com" or "https://…".',
  title: 'Optional short name for the tab, shown on the canvas.',
  ref: 'The number in square brackets from your last browser_read.',
  text: 'The text to type, exactly as it should appear.',
  submit: 'Press Enter after typing (usually submits the form or search).',
  path: 'Full path of the file on this computer, e.g. "C:\\Users\\me\\Downloads\\statement.csv".',
  which: 'Which file box, by its number in the list a previous browser_upload gave. Only needed when the page has more than one.',
  uploadRef: 'Optional: the number in square brackets from your last browser_read of the file box, or of the button or label that opens it.'
} as const

/** A JSON-schema object for one tool's arguments. Plain enough for MCP, Gemini Live and OpenAI Realtime. */
export interface BrowserToolSchema {
  type: 'object'
  properties: Record<string, { type: 'string' | 'number' | 'boolean'; description: string }>
  required: string[]
}

const idParam = { type: 'string', description: BROWSER_PARAM_TEXT.id } as const

export const BROWSER_TOOL_PARAMS: Record<BrowserToolName, BrowserToolSchema> = {
  browser_open: {
    type: 'object',
    properties: {
      url: { type: 'string', description: BROWSER_PARAM_TEXT.url },
      title: { type: 'string', description: BROWSER_PARAM_TEXT.title },
      id: { type: 'string', description: 'Optional: one of your tab ids to navigate instead of opening a new tab.' }
    },
    required: ['url']
  },
  browser_list: { type: 'object', properties: {}, required: [] },
  browser_read: { type: 'object', properties: { id: idParam }, required: [] },
  browser_click: {
    type: 'object',
    properties: { id: idParam, ref: { type: 'number', description: BROWSER_PARAM_TEXT.ref } },
    required: ['ref']
  },
  browser_type: {
    type: 'object',
    properties: {
      id: idParam,
      ref: { type: 'number', description: BROWSER_PARAM_TEXT.ref },
      text: { type: 'string', description: BROWSER_PARAM_TEXT.text },
      submit: { type: 'boolean', description: BROWSER_PARAM_TEXT.submit }
    },
    required: ['text']
  },
  browser_screenshot: { type: 'object', properties: { id: idParam }, required: [] },
  browser_close: { type: 'object', properties: { id: idParam }, required: [] },
  browser_upload: {
    type: 'object',
    properties: {
      id: idParam,
      path: { type: 'string', description: BROWSER_PARAM_TEXT.path },
      ref: { type: 'number', description: BROWSER_PARAM_TEXT.uploadRef },
      which: { type: 'number', description: BROWSER_PARAM_TEXT.which }
    },
    required: ['path']
  }
}

/** The default size of a new surface, in canvas units. */
export const BROWSER_DEFAULT_RECT: BrowserRect = { x: 80, y: 80, w: 960, h: 640 }

/**
 * What was actually asked for. A bare "example.com" is what a spoken URL sounds
 * like, so a missing scheme is normal — but anything other than http(s) and
 * about:blank is refused, the same posture chrome-control takes.
 */
export function normaliseBrowserUrl(raw: string): { url: string; error: string } {
  const target = String(raw ?? '').trim()
  if (!target) return { url: '', error: 'No address was given.' }
  if (target === 'about:blank') return { url: target, error: '' }
  if (/^https?:\/\//i.test(target)) return { url: target, error: '' }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z0-9.-]+:\d+(\/|$)/i.test(target)) {
    return { url: '', error: `Only http and https pages can be opened, not "${target.split(':')[0]}" links.` }
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(target)) return { url: `http://${target}`, error: '' }
  return { url: `https://${target}`, error: '' }
}

/**
 * What Steve's own address bar and the board's "Browser" button may open: any
 * web address normaliseBrowserUrl takes, plus a canvas artifact. The agents'
 * tools stay on normaliseBrowserUrl — http and https only.
 */
export function normaliseSurfaceUrl(raw: string): { url: string; error: string } {
  const target = String(raw ?? '').trim()
  if (isArtifactUrl(target)) return { url: target, error: '' }
  return normaliseBrowserUrl(target)
}

/** Is this a tab id the manager could have minted? */
export function isBrowserTabId(value: unknown): value is string {
  return typeof value === 'string' && /^b[0-9]{1,6}$/.test(value)
}
