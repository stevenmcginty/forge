/**
 * The slash-command reference and the changelog, parsed without a network.
 *
 *   node scripts/commands-check.mjs
 *
 * Everything Forge *decides* about these two documents is a pure function in
 * shared/commands.ts, so the documents themselves can be a pair of string
 * literals here — captured verbatim from the live pages on 2026-07-30, escapes
 * and all. That is the whole point of the file: the one thing realistically
 * likely to break is somebody else's markdown changing shape, and this is what
 * notices.
 *
 * The four that matter:
 *
 *  1. Escaped pipes. `/advisor [model\|off]` is one row, not three cells of
 *     rubble — and the backslash must not survive into the UI.
 *  2. Aliases. `/new` has to be findable, or search lies about what exists.
 *  3. `releasesAhead`. "3 new releases" is the badge; getting the comparison
 *     backwards means nagging forever or never mentioning an update at all.
 *  4. commandToType. The argument form is documentation and must never be
 *     typed — `/add-dir <path>` submitted literally is a wrong answer that
 *     looks like a helpful one.
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const {
  BUNDLED_COMMANDS,
  CHANGELOG_URL,
  COMMANDS_DOC_URL,
  commandSignature,
  commandToType,
  matchesQuery,
  needsNewerCli,
  parseChangelog,
  parseCommandsDoc,
  rankCommands,
  releasesAhead
} = await import('../shared/commands.ts')

let failures = 0
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) {
    failures++
    console.error(`  FAIL  ${what}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  } else {
    console.log(`  ok    ${what}`)
  }
}
function section(title) {
  console.log(`\n${title}`)
}

/* ------------------------------------------------------------------ input
 *
 * Captured from https://code.claude.com/docs/en/commands.md — including the
 * prose above the table and the note below it, because the parser has to walk
 * past both without tripping.
 */
const DOC = `# Commands reference

> Built-in slash commands.

Some prose that is not a table at all.

| Command | Description |
|---------|-------------|
| \`/add-dir <path>\` | Add a working directory for file access during the current session. Typing a partial path shows matching directory suggestions |
| \`/advisor [model\\|off]\` | Enable or disable the advisor tool, which consults a second model. Accepts \`opus\`, \`sonnet\`, or a full model ID |
| \`/clear [name]\` | Start a new conversation with empty context. Pass a name to label the previous conversation. Aliases: \`/reset\`, \`/new\` |
| \`/exit\` | Exit the CLI. In an attached background session, this detaches. Alias: \`/quit\` |
| \`/mcp [reconnect <server>\\|enable\\|disable [<server>\\|all]]\` | Manage MCP server connections and OAuth authentication |
| \`/model [model]\` | Switch the AI model and save it as your default for new sessions. Requires Claude Code v2.1.205 or later |
| \`/cd <path>\` | {/* min-version: 2.1.169 */}Move this session to a new [working directory](/docs/en/settings#cd). Requires Claude Code v2.1.169 or later |
| \`/batch <instruction>\` | **[Skill](/docs/en/skills#bundled-skills).** Orchestrate large-scale changes across a codebase, keeping \`<file>\` markers intact |

<Note>
  Custom commands have been merged into skills.
</Note>
`

const CHANGELOG = `# Changelog

## 2.1.220

- Bug fixes and reliability improvements

## 2.1.219

- Claude Opus 5 is now the default model
- Added network allowlist configuration for sandboxed commands

## 2.1.218

- \`/code-review\` now runs as a background subagent

## 2.1.217

- Windows path corruption fix
`

/* ------------------------------------------------------------- the table */

section('The docs table')

const commands = parseCommandsDoc(DOC)

check('every command row, and nothing else', commands.map((c) => c.name), [
  'add-dir',
  'advisor',
  'clear',
  'exit',
  'mcp',
  'model',
  'cd',
  'batch'
])

// 1. Escaped pipes — the row survives, and the backslash does not.
const advisor = commands.find((c) => c.name === 'advisor')
check('an escaped pipe stays one row', advisor.args, '[model|off]')
check('the nastiest argument form in the page', commands.find((c) => c.name === 'mcp').args,
  '[reconnect <server>|enable|disable [<server>|all]]')
check('no backslash reaches the UI', /\\/.test(JSON.stringify(commands)), false)

check('the signature is what a heading shows', commandSignature(advisor), '/advisor [model|off]')

// Summary is the first sentence; detail is the lot.
check(
  'summary stops at the first full stop',
  commands.find((c) => c.name === 'add-dir').summary,
  'Add a working directory for file access during the current session.'
)
check(
  'detail keeps everything',
  commands.find((c) => c.name === 'add-dir').detail.endsWith('directory suggestions'),
  true
)
// A version number inside a sentence must not end it.
check(
  'v2.1.205 does not look like a full stop',
  commands.find((c) => c.name === 'model').summary,
  'Switch the AI model and save it as your default for new sessions.'
)

/* The page is MDX, not prose. Everything below is a real artefact taken from
 * the live page — each one used to reach the screen verbatim. */
section('MDX, made readable')

const cd = commands.find((c) => c.name === 'cd')
check('a version marker never reaches the text', cd.summary, 'Move this session to a new working directory.')
check('...it becomes a field instead', cd.minVersion, '2.1.169')
check('a link keeps its words and loses its path', /docs\/en/.test(cd.detail), false)
check('no MDX comment survives anywhere', commands.some((c) => c.detail.includes('{/*')), false)
check('no markdown link survives anywhere', commands.some((c) => /\]\([^)]*\)/.test(c.detail)), false)
check('no backticks survive', commands.some((c) => c.detail.includes('`')), false)

const batch = commands.find((c) => c.name === 'batch')
check('bold markers go, the word stays', batch.summary, 'Skill.')
// The reason HTML tags are NOT stripped: these are argument placeholders.
check('an angle-bracket placeholder is not a tag', batch.detail.includes('<file>'), true)
check('nor is one in the argument form', cd.args, '<path>')

check('a command with no marker has no field', 'minVersion' in commands.find((c) => c.name === 'exit'), false)

section('Too new for the CLI you have')
check('older CLI than the command needs', needsNewerCli(cd, '2.1.100'), true)
check('exactly the version it needs is fine', needsNewerCli(cd, '2.1.169'), false)
check('newer is fine', needsNewerCli(cd, '2.2.0'), false)
check('no marker, no claim', needsNewerCli(commands.find((c) => c.name === 'exit'), '1.0.0'), false)
check('no installed version, no claim', needsNewerCli(cd, null), false)

// 2. Aliases.
section('Aliases')
check('two aliases, listed', commands.find((c) => c.name === 'clear').aliases, ['reset', 'new'])
check('one alias, singular heading', commands.find((c) => c.name === 'exit').aliases, ['quit'])
check('an alias is searchable', matchesQuery(commands.find((c) => c.name === 'clear'), 'new'), true)
check('a leading slash in the query is ignored', matchesQuery(advisor, '/advis'), true)
check('prose is searchable too', matchesQuery(commands.find((c) => c.name === 'mcp'), 'oauth'), true)
check('a miss is a miss', matchesQuery(advisor, 'zzzz'), false)

section('Ranking')
// `/model` starts with "mo"; `/advisor` only says "model" in its prose. Name first.
check('name prefix beats a prose mention', rankCommands(commands, 'mo').map((c) => c.name), [
  'model',
  'advisor',
  'cd'
])
check('an alias prefix beats a body match', rankCommands(commands, 'quit').map((c) => c.name), ['exit'])
check('an empty query keeps the docs order', rankCommands(commands, '').length, commands.length)

/* 4. What actually gets typed. */
section('Typing')
check('no argument: no trailing space', commandToType(commands.find((c) => c.name === 'exit')), '/exit')
check('an argument form is never typed', commandToType(commands.find((c) => c.name === 'add-dir')), '/add-dir ')
check('nor is the escaped one', commandToType(advisor), '/advisor ')

/* ---------------------------------------------------------- the changelog */

section('The changelog')

const releases = parseChangelog(CHANGELOG)
check('every version, newest first', releases.map((r) => r.version), ['2.1.220', '2.1.219', '2.1.218', '2.1.217'])
check('bullets belong to their version', releases[1].bullets, [
  'Claude Opus 5 is now the default model',
  'Added network allowlist configuration for sandboxed commands'
])
check('the limit is honoured', parseChangelog(CHANGELOG, 2).map((r) => r.version), ['2.1.220', '2.1.219'])
check('a heading that is not a version is not one', parseChangelog('## Unreleased\n- nope\n'), [])

// 3. THE COMPARISON. Everything the badge claims rests on this.
section('What is new since yours')
check('three releases ahead of 2.1.217', releasesAhead(releases, '2.1.217').map((r) => r.version), [
  '2.1.220',
  '2.1.219',
  '2.1.218'
])
check('up to date is empty, not "everything"', releasesAhead(releases, '2.1.220'), [])
check('ahead of the changelog is still empty', releasesAhead(releases, '2.2.0'), [])
check('no installed version claims nothing', releasesAhead(releases, null), [])
// The bug this exists to catch: 2.1.220 vs 2.1.99 is not string order.
check(
  'double digits sort as numbers',
  releasesAhead([{ version: '2.1.220', bullets: [] }, { version: '2.1.99', bullets: [] }], '2.1.100').map(
    (r) => r.version
  ),
  ['2.1.220']
)

/* -------------------------------------------------------------- fallback */

section('The bundled snapshot')
check('big enough to be worth having', BUNDLED_COMMANDS.length >= 30, true)
check('every entry has a name and a summary', BUNDLED_COMMANDS.every((c) => c.name && c.summary), true)
check('no duplicate names', new Set(BUNDLED_COMMANDS.map((c) => c.name)).size, BUNDLED_COMMANDS.length)
check('no leading slashes in names', BUNDLED_COMMANDS.some((c) => c.name.startsWith('/')), false)
check('it survives the same search the live list does', rankCommands(BUNDLED_COMMANDS, 'context').length >= 1, true)

section('Sources')
check('the docs page is fetched as raw markdown', COMMANDS_DOC_URL.endsWith('.md'), true)
check('the changelog is the raw file, not the API', CHANGELOG_URL.startsWith('https://raw.githubusercontent.com/'), true)

/* ------------------------------------------------------------- rubbish in */

section('Rubbish in, empty out')
check('empty string', parseCommandsDoc(''), [])
check('not markdown at all', parseCommandsDoc('<html><body>404</body></html>'), [])
check('a table of something else', parseCommandsDoc('| Name | Age |\n|---|---|\n| Steve | 40 |'), [])
check('an unclosed row', parseCommandsDoc('| `/help` |'), [])
check('null-ish', parseCommandsDoc(undefined), [])
check('changelog of nothing', parseChangelog(''), [])

console.log(failures === 0 ? '\nAll command-reference checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
