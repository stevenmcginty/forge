import { useMemo, useState, type ReactNode } from 'react'
import { BUILTIN_AGENT_PROFILES } from '@shared/agents'
import {
  addDays,
  alertText,
  applyPatch,
  completeItem,
  normaliseItem,
  todayOf,
  type DateItem,
  type DateKind,
  type DatePatch,
  type DatesWeeklyView
} from '@shared/dates'
import type { Project } from '@shared/types'
import type { WebDateChange, WebDateFields } from '@shared/web'
import { useDeckTheme } from '../deck/theme'
import { ForgeContext, type DateNoticeState, type ForgeActions, type ForgeState, type Picture } from '../state'
import { DatesSheet, type DatesStart } from './DatesSheet'
import { MoreSheet } from './MoreSheet'
import { TabStrip } from './TabStrip'
import { TopBar } from './TopBar'

/**
 * `?preview=dates&phone` on the dev server: the Dates sheet over the real head,
 * on a fixture `ForgeContext`, so every state can be looked at with no desktop.
 * Compiled out of every `vite build` by the `__DEV_SERVER__` gate in main.tsx.
 * Every line is made up.
 *
 * URL params:
 *  `show=<id>`   `three` (default) · `forty` · `sixty` (60 open lines over 14
 *                months, one in each heat) · `urgent` (one overdue, one today)
 *                · `empty` · `loading` · `error` (the desktop did not answer)
 *                · `offline` (the last list, desktop asleep) · `detail` · `add`
 *                · `edit` · `snooze` · `delete` · `more` (the More sheet's row)
 *  `agent=fail`  "Get an agent on it" answers with the PC-did-not-answer sentence
 *  `notice=<id>` a date alert banner: `line` (5 days out) · `late` · `summary`
 *  `weekly=<id>` the weekly check: `ran` (default) · `never` · `failed` · `off` · `none` (an older desktop)
 *  `theme=<id>`  one of the eight themes
 *
 * Writes go to the fixture list (through the shared pure helpers), so Done,
 * Snooze, Edit, Delete and Add can be tried end to end.
 */

function param(name: string): string | null {
  return new URLSearchParams(location.search).get(name)
}

const NO_ANSWER = "Couldn't reach OFFICE-PC. The PC did not answer in time. Check it's awake, then try again."

interface Seed {
  title: string
  in: number
  kind: DateKind
  group?: string
  amount?: string
  note?: string
  action?: string
  estimated?: boolean
  repeat?: DateItem['repeat']
  end?: number
  done?: boolean
}

const THREE: Seed[] = [
  {
    title: 'Shop lease ends',
    in: 12,
    kind: 'contract',
    group: 'Corner Café',
    amount: '1,850 a month',
    note: 'Six months’ notice to renew. The landlord’s agent is Harbour Lettings, front desk.',
    action: 'Decide whether to renew or move, then tell the agent in writing.'
  },
  { title: 'Van insurance renews', in: 5, kind: 'insurance', group: 'Northside Motors', amount: '480 a year', repeat: 'yearly' },
  { title: 'example-shop.co.uk renews', in: 64, kind: 'domain', group: 'Corner Café', amount: '12 a year', estimated: true }
]

const URGENT: Seed[] = [
  { title: 'Quarterly return due', in: -3, kind: 'task', group: 'Northside Motors', action: 'Send the figures to the accountant.' },
  { title: 'Card machine contract ends', in: 0, kind: 'contract', group: 'Corner Café', amount: '29 a month' },
  ...THREE
]

const POOL: [string, DateKind, string, string][] = [
  ['Gas safety check', 'licence', 'Corner Café', ''],
  ['Broadband contract ends', 'contract', 'Home', '32 a month'],
  ['Trade plates renew', 'licence', 'Northside Motors', '165 a year'],
  ['Music licence renews', 'licence', 'Corner Café', '210 a year'],
  ['Phone plan finishes', 'payment', 'Home', '18 a month'],
  ['Design tool subscription', 'subscription', 'Northside Motors', '11 a month'],
  ['Summer holiday', 'holiday', 'Home', ''],
  ['Fridge service', 'task', 'Corner Café', '90'],
  ['Public liability insurance', 'insurance', 'Corner Café', '640 a year'],
  ['Forecourt sign lease', 'contract', 'Northside Motors', '75 a month'],
  ['Payroll year end', 'task', 'Corner Café', ''],
  ['northside-motors.example renews', 'domain', 'Northside Motors', '14 a year'],
  ['Coffee machine finance ends', 'payment', 'Corner Café', '120 a month'],
  ['Boiler cover', 'insurance', 'Home', '16 a month']
]

function forty(): Seed[] {
  const offsets = [-9, -2, 0, 1, 3, 6, 9, 14, 18, 22, 27, 33, 41, 48, 57, 66, 80, 95, 110, 128, 150, 170, 200, 240, 300, 365, 420, 500, 640, 800]
  const seeds: Seed[] = offsets.map((n, i) => {
    const [title, kind, group, amount] = POOL[i % POOL.length]
    return { title: i >= POOL.length ? `${title} (${Math.floor(i / POOL.length) + 1})` : title, in: n, kind, group, amount, end: kind === 'holiday' ? n + 9 : undefined }
  })
  for (let i = 0; i < 10; i++) {
    const [title, kind, group] = POOL[(i + 5) % POOL.length]
    seeds.push({ title: `${title}, last time`, in: -20 - i * 15, kind, group, done: true })
  }
  return seeds
}

/** 60 open lines over 14 months: one late, one today, one this week, one this month, then a line a week. */
function sixty(): Seed[] {
  const offsets = [-9, -3, 0, 2, 5, 12, 25]
  for (let d = 31; offsets.length < 60; d += 7) offsets.push(d)
  const seeds: Seed[] = offsets.map((n, i) => {
    const [title, kind, group, amount] = POOL[i % POOL.length]
    return { title: i >= POOL.length ? `${title} (${Math.floor(i / POOL.length) + 1})` : title, in: n, kind, group, amount, estimated: i % 11 === 4 }
  })
  for (let i = 0; i < 4; i++) {
    const [title, kind, group] = POOL[i]
    seeds.push({ title: `${title}, last time`, in: -40 - i * 20, kind, group, done: true })
  }
  return seeds
}

/** The weekly check in each of its states, with times relative to now. */
function weeklyFixture(which: string): DatesWeeklyView | null {
  if (which === 'none') return null
  const at = (days: number, hour: number): string => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    d.setHours(hour, 0, 0, 0)
    return d.toISOString()
  }
  const base = { enabled: which !== 'off', weekday: 1, hour: 7, since: at(-30, 9), nextRunAt: which === 'off' ? null : at(4, 7) }
  if (which === 'never') return base
  if (which === 'failed') return { ...base, lastRunAt: at(-3, 7), lastResult: 'failed', lastError: 'No window was ready for the agent pane.' }
  return { ...base, lastRunAt: at(-3, 7), lastResult: 'started' }
}

function build(seeds: Seed[], today: string): DateItem[] {
  return seeds.map((s, i) => {
    const item = normaliseItem({
      id: `p${i}`,
      title: s.title,
      date: addDays(today, s.in),
      kind: s.kind,
      group: s.group,
      amount: s.amount,
      note: s.note,
      action: s.action,
      estimated: s.estimated,
      repeat: s.repeat,
      endDate: s.end !== undefined ? addDays(today, s.end) : undefined,
      done: s.done,
      doneAt: s.done ? new Date(Date.now() - i * 86_400_000).toISOString() : undefined
    })
    if (!item) throw new Error(`bad fixture ${s.title}`)
    return item
  })
}

/** The wire's snake_case change as the store's patch. */
function patchOf(change: WebDateChange | WebDateFields): DatePatch {
  const c = change as WebDateChange
  const p: DatePatch = {}
  if (c.title !== undefined) p.title = c.title
  if (c.date !== undefined) p.date = c.date
  if (c.kind !== undefined) p.kind = c.kind
  if (c.group !== undefined) p.group = c.group
  if (c.amount !== undefined) p.amount = c.amount
  if (c.end_date !== undefined) p.endDate = c.end_date
  if (c.note !== undefined) p.note = c.note
  if (c.action !== undefined) p.action = c.action
  if (c.estimated !== undefined) p.estimated = c.estimated
  if (c.repeat !== undefined) p.repeat = c.repeat
  if (c.snooze_until !== undefined) p.snoozedUntil = c.snooze_until
  if (c.done === false) p.done = false
  return p
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function DatesPreview(): ReactNode {
  const { themeId, setTheme } = useDeckTheme(true)
  const [seeded, setSeeded] = useState(false)
  if (!seeded) {
    setSeeded(true)
    const first = param('theme')
    if (first && first !== themeId) setTheme(first)
  }

  const show = param('show') ?? 'three'
  const today = todayOf(new Date())
  const [items, setItems] = useState<DateItem[] | null>(() => {
    if (show === 'loading' || show === 'error') return null
    if (show === 'empty') return []
    if (show === 'forty') return build(forty(), today)
    if (show === 'sixty') return build(sixty(), today)
    if (show === 'three' || show === 'offline') return build(THREE, today)
    return build(URGENT, today)
  })
  const [open, setOpen] = useState(show !== 'more' && !param('notice'))
  const [weekly, setWeekly] = useState(() => weeklyFixture(param('weekly') ?? 'ran'))
  const [notice, setNotice] = useState<DateNoticeState | null>(() => {
    const which = param('notice')
    const list = items ?? []
    if (which === 'summary') {
      return {
        title: '5 dates are coming up',
        body: ['Gas safety check: 9 days overdue', 'Trade plates renew: today', 'Phone plan finishes: in 5 days', 'and 2 more'].join('\n'),
        summary: true,
        at: Date.now()
      }
    }
    const line = which === 'late' ? list.find((i) => i.date < today && !i.done) : which ? list.find((i) => i.date > addDays(today, 3)) : null
    return line ? { id: line.id, ...alertText(line, today), at: Date.now() } : null
  })
  const [moreOpen, setMoreOpen] = useState(show === 'more')
  const agentFails = param('agent') === 'fail'

  const start = useMemo<DatesStart | undefined>(() => {
    if (show === 'add') return { step: 'add' }
    if (show === 'detail' || show === 'edit' || show === 'snooze' || show === 'delete') return { step: show, id: 'p2' }
    return undefined
  }, [show])

  const actions = useMemo(() => {
    const dates: ForgeActions['dates'] = {
      refresh: async () => {
        if (show === 'loading') return new Promise<string | null>(() => undefined)
        await wait(400)
        return show === 'error' ? NO_ANSWER : null
      },
      add: async (input) => {
        await wait(350)
        const item = normaliseItem({ ...patchOf(input), id: `n${Date.now()}`, title: input.title, date: input.date })
        if (!item) return 'That line could not be saved.'
        setItems((list) => [...(list ?? []), item])
        return null
      },
      update: async (id, change) => {
        await wait(350)
        let error: string | null = null
        setItems((list) => {
          if (!list) return list
          if (change.delete) return list.filter((i) => i.id !== id)
          return list.map((i) => {
            if (i.id !== id) return i
            try {
              return change.done === true ? completeItem(i) : applyPatch(i, patchOf(change))
            } catch (e) {
              error = e instanceof Error ? e.message : String(e)
              return i
            }
          })
        })
        return error
      },
      startAgent: async () => {
        await wait(700)
        return agentFails ? NO_ANSWER : null
      },
      open: () => setOpen(true),
      close: () => setOpen(false),
      runWeekly: async () => {
        await wait(600)
        if (agentFails) return NO_ANSWER
        setWeekly((w) => (w ? { ...w, lastRunAt: new Date().toISOString(), lastResult: 'started', lastError: undefined } : w))
        return null
      },
      setWeekly: async (patch) => {
        await wait(200)
        setWeekly((w) => (w ? { ...w, ...patch } : w))
        return null
      },
      dismissNotice: () => setNotice(null)
    }
    return new Proxy({} as ForgeActions, {
      get: (_target, key) => {
        const name = String(key)
        if (name === 'dates') return dates
        if (name === 'request') return () => Promise.resolve({ kind: 'failed', message: 'This is the preview.' })
        if (name.startsWith('on')) return () => () => undefined
        return () => undefined
      }
    })
  }, [show, agentFails])

  const state = useMemo(() => {
    const cafe: Project = { id: 'cafe', name: 'corner-cafe', path: 'C:\\Projects\\corner-cafe', color: '#ff9f43', defaultProfileId: 'claude', createdAt: 0 }
    const picture: Picture = {
      desktopName: 'OFFICE-PC',
      appVersion: '0.0.0',
      projects: [cafe],
      profiles: BUILTIN_AGENT_PROFILES,
      workspaces: { cafe: { activeTabId: 't1', tabs: [{ id: 't1', title: 'Menu', root: { type: 'leaf', id: 'p1', profileId: 'claude', title: '' }, activePaneId: 'p1' }] } },
      sessions: [{ id: 'p1', cwd: cafe.path, cols: 60, rows: 30, bootstrapCommand: '', startedAt: 0 }],
      projectsRoot: '',
      foreman: {},
      handoff: {},
      brain: null
    }
    const offline = show === 'offline'
    return {
      stage: offline ? { kind: 'offline', message: '', record: { name: 'OFFICE-PC' } } : { kind: 'connected' },
      connection: { state: offline ? 'offline' : 'live' },
      session: { email: 'someone@example.com' },
      config: null,
      picture,
      cached: null,
      projectId: 'cafe',
      git: {},
      asking: new Set<string>(),
      busy: new Set<string>(),
      prompts: {},
      waiting: [],
      notice: '',
      desktopRecovering: '',
      remoteYes: { enabled: false, uac: false, address: '', port: 0 },
      warm: true,
      offlineMode: 'frozen',
      notifyPermission: 'granted',
      pushActive: true,
      askBanner: null,
      brainConfirms: [],
      dates: items,
      datesOpen: open,
      datesWeekly: weekly,
      dateNotice: notice
    } as unknown as ForgeState
  }, [show, items, open, weekly, notice])

  const value = useMemo(() => ({ state, actions }), [state, actions])
  const off = { available: false, reason: 'Not in the preview', detail: '', onPress: () => undefined }

  return (
    <ForgeContext.Provider value={value}>
      <div className="app" data-mobile="true" data-ready="true" data-shell="app" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <TopBar collapsed onToggleRail={() => undefined} onWatchScreen={null} mobile />
        <div className="app__body" style={{ flex: 1, minHeight: 0 }}>
          <main className="app__main">
            <div className="grid">
              <TabStrip mobile />
              <div className="app__display grid__body" data-region="display" />
            </div>
          </main>
        </div>
        <button
          type="button"
          className="pu-btn"
          style={{ position: 'absolute', left: 16, bottom: 24 }}
          onClick={() => (show === 'more' ? setMoreOpen(true) : setOpen(true))}
        >
          {show === 'more' ? 'Open More' : 'Open Dates'}
        </button>
        {show === 'more' ? (
          <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} pane={null} foreman={off} foremanOn={false} handoff={off} screen={off} />
        ) : null}
        <DatesSheet start={start} />
      </div>
    </ForgeContext.Provider>
  )
}
