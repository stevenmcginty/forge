import { useEffect, useState, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { useForge, type ForgeState } from '../state'
import { BottomSheet, SheetConfirm, SheetGlyph, SheetRow, SheetSection } from './BottomSheet'
import './ConnectionSheet.css'

/**
 * The link, in words — what the live dot in the top bar opens.
 *
 * The phone says "is this live?" in exactly one place on screen (the dot, and
 * the 2px line under the bar that repeats it edge to edge) and in words here:
 * which desktop, what state, when it last spoke, and the one thing to do about
 * it. The signed-in account lives here too, because "which machine am I
 * looking at" and "as whom" are the same question.
 */

/** The four things the link can be, as the phone draws them. */
export type LinkState = 'live' | 'quiet' | 'reconnecting' | 'asleep'

export function linkStateOf(state: ForgeState): LinkState {
  if (state.stage.kind === 'offline') return 'asleep'
  if (state.stage.kind === 'connected' && state.connection.state === 'live') return state.warm ? 'live' : 'quiet'
  return 'reconnecting'
}

const LINK_WORD: Record<LinkState, string> = {
  live: 'Live',
  quiet: 'Live, but quiet',
  reconnecting: 'Reconnecting',
  asleep: 'Asleep'
}

export function linkWord(link: LinkState): string {
  return LINK_WORD[link]
}

/**
 * The dot. Shape carries the state as well as colour: filled with a halo for
 * live, a hollow ring for quiet, a pulsing ring for reconnecting, a plain grey
 * disc for asleep.
 */
export function LinkDot({ link }: { link: LinkState }): ReactNode {
  return <span className="linkdot" data-state={link} aria-hidden="true" />
}

/* ------------------------------------------------------------ last heard
 *
 * The client knows the time of its last frame and keeps it to itself; what the
 * page is told is `warm`, polled every two seconds. So "last heard" is kept
 * here from the outside: stamped while the link is live and warm, and left
 * standing when it goes quiet or drops. Accurate to a few seconds, which is the
 * precision the sentence is written in.
 */
let lastHeardAt = 0

export function useTrackLastHeard(liveAndWarm: boolean): void {
  useEffect(() => {
    if (!liveAndWarm) return
    const mark = (): void => {
      lastHeardAt = Date.now()
    }
    mark()
    const timer = window.setInterval(mark, 1000)
    return () => window.clearInterval(timer)
  }, [liveAndWarm])
}

export function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds} seconds ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export function ConnectionSheet({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const { state, actions } = useForge()
  const [step, setStep] = useState<'status' | 'sign-out'>('status')
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (!open) return
    setStep('status')
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open])

  const link = linkStateOf(state)
  const name =
    state.picture?.desktopName ||
    (state.stage.kind === 'offline' ? state.stage.record?.name : '') ||
    state.cached?.desktopName ||
    'the desktop'
  const version = state.picture?.appVersion ?? ''
  const email = state.session?.email ?? ''

  const heardAt = link === 'asleep' ? (state.cached?.at ?? 0) : lastHeardAt
  const heard = link === 'live' ? 'just now' : heardAt ? ago(heardAt, now) : 'not yet'

  const sentence: Record<LinkState, string> = {
    live: `Connected to ${name}. What you see is happening now.`,
    quiet: `Still connected to ${name}, but nothing has come back for a few seconds — a slow signal, or a busy desktop.`,
    reconnecting: `The link to ${name} dropped. Forge is getting it back; nothing you type gets through until it does.`,
    asleep: `${name} is not answering. What you see is the last picture it sent.`
  }

  const reconnect =
    link === 'reconnecting' ? () => actions.retry() : link === 'asleep' ? () => actions.refind() : null

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      onBack={step === 'sign-out' ? () => setStep('status') : undefined}
      label={step === 'sign-out' ? 'Sign out' : `Connection: ${linkWord(link)}`}
      title={
        step === 'sign-out' ? null : (
          <span className="connsheet__title" data-state={link}>
            <LinkDot link={link} />
            {linkWord(link)}
          </span>
        )
      }
      subtitle={step === 'sign-out' ? undefined : sentence[link]}
      testId="connection-sheet"
    >
      {step === 'sign-out' ? (
        <SheetConfirm
          question="Sign out of Forge on this phone?"
          detail="Then sign in with the other account. This phone stops getting alerts until you sign back in."
          confirmLabel="Sign out"
          onCancel={() => setStep('status')}
          onConfirm={() => {
            onClose()
            actions.signOut()
          }}
          testId="connection-sign-out-confirm"
        />
      ) : (
        <>
          <SheetSection>
            <SheetRow
              icon={<Icon name="screen" size={20} />}
              label={name}
              secondary={version ? `Forge ${version}` : 'Desktop'}
            />
            <SheetRow icon={<Icon name="history" size={20} />} label={`Last heard ${heard}`} testId="connection-heard" />
            {email ? (
              <SheetRow
                icon={<Icon name="user" size={20} />}
                label={email}
                secondary="Signed in on this phone"
                testId="connection-account"
              />
            ) : null}
            {email ? (
              <SheetRow
                icon={<SheetGlyph name="signOut" />}
                label="Use a different account"
                secondary="Signs this phone out first"
                onClick={() => setStep('sign-out')}
              />
            ) : null}
          </SheetSection>
          {reconnect ? (
            <div className="connsheet__actions">
              <button
                type="button"
                className="bsbtn"
                data-wide="true"
                data-tone="act"
                onClick={() => {
                  reconnect()
                  onClose()
                }}
                data-testid="connection-reconnect"
              >
                Reconnect now
              </button>
            </div>
          ) : null}
        </>
      )}
    </BottomSheet>
  )
}
