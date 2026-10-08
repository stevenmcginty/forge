import { useEffect, useRef } from 'react'
import type { MiniBarCall, MiniBarState, MiniBarViewApi } from '@shared/minibar'
import { comboFromEvent } from '@/lib/keymap'
import { createKeyForwarder, type Forwarded } from '@/lib/miniBarKeys'
import { isModifierHotkey } from '@/lib/stt-gesture'

/**
 * Keys while the mini bar has focus (docs/MINI-BAR.md, 4.5 and 5.5 a).
 *
 * Shortcuts: a chord from `state.keymap` (Steve's keymap, cut to what makes
 * sense without the big window) is taken here, so Ctrl+T never reaches the
 * box, and run in the host. Two act on this window instead: Ask Forge focuses
 * the box, All projects opens the project list. A `restore` one sends the
 * command and brings Forge back, where it shows.
 *
 * Talk keys: only the raw presses go to the host, which plays them into the
 * same gesture machine as the main window (src/lib/miniBarKeys.ts). Plain
 * typing in the box is untouched, and a modifier talk key is never swallowed.
 */
export function useMiniKeys(state: MiniBarState | null, api: MiniBarViewApi | undefined): void {
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    if (!api) return undefined
    const forward = createKeyForwarder(() => stateRef.current?.talkKeys)
    const send = (out: Forwarded[]): void => {
      for (const k of out) api.call(k as MiniBarCall)
    }

    const runLocal = (id: string): boolean => {
      if (id === 'voice.hubCard') {
        document.querySelector<HTMLTextAreaElement>('.mb-box')?.focus()
        return true
      }
      if (id === 'rail.toggle') {
        document.querySelector<HTMLButtonElement>('.mb-proj')?.click()
        return true
      }
      return false
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (forward.isTalkKey(e.code)) {
        send(forward.keydown(e))
        // F8 and friends are the talk key's alone; a modifier still types its capital.
        if (!isModifierHotkey(e.code)) e.preventDefault()
        return
      }
      send(forward.keydown(e))
      const combo = comboFromEvent(e)
      if (!combo) return
      const hit = stateRef.current?.keymap.find((k) => k.chord === combo)
      if (!hit) return
      e.preventDefault()
      e.stopPropagation()
      if (runLocal(hit.command)) return
      api.call({ t: 'command', id: hit.command })
      if (hit.scope === 'restore') void api.openMain()
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      send(forward.keyup(e))
    }
    const onPointer = (): void => {
      send(forward.pointer())
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('pointerdown', onPointer, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointerdown', onPointer, true)
    }
  }, [api])
}
