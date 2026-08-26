import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { WatchdogStatus } from '@shared/types'
import { useApp } from '@/state/AppState'
import { Card, Row, Section, StateChip, Toggle, type ChipTone } from './parts'

/**
 * Always on — the "Keep Forge running" switch.
 *
 * Behind it is a scheduled task on this PC that runs a small script
 * (scripts/watchdog.mjs) for the whole logon session, outside Forge. Every ten
 * seconds it reads the heartbeat Forge's main process writes; no Forge process,
 * or a heartbeat gone stale, and it clears whatever is left of the old one and
 * relaunches. That is the entire mechanism, and the panel says so, because the
 * first question anybody asks of a switch that registers a task is what it
 * does to their machine: this one touches nothing beyond that task, sends
 * nothing anywhere, and watches only this Forge.
 *
 * `keepRunning` is main-owned (see MAIN_OWNED_SETTINGS in electron/main.ts):
 * the value and the task are flipped in one act by `watchdog:enable` and
 * `watchdog:disable`, so this panel mirrors what main reports rather than
 * writing the setting itself — the same arrangement as Forge Web's switch.
 *
 * Every `window.forge.watchdog` call is guarded: a renderer served by a newer
 * bundle than the preload it loaded with would otherwise throw here and unmount
 * the app, which strands the phone (see electron/renderer-watchdog.ts).
 */

function api() {
  return typeof window.forge?.watchdog?.status === 'function' ? window.forge.watchdog : null
}

function whenText(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return sameDay ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

export function AlwaysOnSection(): ReactNode {
  const { state, actions } = useApp()
  const [status, setStatus] = useState<WatchdogStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const supported = api() !== null

  const refresh = useCallback(async () => {
    const w = api()
    if (!w) return
    try {
      setStatus(await w.status())
    } catch (err) {
      setError(String(err))
    }
  }, [])

  // Read on arrival and every few seconds while the page is open: the task
  // can be stopped from Task Scheduler, and a relaunch changes the line below.
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const toggle = useCallback(
    async (on: boolean) => {
      const w = api()
      if (!w) return
      setBusy(true)
      setError('')
      try {
        const next = on ? await w.enable() : await w.disable()
        setStatus(next)
        // Mirror main's decision so the toggle does not flick back while the
        // debounced settings save is in flight. `keepRunning` is main-owned,
        // so this write never reaches settings.json.
        actions.patchSettings({ keepRunning: on })
      } catch (err) {
        setError(String(err))
      } finally {
        setBusy(false)
      }
    },
    [actions]
  )

  const enabled = state.settings.keepRunning
  let tone: ChipTone = 'off'
  let chip = 'Off'
  let line = 'Not installed. Closing Forge closes it.'
  if (enabled && status) {
    if (!status.installed) {
      tone = 'warn'
      chip = 'Missing'
      line = 'Switched on, but the scheduled task is gone — switch it off and on again to put it back.'
    } else if (status.paused) {
      tone = 'warn'
      chip = 'Paused'
      line = 'Installed, standing down for now — Quit from the tray pauses it for 30 minutes.'
    } else if (!status.running) {
      tone = 'warn'
      chip = 'Stopped'
      line = 'Installed, but no watchdog is running right now. It starts again at the next sign-in.'
    } else {
      tone = 'ok'
      chip = 'Watching'
      const last = whenText(status.lastRestart)
      line = last ? `Watching · last restart ${last}` : 'Watching · has not needed to restart Forge yet'
    }
  } else if (enabled) {
    tone = 'soon'
    chip = 'Checking'
    line = 'Checking the scheduled task…'
  }

  return (
    <Section
      title="Always on"
      blurb="Keep Forge running whenever this PC is on, so a phone or a browser is never left talking to a desktop that has gone."
    >
      <Card
        title="Keep Forge running"
        hint="Restart Forge if it closes, crashes or hangs."
        actions={<StateChip tone={tone}>{chip}</StateChip>}
      >
        <Row
          label="Keep Forge running"
          hint={
            !supported
              ? 'Restart Forge to pick this up — the running copy predates the switch.'
              : busy
                ? 'Working…'
                : line
          }
        >
          <Toggle
            checked={enabled}
            disabled={!supported || busy}
            onChange={(on) => void toggle(on)}
            label="Keep Forge running — restart it if it closes, crashes or hangs"
          />
        </Row>
        {error ? <p className="web-note">{error}</p> : null}
        <p className="web-note">
          This is a scheduled task on this PC, for your Windows account only. It runs a small script that watches
          this copy of Forge and relaunches it — nothing leaves the machine, and nothing else is touched. Quit from
          the tray icon still quits: it pauses the task for 30 minutes first.
        </p>
      </Card>
    </Section>
  )
}
