/**
 * Steve's Dates list, as MCP tools for pane agents: dates_list, dates_add,
 * dates_update (docs/DATES.md, "Agent tools").
 *
 * Main owns the list, so every call is relayed down the same authenticated
 * pipe the browser tools use (./browser-tools.mjs `browserAsk`) and answered in
 * main by electron/browser-panes/ipc.ts with shared/dates-tools.ts
 * `runDatesTool` — the one function Forge's own agents call too, so the words
 * are the same in both tool sets.
 *
 * Spread into forge-bridge's tool list like the app tools. Plain Node, no MCP
 * SDK import.
 *
 * ⚠ The descriptions and schemas are DUPLICATED from shared/brain-tools.ts
 * `DATES_TOOL_SPECS` (canonical — this file cannot import TypeScript).
 * scripts/dates-tools-check.mjs asserts they agree word for word.
 */

import { browserAsk } from './browser-tools.mjs'

export const DATES_LIST_DESCRIPTION = [
  'Read Steve’s Dates list: his renewals and deadlines — contracts and leases, insurance, web domains, subscriptions, licences, payment plans, holidays, forms that are due.',
  'Call it whenever he asks what is coming up, what is due or when something renews, and before dates_add, so a date is not added twice.',
  'Open items, soonest first, one line each: id | date | when | kind | group | title | amount | note | action. include_done adds the done ones; kind and group narrow the list.'
].join(' ')

export const DATES_ADD_DESCRIPTION = [
  'Add one line to Steve’s Dates list, so Forge alerts him before it.',
  'Use it when he asks, and when you find a renewal or deadline in something he had you read — an email, a letter, a contract, a web page: an insurance renewal, a contract or lease end, a domain expiry, a last payment, a form due. Check dates_list first, then tell him what you added.',
  'date is YYYY-MM-DD; set estimated true when the day is not confirmed. Put the facts (amount, notice rules, who to call) in note and what to do in action. The answer is the new line.'
].join(' ')

export const DATES_UPDATE_DESCRIPTION = [
  'Change one line of Steve’s Dates list, by the id dates_list shows. Give only the fields that change.',
  'done true marks it done (a repeating line moves on to its next date instead). snooze_until YYYY-MM-DD stops its alerts until that day; "" clears it. end_date "" clears the end day.',
  'delete true removes the line for good: only when Steve asks for it to be deleted. When something is finished, use done. The answer is the changed line.'
].join(' ')

const DATE_FIELDS = {
  title: { type: 'string', description: 'What happens, in a few words, e.g. "Shop lease ends". At most 120 characters.' },
  date: { type: 'string', description: 'The day it happens, YYYY-MM-DD' },
  kind: {
    type: 'string',
    description: 'Optional: contract, insurance, domain, payment, subscription, licence, holiday, task or other (the default)'
  },
  group: { type: 'string', description: 'Optional: free text to group by, e.g. the business it belongs to' },
  amount: { type: 'string', description: 'Optional: the money, as written, e.g. "250 a month"' },
  end_date: { type: 'string', description: 'Optional: the last day, YYYY-MM-DD, for something that spans days (a holiday)' },
  note: { type: 'string', description: 'Optional: the facts — amounts, notice rules, who to call' },
  action: { type: 'string', description: 'Optional: what to do when it comes up' },
  estimated: { type: 'boolean', description: 'Optional: true when the day is not confirmed' },
  remind_days: {
    type: 'array',
    items: { type: 'integer' },
    description: 'Optional: days before the date an alert fires, each 0 to 730. Default [30, 7, 1, 0].'
  },
  repeat: {
    type: 'string',
    description: 'Optional: none (the default), monthly, quarterly or yearly. Marking a repeating line done moves it to its next date.',
    enum: ['none', 'monthly', 'quarterly', 'yearly']
  }
}

/** dates_update takes every field, each one optional. */
function optional(prop) {
  return prop.description.startsWith('Optional: ') ? prop : { ...prop, description: `Optional: ${prop.description}` }
}

export const DATES_TOOLS = [
  {
    name: 'dates_list',
    description: DATES_LIST_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        include_done: { type: 'boolean', description: 'Optional: also list the done ones. Default false.' },
        kind: { type: 'string', description: 'Optional: only this kind, e.g. insurance' },
        group: { type: 'string', description: 'Optional: only lines whose group contains this' }
      },
      required: []
    }
  },
  {
    name: 'dates_add',
    description: DATES_ADD_DESCRIPTION,
    inputSchema: { type: 'object', properties: { ...DATE_FIELDS }, required: ['title', 'date'] }
  },
  {
    name: 'dates_update',
    description: DATES_UPDATE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The line, by the id dates_list shows' },
        ...Object.fromEntries(Object.entries(DATE_FIELDS).map(([key, prop]) => [key, optional(prop)])),
        done: { type: 'boolean', description: 'Optional: true marks it done; false opens it again' },
        snooze_until: { type: 'string', description: 'Optional: no alerts before this day, YYYY-MM-DD; "" clears it' },
        delete: { type: 'boolean', description: 'Optional: true removes the line. Only when Steve asks.' }
      },
      required: ['id']
    }
  }
]

function fail(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

/** One Dates tool, relayed to main as it was given; main checks every field. */
function relay(name) {
  return async (args) => {
    let reply
    try {
      reply = await browserAsk(name, args && typeof args === 'object' ? args : {})
    } catch (err) {
      if (err?.link) return fail('Forge is not reachable from here (no FORGE_BROWSER_LINK_FILE, or Forge is not running), so the Dates list could not be reached.')
      return fail(`The Dates list could not be reached: ${err?.message ?? err}`)
    }
    const text = String(reply?.text ?? 'Forge sent an empty answer.')
    return reply?.ok ? { content: [{ type: 'text', text }] } : fail(text)
  }
}

export const DATES_HANDLERS = { dates_list: relay('dates_list'), dates_add: relay('dates_add'), dates_update: relay('dates_update') }
