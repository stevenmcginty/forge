import { datesApi } from '@/lib/datesApi'
import { registerSurface } from '@/lib/shellSlots'
import { uiCommands } from '@/lib/uiCommands'
import { DateAlertNotice } from './DateAlertNotice'
import { DatesGlyph } from './DatesGlyph'
import { DatesSurface } from './DatesSurface'

/**
 * Plugs Dates into the shell: a `dates` canvas surface that takes the whole
 * stage (a mode in the switcher, `set-mode dates`), whose glyph carries the
 * count of dates that need Steve soon. A click on a date notification brings
 * the window forward (main does that) and opens this surface (here).
 *
 * Call `registerDates()` once at startup. It returns the undo.
 */
export function registerDates(): () => void {
  const offSurface = registerSurface({
    id: 'dates',
    title: 'Dates',
    placement: 'full',
    order: 40,
    // The glyph is drawn once, in the switcher, whatever mode is up: the alert notice rides with it.
    glyph: (
      <>
        <DatesGlyph />
        <DateAlertNotice />
      </>
    ),
    render: DatesSurface
  })
  const offOpen = datesApi()?.onOpen(() => uiCommands.run('set-mode', 'dates'))
  return () => {
    offOpen?.()
    offSurface()
  }
}
