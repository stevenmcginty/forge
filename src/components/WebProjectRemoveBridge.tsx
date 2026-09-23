import { useEffect, useRef } from 'react'
import { useApp } from '@/state/AppState'

/**
 * A browser asking for a project to come off the rail — Forge Web's "Remove
 * project…". Renders nothing.
 *
 * Main has already checked the id against its own list (electron/web-host.ts's
 * `dispatchProjectRemove`); this performs it with `removeProject`, the action
 * the rail's own menu item calls, so the panes close and the layout goes
 * exactly as they would from a click at the desk. The folder is never touched.
 *
 * Its own component rather than another effect beside `onProjectAdd` in
 * src/state/AppState.tsx only so it could be added without editing that file;
 * it reaches the reducer through `useApp`, the same as any other consumer.
 *
 * Every step of `window.forge?.web?.onProjectRemove?.(...)` is optional-chained
 * on purpose: a Forge that booted before this existed has a preload without
 * the method, and a TypeError here would blank the renderer — and with it the
 * phone, whose layout ops run through it.
 */
export function WebProjectRemoveBridge(): null {
  const { state, actions } = useApp()
  // Read at the moment a request lands rather than subscribed to, so a project
  // added or renamed at the desk does not tear the subscription down and up.
  const projects = useRef(state.projects)
  projects.current = state.projects
  const remove = useRef(actions.removeProject)
  remove.current = actions.removeProject

  useEffect(() => {
    const unsubscribe = window.forge?.web?.onProjectRemove?.(({ requestId, projectId }) => {
      const answer = (error?: string): void => window.forge?.web?.commandResult?.(requestId, error)
      const id = String(projectId ?? '')
      if (!projects.current.some((p) => p.id === id)) return answer('No project by that id on this desktop.')
      remove.current(id)
      return answer()
    })
    return () => unsubscribe?.()
  }, [])

  return null
}
