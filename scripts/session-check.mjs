/**
 * Head-less proof of resume-on-restore.
 *
 * Closing Forge kills every pane's shell — that is what a PTY is. What it must
 * no longer kill is the *conversation*: every pane carries a session id in its
 * saved layout, and reopening the project hands that id back to Claude Code.
 * This drives the real modules the way Forge does:
 *
 *   1. ids and composition        shared/session.ts
 *   2. the transcript lookup      electron/bridge/claude-transcripts.ts,
 *      against a real tree         built under a temp CLAUDE_CONFIG_DIR
 *   3. the whole bootstrap line   composed in the order pty-host.ts uses
 *   4. the installed CLI agrees   a real `claude` rejecting a non-uuid, which
 *                                  is the contract shared/session.ts encodes
 *
 * What it cannot prove is the conversation itself coming back — that needs
 * Steve's account and a real session. Step 4 is the closest a script gets.
 *
 *   npm run session:check
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-session-check')
mkdirSync(scratch, { recursive: true })

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

const eq = (actual, expected, label) =>
  log(actual === expected, `${label}${actual === expected ? '' : `\n        got: ${actual}\n        want: ${expected}`}`)

async function bundle(relSource, outName, external = []) {
  const outfile = join(scratch, outName)
  await build({
    entryPoints: [join(ROOT, relSource)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    logLevel: 'silent',
    absWorkingDir: ROOT,
    // electron-vite resolves this for the real build; esbuild has to be told.
    alias: { '@shared': join(ROOT, 'shared') }
  })
  return import(pathToFileURL(outfile).href)
}

/**
 * Run a command line and hand back whatever it said, however it exited — the
 * interesting answers here are on stderr, with a non-zero exit.
 *
 * One string rather than exe + args: `claude` on Windows is npm's .cmd shim, so
 * it needs a shell, and a shell plus a separate args array is the combination
 * Node now warns about.
 */
function run(line) {
  return new Promise((done) => {
    execFile(line, { shell: true, timeout: 30_000 }, (err, stdout, stderr) => {
      done(`${stdout ?? ''}${stderr ?? ''}${err && !stdout && !stderr ? String(err.message) : ''}`.trim())
    })
  })
}

const UUID = '3f8c1a92-5b7e-4d21-9c04-7ae6d1b8f350'
const OTHER = '11111111-2222-4333-8444-555555555555'

async function main() {
  const session = await bundle('shared/session.ts', 'session.mjs')
  const transcripts = await bundle('electron/bridge/claude-transcripts.ts', 'transcripts.mjs')

  const { composeSession, hasSessionFlag, isSessionId, newSessionId, transcriptDirName } = session

  /* ----------------------------------------------------------------- 1. ids */

  log(isSessionId(UUID), 'a canonical uuid is a session id')
  log(!isSessionId('not-a-uuid'), 'and a bare word is not')
  log(!isSessionId(''), 'nor is nothing')
  log(!isSessionId(`${UUID} --dangerously-skip-permissions`), 'nor is a uuid with a flag smuggled onto the end')
  log(!isSessionId(undefined), 'a missing id is not an id')

  const minted = newSessionId()
  log(isSessionId(minted), `a freshly minted id is one Claude will accept (${minted})`)
  log(newSessionId() !== newSessionId(), 'and two of them are not the same')

  /* --------------------------------------------------------- 2. composition */

  eq(composeSession('claude', UUID, 'new'), `claude --session-id ${UUID}`, 'a first launch claims the id')
  eq(composeSession('claude', UUID, 'resume'), `claude --resume ${UUID}`, 'every launch after that resumes it')
  eq(
    composeSession('claude --permission-mode plan', UUID, 'resume'),
    `claude --permission-mode plan --resume ${UUID}`,
    'a pane opened in plan mode keeps its mode and gains the session'
  )
  eq(composeSession('', UUID, 'new'), '', 'a plain shell is left alone')
  eq(composeSession('gemini', UUID, 'new'), 'gemini', 'so is another tool')
  eq(composeSession('kimi --yolo', UUID, 'resume'), 'kimi --yolo', 'and a renamed profile command')
  eq(composeSession('claude', 'not-a-uuid', 'new'), 'claude', 'an id Claude would reject is never put on the line')
  eq(composeSession('claude -p "hi"', UUID, 'new'), 'claude -p "hi"', 'a one-shot --print run has no session to name')

  // Somebody who has already decided how their panes start is not overruled.
  eq(composeSession('claude --resume', UUID, 'resume'), 'claude --resume', 'a hand-written --resume is left as it is')
  eq(composeSession('claude -c', UUID, 'resume'), 'claude -c', 'so is --continue')
  eq(
    composeSession(`claude --session-id ${OTHER}`, UUID, 'new'),
    `claude --session-id ${OTHER}`,
    'and a hand-written --session-id is never doubled'
  )
  log(hasSessionFlag('claude --fork-session --resume x'), '--fork-session counts as having decided too')
  log(!hasSessionFlag('claude --permission-mode acceptEdits'), 'an unrelated flag does not')

  eq(
    composeSession('C:\\tools\\claude.exe', UUID, 'resume'),
    `C:\\tools\\claude.exe --resume ${UUID}`,
    'an absolute path to claude.exe is recognised'
  )
  eq(
    composeSession('claude.cmd', UUID, 'resume'),
    `claude.cmd --resume ${UUID}`,
    "npm's .cmd shim is recognised as Claude too"
  )

  /* --------------------------------------------------------- 3. the folder */

  eq(
    transcriptDirName('C:\\Users\\steve\\Desktop\\forge'),
    'C--Users-steve-Desktop-forge',
    'a Windows path becomes the folder Claude really files it under'
  )
  eq(
    transcriptDirName('C:\\Users\\steve\\Desktop\\forge\\.claude\\worktrees\\agent-af4bb'),
    'C--Users-steve-Desktop-forge--claude-worktrees-agent-af4bb',
    'a dotted folder collapses the same way (verified against a real ~/.claude/projects)'
  )
  eq(transcriptDirName('C:\\Users\\steve\\Desktop\\forge\\'), 'C--Users-steve-Desktop-forge', 'a trailing slash is not a folder of its own')

  /* ------------------------------------------------ 4. resume vs first run */

  const home = mkdtempSync(join(tmpdir(), 'forge-claude-'))
  const env = { CLAUDE_CONFIG_DIR: home }
  const cwd = 'C:\\Users\\steve\\Desktop\\forge'

  log(!transcripts.hasTranscript(cwd, UUID, env), 'a pane with no transcript on disk has never run')

  const dir = join(home, 'projects', transcriptDirName(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${UUID}.jsonl`), '{"type":"user"}\n')

  log(transcripts.hasTranscript(cwd, UUID, env), 'and once Claude has written one, it has')
  log(!transcripts.hasTranscript(cwd, OTHER, env), 'a different pane in the same project is judged on its own file')
  log(!transcripts.hasTranscript('C:\\Users\\steve\\Desktop\\other', UUID, env), 'as is the same id in another project')
  log(!transcripts.hasTranscript(cwd, 'not-a-uuid', env), 'a junk id is never turned into a path')
  eq(
    transcripts.transcriptPath(cwd, UUID, env),
    join(home, 'projects', 'C--Users-steve-Desktop-forge', `${UUID}.jsonl`),
    'the path is the one Claude Code uses'
  )

  // The decision applyClaudeSession makes, spelled out end to end.
  const mode = transcripts.hasTranscript(cwd, UUID, env) ? 'resume' : 'new'
  eq(composeSession('claude', UUID, mode), `claude --resume ${UUID}`, 'a pane with a past reopens into it')

  rmSync(home, { recursive: true, force: true })

  /* ------------------------------------------------- 5. the whole line */

  // The order electron/pty-host.ts applies them in: Remote Control, then the
  // session, then the bridge — whose `--mcp-config <configs...>` is variadic
  // and has to stay last.
  const remote = await bundle('shared/remote.ts', 'remote.mjs')
  const withRemote = remote.composeRemoteControl('claude', 'Forge — Claude Code')
  const withSession = composeSession(withRemote, UUID, 'resume')
  const full = `${withSession} --mcp-config "C:\\Forge\\bridge\\mcp.json"`
  eq(
    full,
    `claude --remote-control 'Forge — Claude Code' --resume ${UUID} --mcp-config "C:\\Forge\\bridge\\mcp.json"`,
    'all three transforms compose, with --mcp-config last'
  )

  /* --------------------------------------------------- 6. the real CLI */

  const bad = await run('claude --session-id not-a-uuid -p "hi"')
  log(
    /invalid session id/i.test(bad),
    `the installed Claude requires a real uuid — which is why isSessionId exists\n        said: ${bad.split('\n')[0]}`
  )
  const unknown = await run('claude --not-a-real-flag -p "hi"')
  log(
    /unknown option/i.test(unknown),
    'and it rejects flags it does not know, so the check above is a real parse'
  )

  console.log(failures === 0 ? '\nAll session checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
