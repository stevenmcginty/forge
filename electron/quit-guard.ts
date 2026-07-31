import { dialog, type BrowserWindow } from 'electron'
import { remoteControlName } from '@shared/remote'
import { liveSessions, type LiveSession } from './pty-host'
import { getSettings, setSettings } from './store'

/**
 * The "are you sure" on closing Forge.
 *
 * Closing the window kills every pane, and until there was something to say
 * about that, saying nothing was right. Now there is: Claude panes come back
 * where they left off (see electron/bridge/claude-session.ts) and everything
 * else does not, and which is which is worth a sentence before the lot goes.
 *
 * So this is not really a confirmation — it is a list of what is running and
 * what survives it. That is also why it only appears when something *is*
 * running: an empty Forge closes on the first click, as it always did.
 *
 * Its own module rather than another hundred lines of main.ts, and because the
 * waiver below is needed by stale-watcher.ts and updater.ts — which main.ts
 * imports, so a flag living there would be a cycle.
 */

/** True once the user has said yes, or once something else owns the shutdown. */
let allowed = false
/** A dialog is on screen; further close clicks must not stack another one. */
let asking = false

/**
 * Close without asking.
 *
 * For the deliberate restarts that have already asked in their own words — the
 * stale-build banner's Restart button and installing an update. Both relaunch
 * Forge on purpose, and neither should be met with a dialog asking whether the
 * button that was just pressed was meant.
 */
export function allowClose(): void {
  allowed = true
}

/** Called from the window's `close` handler, which has to decide synchronously. */
export function shouldConfirmClose(): boolean {
  if (allowed || asking) return false
  if (!getSettings().confirmOnQuit) return false
  return liveSessions().length > 0
}

/** Up to `max` pane names, then a count — a dialog is not a list view. */
function nameList(items: LiveSession[], max = 4): string {
  // The same "<project> — <pane>" label the phone shows for a remote session:
  // one naming rule for panes, wherever they are being described.
  const names = items.map((s) => remoteControlName(s.projectName, s.paneTitle))
  if (names.length <= max) return names.join(', ')
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`
}

/**
 * Ask, then close if the answer was yes.
 *
 * The caller has already called `event.preventDefault()`: nothing is closed
 * until this comes back, and if it never does — a dialog that will not open —
 * the app closes anyway rather than trapping the user inside it.
 */
export async function askBeforeClose(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return
  asking = true
  try {
    const live = liveSessions()
    const resuming = live.filter((s) => s.resumes)
    const losing = live.filter((s) => !s.resumes)

    const detail: string[] = []
    if (resuming.length) {
      detail.push(`Picks up where it left off next time: ${nameList(resuming)}.`)
    }
    if (losing.length) {
      detail.push(
        `Stopped for good: ${nameList(losing)}. Anything running there — a build, an install, an agent that is not Claude — is killed with the pane.`
      )
    }

    const { response, checkboxChecked } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Close Forge', 'Cancel'],
      // Cancel is both the default and the escape: the answer that loses work
      // should never be the one an absent-minded Enter or Escape gives.
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Close Forge',
      message: `${live.length} pane${live.length === 1 ? ' is' : 's are'} still running`,
      detail: detail.join('\n\n'),
      checkboxLabel: 'Don’t ask again',
      checkboxChecked: false
    })

    if (checkboxChecked) setSettings({ confirmOnQuit: false })
    if (response !== 0) return
    allowed = true
    if (!win.isDestroyed()) win.close()
  } catch (err) {
    console.error('[quit] close confirmation failed, closing anyway:', err)
    allowed = true
    if (!win.isDestroyed()) win.close()
  } finally {
    asking = false
  }
}
