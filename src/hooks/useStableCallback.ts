import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * A callback whose identity never changes but which always runs the latest
 * `fn` — for handlers passed to memoised children (Wall tiles, panes), where a
 * fresh function every render would re-render every one of them.
 *
 * Only for event handlers and effects: the latest `fn` is swapped in after
 * commit, so calling the result during render would run the previous one.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}
