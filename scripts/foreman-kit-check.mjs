#!/usr/bin/env node
/**
 * The Foreman kit installer, proved against a real Claude home.
 *
 *   npm run foreman-kit:check
 *
 * electron/foreman/kit.ts writes into `~/.claude` — somebody else's directory,
 * read by every `claude` session on their machine. Two things therefore have to
 * hold, and neither can be established by reading the code:
 *
 *  1. A name already taken by a file Forge did not write is **never** touched.
 *     That is the one failure nobody gets to apologise for afterwards, so it is
 *     provoked here with a real hand-written `gaffer/SKILL.md` and the bytes are
 *     read back afterwards.
 *  2. Nothing the manifest names can land outside the folder it belongs to. The
 *     manifest is a file on disk, so it is doctored on purpose and the tree is
 *     diffed before and after.
 *
 * The rest is the state machine: install, no-op, update. It is driven against
 * the *real bundled kit* in assets/foreman-kit rather than a fixture, so a sync
 * that produced a manifest disagreeing with the files it wrote fails here.
 *
 * SAFETY: every Claude home below comes from mkdtemp(). The real ~/.claude is
 * hashed before and after and the last check asserts it did not move.
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

const { installForemanKit, readForemanKit } = await import('../electron/foreman/kit.ts')
const {
  FOREMAN_KIT_AGENTS,
  FOREMAN_KIT_SKILLS,
  FOREMAN_KIT_MANIFEST,
  foremanMarker,
  readForemanMarker,
  stripForemanMarker,
  parseForemanKitManifest,
  CLAUDE_HOME_PLACEHOLDER
} = await import('../shared/foreman-kit.ts')

const ROOT = resolve(import.meta.dirname, '..')
const KIT = join(ROOT, 'assets', 'foreman-kit')

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

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

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

const homes = []
const newHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-kit-'))
  homes.push(dir)
  return dir
}

const realBefore = sha256(Buffer.from(tree(join(homedir(), '.claude', 'skills')).join('\n')))
const agentsBefore = sha256(Buffer.from(tree(join(homedir(), '.claude', 'agents')).join('\n')))

/* ------------------------------------------------------- the bundled kit */

console.log('\nthe kit that ships')
const bundled = readForemanKit(KIT)
ok(bundled.ok === true, 'assets/foreman-kit has a readable manifest', bundled.error)
if (!bundled.ok) {
  console.log('\nFAILED — run `npm run foreman-kit:sync` first.\n')
  process.exit(1)
}
const manifest = bundled.manifest
ok(Number.isSafeInteger(manifest.version) && manifest.version >= 1, `its version is an integer (v${manifest.version})`)
ok(
  manifest.skills.map((s) => s.name).sort().join(',') === [...FOREMAN_KIT_SKILLS].sort().join(','),
  'it carries exactly the five skills Foreman invokes'
)
ok(
  manifest.agents.map((a) => a.name).sort().join(',') === [...FOREMAN_KIT_AGENTS].sort().join(','),
  'and the three agents /gaffer spawns'
)

{
  // The manifest is what the installer trusts. If it disagrees with the files
  // beside it, every marker it writes is a lie about what is on disk.
  let mismatched = []
  for (const skill of manifest.skills) {
    for (const file of skill.files) {
      const path = join(KIT, 'skills', skill.name, file.path)
      if (!existsSync(path) || sha256(readFileSync(path)) !== file.sha256) mismatched.push(`${skill.name}/${file.path}`)
    }
  }
  for (const agent of manifest.agents) {
    const path = join(KIT, 'agents', `${agent.name}.md`)
    if (!existsSync(path) || sha256(readFileSync(path)) !== agent.sha256) mismatched.push(`${agent.name}.md`)
  }
  ok(mismatched.length === 0, 'every manifest hash matches the bundled file', mismatched.join(', '))
  ok(
    manifest.skills.every((s) => s.files.some((f) => f.path === 'SKILL.md')),
    'and every skill has the SKILL.md Claude actually reads'
  )
  // CRLF here would come back out of a fresh clone as LF (.gitattributes says
  // eol=lf) and no hash would match on anyone else's machine.
  const crlf = manifest.skills
    .flatMap((s) => s.files.map((f) => join(KIT, 'skills', s.name, f.path)))
    .filter((p) => readFileSync(p).includes('\r\n'))
  ok(crlf.length === 0, 'no bundled file carries CRLF, so a fresh clone hashes the same', crlf.join(', '))
}

console.log("\nnothing in the bundle points at the machine it came from")
{
  // The failure this catches is total and silent: the gaffer skill sends its
  // agents to an absolute path, and shipped verbatim that path is the author's
  // home. On anyone else's machine every one of those reads fails and Foreman
  // is a button that does nothing.
  const every = [
    ...manifest.skills.flatMap((s) => s.files.map((f) => [`skills/${s.name}/${f.path}`, join(KIT, 'skills', s.name, f.path)])),
    ...manifest.agents.map((a) => [`agents/${a.name}.md`, join(KIT, 'agents', `${a.name}.md`)])
  ]
  const texts = every.map(([label, path]) => [label, readFileSync(path, 'utf8')])

  for (const needle of ['Users\\steve', 'Users/steve']) {
    const hits = texts.filter(([, text]) => text.includes(needle)).map(([label]) => label)
    ok(hits.length === 0, `no bundled file contains ${needle}`, hits.join(', '))
  }
  // A bare drive letter, or a posix home. The lookbehind is what keeps
  // `https://…` out of it — a URL is a reference anyone can follow, an absolute
  // path is one only its author can.
  const homes = texts.filter(([, text]) => /(?<![A-Za-z])[A-Za-z]:[\\/]|\/(?:home|Users)\//.test(text)).map(([label]) => label)
  ok(homes.length === 0, 'and none carries an absolute local path of any shape', homes.join(', '))

  // The placeholder is only substituted into SKILL.md and agent .md. One that
  // turned up anywhere else would ship as the literal text `{{CLAUDE_HOME}}`,
  // which is a broken path that nothing would report.
  const stray = texts
    .filter(([label, text]) => text.includes(CLAUDE_HOME_PLACEHOLDER) && !/(\/SKILL\.md|^agents\/)/.test(label))
    .map(([label]) => label)
  ok(stray.length === 0, 'the placeholder appears only where the installer fills it in', stray.join(', '))
  ok(
    texts.some(([, text]) => text.includes(CLAUDE_HOME_PLACEHOLDER)),
    'and it does appear — the rewrite is doing something'
  )
}

/* ------------------------------------------------------------- a fresh home */

console.log('\na machine that has never had these')
const fresh = newHome()
const first = installForemanKit({ kitDir: KIT, claudeHome: fresh })
ok(first.failed.length === 0, 'nothing failed', JSON.stringify(first.failed))
ok(first.installed.length === FOREMAN_KIT_SKILLS.length + FOREMAN_KIT_AGENTS.length, 'all eight names installed')
ok(first.kept.length === 0 && first.updated.length === 0, 'nothing was kept back and nothing was an update')

for (const name of FOREMAN_KIT_SKILLS) {
  ok(existsSync(join(fresh, 'skills', name, 'SKILL.md')), `${name} landed as a folder with a SKILL.md`)
}
for (const name of FOREMAN_KIT_AGENTS) {
  ok(existsSync(join(fresh, 'agents', `${name}.md`)), `${name}.md landed in agents/`)
}
ok(
  existsSync(join(fresh, 'skills', 'fable-method', 'references', 'domains', 'marketing.md')),
  'a nested reference file came with it'
)
ok(
  !readdirSync(join(fresh, 'skills')).some((n) => n.endsWith('.forge-kit')),
  'no staging folder survived the install'
)

{
  const marked = []
  for (const name of FOREMAN_KIT_SKILLS) {
    const mark = readForemanMarker(readFileSync(join(fresh, 'skills', name, 'SKILL.md'), 'utf8'))
    if (mark?.version === manifest.version) marked.push(name)
  }
  for (const name of FOREMAN_KIT_AGENTS) {
    const mark = readForemanMarker(readFileSync(join(fresh, 'agents', `${name}.md`), 'utf8'))
    if (mark?.version === manifest.version) marked.push(name)
  }
  ok(marked.length === 8, 'every installed file carries our marker at the bundled version', `${marked.length}/8`)

  // fable-judge carries no placeholder, so what landed is the bundle verbatim
  // and both hashes are the same number.
  const plain = manifest.skills.find((s) => s.name === 'fable-judge').files.find((f) => f.path === 'SKILL.md')
  const verbatim = readFileSync(join(fresh, 'skills', 'fable-judge', 'SKILL.md'), 'utf8')
  ok(readForemanMarker(verbatim).sha256 === plain.sha256, "a placeholder-free file's marker carries the manifest hash")
  ok(
    sha256(Buffer.from(stripForemanMarker(verbatim), 'utf8')) === plain.sha256,
    'and the body under the marker is byte-identical to the bundled copy'
  )
  // gaffer does carry one, so its marker describes what landed rather than what
  // shipped — that is the whole point of hashing the installed bytes.
  for (const [where, path] of [
    ['gaffer', join(fresh, 'skills', 'gaffer', 'SKILL.md')],
    ['gaffer-builder', join(fresh, 'agents', 'gaffer-builder.md')]
  ]) {
    const text = readFileSync(path, 'utf8')
    ok(
      readForemanMarker(text).sha256 === sha256(Buffer.from(stripForemanMarker(text), 'utf8')),
      `${where}'s marker hashes the bytes that actually landed`
    )
  }
  const reference = join('references', 'domains', 'marketing.md')
  ok(
    readForemanMarker(readFileSync(join(fresh, 'skills', 'fable-method', reference), 'utf8')) === null,
    'a reference file beside SKILL.md is left unmarked — identity lives on one file'
  )
}

console.log('\nand the installed copy points at the home it landed in')
{
  const gaffer = readFileSync(join(fresh, 'skills', 'gaffer', 'SKILL.md'), 'utf8')
  const bundled = readFileSync(join(KIT, 'skills', 'gaffer', 'SKILL.md'), 'utf8')
  const occurrences = bundled.split(CLAUDE_HOME_PLACEHOLDER).length - 1
  ok(occurrences > 0, `the bundled gaffer skill has ${occurrences} placeholders to fill`)
  ok(!gaffer.includes(CLAUDE_HOME_PLACEHOLDER), 'none of them survived into the installed copy')
  ok(
    gaffer.split(fresh).length - 1 === occurrences,
    'every one became the mkdtemp home this was installed into',
    `${gaffer.split(fresh).length - 1} of ${occurrences}`
  )
  ok(
    gaffer.includes(join(fresh, 'skills', 'fable-method', 'SKILL.md')),
    'so the path gaffer sends its agents to is a file that is actually there'
  )
  ok(
    existsSync(join(fresh, 'skills', 'fable-method', 'SKILL.md')),
    'and that file exists — the reference resolves end to end'
  )
  for (const name of FOREMAN_KIT_AGENTS) {
    const text = readFileSync(join(fresh, 'agents', `${name}.md`), 'utf8')
    ok(!text.includes(CLAUDE_HOME_PLACEHOLDER), `${name}.md has no placeholder left either`)
  }
  ok(
    readFileSync(join(fresh, 'agents', 'gaffer-designer.md'), 'utf8').includes(join(fresh, 'skills', 'fable-5', 'SKILL.md')),
    "the designer's craft manual points into the same home"
  )
}

/* ---------------------------------------------------------------- re-run */

console.log('\nthe same machine, a second time')
{
  const before = tree(fresh)
  const again = installForemanKit({ kitDir: KIT, claudeHome: fresh })
  ok(
    again.installed.length === 0 && again.updated.length === 0 && again.kept.length === 0 && again.failed.length === 0,
    'the whole run is a no-op',
    JSON.stringify(again)
  )
  ok(tree(fresh).join('\n') === before.join('\n'), 'and not one file appeared or vanished')
}

/* ------------------------------------------------------- somebody else's */

console.log("\na gaffer skill the user wrote themselves")
{
  const home = newHome()
  const mine = join(home, 'skills', 'gaffer')
  mkdirSync(mine, { recursive: true })
  writeFileSync(join(mine, 'SKILL.md'), '---\nname: gaffer\n---\n\nMINE — do not replace.\n', 'utf8')

  const report = installForemanKit({ kitDir: KIT, claudeHome: home })
  ok(report.kept.includes('gaffer'), 'it is reported as kept')
  ok(!report.installed.includes('gaffer') && !report.updated.includes('gaffer'), 'and neither installed nor updated')
  ok(readFileSync(join(mine, 'SKILL.md'), 'utf8').includes('MINE'), 'the bytes on disk are untouched')
  ok(readdirSync(mine).join(',') === 'SKILL.md', 'and nothing was added beside it')
  ok(report.installed.length === 7, 'the other seven still installed around it')

  // A folder at one of our names with something else in it. Installs land
  // through a staging rename, so this shape can never be ours — it is theirs.
  const home3 = newHome()
  const odd = join(home3, 'skills', 'fable-5')
  mkdirSync(odd, { recursive: true })
  writeFileSync(join(odd, 'README.md'), 'theirs\n', 'utf8')
  const third = installForemanKit({ kitDir: KIT, claudeHome: home3 })
  ok(third.kept.join(',') === 'fable-5', 'a folder at our name with no SKILL.md is kept, not overwritten')
  ok(readdirSync(odd).join(',') === 'README.md', 'and nothing was written into it')

  // The same rule for an agent, which is one file rather than a folder.
  const home2 = newHome()
  mkdirSync(join(home2, 'agents'), { recursive: true })
  writeFileSync(join(home2, 'agents', 'gaffer-builder.md'), 'MY OWN BUILDER\n', 'utf8')
  const second = installForemanKit({ kitDir: KIT, claudeHome: home2 })
  ok(second.kept.join(',') === 'gaffer-builder', 'a hand-written agent file is kept too')
  ok(readFileSync(join(home2, 'agents', 'gaffer-builder.md'), 'utf8') === 'MY OWN BUILDER\n', 'with its bytes intact')
}

/* --------------------------------------------------------- an older kit */

console.log('\na copy left over from an older Forge')
{
  // A copy of the real kit with the version bumped, so the update path is
  // exercised whatever number the bundled manifest happens to be on. The files
  // are byte-identical: the version is what decides an update, and that is the
  // decision under test.
  const next = mkdtempSync(join(tmpdir(), 'forge-kit-next-'))
  homes.push(next)
  cpSync(KIT, next, { recursive: true })
  const bumped = { ...manifest, version: manifest.version + 1 }
  writeFileSync(join(next, FOREMAN_KIT_MANIFEST), JSON.stringify(bumped), 'utf8')

  const home = newHome()
  installForemanKit({ kitDir: KIT, claudeHome: home })

  // Vandalise two of them, keeping the marker they were installed with — the
  // shape of a skill Forge wrote and an old Forge has since moved past.
  const stale = `# stale\n\n${foremanMarker(manifest.version, 'a'.repeat(64))}\n`
  const skill = join(home, 'skills', 'fable-judge', 'SKILL.md')
  const agent = join(home, 'agents', 'gaffer-apprentice.md')
  writeFileSync(skill, stale, 'utf8')
  writeFileSync(agent, stale, 'utf8')

  const report = installForemanKit({ kitDir: next, claudeHome: home })
  ok(report.updated.length === 8, 'every marked name is updated to the newer kit', JSON.stringify(report))
  ok(report.installed.length === 0 && report.kept.length === 0 && report.failed.length === 0, 'nothing else moved')
  ok(!readFileSync(skill, 'utf8').includes('# stale'), 'the stale skill body is gone')
  ok(readForemanMarker(readFileSync(skill, 'utf8')).version === bumped.version, 'and its marker names the new version')
  ok(readForemanMarker(readFileSync(agent, 'utf8')).version === bumped.version, 'the agent is on the new version too')
  ok(
    existsSync(join(home, 'skills', 'fable-method', 'references', 'flowcharts.md')),
    'an update leaves the reference files in place'
  )
  {
    const head = manifest.skills.find((s) => s.name === 'fable-judge').files.find((f) => f.path === 'SKILL.md')
    ok(
      sha256(Buffer.from(stripForemanMarker(readFileSync(skill, 'utf8')), 'utf8')) === head.sha256,
      'the updated body is the bundled one again'
    )
  }

  // A file the user added inside a folder Forge owns is not the folder's
  // identity, and an update is not a reason to take it away.
  const theirs = join(home, 'skills', 'fable-judge', 'notes.md')
  writeFileSync(theirs, 'my notes\n', 'utf8')
  writeFileSync(skill, stale, 'utf8')
  installForemanKit({ kitDir: next, claudeHome: home })
  ok(readFileSync(theirs, 'utf8') === 'my notes\n', 'a file the user added beside SKILL.md survives an update')

  // A marker from the *future* is not ours to downgrade.
  const ahead = `# newer\n\n${foremanMarker(manifest.version + 5, 'b'.repeat(64))}\n`
  writeFileSync(skill, ahead, 'utf8')
  const forward = installForemanKit({ kitDir: KIT, claudeHome: home })
  ok(readFileSync(skill, 'utf8') === ahead, 'a newer marker is left alone rather than rolled back')
  ok(forward.updated.length === 0, 'and is not reported as an update')
}

/* ------------------------------------------------------ a doctored manifest */

console.log('\na manifest that is trying to get out')
{
  const home = newHome()
  const kit = mkdtempSync(join(tmpdir(), 'forge-kit-src-'))
  homes.push(kit)
  mkdirSync(join(kit, 'skills', 'gaffer'), { recursive: true })
  mkdirSync(join(kit, 'agents'), { recursive: true })
  const body = Buffer.from('---\nname: gaffer\n---\n\nreal.\n', 'utf8')
  writeFileSync(join(kit, 'skills', 'gaffer', 'SKILL.md'), body)
  writeFileSync(join(kit, 'agents', 'gaffer-builder.md'), body)
  // The file a traversal would be reaching for, one level above the kit.
  writeFileSync(join(kit, 'loot.md'), 'secret\n', 'utf8')

  const doctored = {
    version: 9,
    skills: [
      {
        name: 'gaffer',
        files: [
          { path: 'SKILL.md', sha256: sha256(body) },
          { path: '../../loot.md', sha256: sha256(body) }
        ]
      }
    ],
    agents: [{ name: 'gaffer-builder', sha256: sha256(body) }]
  }
  writeFileSync(join(kit, FOREMAN_KIT_MANIFEST), JSON.stringify(doctored), 'utf8')

  const before = tree(home)
  const report = installForemanKit({ kitDir: kit, claudeHome: home })
  ok(report.failed.some((f) => f.name === 'gaffer'), 'the skill carrying the traversal fails', JSON.stringify(report))
  ok(!report.installed.includes('gaffer'), 'and is not reported as installed')
  ok(!existsSync(join(home, 'skills', 'gaffer')), 'no half-written folder is left behind')
  ok(!existsSync(join(home, 'skills', 'gaffer.forge-kit')), 'and no staging folder either')
  ok(!existsSync(join(home, 'loot.md')) && !existsSync(join(home, 'skills', 'loot.md')), 'nothing landed up the tree')
  const added = tree(home).filter((p) => !before.includes(p))
  ok(
    added.every((p) => p === 'skills' || p === 'agents' || p.startsWith('agents/gaffer-builder')),
    `only the agent that was well-formed appeared (${added.join(', ') || 'nothing'})`
  )
  ok(report.installed.includes('gaffer-builder'), 'the well-formed half of the kit still installed')

  // The same reach, arriving as a Windows traversal rather than a posix one.
  const windows = JSON.parse(JSON.stringify(doctored))
  windows.skills[0].files[1].path = '..\\..\\loot.md'
  writeFileSync(join(kit, FOREMAN_KIT_MANIFEST), JSON.stringify(windows), 'utf8')
  const winHome = newHome()
  const winReport = installForemanKit({ kitDir: kit, claudeHome: winHome })
  ok(winReport.failed.some((f) => f.name === 'gaffer'), 'a backslash traversal fails the skill the same way')
  ok(!existsSync(join(winHome, 'skills', 'gaffer')), 'and writes nothing')
  ok(tree(winHome).every((p) => !p.includes('loot')), 'no loot.md anywhere under the home')

  // A skill name that is itself a path.
  const named = JSON.parse(JSON.stringify(doctored))
  named.skills[0].name = '../escape'
  named.skills[0].files = [{ path: 'SKILL.md', sha256: sha256(body) }]
  writeFileSync(join(kit, FOREMAN_KIT_MANIFEST), JSON.stringify(named), 'utf8')
  const nameHome = newHome()
  const namedReport = installForemanKit({ kitDir: kit, claudeHome: nameHome })
  ok(namedReport.failed.some((f) => f.name === '../escape'), 'a skill name that is a path is refused by name')
  ok(!existsSync(join(nameHome, 'escape')), 'and nothing was written a level up')
}

/* ------------------------------------------------------- a broken manifest */

console.log('\na kit that cannot be read at all')
{
  const empty = mkdtempSync(join(tmpdir(), 'forge-kit-empty-'))
  homes.push(empty)
  const home = newHome()
  const missing = installForemanKit({ kitDir: empty, claudeHome: home })
  ok(missing.failed.length === 1 && missing.installed.length === 0, 'a kit with no manifest is one failure, not a throw')

  writeFileSync(join(empty, FOREMAN_KIT_MANIFEST), '{ not json', 'utf8')
  ok(installForemanKit({ kitDir: empty, claudeHome: home }).failed.length === 1, 'and so is a manifest that is junk')

  ok(parseForemanKitManifest('{"version":0,"skills":[],"agents":[]}').ok === false, 'version 0 is not a version')
  ok(parseForemanKitManifest('[]').ok === false, 'a top-level array is refused')
  ok(
    parseForemanKitManifest('{"version":1,"skills":[{"name":"a","files":[{"path":"x","sha256":"nope"}]}],"agents":[]}').ok ===
      false,
    'a hash that is not a hash is refused'
  )
}

/* ---------------------------------------------------------- the marker itself */

console.log('\nthe marker')
{
  ok(readForemanMarker('# hello\n') === null, 'an ordinary file has no marker')
  ok(readForemanMarker(`${foremanMarker(3, 'c'.repeat(64))}\n`)?.version === 3, 'ours reads back its version')
  ok(
    readForemanMarker(`${foremanMarker(3, 'c'.repeat(64))}\n\nand then more prose\n`) === null,
    'a marker quoted mid-document does not count — it is anchored at the end'
  )
  ok(readForemanMarker('<!-- forge-foreman-kit v2 sha:short -->\n') === null, 'a truncated hash is not a marker')
  ok(readForemanMarker(null) === null, 'and neither is nothing at all')
}

/* -------------------------------------------------------------- the real one */

console.log('\nthe machine this ran on')
ok(sha256(Buffer.from(tree(join(homedir(), '.claude', 'skills')).join('\n'))) === realBefore, '~/.claude/skills never moved')
ok(sha256(Buffer.from(tree(join(homedir(), '.claude', 'agents')).join('\n'))) === agentsBefore, 'and neither did agents/')

for (const dir of homes) rmSync(dir, { recursive: true, force: true })

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'} — ${pass + fail} checks, ${fail} failures.\n`)
process.exit(fail === 0 ? 0 : 1)
