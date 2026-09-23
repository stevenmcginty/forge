import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { WEB_FEATURE_PASSKEY, type WebPasskeyInfo } from '@shared/web'
import { Icon } from '@/components/Icon'
import { useDeskFacts } from '../lib/features'
import {
  biometricName,
  biometricUnlockLabel,
  enrolPasskey,
  forgetPasskey,
  listPasskeys,
  platformPasskeyAvailable,
  prepareEnrolment,
  thisDevicePasskey,
  type PreparedEnrolment
} from '../lib/passkey'
import { speakSample, speechSupported, useVoices } from '../lib/speak'
import { getReadAloudVoice, getVoiceAutoStop, setReadAloudVoice, setVoiceAutoStop } from '../lib/voice-prefs'
import { useForge, type NotifySupport } from '../state'
import { BottomSheet, SheetConfirm, SheetGlyph, SheetRow, SheetSection, SheetSwitch } from './BottomSheet'
import { FingerprintGlyph } from './Connection'
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
  const [step, setStep] = useState<'list' | 'sign-out' | 'passkey-forget' | 'voice'>('list')
  const [autoStop, setAutoStop] = useState(getVoiceAutoStop)
  const [voiceURI, setVoiceURI] = useState(getReadAloudVoice)
  const voices = useVoices()
  const [scale, setScale] = useTextScale()
  const unlock = usePasskeyRow(open)

  // Every opening starts on the list, reading the stored preference afresh —
  // the composer may have changed nothing, but another tab may have.
  useEffect(() => {
    if (!open) return
    setStep('list')
    setAutoStop(getVoiceAutoStop())
    setVoiceURI(getReadAloudVoice())
  }, [open])

  const alerts = alertsRow(state.notifyPermission, state.pushActive)
  const email = state.session?.email ?? ''
  const at = TEXT_SCALE_STEPS.indexOf(scale)
  const chosenVoice = voiceURI ? (voices.find((voice) => voice.voiceURI === voiceURI) ?? null) : null

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      onBack={step !== 'list' ? () => setStep('list') : undefined}
      label={
        step === 'sign-out'
          ? 'Sign out'
          : step === 'passkey-forget'
            ? biometricUnlockLabel()
            : step === 'voice'
              ? 'Read-aloud voice'
              : 'More'
      }
      title={step === 'sign-out' || step === 'passkey-forget' ? null : undefined}
      subtitle={step === 'voice' ? 'Tap a voice to hear it' : undefined}
      testId="more-sheet"
    >
      {step === 'voice' ? (
        <VoicePicker
          voices={voices}
          chosen={voiceURI}
          onPick={(voice) => {
            const uri = voice?.voiceURI ?? ''
            setReadAloudVoice(uri)
            setVoiceURI(uri)
            // Straight into speech, no await: the phone only talks inside the tap.
            speakSample(voice)
          }}
        />
      ) : step === 'passkey-forget' ? (
        <SheetConfirm
          question={`Stop unlocking with your ${biometricName()} on this phone?`}
          detail="The desktop forgets this phone's passkey at once. The PIN keeps working, and you can set it up again here."
          confirmLabel="Forget on this phone"
          onCancel={() => setStep('list')}
          onConfirm={() => {
            setStep('list')
            void unlock.forget()
          }}
          testId="passkey-forget-confirm"
        />
      ) : step === 'sign-out' ? (
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
            {speechSupported() ? (
              <SheetRow
                icon={<Icon name="voice" size={20} />}
                label="Read-aloud voice"
                secondary={
                  chosenVoice ? chosenVoice.name : voiceURI && !voices.length ? 'Loading voices…' : 'Automatic'
                }
                onClick={() => setStep('voice')}
                testId="more-read-aloud-voice"
              />
            ) : null}
            {unlock.row ? (
              <SheetRow
                icon={<FingerprintGlyph />}
                label={biometricUnlockLabel()}
                secondary={unlock.row.detail}
                disabled={!unlock.row.onPress}
                onClick={unlock.row.onPress === 'forget' ? () => setStep('passkey-forget') : unlock.row.onPress}
                trailing={unlock.row.on ? <Icon name="check" size={18} /> : undefined}
                testId="more-passkey"
              />
            ) : null}
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

/* ------------------------------------------------------ fingerprint unlock */

interface PasskeyRow {
  on: boolean
  detail: string
  /** A handler, `'forget'` (the row opens the confirm step), or absent for a greyed row. */
  onPress?: (() => void) | 'forget'
}

/**
 * The "Fingerprint unlock" row: shown only when the desktop announces passkeys
 * and has a PIN set (this socket had to answer one to get in). On: this phone's
 * credential is in the desktop's list — tap to forget it. Off: tap to set up.
 * Either change needs a socket opened with the PIN itself; one opened with the
 * fingerprint says so instead of offering a button the desktop would refuse.
 */
function usePasskeyRow(open: boolean): { row: PasskeyRow | null; forget: () => Promise<void> } {
  const { actions } = useForge()
  const facts = useDeskFacts()
  const shown = facts.features.includes(WEB_FEATURE_PASSKEY) && facts.unlockedWith !== 'none'
  const [capable, setCapable] = useState<boolean | null>(null)
  const [list, setList] = useState<{ mine: WebPasskeyInfo | null; canRegister: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const prepared = useRef<PreparedEnrolment | null>(null)

  useEffect(() => {
    if (!open || !shown) return
    let gone = false
    setList(null)
    void (async () => {
      const can = await platformPasskeyAvailable()
      if (gone) return
      setCapable(can)
      const answer = await listPasskeys(actions.request)
      if (gone) return
      if (!answer.ok) {
        setList({ mine: null, canRegister: false })
        return
      }
      const mine = thisDevicePasskey(answer.passkeys)
      setList({ mine, canRegister: answer.canRegister })
      // Ready before the tap, so the tap reaches the biometric inside its gesture.
      prepared.current = can && !mine && answer.canRegister ? await prepareEnrolment(actions.request) : null
    })()
    return () => {
      gone = true
    }
  }, [open, shown, actions])

  const setUp = async (): Promise<void> => {
    setBusy(true)
    const outcome = await enrolPasskey(actions.request, prepared.current)
    prepared.current = null
    setBusy(false)
    if (outcome.ok) {
      setList({ mine: thisDevicePasskey(outcome.passkeys), canRegister: outcome.canRegister })
      return
    }
    if (!outcome.cancelled) actions.setNotice(outcome.message)
    prepared.current = await prepareEnrolment(actions.request)
  }

  const forget = async (): Promise<void> => {
    const mine = list?.mine
    if (!mine) return
    setBusy(true)
    const outcome = await forgetPasskey(actions.request, mine.credentialId)
    setBusy(false)
    if (outcome.ok) {
      setList({ mine: thisDevicePasskey(outcome.passkeys), canRegister: outcome.canRegister })
      return
    }
    actions.setNotice(outcome.message)
  }

  if (!shown) return { row: null, forget }
  if (capable === false) return { row: { on: false, detail: 'This phone cannot hold a passkey' }, forget }
  if (!list || capable === null) return { row: { on: false, detail: 'Checking…' }, forget }
  if (busy) return { row: { on: !!list.mine, detail: 'Waiting for the phone…' }, forget }
  if (list.mine) {
    return list.canRegister
      ? { row: { on: true, detail: 'On — tap to forget on this phone', onPress: 'forget' }, forget }
      : { row: { on: true, detail: 'On — unlock with the PIN to change this' }, forget }
  }
  return list.canRegister
    ? { row: { on: false, detail: 'Off — tap to set up', onPress: () => void setUp() }, forget }
    : { row: { on: false, detail: 'Off — unlock with the PIN to set this up' }, forget }
}

/* --------------------------------------------------------- read-aloud voice */

function voiceLang(voice: SpeechSynthesisVoice): string {
  return voice.lang.replace('_', '-')
}

/**
 * The phone's voices in two groups: its own language first (the exact locale,
 * then the rest of the language, each by name), and every other language after,
 * by language then name. The list is the device's own — Android and iPhone
 * offer different voices — so nothing here names one.
 */
function groupVoices(voices: SpeechSynthesisVoice[]): {
  mine: SpeechSynthesisVoice[]
  other: SpeechSynthesisVoice[]
} {
  const want = (navigator.language || 'en').toLowerCase()
  const base = want.split('-')[0]
  const byName = (a: SpeechSynthesisVoice, b: SpeechSynthesisVoice): number => a.name.localeCompare(b.name)
  const exact: SpeechSynthesisVoice[] = []
  const near: SpeechSynthesisVoice[] = []
  const other: SpeechSynthesisVoice[] = []
  for (const voice of voices) {
    const lang = voiceLang(voice).toLowerCase()
    if (lang === want) exact.push(voice)
    else if (lang.split('-')[0] === base) near.push(voice)
    else other.push(voice)
  }
  other.sort((a, b) => voiceLang(a).localeCompare(voiceLang(b)) || byName(a, b))
  return { mine: [...exact.sort(byName), ...near.sort(byName)], other }
}

/**
 * The list the "Read-aloud voice" row opens: Automatic, the phone's own
 * language, then other languages folded behind one row (Android lists hundreds).
 * A tap picks, saves and plays a sample, and the sheet stays open so another
 * voice can be tried. The chosen row carries the tick — a shape, not a tint.
 */
function VoicePicker({
  voices,
  chosen,
  onPick
}: {
  voices: SpeechSynthesisVoice[]
  /** The saved `voiceURI`; empty for Automatic. */
  chosen: string
  onPick: (voice: SpeechSynthesisVoice | null) => void
}): ReactNode {
  const [showOther, setShowOther] = useState(false)
  const { mine, other } = groupVoices(voices)
  const chosenFound = voices.some((voice) => voice.voiceURI === chosen)
  const othersOpen = showOther || other.some((voice) => voice.voiceURI === chosen) || (!mine.length && other.length > 0)

  const row = (voice: SpeechSynthesisVoice, i: number): ReactNode => (
    <VoiceRow
      key={`${i}:${voice.voiceURI}`}
      label={voice.name}
      note={`${voiceLang(voice)} · ${voice.localService ? 'On device' : 'Online'}`}
      current={voice.voiceURI === chosen}
      onPick={() => onPick(voice)}
    />
  )

  return (
    <>
      <SheetSection title="This phone's language">
        <div role="radiogroup" aria-label="Read-aloud voice">
          <VoiceRow
            label="Automatic"
            note="A voice in this phone's language, on-device first"
            // A saved voice the phone no longer has speaks as Automatic, so it reads as one.
            current={!chosen || (voices.length > 0 && !chosenFound)}
            onPick={() => onPick(null)}
          />
          {mine.map(row)}
        </div>
        {!voices.length ? <p className="mseg__note">Loading voices…</p> : null}
      </SheetSection>
      {other.length ? (
        <SheetSection title="Other languages">
          {othersOpen ? (
            <div role="radiogroup" aria-label="Read-aloud voice, other languages">
              {other.map(row)}
            </div>
          ) : (
            <SheetRow
              icon={<Icon name="globe" size={20} />}
              label={`Show ${other.length} more ${other.length === 1 ? 'voice' : 'voices'}`}
              onClick={() => setShowOther(true)}
              testId="voice-show-other"
            />
          )}
        </SheetSection>
      ) : null}
      <p className="mseg__note">More voices can be added in the phone's text-to-speech settings.</p>
    </>
  )
}

/** One voice: ModelChip's pick row — a radio by role, a tick on the chosen one. */
function VoiceRow({
  label,
  note,
  current,
  onPick
}: {
  label: string
  note: string
  current: boolean
  onPick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className="bsrow mpick"
      role="radio"
      aria-checked={current}
      data-current={current ? 'true' : undefined}
      onClick={onPick}
    >
      <span className="bsrow__text">
        <span className="bsrow__label">{label}</span>
        <span className="bsrow__sub">{note}</span>
      </span>
      <span className="bsrow__trail mpick__tick" aria-hidden="true">
        {current ? <Icon name="check" size={20} /> : null}
      </span>
    </button>
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
