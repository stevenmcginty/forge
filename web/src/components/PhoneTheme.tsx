import type { ReactNode } from 'react'
import type { ThemeCore } from '@shared/types'
import { Icon } from '@/components/Icon'
import { PHONE_THEMES, swatchOf } from '../deck/theme'
import { followsSystem, phoneOnlyPair, useSystemDark } from '../lib/phone-themes'
import { SheetSection } from './BottomSheet'
import './PhoneTheme.css'

/**
 * The theme, on the phone: the deck's six (deck/theme.ts) and WhatsApp
 * (lib/phone-themes.ts), as rows in the More sheet. Each is a swatch of its own
 * background, panel and accent, its name, and whether it is dark or light; the
 * one in use says "In use" and carries a tick, so the pick never rests on
 * telling swatches apart. A tap wears it at once — the sheet stays up over the
 * page, which is the preview.
 */
export function ThemePicker({ themeId, onPick }: { themeId: string; onPick: (id: string) => void }): ReactNode {
  const dark = useSystemDark()
  return (
    <SheetSection>
      <div role="radiogroup" aria-label="Theme">
        {PHONE_THEMES.map((core) => {
          const here = core.id === themeId
          const follows = followsSystem(core.id)
          return (
            <button
              key={core.id}
              type="button"
              className="bsrow ptheme"
              role="radio"
              aria-checked={here}
              data-current={here ? 'true' : undefined}
              data-theme-id={core.id}
              onClick={() => onPick(core.id)}
            >
              <span className="bsrow__icon">
                <ThemeSwatch core={core} />
              </span>
              <span className="bsrow__text">
                <span className="bsrow__label">{core.name}</span>
                <span className="bsrow__sub">
                  {follows ? `Follows your phone — ${dark ? 'dark' : 'light'} now` : core.appearance === 'light' ? 'Light' : 'Dark'}
                  {here ? ' — in use' : ''}
                </span>
              </span>
              <span className="bsrow__trail ptheme__tick" aria-hidden="true">
                {here ? <Icon name="check" size={20} /> : null}
              </span>
            </button>
          )
        })}
      </div>
    </SheetSection>
  )
}

/**
 * Background, a band of panel, and the accent as a dot: the theme at a glance.
 * A theme that follows the phone shows both halves, dark over light, split on
 * the diagonal.
 */
export function ThemeSwatch({ core, size = 28 }: { core: ThemeCore; size?: number }): ReactNode {
  const pair = phoneOnlyPair(core.id)
  if (pair) {
    const dark = swatchOf(pair.dark)
    const light = swatchOf(pair.light)
    return (
      <span
        className="ptheme__swatch"
        data-split="true"
        style={{ background: light.bg, width: size, height: size }}
        aria-hidden="true"
      >
        <span className="ptheme__half" style={{ background: dark.bg }} />
        <span className="ptheme__accent" style={{ background: dark.accent }} />
      </span>
    )
  }
  const sw = swatchOf(core)
  return (
    <span className="ptheme__swatch" style={{ background: sw.bg, width: size, height: size }} aria-hidden="true">
      <span className="ptheme__panel" style={{ background: sw.panel }} />
      <span className="ptheme__accent" style={{ background: sw.accent }} />
    </span>
  )
}
