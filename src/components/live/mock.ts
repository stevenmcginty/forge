import type { LiveJob, LiveView } from './types'

/**
 * A full LiveView matching the approved comp (docs/live-agent-design/B.png):
 * Forge speaking while it shows the koraos VAT return, Kess building, Lena
 * waiting on a yes, Mira reading, Tomas done. For the screenshot harness and
 * for building against before the real provider is wired. Times are relative
 * to `at`, so elapsed counters read sensibly.
 */
export function mockLiveView(at = Date.now(), overrides: Partial<LiveView> = {}): LiveView {
  const s = (secondsAgo: number): number => at - secondsAgo * 1000

  const now: LiveJob = {
    id: 'job-vat',
    title: 'Showing you box 5 on the koraos VAT return',
    project: 'koraos',
    paneId: 'pane-tomas',
    paneName: 'Tomas',
    owner: 'conductor',
    state: 'running',
    createdAt: s(140),
    updatedAt: s(6),
    steps: [
      { at: s(130), text: 'Opened koraos' },
      { at: s(70), text: 'Found the Q3 return' },
      { at: s(6), text: 'Pointing at box 5' }
    ]
  }
  const next: LiveJob = {
    id: 'job-next',
    title: 'Check on Kess’s build',
    owner: 'conductor',
    state: 'queued',
    createdAt: s(5),
    updatedAt: s(5),
    steps: []
  }
  const kess: LiveJob = {
    id: 'job-kess',
    title: 'Update the menu prices',
    project: 'cafe-roma-homepage',
    paneId: 'pane-kess',
    paneName: 'Kess',
    owner: 'pane',
    state: 'running',
    createdAt: s(134),
    updatedAt: s(3),
    summary: 'Changing menu prices: 3 of 5 done',
    steps: [
      { at: s(120), text: 'Read(src/data/menu.json)' },
      { at: s(3), text: 'Update(src/data/menu.json) · 3 changes' }
    ]
  }
  const lena: LiveJob = {
    id: 'job-lena',
    title: 'OBD log parser',
    project: 'car-harness',
    paneId: 'pane-lena',
    paneName: 'Lena',
    owner: 'pane',
    state: 'needs-you',
    createdAt: s(900),
    updatedAt: s(12),
    summary: 'All 42 tests pass. Wants a yes to push.',
    steps: [
      { at: s(60), text: 'Bash(npm test) · 42 passed' },
      { at: s(12), text: 'The OBD log parser is finished and all 42 tests pass. Shall I push obd-parser?' }
    ]
  }
  const mira: LiveJob = {
    id: 'job-mira',
    title: 'Open prep jobs for Andreas',
    project: 'dealer-ledger-pro',
    paneId: 'pane-mira',
    paneName: 'Mira',
    owner: 'pane',
    state: 'running',
    createdAt: s(38),
    updatedAt: s(4),
    summary: 'Reading the open prep jobs for Andreas',
    steps: [
      { at: s(30), text: 'Read(src/prep/jobs.ts)' },
      { at: s(4), text: `Grep("status: 'open'") → 11 matches` }
    ]
  }
  const tomas: LiveJob = {
    id: 'job-tomas',
    title: 'Open the VAT page',
    project: 'koraos',
    paneId: 'pane-tomas',
    paneName: 'Tomas',
    owner: 'operator',
    state: 'done',
    createdAt: s(200),
    updatedAt: s(90),
    summary: 'VAT page open',
    steps: [{ at: s(90), text: 'Opened koraos.app/backoffice/vat/2026-q3' }]
  }

  const said = 'You owe £3,126.80. That’s box five, about £400 less than last quarter. Here it is.'
  const turns: LiveView['turns'] = [
    { id: 't1', who: 'you', text: 'Morning. What’s everyone up to?', at: s(1500), final: true },
    { id: 't2', who: 'forge', text: 'Kess is on the menu prices, Lena is finishing the OBD parser, and Mira is pulling the prep list.', at: s(1495), final: true },
    { id: 't3', who: 'you', text: 'Get Mira to send the prep list to Andreas when it’s ready.', at: s(1200), final: true },
    { id: 't4', who: 'forge', text: 'Will do. I’ll tell you when it’s gone.', at: s(1196), final: true },
    { id: 't5', who: 'you', text: 'And open the VAT return on koraos.', at: s(220), final: true },
    { id: 't6', who: 'forge', text: 'Opening it now.', at: s(218), final: true },
    { id: 't7', who: 'you', text: 'What do we owe this quarter?', at: s(9), final: true },
    { id: 't8', who: 'forge', text: said, at: s(7), final: false, spokenChars: said.indexOf('Here') }
  ]

  const noop = (): void => {}
  return {
    phase: 'speaking',
    working: 3,
    turns,
    caption: { you: 'What do we owe this quarter?', forge: said, forgeSpokenChars: said.indexOf('Here') },
    jobs: [now, next, kess, lena, mira, tomas],
    now,
    needsYou: [lena],
    status: {
      ready: true,
      voiceModel: 'claude-opus-5-5',
      conductorModel: 'claude-opus-5-5',
      voiceRoute: 'subscription',
      hasApiKey: false,
      conductorBusy: true
    },
    start: noop,
    stop: noop,
    toggle: noop,
    sendTyped: noop,
    stopJob: noop,
    showJob: noop,
    ...overrides
  }
}
