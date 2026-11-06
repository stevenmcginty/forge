/**
 * Phone hands: the one copy of every word an agent is told about Steve's phone.
 *
 * Forge agents on the PC operate Steve's Pixel through the Forge Mobile app,
 * which dials into the mobile link with `role: "hands"` (docs/PHONE-HANDS.md
 * carries the wire contract). This file is the tool list and the rules, as
 * plain data, so every brain reads the same sentences:
 *
 *  - pane agents: bridge/phone-tools.mjs builds forge-bridge's phone_* tools
 *    from PHONE_TOOL_SPECS (JSON Schema),
 *  - Forge Brain, Telegram, the CLI brains, the voice agent and Claude Live's
 *    Conductor: electron/phone-hands.ts builds the same tools with zod for
 *    electron/voice-agent/host.ts forgeToolDefs(),
 *  - the prose: shared/brain-persona.ts PHONE_HANDS_RULES and
 *    bridge/gemini-bridge.mjs's server instructions.
 *
 * Plain JavaScript, not TypeScript, because the bridge runs under bare `node`
 * and cannot import a .ts file; ./phone-hands-spec.d.mts types it for the rest.
 * Tool name = `phone_<op>`, one per contract op.
 */

/** The contract's ops, in its order. */
export const PHONE_OPS = [
  'status',
  'look',
  'read',
  'tap',
  'type',
  'scroll',
  'key',
  'open_app',
  'open_link',
  'apps',
  'notifications',
  'reply',
  'find_contact'
]

/** How long the desk waits for one answer (contract: 15 s). */
export const PHONE_TIMEOUT_MS = 15_000

export const PHONE_NOT_CONNECTED =
  "The phone is not connected. Open the Forge app on the phone and turn on 'Let Forge use this phone'."
export const PHONE_TIMED_OUT = 'The phone did not answer in 15 s.'

const SCOPE =
  "Acts on Steve's Android phone (his Pixel) through the Forge app on it: any app on the phone, and Chrome or the phone's web browser. Not Forge, not his PC."

/** The contract's agent rule, word for word in substance. */
export const PHONE_CONFIRM_RULE =
  'Before the final tap that books a ride, pays, buys, or sends a message whose words Steve did not give word for word, tell Steve what will happen (e.g. "UberX, GBP 14.20, 4 min away - book it?") and wait for yes. If Steve dictated the exact message, send it without asking. If Steve said "just book it", skip the price check.'

const LIMITS =
  'If the phone is locked the answer says so: ask Steve to unlock it. Banking, password and authenticator apps, Google sign-in sheets and the Play Store are blocked for Forge: say so, never work round it.'

/** The general recipe, first; Uber and WhatsApp are only examples. */
export const PHONE_RECIPE_GENERAL =
  "Any app: phone_open_app (or phone_apps to find it) → phone_read → phone_tap / phone_type / phone_scroll → phone_read again after each step. Web: phone_open_link with the URL (opens the phone's default browser), or open Chrome and type into its address bar. If phone_read shows nothing useful (games, canvas, video), use phone_look and phone_tap with x,y fractions."

export const PHONE_EXAMPLE_UBER =
  'Example, Uber (com.ubercab): phone_open_link "uber://?action=setPickup&pickup=my_location&dropoff[formatted_address]=<url-encoded address>" → phone_read; if the dropoff did not fill, phone_open_app "Uber", tap "Where to?", phone_type the place, tap the right suggestion. Read the ride options, tell Steve product + price + ETA, wait for yes, then tap choose/confirm and "Confirm pickup".'

export const PHONE_EXAMPLE_WHATSAPP =
  'Example, WhatsApp reply (com.whatsapp): phone_notifications app "WhatsApp" → if the person has a notification marked (can reply), phone_reply n text. Otherwise phone_find_contact name → phone_open_link "https://wa.me/<digits>?text=<url-encoded text>" → phone_read → tap the Send button.'

/** One line for forge-bridge's server instructions (pane agents). */
export const PHONE_INSTRUCTION_LINE = `Steve's phone (any app on his Pixel, and its web browser): the phone_* tools. ${PHONE_RECIPE_GENERAL} ${PHONE_CONFIRM_RULE}`

const n = (what) => ({ type: 'integer', description: `The number in square brackets from your last phone_read${what}.` })

/**
 * The thirteen tools. `params` is a small JSON-Schema subset (type, description,
 * enum) that both builders understand; `required` lists the must-have keys.
 */
export const PHONE_TOOL_SPECS = [
  {
    name: 'phone_status',
    op: 'status',
    description: [
      `Says whether Steve's phone can be used right now: the switch "Let Forge use this phone", the accessibility, notification and contacts permissions, screen on or off, locked or not, and the app in front. Read-only. ${SCOPE}`,
      'Call it first when another phone_* tool fails and the reason is not clear.'
    ].join('\n'),
    params: {},
    required: []
  },
  {
    name: 'phone_look',
    op: 'look',
    description: [
      `Takes a picture of the phone's screen now and returns it, with the app in front. Read-only. ${SCOPE}`,
      'Use it when phone_read shows nothing useful (games, canvas, video, maps), then phone_tap with x,y as fractions (0..1) of this picture.',
      LIMITS
    ].join('\n'),
    params: {},
    required: []
  },
  {
    name: 'phone_read',
    op: 'read',
    description: [
      `Reads the phone's screen as a numbered list: first line "App: <label> (<package>)", then one line per control: [n] role "text" (clickable, editable, scrollable, checked, selected). Read-only. ${SCOPE}`,
      'The numbers are what phone_tap, phone_type and phone_scroll take. They last only until the next phone_read: read again after every step, and never act on a number you did not just receive.',
      PHONE_RECIPE_GENERAL,
      LIMITS
    ].join('\n'),
    params: {},
    required: []
  },
  {
    name: 'phone_tap',
    op: 'tap',
    description: [
      `Taps on the phone: n = a number from your last phone_read (its nearest clickable parent is tapped), or x and y as fractions (0..1) of the screen from your last phone_look. long: true does a long press. Read again after. ${SCOPE}`,
      PHONE_CONFIRM_RULE,
      LIMITS
    ].join('\n'),
    params: {
      n: n(''),
      x: { type: 'number', description: 'Instead of n: left-to-right, 0..1 of the screen width.' },
      y: { type: 'number', description: 'Instead of n: top-to-bottom, 0..1 of the screen height.' },
      long: { type: 'boolean', description: 'Optional: a long press instead of a tap.' }
    },
    required: []
  },
  {
    name: 'phone_type',
    op: 'type',
    description: [
      `Types text on the phone: replaces the text of box n from your last phone_read, or of the box that has focus. enter: true then presses the keyboard's enter / send / search key. Never type passwords or card details: Steve types those himself. ${SCOPE}`,
      PHONE_CONFIRM_RULE,
      LIMITS
    ].join('\n'),
    params: {
      text: { type: 'string', description: 'The text, exactly as it should appear.' },
      n: n(' (an editable box). Omit for the box that has focus'),
      enter: { type: 'boolean', description: 'Optional: press the keyboard enter / send / search key after typing.' }
    },
    required: ['text']
  },
  {
    name: 'phone_scroll',
    op: 'scroll',
    description: `Scrolls on the phone: box n from your last phone_read, else the biggest scrollable list on screen, else a swipe. Read again after. ${SCOPE}`,
    params: {
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Which way the content moves into view: "down" shows what is further down.' },
      n: n(' (a scrollable box). Omit for the biggest list on screen')
    },
    required: ['direction']
  },
  {
    name: 'phone_key',
    op: 'key',
    description: `Presses a phone button: back, home, recents (the app switcher), notifications (pulls the shade down) or quick_settings. ${SCOPE}`,
    params: {
      key: { type: 'string', enum: ['back', 'home', 'recents', 'notifications', 'quick_settings'], description: 'The button.' }
    },
    required: ['key']
  },
  {
    name: 'phone_open_app',
    op: 'open_app',
    description: [
      `Opens an app on the phone by its name (best match, any case) or its package. phone_apps lists what is installed. ${SCOPE}`,
      PHONE_RECIPE_GENERAL
    ].join('\n'),
    params: {
      name: { type: 'string', description: 'The app name as on the phone, e.g. "Uber", "Chrome", "Maps".' },
      package: { type: 'string', description: 'Instead of name: the package, e.g. "com.ubercab".' }
    },
    required: []
  },
  {
    name: 'phone_open_link',
    op: 'open_link',
    description: [
      `Opens a link on the phone, as tapping it would: a web address opens in the phone's default browser, an app link opens its app (uber://..., https://wa.me/...). Works with the screen locked. ${SCOPE}`,
      PHONE_EXAMPLE_UBER,
      PHONE_EXAMPLE_WHATSAPP
    ].join('\n'),
    params: {
      url: { type: 'string', description: 'The full link, url-encoded where needed.' }
    },
    required: ['url']
  },
  {
    name: 'phone_apps',
    op: 'apps',
    description: `Lists the apps Steve can open on the phone, one per line: "<label> (<package>)". Read-only. ${SCOPE}`,
    params: {
      query: { type: 'string', description: 'Optional: only apps whose name or package contains this.' }
    },
    required: []
  },
  {
    name: 'phone_notifications',
    op: 'notifications',
    description: [
      `Lists the phone's notifications: [n] <app> - <title>: <text> (can reply). The numbers are what phone_reply takes and last until the next phone_notifications. Read-only; works with the screen locked. Notifications from blocked apps never appear. ${SCOPE}`,
      PHONE_EXAMPLE_WHATSAPP
    ].join('\n'),
    params: {
      app: { type: 'string', description: 'Optional: only this app\'s notifications, e.g. "WhatsApp".' }
    },
    required: []
  },
  {
    name: 'phone_reply',
    op: 'reply',
    description: [
      `Replies to notification n from your last phone_notifications through its own reply box (WhatsApp, Messages and the like), without opening the app. Fails if that notification has no reply action. ${SCOPE}`,
      PHONE_CONFIRM_RULE
    ].join('\n'),
    params: {
      n: { type: 'integer', description: 'The number in square brackets from your last phone_notifications.' },
      text: { type: 'string', description: 'The reply, exactly as it should be sent.' }
    },
    required: ['n', 'text']
  },
  {
    name: 'phone_find_contact',
    op: 'find_contact',
    description: `Finds contacts on the phone by name, best match first, with their numbers; each number is also given in international digits for a wa.me link (07... becomes 447...). Read-only. ${SCOPE}`,
    params: {
      name: { type: 'string', description: 'The name, or part of it.' }
    },
    required: ['name']
  }
]
