import { createContext, useContext, type ReactNode } from 'react'
import { useDictationEngine, type Dictation } from '@/hooks/useDictation'

/**
 * One microphone, shared.
 *
 * `useDictationEngine` holds a phrase subscription and the toggle hotkey, so
 * calling it from two components would insert every dictated sentence twice and
 * make Right Ctrl toggle twice — cancelling itself out. That was fine while the
 * status-bar pill was the only thing that showed dictation; the floating hub
 * shows the same state and drives the same toggle, which is what made this
 * necessary.
 *
 * So the engine runs once, here, and every pill is a view of it.
 */

const DictationContext = createContext<Dictation | null>(null)

export function DictationProvider({ children }: { children: ReactNode }): ReactNode {
  const dictation = useDictationEngine()
  return <DictationContext.Provider value={dictation}>{children}</DictationContext.Provider>
}

export function useDictation(): Dictation {
  const ctx = useContext(DictationContext)
  if (!ctx) throw new Error('useDictation must be used inside <DictationProvider>')
  return ctx
}
