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
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
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

/**
 * A fingerprint of a directory tree: every path, its kind, and the bytes of
 * every file, hashed. This is how "Forge never writes in ~/.claude/skills" gets
 * proved rather than asserted — take one before the read-only surface is
 * exercised, take another after, and compare the two strings. A new file, a
 * changed byte, a deleted junction or a re-created folder all move the hash.
 *
 * Junctions are recorded as links and never followed, so a link whose target
 * changed underneath is still a link with the same name — which is exactly what
 * we are claiming: the folder is untouched.
 */
function fingerprint(dir) {
  const parts = []
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name)
      const rel = relative(dir, full).split(sep).join('/')
      if (entry.isSymbolicLink()) {
        parts.push(`L ${rel}`)
      } else if (entry.isDirectory()) {
        parts.push(`D ${rel}`)
        walk(full)
      } else {
        parts.push(`F ${rel} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
      }
    }
  }
  walk(dir)
  return createHash('sha256').update(parts.join('\n')).digest('hex')
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
  const {
    dedupeSkills,
    isValidSkillName,
    parseFrontmatter,
    skillBlurb,
    skillBody,
    skillCommandFor,
    skillTemplate,
    slugSkillName,
    skillCommandForAgent,
    usesNativeSkills,
    usesSlashSkills
  } = await bundle(join(ROOT, 'shared', 'skills.ts'), join(scratch, 'skills.mjs'))

  const sandbox = mkdtempSync(join(tmpdir(), 'forge-skills-'))
  const libraryDir = join(sandbox, 'library')
  const claudeSkillsDir = join(sandbox, 'home', '.claude', 'skills')
  const codexSkillsDir = join(sandbox, 'home', '.codex', 'skills')
  const antigravitySkillsDir = join(sandbox, 'home', '.gemini', 'antigravity-cli', 'skills')
  const agentsDir = join(sandbox, 'home', '.agents', 'skills')
  const geminiDir = join(sandbox, 'home', '.gemini', 'skills')
  const outside = join(sandbox, 'outside')
  mkdirSync(claudeSkillsDir, { recursive: true })
  mkdirSync(codexSkillsDir, { recursive: true })
  mkdirSync(antigravitySkillsDir, { recursive: true })
  mkdirSync(agentsDir, { recursive: true })
  mkdirSync(geminiDir, { recursive: true })

  const store = new SkillsStore({ libraryDir, claudeSkillsDir, codexSkillsDir, antigravitySkillsDir, peerDirs: [agentsDir, geminiDir] })

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
  const codexLinkPath = join(codexSkillsDir, 'zz-forge-test-skill')
  log(existsSync(join(codexLinkPath, 'SKILL.md')), 'and the SKILL.md is readable through Codex')
  const antigravityLinkPath = join(antigravitySkillsDir, 'zz-forge-test-skill')
  log(existsSync(join(antigravityLinkPath, 'SKILL.md')), 'and the SKILL.md is readable through Antigravity')
  const mode = store.linkStateFor('zz-forge-test-skill')
  log(mode === 'junction' || mode === 'copy', `the link is a junction or a marked copy (got ${mode})`)
  const codexMode = store.codexLinkStateFor('zz-forge-test-skill')
  log(codexMode === 'junction' || codexMode === 'copy', `Codex has a junction or marked copy (got ${codexMode})`)
  const antigravityMode = store.antigravityLinkStateFor('zz-forge-test-skill')
  log(antigravityMode === 'junction' || antigravityMode === 'copy', `Antigravity has a junction or marked copy (got ${antigravityMode})`)
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
  setSkillsDirs({ libraryDir, claudeSkillsDir, codexSkillsDir, antigravitySkillsDir, peerDirs: [agentsDir, geminiDir] })
  registerSkillsHandlers(
    { handle: (channel, fn) => handlers.set(channel, fn) },
    {
      list: 'skills:list',
      read: 'skills:read',
      create: 'skills:create',
      import: 'skills:import',
      remove: 'skills:remove',
      setEnabled: 'skills:set-enabled',
      openFolder: 'skills:open-folder',
      copyToLibrary: 'skills:copy-to-library',
      // The pack half. Its own behaviour is proved in scripts/pack-check.mjs;
      // what matters here is that registering it did not disturb the eight
      // channels above, and that every one of them is still wired.
      packPlugins: 'skills:pack-plugins',
      packExport: 'skills:pack-export',
      packOpen: 'skills:pack-open',
      packInstall: 'skills:pack-install'
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
  log(handlers.size === 12, `all twelve channels are registered (${handlers.size})`)

  const listedOverIpc = await handlers.get('skills:list')()
  log(
    Array.isArray(listedOverIpc.skills) && Array.isArray(listedOverIpc.machineSkills),
    'list hands back both groups in one round trip'
  )

  const madeOverIpc = await handlers.get('skills:create')(null, 'over-ipc', 'Made through the bridge.')
  log(madeOverIpc.ok && madeOverIpc.skills.some((s) => s.name === 'over-ipc'), 'create over IPC returns the fresh list')
  log(Array.isArray(madeOverIpc.machineSkills), 'and a mutation carries the machine group too')

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
  log(usesNativeSkills('codex') && skillCommandForAgent('caveman', 'codex') === '$caveman ', 'Codex uses its native skill invocation')
  log(usesNativeSkills('agy') && usesSlashSkills('agy'), 'Antigravity uses native slash-command skills')
  log(usesSlashSkills('claude --dangerously-skip-permissions'), 'flags do not confuse the check')
  log(usesSlashSkills('C:\\npm\\claude.cmd'), 'nor does a full path to the npm shim')
  log(!usesSlashSkills('gemini') && !usesSlashSkills(''), 'nothing else claims to')

  /* ------------------------------------------------ 12. the voice route */

  // use_skill has to travel three modules to reach a pane: the sanitiser that
  // decides a model's JSON is honourable, the executor that runs it, and the
  // bus the renderer registers its typing implementation on. All three are
  // renderer TypeScript, so they are bundled the same way the store was.
  const { actions, brain, bus, manifest, library } = await bundleTogether(
    {
      actions: './src/lib/appactions.ts',
      brain: './src/lib/brainjson.ts',
      bus: './src/lib/skillbus.ts',
      library: './src/lib/skills.ts',
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

  /* ------------------------------- 12b. one library, two folders, one lookup
   *
   * The renderer's copy of the list. `apply` is pure — no window, no IPC — so
   * the store can be driven here exactly as a round trip would drive it, and
   * the question worth asking is whether "the apple design skill" resolves to
   * the same folder however it was asked for: dropped on a pane, or named by
   * the voice model. Both go through `find`.
   */

  library.skillLibrary.apply({
    skills: [
      { name: 'release-checklist', title: 'release-checklist', description: 'Before a build ships.', path: 'L1', enabled: true, link: 'junction', alsoIn: [] },
      { name: 'gaffer', title: 'gaffer', description: 'Forge’s own copy.', path: 'L2', enabled: false, link: 'conflict', alsoIn: [] }
    ],
    machineSkills: [
      { name: 'apple-design', title: 'apple-design', description: 'Apple’s design language.', path: 'M1', shadowed: false },
      { name: 'gaffer', title: 'gaffer', description: 'Steve’s own.', path: 'M2', shadowed: true }
    ]
  })

  log(library.skillLibrary.find('release-checklist')?.source === 'library', 'a library name resolves to the library')
  log(library.skillLibrary.find('apple-design')?.source === 'machine', 'and a machine-only name to ~/.claude/skills')
  log(library.skillLibrary.find('apple-design')?.skill.description === 'Apple’s design language.', 'with its description')
  log(library.skillLibrary.find('gaffer')?.source === 'library', 'a name in both resolves to the library — one rule, both routes')
  log(library.skillLibrary.find('not-a-skill') === null, 'and an unknown name resolves to nothing, rather than to something')

  const roster = library.skillLibrary.catalogue()
  log(roster.length === 3, `the model is told about both folders, once each (${roster.length})`)
  log(roster.find((s) => s.name === 'apple-design')?.enabled === true, 'a machine skill is listed as on — it always is')
  log(roster.filter((s) => s.name === 'gaffer').length === 1, 'and the shadowed duplicate is not listed twice')
  log(roster.find((s) => s.name === 'gaffer')?.description === 'Forge’s own copy.', 'the library row is the one described')

  // The whole point of the roster: a spoken "use the apple design skill" has to
  // reach that folder. Same executor, same bus, same resolved pane as before.
  const machineRoute = bus.setSkillHandler((req) => {
    const found = library.skillLibrary.find(req.name)
    return found
      ? { ok: true, summary: `${found.source}:${found.skill.path}`, requested: 1, done: 1 }
      : { ok: false, summary: 'no such skill', requested: 1, done: 0 }
  })
  log(
    actions.runAppAction({ kind: 'use_skill', name: 'apple-design' }, CTX, {}).summary === 'machine:M1',
    'use_skill reaches one of Steve’s own skills, not just the library'
  )
  machineRoute()

  library.skillLibrary.apply({ skills: [], machineSkills: [] })
  log(library.skillLibrary.catalogue().length === 0, 'and an empty machine folder leaves an empty roster, not a crash')

  /* ------------------------------------- 13. the skills already on the machine
   *
   * The second group in the rail: Steve's own ~/.claude/skills. Ten of them on
   * the real machine, one of which is a junction into ~/.agents/skills and a
   * couple of which are, as ever, half-written. Forge lists them, reads them,
   * types them into panes — and never writes a byte in there. The fingerprint
   * either side of this section is what turns that last sentence into a test
   * rather than a comment.
   */

  const home2 = mkdtempSync(join(tmpdir(), 'forge-machine-'))
  const machineDir = join(home2, '.claude', 'skills')
  const otherLibrary = join(home2, 'library')
  const agentsElsewhere = join(home2, '.agents', 'skills')
  mkdirSync(machineDir, { recursive: true })
  mkdirSync(otherLibrary, { recursive: true })

  writeSkill(join(machineDir, 'apple-design'), 'apple-design', 'Build interfaces with Apple’s design language.')
  writeSkill(join(machineDir, 'gaffer'), 'gaffer', 'Delegation harness.')

  // remotion-best-practices really is a junction into ~/.agents/skills. A read
  // through it has to work, and the folder it points at must never be recursed
  // into by anything that deletes.
  writeSkill(join(agentsElsewhere, 'remotion-best-practices'), 'remotion-best-practices', 'Video in React.')
  let junctioned = true
  try {
    symlinkSync(join(agentsElsewhere, 'remotion-best-practices'), join(machineDir, 'remotion-best-practices'), 'junction')
  } catch {
    junctioned = false
  }

  // The two shapes a hand-written folder turns up in.
  mkdirSync(join(machineDir, 'half-written'), { recursive: true })
  writeFileSync(join(machineDir, 'half-written', 'SKILL.md'), '# Just a heading\n\nno frontmatter here\n', 'utf8')
  mkdirSync(join(machineDir, 'not-a-skill-at-all'), { recursive: true })
  writeFileSync(join(machineDir, 'not-a-skill-at-all', 'notes.txt'), 'keep me', 'utf8')

  const machineStore = new SkillsStore({ libraryDir: otherLibrary, claudeSkillsDir: machineDir })
  const before = fingerprint(machineDir)

  const onMachine = machineStore.listMachine()
  const m = (name) => onMachine.find((s) => s.name === name)
  log(onMachine.length === (junctioned ? 5 : 4), `every folder in ~/.claude/skills is listed (${onMachine.length})`)
  log(m('apple-design')?.description === 'Build interfaces with Apple’s design language.', 'a machine skill carries its description')
  log(m('apple-design')?.title === 'apple-design', 'and its frontmatter name')
  log(m('half-written')?.problem?.includes('frontmatter'), 'a SKILL.md with no frontmatter says so')
  log(m('half-written')?.title === 'half-written', 'and still shows up as a usable row')
  log(m('not-a-skill-at-all')?.problem?.includes('SKILL.md'), 'a folder with no SKILL.md says so instead of vanishing')
  log(onMachine.every((s) => s.shadowed === false), 'nothing is shadowed while the library is empty')
  if (junctioned) {
    log(m('remotion-best-practices')?.description === 'Video in React.', 'a junction is read straight through')
  } else {
    log(true, 'no junctions on this filesystem — junction read skipped')
  }

  log(machineStore.readMachineSkillFile('apple-design').includes('Apple'), 'readMachineSkillFile returns the raw SKILL.md')
  log(machineStore.readMachineSkillFile('../../secrets') === '', 'and cannot be pointed outside ~/.claude/skills')
  log(machineStore.readMachineSkillFile('never-there') === '', 'a name that is not there reads as empty, not a throw')

  // Shadowing: a library skill of the same name wins, and the machine row says
  // so rather than pretending to be the one with the switch.
  machineStore.createFromTemplate('gaffer', 'Forge’s own copy.')
  const shadowed = machineStore.listMachine()
  log(shadowed.find((s) => s.name === 'gaffer').shadowed === true, 'a name the library also has comes back shadowed')
  log(shadowed.find((s) => s.name === 'apple-design').shadowed === false, 'and one it does not, does not')

  const both = machineStore.listAll(['gaffer'])
  log(both.skills.length === 1 && both.machineSkills.length === onMachine.length, 'listAll returns both groups')
  const deduped = dedupeSkills(both.skills, both.machineSkills)
  log(!deduped.some((s) => s.name === 'gaffer'), 'dedupeSkills drops the machine copy — the library one wins')
  log(deduped.length === both.machineSkills.length - 1, 'and drops nothing else')
  log(dedupeSkills([], both.machineSkills).length === both.machineSkills.length, 'an empty library shadows nothing')

  // Copy into library — a copy, never a move.
  const copied = machineStore.copyMachineToLibrary('apple-design')
  log(copied.ok && copied.name === 'apple-design', 'copyMachineToLibrary takes a copy into the library')
  log(existsSync(join(otherLibrary, 'apple-design', 'SKILL.md')), 'and the library copy is really there')
  log(existsSync(join(machineDir, 'apple-design', 'SKILL.md')), 'while the original is still in ~/.claude/skills')
  log(machineStore.copyMachineToLibrary('apple-design').ok === false, 'copying it twice is refused')
  log(machineStore.copyMachineToLibrary('../../etc').ok === false, 'and a name that is not a skill name is refused')

  log(
    fingerprint(machineDir) === before,
    'READ-ONLY: ~/.claude/skills is byte-for-byte identical after listing, reading and copying out of it'
  )

  // Anything Forge itself put in there is a *library* skill wearing a different
  // hat, and must not be counted twice. This one writes, so it comes after the
  // fingerprint check.
  machineStore.createFromTemplate('forge-owned', 'Made by Forge.')
  log(machineStore.enable('forge-owned').ok, 'a library skill syncs into the same folder')
  log(existsSync(join(machineDir, 'forge-owned')), 'and is really there')
  log(
    !machineStore.listMachine().some((s) => s.name === 'forge-owned'),
    'but listMachine skips it — it is already a row on the Library side'
  )
  log(machineStore.listMachine().length === onMachine.length, 'so the machine count did not move')

  /* ------------------------------ 13c. plugins, and skills inside projects
   *
   * The two folders Claude Code reads that are not ~/.claude/skills, and the
   * reason this section exists: `/plugin install design-council` put a real,
   * working skill on the machine and the rail could not show it, because the
   * rail only ever looked in one folder. Everything below is about that gap —
   * finding them, naming them the way they are actually invoked, and keeping
   * both trees as strictly read-only as ~/.claude/skills already was.
   */

  const home3 = mkdtempSync(join(tmpdir(), 'forge-plugins-'))
  const pluginsDir = join(home3, '.claude', 'plugins')
  const cacheDir = join(pluginsDir, 'cache')
  const thirdLibrary = join(home3, 'library')
  const projectA = join(home3, 'projects', 'forge')
  const projectB = join(home3, 'projects', 'sidething')
  mkdirSync(thirdLibrary, { recursive: true })

  // Two plugins, one of which ships a skill named after itself and one of which
  // ships several under different names — both real shapes from the marketplace.
  const councilDir = join(cacheDir, 'sjsyrek', 'design-council', '0.4.1')
  writeSkill(join(councilDir, 'skills', 'design-council'), 'design-council', 'Convene a council of peers.')
  const tasteDir = join(cacheDir, 'taste-skill', 'taste-skill', '1.0.0')
  writeSkill(join(tasteDir, 'skills', 'brandkit'), 'brandkit', 'Premium brand-kit boards.')
  writeSkill(join(tasteDir, 'skills', 'minimalist-skill'), 'minimalist-skill', 'Clean editorial interfaces.')
  // A stale version the updater has not swept up. The manifest names 0.4.1, so
  // this must not be listed as well — two rows for one skill is the bug that
  // made everyone stop trusting the rail's count in the first place.
  writeSkill(join(cacheDir, 'sjsyrek', 'design-council', '0.4.0', 'skills', 'design-council'), 'design-council', 'Old.')
  writeFileSync(
    join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'design-council@sjsyrek': [{ scope: 'user', installPath: councilDir, version: '0.4.1' }],
        'taste-skill@taste-skill': [{ scope: 'user', installPath: tasteDir, version: '1.0.0' }],
        // An entry whose folder is gone: uninstalled, or a half-finished update.
        'ghost@nowhere': [{ scope: 'user', installPath: join(cacheDir, 'nowhere', 'ghost', '9'), version: '9' }]
      }
    }),
    'utf8'
  )

  // A skill checked into one project, and one in another with the same name as
  // a plugin skill — both perfectly legal, and the reason rows are addressed by
  // path rather than by name.
  writeSkill(join(projectA, '.claude', 'skills', 'release-checklist'), 'release-checklist', 'Ship Forge.')
  writeSkill(join(projectB, '.claude', 'skills', 'brandkit'), 'brandkit', 'The side project’s own.')
  // Not a skill: no SKILL.md. An external folder like this is skipped outright
  // — nobody is going to finish writing it inside Forge.
  mkdirSync(join(projectA, '.claude', 'skills', 'scratch'), { recursive: true })

  const pluginStore = new SkillsStore({
    libraryDir: thirdLibrary,
    claudeSkillsDir: join(home3, '.claude', 'skills'),
    pluginsDir,
    projectDirs: () => [
      { name: 'Forge', path: projectA },
      { name: 'Sidething', path: projectB }
    ]
  })
  const pluginsBefore = fingerprint(pluginsDir)
  const projectsBefore = fingerprint(join(home3, 'projects'))

  const fromPlugins = pluginStore.listPlugins()
  const p = (command) => fromPlugins.find((s) => s.command.trim() === command)
  log(fromPlugins.length === 3, `every plugin skill is listed, once each (${fromPlugins.length})`)
  log(!!p('/design-council:design-council'), 'a plugin skill is named the way it is actually invoked')
  log(!!p('/taste-skill:brandkit') && !!p('/taste-skill:minimalist-skill'), 'a plugin with several skills lists them all')
  log(!fromPlugins.some((s) => s.description === 'Old.'), 'and the version the manifest does not name is left out')
  log(p('/design-council:design-council')?.description === 'Convene a council of peers.', 'the description comes through')
  log(p('/design-council:design-council')?.origin.includes('0.4.1'), 'and the row says which version it came from')
  log(fromPlugins.every((s) => s.source === 'plugin' && s.id === s.path), 'a plugin row is addressed by its folder path')

  const fromProjects = pluginStore.listProjectSkills()
  log(fromProjects.length === 2, `every project skill is listed (${fromProjects.length})`)
  log(!fromProjects.some((s) => s.name === 'scratch'), 'a folder with no SKILL.md is not a skill and is skipped')
  log(fromProjects.find((s) => s.name === 'release-checklist')?.origin === 'Forge', 'and each row names its project')
  log(
    fromProjects.find((s) => s.name === 'brandkit')?.command.trim() === '/brandkit',
    'a project skill is invoked by its plain name'
  )
  log(
    fromProjects.find((s) => s.name === 'brandkit').id !== p('/taste-skill:brandkit').id,
    'two skills called brandkit stay two skills — the path is the id, not the name'
  )

  // A plugin skill whose name the library also uses is flagged, never dropped:
  // it is a different skill with a different command, and hiding it would be
  // the very bug this section exists to fix.
  pluginStore.createFromTemplate('brandkit', 'Forge’s own brandkit.')
  const all = pluginStore.listAll(['brandkit'])
  log(all.externalSkills.length === 5, `listAll carries plugins and project skills too (${all.externalSkills.length})`)
  log(
    all.externalSkills.filter((s) => s.name === 'brandkit').every((s) => s.shadowed === true),
    'a name the library also has is flagged shadowed on both external rows'
  )
  log(
    all.externalSkills.find((s) => s.name === 'design-council').shadowed === false,
    'and a name it does not have is not'
  )

  const councilPath = p('/design-council:design-council').id
  log(pluginStore.readExternalSkillFile(councilPath).includes('Convene'), 'an external skill reads through its path')
  log(pluginStore.externalPathFor(join(home3, 'secrets')) === null, 'a path outside both trees is refused')
  log(pluginStore.externalPathFor(join(projectA, '.claude')) === null, 'and so is a parent of a project skills folder')
  log(pluginStore.readExternalSkillFile(join(home3, '..')) === '', 'a traversal attempt reads as empty, not a throw')
  log(pluginStore.readExternalSkillFile('') === '' && pluginStore.readExternalSkillFile(null) === '', 'and so does nothing at all')

  log(
    fingerprint(pluginsDir) === pluginsBefore,
    'READ-ONLY: ~/.claude/plugins is byte-for-byte identical after listing and reading'
  )
  log(
    fingerprint(join(home3, 'projects')) === projectsBefore,
    'READ-ONLY: every project’s .claude/skills is byte-for-byte identical too'
  )

  // No plugins folder, no projects: the ordinary state of a fresh machine, and
  // it has to be empty rather than a throw that takes the whole rail down.
  const bareStore = new SkillsStore({ libraryDir: join(home3, 'bare'), claudeSkillsDir: join(home3, 'bare-claude') })
  log(bareStore.listPlugins().length === 0 && bareStore.listProjectSkills().length === 0, 'no plugins and no projects lists nothing')
  log(Array.isArray(bareStore.listAll().externalSkills), 'and listAll still hands back an array')

  /* --------------------------------------------------------- 13b. blurbs */

  // Steve's real descriptions run to paragraphs — huashu-design alone is 1.3k
  // characters — and the manifest goes up the wire on every single utterance.
  const long =
    'Build distinctive, gallery-grade front-end UI. Invoke when the user wants a website, landing page, hero, ' +
    'component, or UI that should look intentional and premium rather than templated, especially when they say ' +
    '“Fable 5” or ask for a specific aesthetic, or want a design spec before code.'
  log(skillBlurb(long).length <= 151, `a long description is cut down (${skillBlurb(long).length})`)
  log(skillBlurb(long) === 'Build distinctive, gallery-grade front-end UI.', 'and cut at the first sentence where there is one')
  log(skillBlurb('Short one.') === 'Short one.', 'a short description is left exactly as it is')
  log(skillBlurb('  spread\n  over lines  ') === 'spread over lines', 'and flattened onto one line')
  log(skillBlurb('') === '' && skillBlurb(null) === '', 'nothing in, nothing out')
  log(!/\n/.test(skillBlurb('a'.repeat(400))), 'a description with no sentence in it is still cut, on a word')

  /* --------------------------------------------- 14. the real one is safe */

  const realClaudeSkills = join(homedir(), '.claude', 'skills')
  const strayInReal = existsSync(realClaudeSkills)
    ? readdirSync(realClaudeSkills).filter((n) => n.startsWith('zz-forge-test') || n === 'over-ipc')
    : []
  log(strayInReal.length === 0, `this test never wrote to the real ~/.claude/skills (${strayInReal.join(', ') || 'clean'})`)

  /* ------------------------------------------------------------- tidy up */

  rmSync(sandbox, { recursive: true, force: true })
  rmSync(home2, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })

  console.log(failures === 0 ? '\nskills: all checks passed\n' : `\nskills: ${failures} FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
