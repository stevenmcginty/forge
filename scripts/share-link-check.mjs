/**
 * Rules check for the pane link — one agent typing into another agent's terminal.
 *
 *   node scripts/share-link-check.mjs
 *
 * The scratchpad's failure mode is losing somebody's note. This feature's is
 * worse: it writes keystrokes into a live agent's PTY, so getting it wrong means
 * interrupting a turn, addressing the wrong pane, or reaching out of the project
 * the caller is in. All three are decided by `ShareLink.handle`, which takes its
 * clock as an argument precisely so they can be held to their rules here without
 * sleeping through a single one of them.
 *
 * Four things this asserts that are easy to get wrong and impossible to notice:
 *
 *   • the idle gate needs BOTH halves — a pane that has been quiet for 1.3s but
 *     printed a solid run of output two seconds ago is an agent between tool
 *     calls, and typing into that is typing over somebody's shoulder;
 *   • an ambiguous name is refused rather than guessed, because guessing which
 *     agent to interrupt is the one mistake this must never make;
 *   • a pane in another project is not addressable at all, and neither is a
 *     caller whose own name main does not know;
 *   • the message reaches the PTY as `\r` and never `\n`, with any escape
 *     sequence in it stripped — the text came from a language model and is about
 *     to be written raw onto a terminal.
 *
 * It then drives the real MCP server over real stdio against a real pipe, which
 * is the only way to know the two ends agree about the protocol.
 */
import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const { ShareLink } = await import('../electron/share-link.ts')
const S = await import('../shared/share.ts')

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

/* --------------------------------------------------------------- the fake desk
 *
 * A stand-in for the PTY host: `write` records instead of reaching ConPTY, and
 * `replay` hands back whatever a case put there. Nothing else about the host is
 * needed, which is the point of injecting the two of them.
 */

const writes = []
const replays = new Map()

const linkOf = () => {
  writes.length = 0
  replays.clear()
  return new ShareLink({
    write: (id, data) => {
      if (id === 'dead') return false
      writes.push({ id, data })
      return true
    },
    replay: (id) => replays.get(id) ?? ''
  })
}

// The Forge project is this checkout, because the MCP server is spawned *in*
// it further down and reports its real cwd over the wire — a made-up path is
// a cwd spawn() cannot enter, which on CI surfaces as a baffling ENOENT for
// node.exe itself (Checks, 2026-08-23). The other project never has to exist.
const FORGE = resolve(fileURLToPath(new URL('..', import.meta.url)))
const OTHER = resolve(FORGE, '..', 'car-harness')

/** Rex, Zora and two more, in one project; a second Zora in another. */
const populate = (link) => {
  link.register({ id: 'p1', title: 'Rex', agent: 'claude', cwd: FORGE, projectName: 'Forge' })
  link.register({ id: 'p2', title: 'Zora', agent: 'codex', cwd: FORGE, projectName: 'Forge' })
  link.register({ id: 'p3', title: 'Kim', agent: 'codex', cwd: `${FORGE}\\web`, projectName: 'Forge' })
  link.register({ id: 'p4', title: 'Sol', agent: 'opencode', cwd: FORGE, projectName: 'Forge' })
  link.register({ id: 'p9', title: 'Zora', agent: 'codex', cwd: OTHER, projectName: 'Car harness' })
  return link
}

const T0 = Date.now()
const from = { from: 'Rex', cwd: FORGE }

/* -------------------------------------------------------------- who is calling */

console.log('\nwho is calling')
{
  const link = populate(linkOf())
  const stranger = link.handle({ op: 'panes', from: 'Mallory', cwd: FORGE }, T0)
  ok(!stranger.ok, 'a caller Forge does not know is refused')
  ok(/does not know a pane called "Mallory"/.test(stranger.error), 'and is told why', stranger.error)

  const anonymous = link.handle({ op: 'panes', from: '', cwd: FORGE }, T0)
  ok(!anonymous.ok && /FORGE_SHARE_AGENT is unset/.test(anonymous.error), 'so is one with no name at all', anonymous.error)

  const bad = link.handle({ op: 'teleport', ...from }, T0)
  ok(!bad.ok && /Unknown op/.test(bad.error), 'an op this link does not speak is refused', bad.error)

  // Two panes called Rex, one per project: the cwd the caller is running in is
  // what says which of them is asking.
  const twins = linkOf()
  twins.register({ id: 'a', title: 'Rex', agent: 'claude', cwd: FORGE, projectName: 'Forge' })
  twins.register({ id: 'b', title: 'Rex', agent: 'claude', cwd: OTHER, projectName: 'Car harness' })
  twins.register({ id: 'c', title: 'Zora', agent: 'codex', cwd: OTHER, projectName: 'Car harness' })
  const placed = twins.handle({ op: 'panes', from: 'Rex', cwd: `${OTHER}\\backend` }, T0)
  ok(placed.ok && placed.panes.some((p) => p.id === 'c'), 'a name shared by two projects is placed by the caller’s cwd', JSON.stringify(placed))
  ok(placed.ok && !placed.panes.some((p) => p.id === 'a'), 'and the other project’s panes are not in the answer')
  const lost = twins.handle({ op: 'panes', from: 'Rex', cwd: 'D:\\somewhere\\else' }, T0)
  ok(!lost.ok, 'a caller whose cwd settles nothing is refused rather than guessed at', JSON.stringify(lost))
}

/* -------------------------------------------------------------------- scoping */

console.log('\nthe project is the wall')
{
  const link = populate(linkOf())
  const panes = link.handle({ op: 'panes', ...from }, T0)
  ok(panes.ok, 'panes lists the project')
  ok(
    JSON.stringify(panes.panes.map((p) => p.id).sort()) === JSON.stringify(['p1', 'p2', 'p3', 'p4']),
    'with every pane in it and nothing from the other project',
    JSON.stringify(panes.panes.map((p) => p.id))
  )

  // 'Zora' exists in both projects. The caller is in Forge, so it can only be p2.
  link.noteOutput('p2', T0 - 9000)
  const sent = link.handle({ op: 'send', ...from, pane: 'Zora', text: 'hello' }, T0)
  ok(sent.ok && sent.id === 'p2', 'a name that exists in two projects resolves inside the caller’s own', JSON.stringify(sent))

  const reachOut = link.handle({ op: 'send', ...from, pane: 'p9', text: 'hello' }, T0)
  ok(!reachOut.ok, 'a pane in another project is not addressable even by its id', JSON.stringify(reachOut))
}

/* ------------------------------------------------------------------- resolving */

console.log('\nfinding a pane')
{
  const link = populate(linkOf())
  for (const id of ['p1', 'p2', 'p3', 'p4']) link.noteOutput(id, T0 - 9000)

  // Spaced well apart, because a send makes its target busy for the next one —
  // which is a rule in its own right, asserted under "the idle gate" below.
  ok(link.handle({ op: 'send', ...from, pane: 'zora', text: 'x' }, T0).id === 'p2', 'a pane name matches case-insensitively')
  ok(link.handle({ op: 'send', ...from, pane: 'p4', text: 'x' }, T0 + 30_000).id === 'p4', 'so does a pane id')
  ok(
    link.handle({ op: 'send', ...from, pane: 'OpenCode', text: 'x' }, T0 + 60_000).id === 'p4',
    'and an agent name, when only one pane is running it'
  )

  const ambiguous = link.handle({ op: 'send', ...from, pane: 'codex', text: 'x' }, T0 + 60_000)
  ok(!ambiguous.ok && /^ambiguous:/.test(ambiguous.error), 'two panes running codex is ambiguous, not a guess', ambiguous.error)
  ok(
    Array.isArray(ambiguous.candidates) && ambiguous.candidates.length === 2,
    'and both candidates are named so the caller can pick',
    JSON.stringify(ambiguous.candidates)
  )
  ok(writes.length === 3, 'an ambiguous send writes nothing', String(writes.length))

  const unknown = link.handle({ op: 'send', ...from, pane: 'Nobody', text: 'x' }, T0 + 60_000)
  ok(!unknown.ok && /No pane in this project is called "Nobody"/.test(unknown.error), 'an unknown pane is refused', unknown.error)
  ok(
    Array.isArray(unknown.panes) && unknown.panes.length === 4,
    'and the refusal lists what there is instead',
    JSON.stringify(unknown.panes?.map((p) => p.title))
  )

  const self = link.handle({ op: 'send', ...from, pane: 'Rex', text: 'x' }, T0 + 60_000)
  ok(!self.ok && /cannot type into itself/.test(self.error), 'a pane cannot send to itself', self.error)

  const nameless = link.handle({ op: 'send', ...from, pane: '  ', text: 'x' }, T0 + 60_000)
  ok(!nameless.ok && /`pane` is required/.test(nameless.error), 'and `pane` is required', nameless.error)
}

/* ------------------------------------------------------------------- the gate */

console.log('\nthe idle gate')
{
  const link = populate(linkOf())

  // A solid run: four chunks, no gap over BUSY_GAP_MS, lasting over BUSY_ONSET_MS.
  for (const at of [T0, T0 + 200, T0 + 400, T0 + 700]) link.noteOutput('p2', at)

  const straightAfter = link.handle({ op: 'send', ...from, pane: 'Zora', text: 'x' }, T0 + 1000)
  ok(!straightAfter.ok && /^busy:/.test(straightAfter.error), 'a pane that just printed is busy', straightAfter.error)
  ok(straightAfter.quietForMs === 300, 'and the refusal says how quiet it has been', String(straightAfter.quietForMs))

  // The half that a naive "has it been quiet for 1.2s" gets wrong: it HAS been
  // quiet for 1.3s, and it is still an agent between two tool calls.
  const inThePause = link.handle({ op: 'send', ...from, pane: 'Zora', text: 'x' }, T0 + 2000)
  ok(!inThePause.ok, 'quiet for over 1.2s is still busy while the burst is inside the window', JSON.stringify(inThePause))
  ok(inThePause.quietForMs === 1300, 'and it is quiet for 1300ms exactly', String(inThePause.quietForMs))

  ok(writes.length === 0, 'a busy refusal writes nothing at all, and queues nothing')

  const forced = link.handle({ op: 'send', ...from, pane: 'Zora', text: 'stop', force: true }, T0 + 2000)
  ok(forced.ok && forced.forced === true, 'force sends anyway, and says it forced', JSON.stringify(forced))
  ok(writes.length === 1 && writes[0].data === '[from Rex] stop\r', 'writing the message it was given', JSON.stringify(writes[0]))

  // Once the burst has aged out of the window, the pane is genuinely idle.
  const later = link.handle({ op: 'send', ...from, pane: 'Zora', text: 'now then' }, T0 + 8000)
  ok(later.ok, 'a pane whose burst has aged out of the window is idle', JSON.stringify(later))

  // A single blip — a keystroke echo — is not a run and never made it busy.
  const blip = linkOf()
  populate(blip)
  blip.noteOutput('p2', T0)
  const afterBlip = blip.handle({ op: 'send', ...from, pane: 'Zora', text: 'x' }, T0 + 1500)
  ok(afterBlip.ok, 'one chunk of output is an echo, not a run — the pane stays sendable', JSON.stringify(afterBlip))

  // A send makes the pane busy for the next one: the receiving TUI has not
  // echoed anything yet, and two messages in the same millisecond is not a
  // conversation.
  const twice = blip.handle({ op: 'send', ...from, pane: 'Zora', text: 'and another' }, T0 + 1500)
  ok(!twice.ok && /^busy:/.test(twice.error), 'a second send in the same beat is refused', twice.error)
}

console.log('\nwhat reaches the terminal')
{
  const link = populate(linkOf())
  link.noteOutput('p2', T0 - 9000)

  const sent = link.handle({ op: 'send', ...from, pane: 'Zora', text: 'use the Cloudflare route' }, T0)
  ok(sent.ok, 'an idle pane takes the message', JSON.stringify(sent))
  ok(
    writes[0].data === '[from Rex] use the Cloudflare route\r',
    'prefixed with the sender and submitted with a carriage return',
    JSON.stringify(writes[0].data)
  )
  ok(!writes[0].data.includes('\n'), 'never a line feed — that would land in the composer and submit nothing')

  link.noteOutput('p3', T0 - 9000)
  link.handle({ op: 'send', ...from, pane: 'Kim', text: 'first line\nsecond line\n\nthird' }, T0)
  ok(
    writes[1].data === '[from Rex] first line second line third\r',
    'newlines collapse to spaces, because a TUI submits on Enter',
    JSON.stringify(writes[1].data)
  )

  link.noteOutput('p4', T0 - 9000)
  link.handle({ op: 'send', ...from, pane: 'Sol', text: 'one\ntwo', multiline: true }, T0)
  ok(
    writes[2].data === '[from Rex] one\rtwo\r',
    'multiline: true keeps them, as carriage returns, which is what the caller asked for',
    JSON.stringify(writes[2].data)
  )

  const nasty = linkOf()
  populate(nasty)
  nasty.noteOutput('p2', T0 - 9000)
  nasty.handle({ op: 'send', ...from, pane: 'Zora', text: 'red \u001b[31mtext\u001b[0m and \u001b]0;a title\u0007more' }, T0)
  ok(
    writes[0].data === '[from Rex] red text and more\r',
    'escape sequences are stripped before anything is written to a live terminal',
    JSON.stringify(writes[0].data)
  )

  const empty = nasty.handle({ op: 'send', ...from, pane: 'Sol', text: '   \n  ' }, T0)
  ok(!empty.ok && /`text` is required/.test(empty.error), 'an empty message is refused', empty.error)

  const huge = nasty.handle({ op: 'send', ...from, pane: 'Sol', text: 'x'.repeat(S.SHARE_SEND_MAX_BYTES + 1) }, T0)
  ok(!huge.ok && /refused rather than cut/.test(huge.error), 'a message over the cap is refused rather than truncated', huge.error)
  ok(writes.length === 1, 'and nothing was written trying', String(writes.length))

  const gone = linkOf()
  gone.register({ id: 'p1', title: 'Rex', agent: 'claude', cwd: FORGE, projectName: 'Forge' })
  gone.register({ id: 'dead', title: 'Ghost', agent: 'codex', cwd: FORGE, projectName: 'Forge' })
  gone.noteOutput('dead', T0 - 9000)
  const refused = gone.handle({ op: 'send', ...from, pane: 'Ghost', text: 'hello?' }, T0)
  ok(!refused.ok && /may have just closed/.test(refused.error), 'a PTY that will not take the write is reported honestly', refused.error)
}

/* -------------------------------------------------------------------- renaming */

console.log('\nrenaming')
{
  const link = linkOf()
  link.register({ id: 'r1', title: 'Claude Code', agent: 'claude', cwd: FORGE, projectName: 'Forge' })
  link.register({ id: 'r2', title: 'Rex', agent: 'claude', cwd: FORGE, projectName: 'Forge' })
  link.rename('r1', 'Petra')

  const panes = link.handle({ op: 'panes', from: 'Rex', cwd: FORGE }, T0)
  ok(
    panes.ok && panes.panes.some((p) => p.id === 'r1' && p.title === 'Petra'),
    'panes lists the pane under its new title',
    JSON.stringify(panes.panes)
  )
  ok(!panes.panes.some((p) => p.title === 'Claude Code'), 'and not under the one it launched with', JSON.stringify(panes.panes))

  link.noteOutput('r1', T0 - 9000)
  const sent = link.handle({ op: 'send', from: 'Rex', cwd: FORGE, pane: 'Petra', text: 'hi' }, T0)
  ok(sent.ok && sent.id === 'r1', 'send resolves the pane by its new title', JSON.stringify(sent))

  const read = link.handle({ op: 'read', from: 'Rex', cwd: FORGE, pane: 'Petra' }, T0)
  ok(read.ok && read.id === 'r1', 'read resolves the pane by its new title', JSON.stringify(read))

  // `FORGE_SHARE_AGENT` is set once, into the pane's own environment, when its
  // process is spawned, and cannot change afterwards — so a renamed pane's own
  // requests still arrive with `from` set to the name it launched under. The
  // caller lookup has to keep recognising that name as this pane, even though
  // `panes` (and everyone else) now sees it as "Petra".
  const asCaller = link.handle({ op: 'panes', from: 'Claude Code', cwd: FORGE }, T0)
  ok(asCaller.ok, 'a renamed pane still places itself as caller by the name it launched with', JSON.stringify(asCaller))

  // Its new title places it too — nothing revokes the current name, this only
  // adds the launch name back in as a second way to recognise the same pane.
  const asNewName = link.handle({ op: 'panes', from: 'Petra', cwd: FORGE }, T0)
  ok(asNewName.ok, 'and it places itself by its new title too', JSON.stringify(asNewName))

  const renameGhost = linkOf()
  renameGhost.rename('nobody', 'Whoever')
  ok(true, 'renaming a pane nothing registered is a silent no-op, not a throw')
}

/* -------------------------------------------------------------------- reading */

console.log('\nreading a pane')
{
  const link = populate(linkOf())
  /*
   * Over SHARE_CAPTURE_MAX_LINES on purpose, so the hard ceiling below is
   * actually reached rather than merely asked for.
   *
   * LF and not CRLF — deliberately *not* what a real PTY emits. See the last
   * case in this section, which pins why that distinction currently matters.
   */
  replays.set('p2', `\u001b[2J\u001b[H${Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n')}\n`)
  link.noteOutput('p2', T0 - 9000)

  const read = link.handle({ op: 'read', ...from, pane: 'Zora', lines: 5 }, T0)
  ok(read.ok, 'read answers', JSON.stringify(read).slice(0, 120))
  ok(read.text === 'line 595\nline 596\nline 597\nline 598\nline 599', 'with the last N lines, stripped of escapes', JSON.stringify(read.text))
  ok(read.lines === 5, 'and says how many it gave back', String(read.lines))
  ok(read.idle === true && read.quietForMs === 9000, 'and whether the pane is idle, so a caller can poll', JSON.stringify(read))

  const capped = link.handle({ op: 'read', ...from, pane: 'Zora', lines: 9999 }, T0)
  ok(
    capped.text.split('\n').length === S.SHARE_CAPTURE_MAX_LINES,
    'the hard ceiling wins over the asked-for count',
    String(capped.text.split('\n').length)
  )

  const defaulted = link.handle({ op: 'read', ...from, pane: 'Zora' }, T0)
  ok(defaulted.text.split('\n').length === S.SHARE_READ_DEFAULT_LINES, 'and no count at all gets the default', String(defaulted.lines))

  const silent = link.handle({ op: 'read', ...from, pane: 'Sol' }, T0)
  ok(silent.ok && silent.text === '', 'a pane that has printed nothing reads as nothing, not as an error')

  // Reading never touches the PTY.
  ok(writes.length === 0, 'and reading writes nothing, ever')

  const busy = link.handle({ op: 'read', ...from, pane: 'Kim' }, T0)
  ok(busy.ok, 'a busy pane can still be read — that is the whole point of polling it')

  // A real Windows pane emits CRLF; stripAnsi must keep those lines.
  const crlf = linkOf()
  populate(crlf)
  crlf.noteOutput('p2', T0 - 9000)
  replays.set('p2', 'first line\r\nsecond line\r\n')
  const real = crlf.handle({ op: 'read', ...from, pane: 'Zora', lines: 5 }, T0)
  ok(
    real.text === 'first line\nsecond line',
    'a CRLF buffer — i.e. any real pane — reads back as its lines',
    JSON.stringify(real.text)
  )
}

/* ------------------------------------------------------------ over a real pipe */

const { unlinkSync, existsSync } = await import('node:fs')
const { connect } = await import('node:net')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const PIPE =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\forge-share-check-${process.pid}`
    : join(tmpdir(), `forge-share-check-${process.pid}.sock`)

/**
 * One request, one reply, one connection — exactly what the bridge's client does.
 *
 * `request` is sent as JSON unless it is already a string, which is how the
 * malformed-input case gets a line that JSON.parse cannot take.
 */
function askPipe(path, request) {
  return new Promise((res, rej) => {
    const socket = connect(path)
    let buffer = ''
    let settled = false
    const done = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (err) rej(err)
      else res(value)
    }
    const timer = setTimeout(() => done(new Error('timeout')), 8000)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${typeof request === 'string' ? request : JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl === -1) return
      try {
        done(null, JSON.parse(buffer.slice(0, nl)))
      } catch (err) {
        done(err)
      }
    })
    socket.on('error', (err) => done(err))
    socket.on('close', () => done(new Error('closed without answering')))
  })
}

console.log('\nover a real pipe')
const link = populate(linkOf())
const listening = link.listen(PIPE)
ok(listening === PIPE, 'the link listens on the path it was given', String(listening))
ok(link.address() === PIPE, 'and reports it')
ok(link.listen(PIPE) === PIPE, 'listening twice is the same link, not a second one')

// Left listening for the MCP block below, and closed at the very end.
{
  link.noteOutput('p2', Date.now() - 9000)

  const panes = await askPipe(PIPE, { op: 'panes', from: 'Rex', cwd: FORGE })
  ok(panes?.ok && panes.panes.length === 4, 'panes round-trips as JSON over the socket', JSON.stringify(panes).slice(0, 140))

  const sent = await askPipe(PIPE, { op: 'send', from: 'Rex', cwd: FORGE, pane: 'Zora', text: 'over the wire' })
  ok(sent?.ok, 'send round-trips', JSON.stringify(sent))
  ok(writes.at(-1)?.data === '[from Rex] over the wire\r', 'and reaches the PTY', JSON.stringify(writes.at(-1)))

  const junk = await askPipe(PIPE, '{ not json at all')
  ok(junk?.ok === false && /not JSON/.test(junk.error), 'a malformed request is answered rather than dropped', JSON.stringify(junk))

  const stranger = await askPipe(PIPE, { op: 'send', from: 'Mallory', cwd: FORGE, pane: 'Zora', text: 'hi' })
  ok(stranger?.ok === false, 'and an unknown caller is refused over the wire too', JSON.stringify(stranger))
}

/* ------------------------------------------------------------- the MCP server
 *
 * Hand-rolled JSON-RPC over real stdio, exactly as scripts/share-check.mjs does
 * it — deliberately not through the MCP SDK's client, because a server broken in
 * the same way as the client it was tested with is a server that passes.
 */

const { spawn } = await import('node:child_process')

const SERVER = fileURLToPath(new URL('../bridge/share-bridge.mjs', import.meta.url))
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FORGE_SHARE_')))

function openServer(env) {
  const child = spawn(process.execPath, [SERVER], { cwd: FORGE, stdio: ['pipe', 'pipe', 'pipe'], env })
  let buffer = ''
  let stderr = ''
  const waiters = new Map()

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const w = waiters.get(msg.id)
      if (w) {
        waiters.delete(msg.id)
        w(msg)
      }
    }
  })
  child.stderr.on('data', (d) => {
    stderr += d.toString()
  })

  let nextId = 1
  const request = (method, params) =>
    new Promise((res, rej) => {
      const id = nextId++
      const timer = setTimeout(() => {
        waiters.delete(id)
        rej(new Error(`timeout waiting for ${method}\nstderr: ${stderr}`))
      }, 20_000)
      waiters.set(id, (msg) => {
        clearTimeout(timer)
        res(msg)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  return {
    child,
    request,
    notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    stderrText: () => stderr,
    close: () => child.kill()
  }
}

const textOf = (reply) => (reply?.result?.content ?? []).map((c) => c.text ?? '').join('\n')

async function handshake(server) {
  const init = await server.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'share-link-check', version: '1.0.0' }
  })
  server.notify('notifications/initialized', {})
  return init
}

console.log('\nthe MCP server, wired to the link')
{
  const server = openServer({ ...CLEAN_ENV, FORGE_SHARE_LINK: PIPE, FORGE_SHARE_AGENT: 'Rex' })
  try {
    await handshake(server)

    const list = await server.request('tools/list', {})
    const names = (list?.result?.tools ?? []).map((t) => t.name).sort()
    console.log(`     tools/list → ${JSON.stringify(names)}`)
    ok(names.includes('pane_send') && names.includes('pane_read'), 'pane_send and pane_read are offered', JSON.stringify(names))
    const byName = Object.fromEntries((list?.result?.tools ?? []).map((t) => [t.name, t]))
    ok(
      /another agent/.test(byName.pane_send?.description ?? '') && /\[from/.test(byName.pane_send?.description ?? ''),
      'pane_send says plainly what it does to the receiver',
      byName.pane_send?.description?.slice(0, 90)
    )
    ok(/pane_read/.test(byName.pane_send?.description ?? ''), 'and points at pane_read for the reply')
    ok(/share_panes/.test(byName.pane_send?.description ?? ''), 'and at share_panes for the names')

    const panes = await server.request('tools/call', { name: 'share_panes', arguments: {} })
    ok(/Zora/.test(textOf(panes)) && /Sol/.test(textOf(panes)), 'share_panes answers from the link, with no panes.json in sight', textOf(panes))

    link.noteOutput('p4', Date.now() - 9000)
    const sent = await server.request('tools/call', { name: 'pane_send', arguments: { pane: 'Sol', text: 'ship it' } })
    ok(!sent?.result?.isError, 'pane_send goes through', textOf(sent))
    ok(writes.at(-1)?.id === 'p4' && writes.at(-1)?.data === '[from Rex] ship it\r', 'and lands on the right PTY', JSON.stringify(writes.at(-1)))

    // A real run of output rather than a single stamp: the burst half of the gate
    // then keeps the pane busy for the whole window, so a slow round trip on a
    // loaded machine cannot turn this into a flake.
    const burst = Date.now()
    for (const at of [burst, burst + 200, burst + 400, burst + 700]) link.noteOutput('p3', at)
    const busy = await server.request('tools/call', { name: 'pane_send', arguments: { pane: 'Kim', text: 'oi' } })
    ok(busy?.result?.isError && /busy/.test(textOf(busy)), 'a busy pane comes back as a tool error saying so', textOf(busy))
    ok(/pane_read/.test(textOf(busy)), 'and tells the model how to wait for it', textOf(busy))

    // LF, for the reason pinned at the end of the "reading a pane" section.
    replays.set('p4', 'all done\nnothing left to do\n')
    const read = await server.request('tools/call', { name: 'pane_read', arguments: { pane: 'Sol', lines: 2 } })
    ok(/nothing left to do/.test(textOf(read)), 'pane_read gives the screen back', textOf(read))

    const nowhere = await server.request('tools/call', { name: 'pane_send', arguments: { pane: 'Nobody', text: 'x' } })
    ok(nowhere?.result?.isError && /Panes open in this project/.test(textOf(nowhere)), 'an unknown pane lists the real ones', textOf(nowhere))

    ok(server.child.exitCode === null, 'and the server survived all of it')
  } finally {
    server.close()
  }
}

console.log('\nthe MCP server, with no link')
{
  const server = openServer({ ...CLEAN_ENV, FORGE_SHARE_AGENT: 'Rex' })
  try {
    await handshake(server)
    for (const name of ['pane_send', 'pane_read']) {
      const reply = await server.request('tools/call', { name, arguments: { pane: 'Zora', text: 'x' } })
      ok(reply?.result?.isError, `${name} refuses when FORGE_SHARE_LINK is unset`)
      ok(/older than the link|started by hand/.test(textOf(reply)), 'and says which of the two reasons it is', textOf(reply))
    }
    ok(server.child.exitCode === null, 'and a missing link never crashes the server')
  } finally {
    server.close()
  }
}

/* ------------------------------------------------------------------ shut down */

console.log('\nshutting down')
link.close()
ok(link.address() === null, 'close() gives up the path')
if (process.platform !== 'win32') {
  ok(!existsSync(PIPE), 'and takes the socket file with it')
} else {
  console.log('  -- the socket file is removed — skipped (named pipes have none)')
}
{
  // Every pane is forgotten too: a link that answered after close would be
  // answering for a Forge that had quit.
  const after = link.handle({ op: 'panes', ...from }, Date.now())
  ok(!after.ok, 'and forgets every pane it knew')
}
try {
  if (process.platform !== 'win32' && existsSync(PIPE)) unlinkSync(PIPE)
} catch {
  /* best effort */
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)

/** See scripts/share-check.mjs's tail for why this is not `process.exit()`. */
process.exitCode = fail === 0 ? 0 : 1
