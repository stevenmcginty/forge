import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BRAIN_ENGINE_NAME, BRAIN_PROJECT_NAME, type BrainConfirmRequest, type BrainStatus } from '@shared/brain'
import { terminalHost } from '@/lib/terminals'
import { useApp, type SettingsSection } from '@/state/AppState'
import { Icon } from '../Icon'
import { openBrainMap } from '../brainview'
import { BrainChat } from './BrainChat'
import { BrainComposer } from './BrainComposer'
import { BrainGlyph, type GlyphState } from './BrainGlyph'
import { BrainIntro } from './BrainIntro'
import { toRows } from './brainRows'
import { answerConfirm, setBrainOpen, setBrainTab, shownTab, turnBrainOn, useBrain, type BrainTab } from './brainStore'

/**
 * The drop-down under the brain icon: a header (the mark, its name, what it
 * is doing in words, Chat | CLI), then the chat or the brain pane's own
 * terminal, the brain's questions as Yes / No cards, and the text box.
 * While the brain is off it is the intro instead (BrainIntro).
 *
 * Opaque, like every sheet over live terminals, and marked
 * `data-shell-overlay` so the browser's native page gets out of its way.
 */

/**
 * Settings → Forge Brain (SettingsPage adds the group).
 */
export const BRAIN_SETTINGS: SettingsSection = 'brain'

const STATE_WORD: Record<BrainStatus['state'], string> = {
  off: 'Off',
  starting: 'Starting…',
  idle: 'Ready',
  busy: 'Working…',
  asking: 'Needs you',
  error: 'Stopped'
}

export function glyphStateOf(status: BrainStatus | null): GlyphState {
  if (!status || !status.enabled) return 'off'
  return status.state
}

export function BrainPanel({ id }: { id: string }): ReactNode {
  const snap = useBrain()
  const { status } = snap
  const on = Boolean(status?.enabled)
  const tab = shownTab(snap)
  const rows = useMemo(() => toRows(snap.feed.turns, snap.sends), [snap.feed.turns, snap.sends])
  const needs = status ? status.state === 'asking' || status.confirms.length > 0 : false
  const word = status ? (needs && status.state !== 'asking' ? 'Needs you' : on ? STATE_WORD[status.state] : 'Off') : 'Off'

  return (
    <div id={id} className="brainpanel" role="dialog" aria-label="Forge Brain" data-shell-overlay="" data-tab={on ? tab : undefined}>
      <header className="brainpanel__head">
        <span className="brainpanel__mark">
          <BrainGlyph state={glyphStateOf(status)} size={24} />
        </span>
        <span className="brainpanel__titles">
          <span className="brainpanel__title">Forge Brain</span>
          <span className="brainpanel__sub">
            <span className="brainpanel__state" data-state={on ? status?.state : 'off'} data-needs={needs ? 'true' : undefined}>
              {word}
            </span>
            {on && status ? <span className="brainpanel__engine">· {BRAIN_ENGINE_NAME[status.engine]}</span> : null}
          </span>
        </span>
        {on ? <TabSwitch tab={tab} /> : null}
        {/* The foreman's Expand control (brainview's openBrainMap) goes in this slot. */}
        <span className="brainpanel__slot" data-brain-slot="expand">
          <button type="button" className="brainpanel__close" aria-label="Expand: the map of every agent" title="Expand: every agent (shortcut twice)" onClick={() => { setBrainOpen(false); openBrainMap() }}>
            <Icon name="expand" size={13} />
          </button>
        </span>
        <button type="button" className="brainpanel__close" aria-label="Close Forge Brain" title="Close (Esc)" onClick={() => setBrainOpen(false)}>
          <Icon name="close" size={13} />
        </button>
      </header>

      {!on || !status ? (
        <div className="brainpanel__body brainpanel__body--intro">
          <BrainIntro status={status} />
        </div>
      ) : (
        <>
          {status.state === 'error' ? <Stopped status={status} /> : null}
          <div className="brainpanel__body">
            {tab === 'chat' ? <BrainChat rows={rows} status={status} /> : <BrainTerminal paneId={status.paneId} />}
          </div>
          {status.confirms.length ? <Confirms confirms={status.confirms} /> : null}
          {status.state === 'asking' && !status.confirms.length && tab === 'chat' ? <AskingLine /> : null}
          <BrainComposer
            disabled={status.state === 'error'}
            placeholder={status.state === 'busy' ? 'Message Forge Brain — it goes in when it is free' : 'Message Forge Brain'}
          />
        </>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- Chat | CLI */

function TabSwitch({ tab }: { tab: BrainTab }): ReactNode {
  return (
    <div className="brainpanel__tabs" role="tablist" aria-label="Chat or the brain's terminal">
      {(['chat', 'cli'] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          data-on={tab === t ? 'true' : undefined}
          onClick={() => setBrainTab(t)}
        >
          {t === 'chat' ? 'Chat' : 'CLI'}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------- the terminal */

/**
 * The brain pane's real terminal, attached like any pane's (main launches it
 * the brain's way whatever spec is passed for its id). Esc here goes to the
 * terminal, as in every pane; click outside or the × to close.
 */
function BrainTerminal({ paneId }: { paneId: string | null }): ReactNode {
  const { state } = useApp()
  const ref = useRef<HTMLDivElement | null>(null)
  const s = state.settings
  const spec = useRef({
    cwd: '',
    bootstrapCommand: '',
    fontSize: Math.max(11, s.terminalFontSize - 1),
    fontFamily: s.terminalFontFamily,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c6ff4a',
    projectName: BRAIN_PROJECT_NAME,
    paneTitle: BRAIN_PROJECT_NAME,
    remoteControl: false as const
  })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !paneId) return undefined
    terminalHost.attach(paneId, el, spec.current)
    // The drop-down widens for the CLI: fit to the settled box.
    const raf = requestAnimationFrame(() => terminalHost.fit(paneId))
    return () => {
      cancelAnimationFrame(raf)
      terminalHost.detach(paneId)
    }
  }, [paneId])

  if (!paneId) {
    return (
      <div className="brainpanel__noterm">
        <Icon name="terminal" size={16} />
        The brain's terminal shows here once it has started.
      </div>
    )
  }
  return <div className="brainpanel__term" ref={ref} />
}

/* ------------------------------------------------------------------ states */

function Stopped({ status }: { status: BrainStatus }): ReactNode {
  const [busy, setBusy] = useState(false)
  const { actions } = useApp()
  return (
    <div className="brainpanel__stopped" role="alert">
      <span className="brainpanel__stopped-mark" aria-hidden="true">
        ×
      </span>
      <span className="brainpanel__stopped-text">
        <strong>Stopped.</strong> {status.error ?? 'Forge Brain is not running.'}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void turnBrainOn().finally(() => setBusy(false))
        }}
      >
        {busy ? 'Starting…' : 'Start again'}
      </button>
      <button
        type="button"
        onClick={() => {
          setBrainOpen(false)
          actions.openSettings(BRAIN_SETTINGS)
        }}
      >
        Settings
      </button>
    </div>
  )
}

/** Its screen is showing a question Forge will not answer for it. */
function AskingLine(): ReactNode {
  return (
    <p className="brainpanel__asking">
      <span className="brainpanel__bang" aria-hidden="true">
        !
      </span>
      It is asking something on its screen.
      <button type="button" onClick={() => setBrainTab('cli')}>
        Show CLI
      </button>
    </p>
  )
}

/* --------------------------------------------------------------- confirms */

const RISK_WORD: Record<BrainConfirmRequest['risk'], string> = {
  low: 'Low risk',
  medium: 'Check this',
  high: 'Careful — hard to undo'
}

/** A risk by shape: a circle, a triangle, an octagon. The word beside it says the same. */
function RiskMark({ risk }: { risk: BrainConfirmRequest['risk'] }): ReactNode {
  return (
    <svg className="brainconfirm__risk" data-risk={risk} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {risk === 'low' ? (
        <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      ) : risk === 'medium' ? (
        <path d="M8 1.8 14.6 13.6H1.4Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      ) : (
        <path d="M5.3 1.5h5.4l3.8 3.8v5.4l-3.8 3.8H5.3l-3.8-3.8V5.3Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      )}
      <path d={risk === 'medium' ? 'M8 6.2v3.2' : 'M8 4.9v3.6'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy={risk === 'medium' ? 11.4 : 10.9} r="0.95" fill="currentColor" />
    </svg>
  )
}

function Confirms({ confirms }: { confirms: BrainConfirmRequest[] }): ReactNode {
  const [answering, setAnswering] = useState<string | null>(null)
  const answer = (id: string, allow: boolean): void => {
    setAnswering(id)
    void answerConfirm(id, allow).finally(() => setAnswering(null))
  }
  return (
    <div className="brainconfirms" aria-label="Forge Brain is asking">
      {confirms.map((c) => (
        <section key={c.id} className="brainconfirm" data-risk={c.risk} aria-label={`Forge Brain asks: ${c.summary}`}>
          <p className="brainconfirm__eyebrow">
            <RiskMark risk={c.risk} />
            <span>Forge Brain wants to</span>
            <span className="brainconfirm__riskword">{RISK_WORD[c.risk]}</span>
          </p>
          <p className="brainconfirm__summary">{c.summary}</p>
          <p className="brainconfirm__tool">{c.tool}</p>
          <div className="brainconfirm__acts">
            <button type="button" className="brainconfirm__yes" disabled={answering === c.id} onClick={() => answer(c.id, true)}>
              <Icon name="check" size={13} />
              Yes, do it
            </button>
            <button type="button" className="brainconfirm__no" disabled={answering === c.id} onClick={() => answer(c.id, false)}>
              <Icon name="close" size={12} />
              No
            </button>
          </div>
        </section>
      ))}
    </div>
  )
}
