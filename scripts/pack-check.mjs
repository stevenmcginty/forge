/**
 * Skill packs, proved against a real filesystem.
 *
 *   npm run pack:check
 *
 * Bundles the *real* shared/skillpack.ts and electron/skill-pack.ts with esbuild
 * and drives them the way the main process does — same approach as
 * scripts/skills-smoke.mjs, and for the same reason: a validator that has only
 * ever been reasoned about is a validator nobody has tested.
 *
 * The point of this file is the hostile half. A pack is a document from someone
 * else that ends up as files on disk, so most of what follows is a malicious
 * pack being handed to `installPack` and the check that nothing appeared where
 * it should not have. The traversal cases are not hypothetical shapes: they are
 * the ones that beat naive implementations — `..` behind a legitimate-looking
 * prefix, a Windows device name, a trailing dot the filesystem silently strips,
 * an alternate data stream, and a staging directory whose name is a prefix of
 * the attacker's target.
 *
 * SAFETY: every directory here comes from mkdtemp(). The store is handed its
 * library rather than reading `homedir()`, and the last check confirms the run
 * created nothing in the real ~/.claude.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-pack-check')

let failures = 0
let count = 0
const log = (ok, message) => {
  count++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(count).padStart(2)}  ${message}`)
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

/** Every path under a directory, so "nothing escaped" can be asserted directly. */
function tree(dir) {
  const out = []
  const walk = (path, prefix) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      out.push(rel)
      if (entry.isDirectory()) walk(join(path, entry.name), rel)
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return out
}

function writeSkill(dir, name, description, extra = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the thing.\n`,
    'utf8'
  )
  for (const [file, body] of Object.entries(extra)) {
    const target = join(dir, file)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, body)
  }
}

async function main() {
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })

  const pack = await bundle(join(ROOT, 'shared', 'skillpack.ts'), join(scratch, 'skillpack.mjs'))
  const store = await bundle(join(ROOT, 'electron', 'skills-store.ts'), join(scratch, 'skills-store.mjs'))
  const packFs = await bundle(join(ROOT, 'electron', 'skill-pack.ts'), join(scratch, 'skill-pack.mjs'))
  const skills = await bundle(join(ROOT, 'shared', 'skills.ts'), join(scratch, 'skills.mjs'))

  const { isSafePackPath, parsePack, pluginRecipe, pluginIsShareable, FORGEPACK_VERSION, packSize } = pack
  const { buildPack, installPack, readPackFile, readPluginRecipes } = packFs
  const { SkillsStore } = store
  const { isValidSkillName } = skills

  const claudeBefore = existsSync(join(homedir(), '.claude'))
    ? createHash('sha256').update(tree(join(homedir(), '.claude', 'skills')).join('\n')).digest('hex')
    : 'absent'

  /* ------------------------------------------------------- path refusals */

  console.log('\npath safety — what a pack may name')
  for (const good of ['SKILL.md', 'assets/logo.png', 'a/b/c/d.txt', 'run.py', 'go.sh', 'x.mjs', 'note-1.md']) {
    log(isSafePackPath(good) === true, `allows ${good}`)
  }

  const traversals = [
    ['../evil.md', 'a parent escape'],
    ['../../.claude/settings.json', 'a reach at settings.json'],
    ['a/../../b.md', '`..` hidden behind a real segment'],
    ['./a.md', 'a leading `.` segment'],
    ['/etc/passwd', 'an absolute posix path'],
    ['C:/Windows/x.md', 'a drive letter'],
    ['c:x.md', 'a drive-relative path'],
    ['a\\b.md', 'a backslash'],
    ['..\\..\\x.md', 'a windows traversal'],
    ['a//b.md', 'an empty segment'],
    ['', 'an empty path'],
    ['   ', 'whitespace only'],
    [' a.md', 'a leading space'],
    ['a.md ', 'a trailing space'],
    ['foo./bar.md', 'a segment ending in a dot'],
    ['nul', 'the NUL device'],
    ['nul.txt', 'NUL with an extension'],
    ['COM1.md', 'a COM port'],
    ['dir/LPT9.txt', 'a device name in a subfolder'],
    ['a:stream.md', 'an alternate data stream'],
    ['a?b.md', 'a wildcard'],
    ['a|b.md', 'a pipe'],
    ['a/b/c/d/e/f/g/h/i.md', 'nine levels deep'],
    [`${'a'.repeat(220)}.md`, 'an over-long name']
  ]
  for (const [path, why] of traversals) log(isSafePackPath(path) === false, `refuses ${why} (${JSON.stringify(path)})`)

  log(isSafePackPath('boot.exe') === false, 'refuses .exe')
  log(isSafePackPath('shortcut.lnk') === false, 'refuses .lnk')
  log(isSafePackPath('setup.MSI') === false, 'refuses .MSI regardless of case')
  log(isSafePackPath('tweak.reg') === false, 'refuses .reg')
  log(isSafePackPath('helper.py') === true, 'still allows .py — a real skill may ship one')

  /* --------------------------------------------------------- the parser */

  console.log('\nparsing a pack from someone else')
  const good = {
    forgepack: FORGEPACK_VERSION,
    created: '2026-08-08T00:00:00.000Z',
    from: 'Forge 0.3.0',
    note: 'hello',
    skills: [{ name: 'demo', title: 'Demo', description: 'd', files: [{ path: 'SKILL.md', text: '---\nname: demo\n---\n' }] }],
    plugins: []
  }
  log(parsePack(JSON.stringify(good), isValidSkillName).ok === true, 'a well-formed pack parses')
  log(parsePack('not json', isValidSkillName).ok === false, 'junk is refused')
  log(parsePack('', isValidSkillName).ok === false, 'an empty file is refused')
  log(parsePack('[]', isValidSkillName).ok === false, 'a top-level array is refused')
  log(parsePack('null', isValidSkillName).ok === false, 'null is refused')
  log(
    parsePack(JSON.stringify({ ...good, forgepack: 99 }), isValidSkillName).error?.includes('version 99') === true,
    'a future version is refused by name'
  )

  const dropTest = (mutate, why) => {
    const copy = JSON.parse(JSON.stringify(good))
    mutate(copy)
    const out = parsePack(JSON.stringify(copy), isValidSkillName)
    return out
  }

  {
    const out = dropTest((p) => p.skills[0].files.push({ path: '../pwned.md', text: 'x' }))
    log(out.ok && out.pack.skills[0].files.length === 1, 'an unsafe path is dropped, the skill survives')
    log(out.dropped.some((d) => d.includes('pwned')), 'and the drop is reported, not silent')
  }
  {
    const out = dropTest((p) => (p.skills[0].files = [{ path: 'notes.md', text: 'x' }]))
    log(out.ok === false || out.pack.skills.length === 0, 'a skill with no SKILL.md is not a skill')
  }
  {
    const out = dropTest((p) => p.skills[0].files.push({ path: 'both.md', text: 'x', base64: 'eA==' }))
    log(out.pack.skills[0].files.length === 1, 'a file claiming both text and base64 is dropped')
  }
  {
    const out = dropTest((p) => p.skills[0].files.push({ path: 'neither.md' }))
    log(out.pack.skills[0].files.length === 1, 'a file claiming neither is dropped')
  }
  {
    const out = dropTest((p) => p.skills[0].files.push({ path: 'bad.bin', base64: 'not*base64!' }))
    log(out.pack.skills[0].files.length === 1, 'corrupt base64 is dropped')
  }
  {
    const out = dropTest((p) => (p.skills[0].name = '../escape'))
    log(out.ok === false, 'a skill whose name is a path is dropped')
  }
  {
    const out = dropTest((p) => (p.skills[0].name = 'UPPER'))
    log(out.ok === false, 'a name that is not a valid skill name is dropped')
  }
  {
    const out = dropTest((p) => p.skills[0].files.push({ path: 'huge.md', text: 'x'.repeat(3 * 1024 * 1024) }))
    log(out.pack.skills[0].files.length === 1, 'an over-large file is dropped')
  }

  console.log('\nplugin recipes are commands, so the names are checked')
  {
    const withPlugin = (plugin) => parsePack(JSON.stringify({ ...good, plugins: [plugin] }), isValidSkillName)
    const ok = withPlugin({ plugin: 'taste-skill', marketplace: 'leon', version: '1.0.0', source: { kind: 'github', repo: 'leonxlnx/taste-skill' }, skills: ['a'] })
    log(ok.pack.plugins.length === 1, 'a well-formed plugin survives')
    log(
      pluginRecipe(ok.pack.plugins[0]).join(' && ') ===
        '/plugin marketplace add leonxlnx/taste-skill && /plugin install taste-skill@leon',
      'and yields the two commands that reproduce it'
    )
    const injected = withPlugin({ plugin: 'a; rm -rf /', marketplace: 'x', version: '1', source: { kind: 'local' }, skills: [] })
    log(injected.pack.plugins.length === 0, 'a plugin name with shell punctuation is dropped')
    const spaced = withPlugin({ plugin: 'ok', marketplace: 'a b', version: '1', source: { kind: 'local' }, skills: [] })
    log(spaced.pack.plugins.length === 0, 'a marketplace with a space is dropped')
    const badRepo = withPlugin({ plugin: 'ok', marketplace: 'm', version: '1', source: { kind: 'github', repo: 'not a repo' }, skills: [] })
    log(badRepo.pack.plugins[0].source.kind === 'local', 'a malformed github repo degrades to local')
    log(pluginIsShareable(badRepo.pack.plugins[0]) === false, 'and a local source offers no command at all')
    const badUrl = withPlugin({ plugin: 'ok', marketplace: 'm', version: '1', source: { kind: 'git', url: 'https://x.com/a b' }, skills: [] })
    log(badUrl.pack.plugins[0].source.kind === 'local', 'a git url with a space degrades to local')
  }

  /* -------------------------------------------------- build and install */

  console.log('\nbuild a pack from a real library')
  const home = mkdtempSync(join(tmpdir(), 'forge-pack-'))
  const libA = join(home, 'library-a')
  const libB = join(home, 'library-b')
  const claude = join(home, 'claude-skills')
  mkdirSync(libA, { recursive: true })
  mkdirSync(libB, { recursive: true })
  mkdirSync(claude, { recursive: true })

  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01])
  writeSkill(join(libA, 'release-checklist'), 'release-checklist', 'Ship it properly', {
    'assets/diagram.png': binary,
    'notes/extra.md': '# extra\n'
  })
  writeSkill(join(libA, 'other'), 'other', 'Something else')

  const sender = new SkillsStore({ libraryDir: libA, claudeSkillsDir: claude })
  const receiver = new SkillsStore({ libraryDir: libB, claudeSkillsDir: claude })

  const built = buildPack(sender, { skills: ['release-checklist'], includePlugins: false, note: 'for you', now: () => 0 })
  log(built.ok === true, 'a library skill packs')
  log(built.pack.skills.length === 1 && built.pack.skills[0].files.length === 3, 'with every file in the folder')
  const packedPng = built.pack.skills[0].files.find((f) => f.path === 'assets/diagram.png')
  log(packedPng?.base64 !== undefined && packedPng.text === undefined, 'a binary file is carried as base64')
  const packedMd = built.pack.skills[0].files.find((f) => f.path === 'SKILL.md')
  log(packedMd?.text !== undefined, 'and a text file stays readable text in the pack')
  log(built.pack.skills[0].title === 'release-checklist', 'the frontmatter title travels for the preview')
  log(buildPack(sender, { skills: ['nope'], includePlugins: false }).ok === false, 'packing a skill that is not there fails')
  log(
    buildPack(sender, { skills: ['nope'], includePlugins: false }).skipped.some((s) => s.includes('nope')),
    'and says which one'
  )

  const packPath = join(home, 'demo.forgepack')
  writeFileSync(packPath, built.json, 'utf8')
  log(readPackFile(packPath).ok === true, 'the written file reads back')
  log(
    JSON.parse(readFileSync(packPath, 'utf8')).skills[0].files[0].path === 'SKILL.md',
    'and is plain readable JSON — the whole reason it is not a zip'
  )

  console.log('\ninstall into a different library')
  const installed = installPack(receiver, readPackFile(packPath).pack)
  log(installed.installed.length === 1, 'the skill installs')
  log(
    readFileSync(join(libB, 'release-checklist', 'SKILL.md'), 'utf8') ===
      readFileSync(join(libA, 'release-checklist', 'SKILL.md'), 'utf8'),
    'SKILL.md is byte-identical to the sender copy'
  )
  log(
    readFileSync(join(libB, 'release-checklist', 'assets', 'diagram.png')).equals(binary),
    'and the binary file round-tripped through base64 unchanged'
  )
  log(existsSync(join(libB, 'release-checklist', 'notes', 'extra.md')), 'nested folders are recreated')

  const again = installPack(receiver, readPackFile(packPath).pack)
  log(again.installed.length === 0, 'installing twice does not install twice')
  log(again.skipped.some((s) => s.includes('already in your library')), 'and says the name is taken')

  {
    // The rule that matters most: an existing skill is never overwritten, so a
    // pack cannot replace a skill you wrote with one you did not.
    const mine = join(libB, 'other')
    writeSkill(mine, 'other', 'MINE — do not replace')
    const hostile = {
      ...good,
      skills: [{ name: 'other', title: 'x', description: 'x', files: [{ path: 'SKILL.md', text: 'REPLACED' }] }]
    }
    const hostilePath = join(home, 'hostile.forgepack')
    writeFileSync(hostilePath, JSON.stringify(hostile), 'utf8')
    installPack(receiver, readPackFile(hostilePath).pack)
    log(readFileSync(join(mine, 'SKILL.md'), 'utf8').includes('MINE'), 'an incoming name clash never overwrites')
  }

  /* -------------------------------------------------------- the hostile */

  console.log('\na pack that is trying to get out')
  {
    const outside = join(home, 'pwned.md')
    const evil = {
      forgepack: FORGEPACK_VERSION,
      created: '',
      from: '',
      note: '',
      skills: [
        {
          name: 'innocent',
          title: 'Innocent',
          description: '',
          files: [
            { path: 'SKILL.md', text: '---\nname: innocent\n---\n' },
            { path: '../../pwned.md', text: 'owned' },
            { path: '..\\..\\pwned.md', text: 'owned' },
            { path: 'a/../../../pwned.md', text: 'owned' },
            { path: '/pwned.md', text: 'owned' }
          ]
        }
      ],
      plugins: []
    }
    const evilPath = join(home, 'evil.forgepack')
    writeFileSync(evilPath, JSON.stringify(evil), 'utf8')

    const read = readPackFile(evilPath)
    log(read.ok === true, 'the pack still parses — the skill is real, the paths are not')
    log(read.pack.skills[0].files.length === 1, 'every escaping path was dropped by the parser')
    log(read.dropped.length === 4, 'all four are reported')

    const before = tree(home)
    installPack(receiver, read.pack)
    log(!existsSync(outside), 'nothing was written outside the library')
    log(!existsSync(join(home, 'library-b', '..', 'pwned.md')), 'and nothing one level up either')
    const after = tree(home)
    const added = after.filter((p) => !before.includes(p))
    log(
      added.every((p) => p.startsWith('library-b/innocent')),
      `only the skill's own folder appeared (${added.join(', ') || 'nothing'})`
    )
  }

  {
    // Belt and braces: hand installPack a pack that skipped the parser entirely,
    // which is what a bug in parsePack would look like from here. The write-time
    // containment check is the one that has to hold.
    const forged = {
      forgepack: FORGEPACK_VERSION,
      created: '',
      from: '',
      note: '',
      skills: [
        {
          name: 'forged',
          title: 'forged',
          description: '',
          files: [
            { path: 'SKILL.md', text: 'x' },
            { path: '../../escaped.md', text: 'owned' }
          ]
        }
      ],
      plugins: []
    }
    const before = tree(home)
    const result = installPack(receiver, forged)
    log(!existsSync(join(home, 'escaped.md')), 'a path that never met the parser is still refused at write time')
    log(result.installed.length === 0, 'and the whole skill is refused rather than half-written')
    log(!existsSync(join(libB, 'forged')), 'no torn folder is left behind')
    log(!existsSync(join(libB, 'forged.importing')), 'and no staging folder either')
    const added = tree(home).filter((p) => !before.includes(p))
    log(added.length === 0, `nothing at all was created (${added.join(', ') || 'nothing'})`)
  }

  {
    // The staging folder is `<name>.importing`, so a target named to be its
    // prefix is the classic `startsWith` bug. Prove the separator is checked.
    const forged = {
      forgepack: FORGEPACK_VERSION,
      created: '',
      from: '',
      note: '',
      skills: [
        { name: 'sib', title: 's', description: '', files: [{ path: 'SKILL.md', text: 'x' }, { path: '../sib.importing-evil/x.md', text: 'owned' }] }
      ],
      plugins: []
    }
    installPack(receiver, forged)
    log(!existsSync(join(libB, 'sib.importing-evil')), 'a sibling whose name prefixes the staging folder is refused')
  }

  /* --------------------------------------------------------- the recipes */

  console.log('\nplugin recipes off a real plugins tree')
  {
    const pluginsDir = join(home, 'plugins')
    const cache = join(pluginsDir, 'cache', 'acme', 'widgets', '2.1.0', 'skills', 'widget')
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, 'SKILL.md'), '---\nname: widget\ndescription: does widgets\n---\n', 'utf8')
    writeFileSync(
      join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({ acme: { source: { source: 'github', repo: 'acme/plugins' } } }),
      'utf8'
    )
    const withPlugins = new SkillsStore({ libraryDir: libA, claudeSkillsDir: claude, pluginsDir })
    const recipes = readPluginRecipes(withPlugins)
    log(recipes.length === 1, 'an installed plugin becomes one recipe')
    log(recipes[0].plugin === 'widgets' && recipes[0].marketplace === 'acme', 'with the plugin and marketplace split')
    log(recipes[0].version === '2.1.0', 'and the version the sender had')
    log(recipes[0].skills.join(',') === 'widget', 'listing the skills it brought')
    log(recipes[0].source.kind === 'github', 'reading the source out of known_marketplaces.json')

    const packed = buildPack(withPlugins, { skills: [], includePlugins: true, now: () => 0 })
    log(packed.ok === true && packed.pack.plugins.length === 1, 'a plugins-only pack is a valid pack')
    log(
      JSON.stringify(packed.pack).includes('does widgets') === false,
      'and carries NO plugin file content — a recipe, not a copy'
    )

    writeFileSync(
      join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({ acme: { source: { source: 'directory', path: 'C:/somewhere' } } }),
      'utf8'
    )
    const localOnly = readPluginRecipes(new SkillsStore({ libraryDir: libA, claudeSkillsDir: claude, pluginsDir }))
    log(localOnly[0].source.kind === 'local', 'a directory marketplace is marked local')
    log(pluginRecipe(localOnly[0]).length === 0, 'and yields no command, rather than one that would fail')
  }

  /* ------------------------------------------------------------- sundry */

  console.log('\nodds and ends')
  log(packSize(512) === '512 B' && packSize(2048) === '2 KB' && packSize(1572864) === '1.5 MB', 'sizes read as sentences')
  log(
    installPack(receiver, readPackFile(packPath).pack).installed.length === 0,
    'installPack is idempotent against an already-installed name'
  )
  log(
    !readdirSync(libB).some((n) => n.endsWith('.importing')),
    'no staging folder survived any of the above'
  )

  const claudeAfter = existsSync(join(homedir(), '.claude'))
    ? createHash('sha256').update(tree(join(homedir(), '.claude', 'skills')).join('\n')).digest('hex')
    : 'absent'
  log(claudeBefore === claudeAfter, 'the real ~/.claude/skills was never touched')

  rmSync(home, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })

  console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${count} checks, ${failures} failures.\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
