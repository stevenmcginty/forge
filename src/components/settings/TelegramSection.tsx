import { useEffect, useState, type ReactNode } from 'react'
import type { ForgeApi } from '@shared/api'
import type { TelegramState, TelegramStatus } from '@shared/telegram'
import { useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { Card, KeyField, Row, Section, Toggle } from './parts'
import './TelegramSection.css'

/**
 * Telegram — talk to Forge Brain from your phone.
 *
 * The bot itself lives in the main process; this page only holds its token,
 * shows what it is doing, and presses its buttons. Three numbered cards, in the
 * order you do them: make a bot, pair your phone, switch it on and test it.
 *
 * Every state is a shape and a word, never a colour alone.
 *
 * The bridge is read defensively: a desktop still running an older preload has
 * no `window.forge.telegram`, and an unguarded call there would take the whole
 * renderer down. That case shows one line asking for a restart instead.
 */
type TelegramApi = ForgeApi['telegram']

function telegramBridge(): TelegramApi | null {
  return (window as unknown as { forge?: Partial<ForgeApi> }).forge?.telegram ?? null
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function TelegramSection(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  const api = telegramBridge()
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [busy, setBusy] = useState<'pair' | 'unpair' | 'test' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    const bridge = telegramBridge()
    if (!bridge) return
    let live = true
    void bridge
      .status?.()
      .then((next) => {
        if (live) setStatus(next)
      })
      .catch(() => {})
    const off = bridge.onStatus?.((next) => setStatus(next))
    return () => {
      live = false
      off?.()
    }
  }, [])

  const run = async (kind: 'pair' | 'unpair', call: (() => Promise<TelegramStatus>) | undefined): Promise<void> => {
    if (!call) return
    setBusy(kind)
    setProblem(null)
    try {
      setStatus(await call())
    } catch (err) {
      setProblem(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const sendTest = async (): Promise<void> => {
    if (!api?.test) return
    setBusy('test')
    setTestResult(null)
    try {
      const result = await api.test()
      setTestResult(result.ok ? { ok: true, text: 'Sent.' } : { ok: false, text: result.error })
    } catch (err) {
      setTestResult({ ok: false, text: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  const setOn = (next: boolean): void => {
    actions.patchSettings({ telegramEnabled: next })
    void api
      ?.setEnabled?.(next)
      .then(setStatus)
      .catch((err: unknown) => setProblem(errorText(err)))
  }

  const ready = status?.state === 'ready'
  const paired = status?.paired === true
  const bot = status?.botUsername ?? null

  return (
    <Section title="Telegram" blurb="Talk to Forge Brain from your phone. The bot runs inside Forge on this computer.">
      <Card
        title="1. Make a bot"
        hint="Also send /setjoingroups to BotFather and pick Disable, so nobody can add it to a group."
      >
        <ol className="scard__steps">
          <li>
            In Telegram, open <span className="mono">@BotFather</span>.
          </li>
          <li>
            Send <span className="mono">/newbot</span>.
          </li>
          <li>Give it a name.</li>
          <li>Copy the token it gives you, and paste it here.</li>
        </ol>
        <KeyField
          label="Bot token"
          value={s.telegramBotToken}
          onCommit={(token) => actions.patchSettings({ telegramBotToken: token.trim() })}
          placeholder="123456789:AA…"
        />
      </Card>

      <Card
        title="2. Pair your phone"
        actions={
          api && status && !confirming ? (
            <>
              {paired && bot ? (
                <button
                  type="button"
                  className="ghost-btn sbtn"
                  onClick={() => void window.forge.openExternal(`https://t.me/${bot}`)}
                >
                  <Icon name="telegram" size={12} />
                  Open in Telegram
                </button>
              ) : null}
              {paired ? (
                <button
                  type="button"
                  className="ghost-btn sbtn sbtn--danger"
                  disabled={busy !== null}
                  onClick={() => setConfirming(true)}
                >
                  Unpair
                </button>
              ) : (
                <button
                  type="button"
                  className="ghost-btn sbtn"
                  disabled={busy !== null || !s.telegramBotToken.trim()}
                  onClick={() => void run('pair', api.pair)}
                >
                  {busy === 'pair' ? 'Pairing…' : 'Pair'}
                </button>
              )}
            </>
          ) : null
        }
      >
        {!api ? (
          <p className="scard__hint">Restart Forge to use Telegram.</p>
        ) : !status ? (
          <p className="scard__hint">Asking the bot…</p>
        ) : (
          <>
            <Row label="Bot" hint={bot ? `@${bot}` : undefined}>
              <StateBadge status={status} />
            </Row>
            {confirming ? (
              <div className="stg__confirm" role="group" aria-label="Unpair your phone">
                <span className="stg__ask">
                  Unpair {status.pairedName ?? 'your phone'}? The bot will stop answering it.
                </span>
                <button type="button" className="ghost-btn sbtn" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="ghost-btn sbtn sbtn--danger"
                  onClick={() => {
                    setConfirming(false)
                    void run('unpair', api.unpair)
                  }}
                >
                  Unpair
                </button>
              </div>
            ) : null}
            {status.pairCode && !paired ? (
              <PairCode code={status.pairCode} expiresAt={status.pairCodeExpiresAt} bot={bot} />
            ) : null}
            {!paired && status.state === 'off' ? (
              <p className="scard__hint">The bot is off. Switch it on in step 3, or your code will not reach Forge.</p>
            ) : null}
            {problem ? <p className="scard__hint">Problem: {problem}</p> : null}
          </>
        )}
      </Card>

      <Card title="3. On and test">
        <Row label="Telegram bot" hint="When it is on, Forge reads your messages and Forge Brain answers them.">
          <span className="stg__onoff">{s.telegramEnabled ? 'On' : 'Off'}</span>
          <Toggle checked={s.telegramEnabled} onChange={setOn} label="Telegram bot" />
        </Row>
        <Row label="Test message" hint={ready ? 'Sends a short message to your phone.' : 'Pair your phone first.'}>
          {testResult ? (
            <span className="stg__result" role="status">
              <StateMark state={testResult.ok ? 'ready' : 'error'} />
              {testResult.text}
            </span>
          ) : null}
          <button
            type="button"
            className="ghost-btn sbtn"
            disabled={!api || !ready || busy !== null}
            onClick={() => void sendTest()}
          >
            <Icon name="send" size={12} />
            {busy === 'test' ? 'Sending…' : 'Send test'}
          </button>
        </Row>
      </Card>
    </Section>
  )
}

/** The bot's state as a shape and a word. The tint only repeats them. */
function StateBadge({ status }: { status: TelegramStatus }): ReactNode {
  return (
    <span className="stg__state" data-state={status.state} role="status">
      <StateMark state={status.state} />
      {stateWord(status)}
    </span>
  )
}

function stateWord(status: TelegramStatus): string {
  switch (status.state) {
    case 'off':
      return 'Off'
    case 'no-token':
      return 'Needs a token'
    case 'checking':
      return 'Checking the token'
    case 'pairing':
      return 'Waiting for your code'
    case 'ready':
      return status.paired ? `Paired with ${status.pairedName ?? 'your phone'}` : 'Ready to pair'
    case 'error':
      return `Problem: ${status.error ?? 'unknown'}`
  }
}

/**
 * One shape per state, so the state reads without colour: a slashed circle for
 * off, a key for no token, an open ring for checking, an open padlock for
 * pairing, a tick for ready, a triangle for a problem.
 */
function StateMark({ state }: { state: TelegramState }): ReactNode {
  if (state === 'no-token') return <Icon name="key" size={14} className="stg__mark" />
  if (state === 'ready') return <Icon name="check" size={14} className="stg__mark" />
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="stg__mark"
      aria-hidden="true"
      focusable="false"
    >
      {state === 'off' ? (
        <>
          <circle cx="8" cy="8" r="5.6" />
          <path d="M4 12l8-8" />
        </>
      ) : state === 'checking' ? (
        <path d="M8 2.4a5.6 5.6 0 1 1-5.6 5.6" />
      ) : state === 'pairing' ? (
        <>
          <rect x="3.4" y="7.2" width="9.2" height="6.4" rx="1.2" />
          <path d="M5.6 7.2V5.2a2.4 2.4 0 0 1 4.7-.7" />
        </>
      ) : (
        <>
          <path d="M8 2.4l6 10.8H2z" />
          <path d="M8 6.8v2.8M8 11.4v.1" />
        </>
      )}
    </svg>
  )
}

/** The six digits, big enough to copy by eye, with the minutes they have left. */
function PairCode({ code, expiresAt, bot }: { code: string; expiresAt: number | null; bot: string | null }): ReactNode {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const minutes = expiresAt ? Math.ceil((expiresAt - now) / 60_000) : null
  const left =
    minutes === null
      ? null
      : minutes <= 0
        ? 'This code has run out. Press Pair for a new one.'
        : minutes === 1
          ? 'Less than a minute left.'
          : `${minutes} minutes left.`

  return (
    <div className="stg__code">
      <span className="stg__digits mono">{code}</span>
      <p className="scard__hint">
        Send this code to {bot ? <span className="mono">@{bot}</span> : 'your bot'} in Telegram. It works for 10 minutes.
      </p>
      {left ? <p className="stg__left">{left}</p> : null}
    </div>
  )
}
