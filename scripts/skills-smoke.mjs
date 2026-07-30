/**
 * Head-less proof of the skills library (M8).
 *
 * Bundles the *real* electron/skills-store.ts and shared/skills.ts with esbuild
 * and drives them exactly as the main process does: create from a template,
 * import a folder, list a library full of half-written skills, enable one into a
 * "~/.claude/skills" of our own, refuse to trample a folder we did not create,
 * and take our own links back out again.
 *
 *   npm run skills:smoke
 *
 * SAFETY: every directory here comes from mkdtemp(). The store is handed its
 * library and its claude-skills directory rather than reading `homedir()`, which
 * is exactly why this test can exist — Steve's real ~/.claude/skills is full of
 * skills he wrote by hand and nothing in this file can reach it. The final
 * check asserts that, by looking at the real path and confirming the run never
 * created anything in it.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-skills-smoke')

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

/** A skill folder on disk, written the way a human would write one. */
function writeSkill(dir, name, description, extra = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the thing.\n`,
    'utf8'
  )
  for (const [file, body] of Object.entries(extra)) {
    mkdirSync(join(dir, '..', '.'), { recursive: true })
    writeFileSync(join(dir, file), body, 'utf8')
  }
  return dir
}

const ALIAS = { '@shared': join(ROOT, 'shared'), '@': join(ROOT, 'src') }

async function bundle(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    absWorkingDir: ROOT,
    alias: ALIAS
  })
  return import(pathToFileURL(outfile).href)
}

/**
 * Several renderer modules in ONE bundle.
 *
 * It has to be one: `skillbus` holds the registered handler in a module-level
 * variable, and two separate esbuild bundles would each inline their own copy of
 * it — so the executor would look at a different registry from the one the test
 * wrote to and the fallback would "fail" for a reason that does not exist in the
 * app. One bundle, one module instance, same as the browser.
 */
async function bundleTogether(named, outfile) {
  const contents = Object.entries(named)
    .map(([alias, path]) => `export * as ${alias} from ${JSON.stringify(path.replace(/\\/g, '/'))}`)
    .join('\n')
  await build({
    stdin: { contents, resolveDir: ROOT, sourcefile: 'together.ts', loader: 'ts' },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    absWorkingDir: ROOT,
    alias: ALIAS
  })
  return import(pathToFileURL(outfile).href)
}

async function main() {
  const { SkillsStore, registerSkillsHandlers, setSkillsDirs } = await bundle(
    join(ROOT, 'electron', 'skills-store.ts'),
    join(scratch, 'skills-store.mjs')
  )
  const { parseFrontmatter, skillBody, skillTemplate, slugSkillName, isValidSkillName, usesSlashSkills, skillCommandFor } =
    await bundle(join(ROOT, 'shared', 'skills.ts'), join(scratch, 'skills.mjs'))

  const sandbox = mkdtempSync(join(tmpdir(), 'forge-skills-'))
  const libraryDir = join(sandbox, 'library')
  const claudeSkillsDir = join(sandbox, 'home', '.claude', 'skills')
  const agentsDir = join(sandbox, 'home', '.agents', 'skills')
  const geminiDir = join(sandbox, 'home', '.gemini', 'skills')
  const outside = join(sandbox, 'outside')
  mkdirSync(claudeSkillsDir, { recursive: true })
  mkdirSync(agentsDir, { recursive: true })
  mkdirSync(geminiDir, { recursive: true })

  const store = new SkillsStore({ libraryDir, claudeSkillsDir, peerDirs: [agentsDir, geminiDir] })

  /* ------------------------------------------------------- 1. frontmatter */

  const good = parseFrontmatter('---\nname: tidy-up\ndescription: Clean the thing.\n---\n\n# Tidy\n')
  log(good.ok && good.name === 'tidy-up' && good.description === 'Clean the thing.', 'plain frontmatter parses')

  const crlf = parseFrontmatter('\uFEFF---\r\nname: notepad\r\ndescription: Saved by Notepad.\r\n---\r\nbody\r\n')
  log(crlf.ok && crlf.name === 'notepad', 'a BOM and CRLF line endings do not defeat the parser')

  const folded = parseFrontmatter('---\nname: long\ndescription: >-\n  first part\n  second part\n---\n')
  log(folded.description === 'first part second part', 'a folded block description is joined onto one line')

  const quoted = parseFrontmatter('---\nname: "quoted"\ndescription: \'single\'\n---\n')
  log(quoted.name === 'quoted' && quoted.description === 'single', 'quotes are stripped')

  const extra = parseFrontmatter('---\nname: x\nlicense: MIT\nallowed-tools: Read, Grep\ndescription: D\n---\n')
  log(extra.name === 'x' && extra.description === 'D', 'keys we do not care about are skipped, not fatal')

  log(parseFrontmatter('no frontmatter at all').ok === false, 'a file with no --- block reports ok:false')
  log(parseFrontmatter('---\nname: unterminated\n').ok === false, 'an unterminated block reports ok:false')
  log(parseFrontmatter('').ok === false && parseFrontmatter(null).ok === false, 'empty and null never throw')

  log(skillBody('---\nname: a\n---\n\n# Heading\n\ntext\n') === '# Heading\n\ntext', 'the body is everything after the block')
  log(skillBody('# No frontmatter\n\ntext') === '# No frontmatter\n\ntext', 'a file with no block is all body')

  /* --------------------------------------------------------- 2. the names */

  log(slugSkillName('Release Checklist!') === 'release-checklist', 'a typed name becomes a folder name')
  log(slugSkillName('  ..\\..\\Windows  ') === 'windows', 'a traversal attempt is flattened to something harmless')
  log(slugSkillName('...') === '' && slugSkillName('') === '', 'a name with nothing usable in it is refused')
  log(!isValidSkillName('../evil') && !isValidSkillName('a/b') && !isValidSkillName('..'), 'separators are never valid')
  log(store.pathFor('../../evil') === null, 'pathFor refuses to leave the library')
  log(store.linkPathFor('..\\..\\evil') === null, 'and so does linkPathFor')

  /* ----------------------------------------------------- 3. from template */

  const created = store.createFromTemplate('Zz Forge Test Skill', 'Prove the library works end to end.')
  log(created.ok && created.name === 'zz-forge-test-skill', 'createFromTemplate slugs the name it was given')
  const templateFile = join(libraryDir, 'zz-forge-test-skill', 'SKILL.md')
  log(existsSync(templateFile), 'and writes a SKILL.md')
  const templateParsed = parseFrontmatter(readFileSync(templateFile, 'utf8'))
  log(
    templateParsed.ok && templateParsed.name === 'zz-forge-test-skill',
    'the template it writes parses with its own parser'
  )
  log(templateParsed.description === 'Prove the library works end to end.', 'and carries the description through')
  log(skillTemplate('two-words', 'x').includes('# Two Words'), 'the template titles itself in Title Case')
  log(store.createFromTemplate('zz-forge-test-skill', 'again').ok === false, 'a name already in the library is refused')
  log(store.createFromTemplate('   ', 'x').ok === false, 'an empty name is refused')

  /* ----------------------------------------------------------- 4. import */

  writeSkill(join(outside, 'imported-skill'), 'imported-skill', 'Came from somewhere else.')
  writeFileSync(join(outside, 'imported-skill', 'reference.md'), 'support file\n', 'utf8')
  const imported = store.importFolder(join(outside, 'imported-skill'))
  log(imported.ok && imported.name === 'imported-skill', 'importFolder copies a real skill folder in')
  log(existsSync(join(libraryDir, 'imported-skill', 'reference.md')), 'support files come with it')
  log(store.importFolder(join(outside, 'imported-skill')).ok === false, 'importing it twice is refused')

  mkdirSync(join(outside, 'not-a-skill'), { recursive: true })
  writeFileSync(join(outside, 'not-a-skill', 'readme.txt'), 'nope', 'utf8')
  const notASkill = store.importFolder(join(outside, 'not-a-skill'))
  log(!notASkill.ok && /SKILL\.md/.test(notASkill.error), 'a folder with no SKILL.md is refused by name')
  log(store.importFolder(join(outside, 'does-not-exist')).ok === false, 'a folder that is not there is refused')
  log(!existsSync(join(libraryDir, 'imported-skill.importing')), 'no staging folder is left behind')

  // The frontmatter name wins over the folder name — it is what the agent shows.
  writeSkill(join(outside, 'wrong-folder-name'), 'real-name', 'Named in its frontmatter.')
  log(store.importFolder(join(outside, 'wrong-folder-name')).name === 'real-name', 'the frontmatter name wins on import')

  /* ------------------------------------------------------------- 5. list */

  // Two broken ones, because a real skills folder always has some.
  mkdirSync(join(libraryDir, 'empty-folder'), { recursive: true })
  mkdirSync(join(libraryDir, 'malformed'), { recursive: true })
  writeFileSync(join(libraryDir, 'malformed', 'SKILL.md'), '# Just a heading\n\nno frontmatter here\n', 'utf8')

  const listed = store.list([])
  const by = (name) => listed.find((s) => s.name === name)
  log(listed.length === 5, `every folder is listed, broken or not (${listed.length})`)
  log(
    listed.map((s) => s.name).join(',') === [...listed.map((s) => s.name)].sort((a, b) => a.localeCompare(b)).join(','),
    'the list comes back in name order'
  )
  log(by('imported-skill').description === 'Came from somewhere else.', 'a good skill carries its description')
  log(by('empty-folder').problem?.includes('SKILL.md'), 'a folder with no SKILL.md says so instead of vanishing')
  log(by('empty-folder').title === 'empty-folder', 'and falls back to the folder name for a title')
  log(by('malformed').problem?.includes('frontmatter'), 'a SKILL.md with no frontmatter says so')
  log(by('malformed').title === 'malformed', 'and still shows up as a usable row')
  log(listed.every((s) => s.enabled === false && s.link === 'absent'), 'nothing is enabled until it is asked for')

  // The duplicate-skill hint. remotion-best-practices really does live in both
  // of Steve's other agent folders; Forge points it out and does nothing else.
  mkdirSync(join(agentsDir, 'imported-skill'), { recursive: true })
  mkdirSync(join(geminiDir, 'imported-skill'), { recursive: true })
  const withPeers = store.list([])
  log(
    withPeers.find((s) => s.name === 'imported-skill').alsoIn.length === 2,
    'a name that exists in another agent’s folder is flagged'
  )
  log(withPeers.find((s) => s.name === 'malformed').alsoIn.length === 0, 'and one that does not, is not')

  /* -------------------------------------------------- 6. enable and sync */

  const enabled = store.enable('zz-forge-test-skill')
  log(enabled.ok, 'enable() puts the skill in ~/.claude/skills')
  const linkPath = join(claudeSkillsDir, 'zz-forge-test-skill')
  log(existsSync(join(linkPath, 'SKILL.md')), 'and the SKILL.md is readable through it')
  const mode = store.linkStateFor('zz-forge-test-skill')
  log(mode === 'junction' || mode === 'copy', `the link is a junction or a marked copy (got ${mode})`)
  if (mode === 'junction') {
    log(lstatSync(linkPath).isSymbolicLink(), 'a junction reads back as a link, not a directory')
    // The whole point of a junction: edit the library, every session sees it.
    writeFileSync(join(libraryDir, 'zz-forge-test-skill', 'SKILL.md'), '---\nname: zz-forge-test-skill\ndescription: Edited.\n---\n', 'utf8')
    log(
      readFileSync(join(linkPath, 'SKILL.md'), 'utf8').includes('Edited.'),
      'an edit in the library is live through the link with no re-sync'
    )
  } else {
    log(existsSync(join(linkPath, '.forge-managed')), 'a copy carries the .forge-managed marker')
  }
  log(store.enable('zz-forge-test-skill').ok, 'enabling an already-enabled skill is a no-op, not an error')
  log(store.list(['zz-forge-test-skill']).find((s) => s.name === 'zz-forge-test-skill').enabled, 'and list() agrees')

  // Enabled in settings but never synced: list() must not claim it is live.
  const lying = store.list(['imported-skill']).find((s) => s.name === 'imported-skill')
  log(lying.link === 'error' && Boolean(lying.problem), 'an enabled-but-unsynced skill is reported, not assumed')

  const syncResult = store.syncEnabled(['zz-forge-test-skill', 'imported-skill'])
  log(syncResult.synced.length === 2, 'syncEnabled brings the rest into line')
  log(existsSync(join(claudeSkillsDir, 'imported-skill', 'SKILL.md')), 'and the newly enabled one is really there')
  log(store.list(['zz-forge-test-skill', 'imported-skill']).filter((s) => s.enabled).length === 2, 'both read as enabled')

  // Dropping one from the enabled list takes it back out.
  store.syncEnabled(['zz-forge-test-skill'])
  log(!existsSync(join(claudeSkillsDir, 'imported-skill')), 'a skill dropped from the list is unlinked by the next sync')
  log(existsSync(join(libraryDir, 'imported-skill', 'SKILL.md')), 'and the library copy is untouched — only the link went')

  /* ------------------------------------------------ 7. conflict refusal */

  // Somebody else's skill, sitting on a name we also have. This is the case
  // that must never be overwritten: Steve keeps hand-written skills here.
  const theirs = join(claudeSkillsDir, 'malformed')
  writeSkill(theirs, 'malformed', 'Hand-written by Steve. Do not touch.')
  const precious = readFileSync(join(theirs, 'SKILL.md'), 'utf8')

  const refused = store.enable('malformed')
  log(!refused.ok, 'enabling onto a name somebody else owns is refused')
  log(/not created by Forge|already exists/.test(refused.error), 'and says why in a sentence a human can act on')
  log(readFileSync(join(theirs, 'SKILL.md'), 'utf8') === precious, 'the other skill is byte-for-byte untouched')
  log(store.linkStateFor('malformed') === 'conflict', 'the state is reported as a conflict')
  log(store.list(['malformed']).find((s) => s.name === 'malformed').link === 'conflict', 'and the row shows it')

  const disableRefused = store.disable('malformed')
  log(!disableRefused.ok, 'disable will not delete a folder Forge did not create either')
  log(existsSync(join(theirs, 'SKILL.md')), 'so it is still there afterwards')

  const conflictSync = store.syncEnabled(['zz-forge-test-skill', 'malformed'])
  log(conflictSync.conflicts.includes('malformed'), 'syncEnabled reports the conflict rather than resolving it')
  log(readFileSync(join(theirs, 'SKILL.md'), 'utf8') === precious, 'and still has not touched it')

  // A same-named folder that is not a skill at all is equally off limits.
  const strayFile = join(claudeSkillsDir, 'not-ours')
  mkdirSync(strayFile, { recursive: true })
  writeFileSync(join(strayFile, 'important.txt'), 'keep me', 'utf8')
  store.syncEnabled(['zz-forge-test-skill'])
  log(existsSync(join(strayFile, 'important.txt')), 'a stray folder in ~/.claude/skills survives a full sync')

  /* --------------------------------------------------------- 8. disable */

  log(store.disable('zz-forge-test-skill').ok, 'disable() removes our own link')
  log(!existsSync(join(claudeSkillsDir, 'zz-forge-test-skill')), 'and it is really gone from ~/.claude/skills')
  log(existsSync(join(libraryDir, 'zz-forge-test-skill', 'SKILL.md')), 'while the library copy is left alone')
  log(store.disable('zz-forge-test-skill').ok, 'disabling something already off is not an error')

  /* ---------------------------------------------------------- 9. remove */

  store.enable('zz-forge-test-skill')
  const removed = store.remove('zz-forge-test-skill')
  log(removed.ok, 'remove() deletes the skill')
  log(!existsSync(join(libraryDir, 'zz-forge-test-skill')), 'the library folder is gone')
  log(!existsSync(join(claudeSkillsDir, 'zz-forge-test-skill')), 'and it unlinked itself on the way out')
  log(store.remove('never-existed').ok, 'removing something that was never there is not an error')
  log(store.remove('../../etc').ok === false, 'remove refuses a name that is not a skill name')

  /* --------------------------------------------------- 10. the ipc surface */

  const handlers = new Map()
  let settingsEnabled = []
  setSkillsDirs({ libraryDir, claudeSkillsDir, peerDirs: [agentsDir, geminiDir] })
  registerSkillsHandlers(
    { handle: (channel, fn) => handlers.set(channel, fn) },
    {
      list: 'skills:list',
      read: 'skills:read',
      create: 'skills:create',
      import: 'skills:import',
      remove: 'skills:remove',
      setEnabled: 'skills:set-enabled',
      openFolder: 'skills:open-folder'
    },
    {
      enabled: () => settingsEnabled,
      setEnabled: (names) => {
        settingsEnabled = names
      },
      openPath: () => {},
      pickFolder: async () => join(outside, 'imported-skill')
    }
  )
  log(handlers.size === 7, `all seven channels are registered (${handlers.size})`)

  const madeOverIpc = await handlers.get('skills:create')(null, 'over-ipc', 'Made through the bridge.')
  log(madeOverIpc.ok && madeOverIpc.skills.some((s) => s.name === 'over-ipc'), 'create over IPC returns the fresh list')

  const on = await handlers.get('skills:set-enabled')(null, 'over-ipc', true)
  log(on.ok && settingsEnabled.includes('over-ipc'), 'enabling over IPC records the setting')
  log(existsSync(join(claudeSkillsDir, 'over-ipc', 'SKILL.md')), 'and really syncs it')
  log(on.skills.find((s) => s.name === 'over-ipc').enabled, 'the returned list reflects it immediately')

  const conflictOverIpc = await handlers.get('skills:set-enabled')(null, 'malformed', true)
  log(!conflictOverIpc.ok && !settingsEnabled.includes('malformed'), 'a refused enable does not move the setting')

  const off = await handlers.get('skills:set-enabled')(null, 'over-ipc', false)
  log(off.ok && !settingsEnabled.includes('over-ipc'), 'disabling over IPC drops it from the setting')

  await handlers.get('skills:set-enabled')(null, 'over-ipc', true)
  const removedOverIpc = await handlers.get('skills:remove')(null, 'over-ipc')
  log(removedOverIpc.ok && !settingsEnabled.includes('over-ipc'), 'removing a skill also drops it from the setting')

  const readBack = await handlers.get('skills:read')(null, 'imported-skill')
  log(readBack.includes('Came from somewhere else.'), 'read returns the raw SKILL.md')
  log((await handlers.get('skills:read')(null, '../../secrets')) === '', 'read cannot be pointed outside the library')

  const importedOverIpc = await handlers.get('skills:import')(null)
  log(!importedOverIpc.ok, 'importing what is already there fails through the picker path too')
  log(Array.isArray(importedOverIpc.skills), 'and still hands back a list')

  /* --------------------------------------------------------- 11. typing */

  log(skillCommandFor('tidy-up') === '/tidy-up ', 'a skill types as a slash command with a trailing space')
  log(!/\r|\n/.test(skillCommandFor('tidy-up')), 'and never carries a newline — that would submit it')
  log(usesSlashSkills('claude') && usesSlashSkills('kimi'), 'claude and kimi read ~/.claude/skills')
  log(usesSlashSkills('claude --dangerously-skip-permissions'), 'flags do not confuse the check')
  log(usesSlashSkills('C:\\npm\\claude.cmd'), 'nor does a full path to the npm shim')
  log(!usesSlashSkills('gemini') && !usesSlashSkills(''), 'nothing else claims to')

  /* ------------------------------------------------ 12. the voice route */

  // use_skill has to travel three modules to reach a pane: the sanitiser that
  // decides a model's JSON is honourable, the executor that runs it, and the
  // bus the renderer registers its typing implementation on. All three are
  // renderer TypeScript, so they are bundled the same way the store was.
  const { actions, brain, bus, manifest } = await bundleTogether(
    {
      actions: './src/lib/appactions.ts',
      brain: './src/lib/brainjson.ts',
      bus: './src/lib/skillbus.ts',
      manifest: './src/lib/appmanifest.ts'
    },
    join(scratch, 'renderer.mjs')
  )

  /** A pane the way VoicePanel snapshots one, in spoken-handle order. */
  const pane = (n, over = {}) => ({
    paneId: `pane-${n}`,
    tabId: `tab-${n}`,
    tabNumber: n,
    tabTitle: `Tab ${n}`,
    number: n,
    title: `Terminal ${n}`,
    profileId: 'claude',
    profileName: 'Claude Code',
    live: true,
    focused: n === 1,
    agent: true,
    lastFocusedAt: n === 1 ? 2 : 1,
    ...over
  })

  const PANES = [pane(1), pane(2, { profileId: 'kimi', profileName: 'Kimi', title: 'notes' })]
  const CTX = {
    projects: [],
    profiles: [],
    defaultProfileId: 'claude',
    activeProjectId: 'p',
    activeProjectName: 'p',
    loadedProjectIds: ['p'],
    tabs: [],
    activeTabId: null,
    focusedPaneId: 'pane-1',
    paneCount: 2,
    panesInActiveTab: 2,
    maxSessions: 16,
    maxPanesPerTab: 8,
    panes: PANES
  }

  const noRunner = actions.runAppAction({ kind: 'use_skill', name: 'tidy-up' }, CTX, {})
  log(!noRunner.ok && /not available/.test(noRunner.summary), 'use_skill with nothing wired says so rather than lying')

  const seen = []
  const spy = {
    useSkill: (req) => {
      seen.push(req)
      return { ok: true, summary: `Typed /${req.name} into ${req.pane.title}`, requested: 1, done: 1 }
    }
  }

  const outcome = actions.runAppAction({ kind: 'use_skill', name: '/tidy-up' }, CTX, spy)
  log(outcome.ok && seen[0].name === 'tidy-up', 'a leading slash is stripped before the runner sees it')
  log(seen[0].pane.paneId === 'pane-1', 'no target means the focused terminal')

  // The shared resolver, not a private one: "terminal two" has to mean the same
  // pane here as it does for send_prompt, or free-flow dispatch is a lottery.
  actions.runAppAction({ kind: 'use_skill', name: 'tidy-up', target: 'terminal two' }, CTX, spy)
  log(seen[1].pane.paneId === 'pane-2', 'a spoken number resolves through resolvePaneTarget')
  actions.runAppAction({ kind: 'use_skill', name: 'tidy-up', target: 'the kimi one' }, CTX, spy)
  log(seen[2].pane.paneId === 'pane-2', 'and so does the agent running in it')
  log(
    actions.runAppAction({ kind: 'use_skill', name: 'tidy-up', target: 'terminal 9' }, CTX, spy).ok === false,
    'a terminal that is not open is refused, with the open ones listed'
  )
  log(seen.length === 3, 'and a refusal never reaches the runner')

  const deadCtx = { ...CTX, panes: [pane(1, { live: false })], focusedPaneId: 'pane-1' }
  log(
    actions.runAppAction({ kind: 'use_skill', name: 'tidy-up' }, deadCtx, spy).ok === false,
    'a pane whose shell has exited is refused rather than typed at'
  )
  log(
    actions.runAppAction({ kind: 'use_skill', name: 'tidy-up' }, { ...CTX, panes: [] }, spy).ok === false,
    'and with no terminals at all it says to open one'
  )
  log(actions.runAppAction({ kind: 'use_skill', name: '  ' }, CTX, {}).ok === false, 'an empty name is refused')

  // A skill is never submitted, whatever Settings says about auto-relay — the
  // one place it deliberately parts company with send_prompt.
  const relay = actions.runAppAction({ kind: 'use_skill', name: 'tidy-up' }, { ...CTX, autoRelay: true }, spy)
  log(relay.ok && !/send/i.test(relay.summary), 'auto-relay does not make a skill submit itself')
  log(
    !Object.keys(seen[seen.length - 1]).includes('submit'),
    'and the runner is never even offered the option'
  )

  // Nothing supplied a runner here: the executor falls back to the bus, which
  // is how the voice panel reaches a pane without knowing skills exist.
  const unregister = bus.setSkillHandler((req) => ({
    ok: true,
    summary: `bus:${req.name}:${req.pane.paneId}`,
    requested: 1,
    done: 1
  }))
  log(
    actions.runAppAction({ kind: 'use_skill', name: 'tidy-up', target: 'notes' }, CTX, {}).summary ===
      'bus:tidy-up:pane-2',
    'with no runner method, the executor falls back to the bus — resolved pane and all'
  )
  unregister()
  log(
    actions.runAppAction({ kind: 'use_skill', name: 'tidy-up' }, CTX, {}).ok === false,
    'and unregistering it puts the honest refusal back'
  )

  log(brain.ACTION_KINDS.has('use_skill'), 'the sanitiser honours use_skill')
  const fromModel = brain.sanitiseActions([
    { kind: 'use_skill', name: '/tidy-up', target: 'claude' },
    { kind: 'use_skill' },
    { kind: 'use_skill', name: '   ' }
  ])
  log(fromModel.length === 1, 'a model asking for a nameless skill is dropped, not guessed at')
  log(fromModel[0].name === 'tidy-up' && fromModel[0].target === 'claude', 'and a good one survives intact')

  log(
    manifest.ACTION_SPECS.some((s) => s.kind === 'use_skill'),
    'and the model is told use_skill exists'
  )
  log(
    !manifest.EXTENSION_POINTS.some((p) => p.startsWith('use_skill')),
    'while no longer being listed as something that does not exist yet'
  )

  /* --------------------------------------------- 13. the real one is safe */

  const realClaudeSkills = join(homedir(), '.claude', 'skills')
  const strayInReal = existsSync(realClaudeSkills)
    ? readdirSync(realClaudeSkills).filter((n) => n.startsWith('zz-forge-test') || n === 'over-ipc')
    : []
  log(strayInReal.length === 0, `this test never wrote to the real ~/.claude/skills (${strayInReal.join(', ') || 'clean'})`)

  /* ------------------------------------------------------------- tidy up */

  rmSync(sandbox, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })

  console.log(failures === 0 ? '\nskills: all checks passed\n' : `\nskills: ${failures} FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
