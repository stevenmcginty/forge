/**
 * Rules check for the left rail's section stack.
 *
 *   node scripts/rail-check.mjs
 *
 * Four sections, three of which can be switched off and all four of which can be
 * open, closed or dragged to a height, is enough combinations that the rules
 * deserve to be somewhere other than a component. They live in shared/rail.ts
 * and src/lib/railstack.ts with no DOM in either, and this file holds them to it.
 *
 * The last block is the important one. shared/rail.ts is imported by *both*
 * electron/store.ts (for the settings normaliser) and the renderer, which is the
 * arrangement that stops main and renderer disagreeing about what a rail is. If
 * anyone ever "helpfully" copies DEFAULT_RAIL_OPEN into store.ts as a literal,
 * the two will drift the first time a section is added and nothing else will
 * notice — so this asserts the store's own defaults still come from the shared
 * file, the same way hub:check does for the voice hub.
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('@/')) {
      return next(new URL(`../src/${spec.slice('@/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const R = await import('../shared/rail.ts')
const S = await import('../src/lib/railstack.ts')

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✕ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** A settings object with only the fields the rail cares about. */
const settings = (patch = {}) => ({
  railTasks: true,
  railGit: false,
  railActivity: false,
  railOpen: [...R.DEFAULT_RAIL_OPEN],
  railHeights: {},
  ...patch
})

/* ------------------------------------------------------------------ order */

console.log('\norder')
ok(
  JSON.stringify(R.RAIL_SECTION_ORDER) === JSON.stringify(['projects', 'tasks', 'git', 'activity']),
  'the four sections, in rail order',
  JSON.stringify(R.RAIL_SECTION_ORDER)
)
ok(R.RAIL_SECTION_ORDER[0] === R.RAIL_ALWAYS_ON, 'the always-on section is the first one')
ok(new Set(R.RAIL_SECTION_ORDER).size === R.RAIL_SECTION_ORDER.length, 'no id appears twice')
ok(
  R.DEFAULT_RAIL_OPEN.every((id) => R.RAIL_SECTION_ORDER.includes(id)),
  'every default-open id is a real section'
)

/* ---------------------------------------------------------------- visible */

console.log('\nvisibility')
ok(
  JSON.stringify(S.visibleSections(settings())) === JSON.stringify(['projects', 'tasks']),
  'out of the box: projects and tasks only',
  JSON.stringify(S.visibleSections(settings()))
)
ok(
  JSON.stringify(S.visibleSections(settings({ railGit: true, railActivity: true }))) ===
    JSON.stringify(['projects', 'tasks', 'git', 'activity']),
  'everything on gives all four, still in rail order'
)
ok(
  S.visibleSections(settings({ railTasks: false, railGit: false, railActivity: false })).includes('projects'),
  'projects survives every section being switched off'
)
ok(
  S.isEnabled(settings({ railTasks: false, railGit: false, railActivity: false }), 'projects'),
  'projects has no switch and is always enabled'
)
ok(!S.isEnabled(settings(), 'git'), 'git is off until asked for')
ok(!S.isEnabled(settings(), 'activity'), 'activity is off until asked for')
ok(
  JSON.stringify(S.visibleSections(settings({ railActivity: true }))) ===
    JSON.stringify(['projects', 'tasks', 'activity']),
  'a gap in the middle does not reorder what is left'
)

/* ------------------------------------------------------------------- open */

console.log('\nopen and closed')
ok(S.isOpen(settings(), 'projects'), 'projects starts open')
ok(!S.isOpen(settings(), 'git'), 'git starts closed')

const closedTasks = S.toggleOpen([...R.DEFAULT_RAIL_OPEN], 'tasks')
ok(!closedTasks.includes('tasks'), 'toggling an open section closes it')
ok(
  JSON.stringify(S.toggleOpen(closedTasks, 'tasks')) === JSON.stringify([...R.DEFAULT_RAIL_OPEN]),
  'toggling twice is a round trip',
  JSON.stringify(S.toggleOpen(closedTasks, 'tasks'))
)
ok(
  JSON.stringify(S.toggleOpen(['activity', 'projects'], 'git')) ===
    JSON.stringify(['projects', 'git', 'activity']),
  'the result is always in rail order, whatever order it went in',
  JSON.stringify(S.toggleOpen(['activity', 'projects'], 'git'))
)
ok(
  JSON.stringify(S.toggleOpen(['projects', 'nonsense'], 'git')) === JSON.stringify(['projects', 'git']),
  'an id that is not a section is dropped rather than carried'
)
ok(
  JSON.stringify(S.toggleOpen(['projects', 'projects'], 'git')) === JSON.stringify(['projects', 'git']),
  'a duplicate in the saved set collapses to one'
)

/* ---------------------------------------------------------------- heights */

console.log('\nheights')
const VH = 1000
ok(
  R.clampSectionHeight(R.RAIL_SECTION_MIN_H - 50, VH) === R.RAIL_SECTION_MIN_H,
  'below the floor comes back as the floor'
)
ok(
  R.clampSectionHeight(R.RAIL_SECTION_MAX_H + 500, 4000) === R.RAIL_SECTION_MAX_H,
  'above the ceiling comes back as the ceiling on a tall window'
)
ok(
  R.clampSectionHeight(500, 600) === Math.round(600 * R.RAIL_SECTION_MAX_VH),
  'a short window caps a section below the absolute ceiling',
  String(R.clampSectionHeight(500, 600))
)
ok(
  R.clampSectionHeight(400, 200) === R.RAIL_SECTION_MIN_H,
  'a window shorter than the floor still yields the floor, never less'
)
ok(R.clampSectionHeight(Number.NaN, VH) === R.RAIL_SECTION_DEFAULT_H, 'NaN never reaches CSS')
ok(R.clampSectionHeight(Infinity, VH) > 0, 'Infinity is clamped rather than passed through')
ok(R.clampSectionHeight(0, VH) === R.RAIL_SECTION_DEFAULT_H, 'zero is treated as "never dragged"')
ok(R.clampSectionHeight(-40, VH) === R.RAIL_SECTION_DEFAULT_H, 'a negative height is treated as "never dragged"')
ok(Number.isInteger(R.clampSectionHeight(240.6, VH)), 'the answer is always a whole number of pixels')

ok(S.sectionHeight(settings(), 'projects', VH) === null, 'projects has no height — it takes the slack')
ok(
  S.sectionHeight(settings(), 'git', VH) === R.RAIL_SECTION_DEFAULT_H,
  'an undragged section gets the default'
)
ok(
  S.sectionHeight(settings({ railHeights: { git: 999 } }), 'git', VH) ===
    R.clampSectionHeight(999, VH),
  'a saved height is clamped for the window it is drawn in'
)
ok(
  S.sectionHeight(settings({ railHeights: { projects: 300 } }), 'projects', VH) === null,
  'a height saved for projects is ignored rather than honoured'
)

/* ------------------------------------------------------------- id guarding */

console.log('\nid guarding')
ok(R.isRailSectionId('git'), 'a real id is accepted')
ok(!R.isRailSectionId('shots'), 'an id from another part of the rail is refused')
ok(!R.isRailSectionId(''), 'the empty string is refused')
ok(!R.isRailSectionId(null) && !R.isRailSectionId(7) && !R.isRailSectionId({}), 'non-strings are refused')

/* -------------------------------------------------------------- discovery */

console.log('\ndiscovery hint')
ok(S.showsDiscoveryHint(settings()), 'offered while both new sections are off')
ok(!S.showsDiscoveryHint(settings({ railGit: true })), 'gone once git is on')
ok(!S.showsDiscoveryHint(settings({ railActivity: true })), 'gone once activity is on')

/* ------------------------------------------------- main and renderer agree */

console.log('\nmain and renderer agree')
const storeSrc = await (await import('node:fs/promises')).readFile(
  new URL('../electron/store.ts', import.meta.url),
  'utf8'
)
ok(
  /from '@shared\/rail'/.test(storeSrc),
  'electron/store.ts takes its rail facts from shared/rail.ts'
)
ok(
  /railOpen:\s*\[\.\.\.DEFAULT_RAIL_OPEN\]/.test(storeSrc),
  'the store seeds railOpen from the shared constant, not a literal'
)
ok(
  !/railOpen:\s*\[\s*'/.test(storeSrc),
  'no hand-written railOpen literal has crept into the store'
)
ok(
  /railTasks:\s*s\.railTasks\s*\?\?/.test(storeSrc),
  'railTasks defaults on for a settings.json written before sections existed'
)
ok(
  /railGit:\s*Boolean\(/.test(storeSrc) && /railActivity:\s*Boolean\(/.test(storeSrc),
  'railGit and railActivity default off for the same file'
)
ok(
  /railHeights:\s*normaliseRailHeights\(/.test(storeSrc),
  'railHeights goes through the normaliser rather than straight off disk'
)
ok(
  /railOpen:.*isRailSectionId/s.test(storeSrc),
  'railOpen is filtered against the shared id list on load'
)

/* -------------------------------------------------------------------- end */

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
