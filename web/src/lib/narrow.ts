import { useEffect, useState } from 'react'

/**
 * Is the window too narrow for the rail to be worth its 260px?
 *
 * A media query alone cannot answer this, and that is the whole reason this hook
 * exists rather than a CSS rule. The desktop's rail has *two markups* — the full
 * row, and a single tinted initial (`.prow__initial`) — chosen in
 * src/components/ProjectRail.tsx by a `collapsed` flag, not by a stylesheet.
 * Narrowing `.app__left` in CSS without telling React leaves the expanded markup
 * inside a 56px box: the heading clips to "PROJEC", the project name and path
 * are squeezed to nothing, and the git panel wraps to one word a line.
 *
 * So the breakpoint is read in JavaScript and handed to the same `collapsed`
 * prop a person toggling the rail sets. One collapsed state, one set of markup,
 * and the phone-width window is simply the rail collapsed by the window instead
 * of by a click.
 *
 * 640px matches the one breakpoint in web/src/styles.css; there is deliberately
 * only one, and it is a *fold* of the desktop layout rather than a second
 * design. Forge Mobile is a separate application and decision 7 keeps it out of
 * here.
 */
const NARROW = '(max-width: 640px)'

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(NARROW).matches)

  useEffect(() => {
    const query = window.matchMedia(NARROW)
    const update = (): void => setNarrow(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return narrow
}
