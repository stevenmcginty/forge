import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { getVoiceAutoStop, setVoiceAutoStop } from '../lib/voice-prefs'
import { useForge, type NotifySupport } from '../state'
import { BottomSheet, SheetConfirm, SheetGlyph, SheetRow, SheetSection, SheetSwitch } from './BottomSheet'
import { rustDeskLink } from './Workspace'
import './MoreSheet.css'

/**
 * The "⋯" sheet: everything the top bar used to say in six unlabelled glyphs,
 * said in words, in rows a thumb can hit.
 *
 * The rows never change per pane — a row that cannot act on this pane stays
 * where it is, greyed, with the reason as its second line — so the list is
 * learned once. Grouped by what each row acts on: this pane, the desktop,
 * this phone, the account.
 */

export interface MoreSheetPane {
  /** "Claude Code · claude" — whose pane the pane rows act on. */
  label: string
  /** The agent's dot colour, or null for none. Identity, not state. */
  accent: string | null
}

export interface MoreSheetAction {
  /** False draws the row greyed, with `reason` as its second line. */
  available: boolean
  reason: string
  /** The second line when available. */
  detail: string
  onPress: () => void
}

export function MoreSheet({
  open,
  onClose,
  pane,
  foreman,
  foremanOn,
  handoff,
  screen
}: {
  open: boolean
  onClose: () => void
  pane: MoreSheetPane | null
  foreman: MoreSheetAction
  foremanOn: boolean
  handoff: MoreSheetAction
  screen: MoreSheetAction
}): ReactNode {
  const { state, actions } = useForge()
  const [step, setStep] = useState<'list' | 'sign-out'>('list')
  const [autoStop, setAutoStop] = useState(getVoiceAutoStop)
  const [scale, setScale] = useTextScale()

  // Every opening starts on the list, reading the stored preference afresh —
  // the composer may have changed nothing, but another tab may have.
  useEffect(() => {
    if (!open) return
    setStep('list')
    setAutoStop(getVoiceAutoStop())
  }, [open])

  const alerts = alertsRow(state.notifyPermission, state.pushActive)
  const email = state.session?.email ?? ''
  const at = TEXT_SCALE_STEPS.indexOf(scale)

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      onBack={step === 'sign-out' ? () => setStep('list') : undefined}
      label={step === 'sign-out' ? 'Sign out' : 'More'}
      title={step === 'sign-out' ? null : undefined}
      testId="more-sheet"
    >
      {step === 'sign-out' ? (
        <SheetConfirm
          question="Sign out of Forge on this phone?"
          detail="You will need your email and password to get back in, and this phone stops getting alerts until you do."
          confirmLabel="Sign out"
          onCancel={() => setStep('list')}
          onConfirm={() => {
            onClose()
            actions.signOut()
          }}
          testId="sign-out-confirm"
        />
      ) : (
        <>
          <SheetSection title={pane ? `This pane · ${pane.label}` : 'This pane'}>
            <SheetRow
              icon={<Icon name="foreman" size={20} />}
              label={foremanOn ? 'Stop Foreman' : 'Foreman'}
              secondary={foreman.available ? foreman.detail : foreman.reason}
              disabled={!foreman.available}
              onClick={foreman.onPress}
              testId="more-foreman"
            />
            <SheetRow
              icon={<SheetGlyph name="handoff" />}
              label="Hand off"
              secondary={handoff.available ? handoff.detail : handoff.reason}
              disabled={!handoff.available}
              onClick={handoff.onPress}
              testId="more-handoff"
            />
          </SheetSection>

          <SheetSection title={state.picture?.desktopName || 'The desktop'}>
            <SheetRow
              icon={<Icon name="screen" size={20} />}
              label="Screen"
              secondary={screen.available ? screen.detail : screen.reason}
              disabled={!screen.available}
              onClick={screen.onPress}
              testId="more-screen"
            />
            {state.remoteYes.enabled ? (
              <SheetRow
                icon={<Icon name="key" size={20} />}
                label="Open RustDesk"
                secondary="Remote Yes is on. Test the link before a prompt needs it."
                href={rustDeskLink(state.remoteYes.address)}
                testId="more-remote-yes"
              />
            ) : null}
          </SheetSection>

          <SheetSection title="This phone">
            <SheetRow
              icon={<SheetGlyph name="bell" />}
              label={alerts.label}
              secondary={alerts.detail}
              onClick={alerts.ask ? () => void actions.requestNotifyPermission() : undefined}
              trailing={alerts.on ? <Icon name="check" size={18} /> : undefined}
              testId="more-alerts"
            />
            <SheetRow
              icon={<SheetGlyph name="textSize" />}
              label="Text size"
              secondary={`${Math.round(scale * 100)}%`}
              trailing={
                <span className="moresheet__stepper" role="group" aria-label="Text size">
                  <button
                    type="button"
                    className="moresheet__step"
                    aria-label="Smaller text"
                    disabled={at <= 0}
                    onClick={() => setScale(TEXT_SCALE_STEPS[Math.max(0, at - 1)])}
                  >
                    <span className="moresheet__a" data-size="small">
                      A
                    </span>
                    <span aria-hidden="true">−</span>
                  </button>
                  <button
                    type="button"
                    className="moresheet__step"
                    aria-label="Larger text"
                    disabled={at >= TEXT_SCALE_STEPS.length - 1}
                    onClick={() => setScale(TEXT_SCALE_STEPS[Math.min(TEXT_SCALE_STEPS.length - 1, at + 1)])}
                  >
                    <span className="moresheet__a" data-size="large">
                      A
                    </span>
                    <span aria-hidden="true">+</span>
                  </button>
                </span>
              }
              testId="more-text-size"
            />
            <SheetRow
              icon={<SheetGlyph name="autoStop" />}
              label="Stop listening after a pause"
              secondary={autoStop ? 'On — sends after about two seconds of quiet' : 'Off — tap the mic again to finish'}
              role="switch"
              checked={autoStop}
              trailing={<SheetSwitch on={autoStop} />}
              onClick={() => {
                const next = !autoStop
                setVoiceAutoStop(next)
                setAutoStop(next)
              }}
              testId="more-auto-stop"
            />
          </SheetSection>

          <SheetSection>
            <SheetRow
              icon={<SheetGlyph name="signOut" />}
              label="Sign out"
              secondary={email ? `Signed in as ${email}` : undefined}
              tone="danger"
              onClick={() => setStep('sign-out')}
              testId="more-sign-out"
            />
          </SheetSection>
        </>
      )}
    </BottomSheet>
  )
}

/* ------------------------------------------------------------- alerts */

function isIPhone(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

function isInstalled(): boolean {
  if (typeof window === 'undefined') return false
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return standalone || window.matchMedia?.('(display-mode: standalone)').matches === true
}

/**
 * The notification row, in words. The label is the state (or the act, when
 * there is one to take); the second line is what it means for this phone.
 */
function alertsRow(
  permission: NotifySupport,
  pushActive: boolean
): { label: string; detail: string; ask: boolean; on: boolean } {
  if (permission === 'granted') {
    return {
      label: 'Alerts on',
      detail: pushActive
        ? 'A pane that needs you reaches this phone, even with Forge closed'
        : 'A pane that needs you raises an alert while Forge is in the background',
      ask: false,
      on: true
    }
  }
  if (permission === 'default') {
    return { label: 'Turn on alerts', detail: 'Hear about a pane that needs you', ask: true, on: false }
  }
  if (permission === 'denied') {
    return {
      label: 'Blocked in browser settings',
      detail: 'Allow notifications for this site in the browser to get alerts',
      ask: false,
      on: false
    }
  }
  if (isIPhone() && !isInstalled()) {
    return {
      label: 'Add to Home Screen to get alerts',
      detail: 'Share, then Add to Home Screen, then open Forge from there',
      ask: false,
      on: false
    }
  }
  return { label: 'Alerts not available', detail: 'This browser cannot show notifications', ask: false, on: false }
}

/* ---------------------------------------------------------- text size */

/**
 * A− / A+ for this phone. Stored in localStorage (`forge.textScale`), guarded
 * like every storage access on this page, and exposed as `--phone-text-scale`
 * on `.app` by Workspace. Nothing reads the variable yet — a later change
 * applies it to the chat, the cards and the terminal.
 */
export const TEXT_SCALE_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5]
const TEXT_SCALE_KEY = 'forge.textScale'

function readTextScale(): number {
  try {
    const stored = Number(localStorage.getItem(TEXT_SCALE_KEY))
    return TEXT_SCALE_STEPS.includes(stored) ? stored : 1
  } catch {
    return 1
  }
}

let textScale: number | null = null
const textScaleListeners = new Set<() => void>()

function currentTextScale(): number {
  if (textScale === null) textScale = readTextScale()
  return textScale
}

function storeTextScale(next: number): void {
  textScale = next
  try {
    if (next === 1) localStorage.removeItem(TEXT_SCALE_KEY)
    else localStorage.setItem(TEXT_SCALE_KEY, String(next))
  } catch {
    // Storage refused: the size holds for this page and is forgotten on reload.
  }
  for (const listener of textScaleListeners) listener()
}

function subscribeTextScale(listener: () => void): () => void {
  textScaleListeners.add(listener)
  return () => textScaleListeners.delete(listener)
}

export function useTextScale(): [number, (next: number) => void] {
  const value = useSyncExternalStore(subscribeTextScale, currentTextScale, () => 1)
  return [value, storeTextScale]
}
