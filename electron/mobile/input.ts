/**
 * The television's cursor, performed on Windows.
 *
 * Everything else the mobile link does ends inside Forge. This file is the one
 * place where a frame off a socket becomes an event at the operating system —
 * a real pointer, on whatever window happens to be under it — so it is written
 * to be small, obvious, and readable in one sitting by somebody deciding
 * whether they trust it.
 *
 * ## Why a PowerShell process and not a native module
 *
 * Moving the real cursor means `user32.dll`, and the usual routes to it from
 * Electron are a native addon (`robotjs`, `nut.js`): a compiler, a node-gyp
 * step, a rebuild every time Electron's ABI moves, and a binary in the tree
 * that nobody reads. This app has already been bitten by native packaging
 * (see the node-pty note in scripts/pack-check.mjs), and a remote control for
 * the sofa is not worth a build step on every machine that clones Forge.
 *
 * Windows already ships a process that can call `user32`. So this spawns one,
 * hands it a fifteen-line loop, and writes it a line per event. The cost is
 * about half a second, once, while .NET compiles the P/Invoke block — which is
 * why the process is kept alive between events and torn down on a timer rather
 * than after each one. The gain is that the whole mechanism is text: the script
 * below is the entire privileged surface, and it can do exactly four things.
 *
 * ## What it can do, exhaustively
 *
 * Move the pointer. Press and release one of three buttons. Turn the wheel.
 * Press and release one of a short list of named keys (`MIRROR_KEYS` in
 * shared/mobile.ts). Type one character. There is no way to name a scancode and
 * nothing that runs a command — the child is a loop over five verbs, and an
 * unrecognised line is discarded by it.
 *
 * ## Typing, and what it costs
 *
 * The fifth verb is newer than the other four and it is the one that widens
 * what a paired television can do, so it is worth stating rather than
 * discovering: a remote can now put arbitrary text into whatever window has
 * focus on this desk. That is a real widening. It is not a new *category* —
 * the remote could already click anything, press Enter and open the Start menu,
 * which is enough to drive a machine — but "it cannot type" was true before
 * this and is not true now.
 *
 * Everything that gated the other four gates this one identically: the setting,
 * the pairing, the screen-watching socket, the rate limit, and the fact that
 * Windows' UIPI refuses all of it to an elevated window. What is new is only
 * the verb.
 *
 * It sends a *character*, not a key. `VkKeyScanW` asks the keyboard layout that
 * is actually loaded which key produces it and with which modifiers held, which
 * is the only way this can be right on a UK desk and a US one and a French one
 * without a table in here that is wrong for two of them. A character the layout
 * cannot produce answers -1 and is skipped, so an emoji dictated into a remote
 * is dropped rather than turned into something else.
 *
 * ## What it deliberately cannot do
 *
 * Reach an elevated window. Windows' UIPI refuses synthetic input from a
 * normal-integrity process to an administrator one, and Forge runs as neither
 * an administrator nor a service. A UAC prompt on the desk is therefore
 * un-clickable from the sofa, which is the correct answer: the one dialog on
 * Windows that exists to confirm a human is present should not be answerable
 * by a device in another room.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { MirrorButton, MirrorInput, MirrorKey } from '@shared/mobile'

/**
 * Where the pointer goes, in physical screen pixels.
 *
 * Not the DIPs Electron's `screen` module speaks: `SetCursorPos` is a Win32
 * call and wants the pixels Windows actually has. The conversion is the
 * caller's — see `pointFor` in electron/mobile-host.ts, which owns the display
 * and its scale factor.
 *
 * That is only true because the helper below makes itself DPI-aware first; see
 * the awareness block in `LOOP`. The two are one decision and neither survives
 * the other being changed.
 */
export interface ScreenPoint {
  x: number
  y: number
}

/** `mouse_event` flags, from WinUser.h. The only four this file ever sends. */
const MOUSE_DOWN: Record<MirrorButton, number> = { left: 0x0002, right: 0x0008, middle: 0x0020 }
const MOUSE_UP: Record<MirrorButton, number> = { left: 0x0004, right: 0x0010, middle: 0x0040 }
const MOUSE_WHEEL = 0x0800

/** One notch of a real wheel, which is what WHEEL_DELTA means. */
const WHEEL_DELTA = 120

/**
 * Virtual-key codes, and whether Windows considers each one "extended".
 *
 * The extended bit is not decoration. The arrows, Home/End, the page keys and
 * Delete share scancodes with the numeric keypad, and the flag is the only
 * thing that tells them apart — without it an application with the numlock
 * state against you receives a `4` where the sofa pressed Left.
 */
const KEYS: Record<MirrorKey, { vk: number; extended: boolean }> = {
  enter: { vk: 0x0d, extended: false },
  escape: { vk: 0x1b, extended: false },
  tab: { vk: 0x09, extended: false },
  backspace: { vk: 0x08, extended: false },
  space: { vk: 0x20, extended: false },
  delete: { vk: 0x2e, extended: true },
  up: { vk: 0x26, extended: true },
  down: { vk: 0x28, extended: true },
  left: { vk: 0x25, extended: true },
  right: { vk: 0x27, extended: true },
  pageup: { vk: 0x21, extended: true },
  pagedown: { vk: 0x22, extended: true },
  home: { vk: 0x24, extended: true },
  end: { vk: 0x23, extended: true },
  win: { vk: 0x5b, extended: true }
}

/** `keybd_event` flags: the extended bit, and the one that means "release". */
const KEY_EXTENDED = 0x0001
const KEY_UP = 0x0002

/**
 * The modifiers a character can need, as the bits `VkKeyScanW` reports them in.
 *
 * Shift for a capital, Ctrl+Alt together for anything on the AltGr level of a
 * European layout — which is where a UK keyboard keeps its euro sign and a
 * German one keeps its @. Named here rather than open-coded in the helper so
 * that the mapping between a bit and a virtual key is readable in one place.
 */
const VK_SHIFT = 0x10
const VK_CONTROL = 0x11
const VK_MENU = 0x12

/**
 * The child's entire program.
 *
 * Three imported functions and a loop over stdin. Deliberately written as one
 * string constant rather than a file on disk: there is nothing here to
 * configure, nothing to edit between releases, and a script that lives only in
 * this module's memory cannot be replaced by anything that can write to the
 * app's folder.
 *
 * `mouse_event` and `keybd_event` rather than `SendInput`, which supersedes
 * them. `SendInput` takes a union whose field offsets differ between 32- and
 * 64-bit processes, which in PowerShell means a `StructLayout` argument that
 * cannot be computed at runtime — three declarations and no structs is the
 * smaller, more readable thing, and Windows implements the older pair in terms
 * of the newer one anyway.
 *
 * Every line is parsed by position and coerced to `int` before it reaches a
 * P/Invoke; a line that does not fit falls through the `switch` and is ignored.
 *
 * ## Why it declares itself DPI-aware before doing anything
 *
 * `powershell.exe` ships with no DPI awareness, and Windows is generous to
 * processes in that state: it lies to them. A helper left unaware on a screen
 * running at 125% sees a 1920x1200 panel as 1536x960, and — the half that
 * actually bites — has every coordinate it passes to `SetCursorPos` multiplied
 * by 1.25 on the way through. The pointer then lands a quarter of the way
 * further right and further down than the sofa aimed, an error that is zero in
 * the top-left corner and grows across the screen, so it reads as a cursor that
 * drifts rather than one that is simply offset.
 *
 * `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2` (the -4 below) turns that off:
 * the process sees real pixels and its coordinates are taken literally, which
 * is what `pointFor` in electron/mobile-host.ts has always been computing.
 * Per-monitor rather than merely system-aware because a desk can mix a 4K panel
 * with a 1080p one at different scales, and only the per-monitor context gets
 * the second screen right.
 *
 * The call needs Windows 10 1703, so it is attempted and then fallen back on:
 * an older Windows throws `EntryPointNotFoundException` at the P/Invoke, and
 * `SetProcessDPIAware` is the 2007 spelling of the same intent. If both fail
 * the helper still works — the pointer is simply as wrong as it was before,
 * which is a better outcome than a remote that does nothing at all.
 */
const LOOP = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Forge -Name Input -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScanW(char ch);
'@
try {
  if (-not [Forge.Input]::SetProcessDpiAwarenessContext([System.IntPtr](-4))) { [void][Forge.Input]::SetProcessDPIAware() }
} catch {
  try { [void][Forge.Input]::SetProcessDPIAware() } catch { }
}
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $p = $line.Split(' ')
    switch ($p[0]) {
      'm' { [Forge.Input]::SetCursorPos([int]$p[1], [int]$p[2]) }
      'b' {
        [Forge.Input]::SetCursorPos([int]$p[2], [int]$p[3])
        [Forge.Input]::mouse_event([int]$p[1], 0, 0, 0, [System.UIntPtr]::Zero)
      }
      'w' {
        [Forge.Input]::SetCursorPos([int]$p[2], [int]$p[3])
        [Forge.Input]::mouse_event(${MOUSE_WHEEL}, 0, 0, [int]$p[1], [System.UIntPtr]::Zero)
      }
      'k' { [Forge.Input]::keybd_event([byte][int]$p[1], 0, [int]$p[2], [System.UIntPtr]::Zero) }
      't' {
        $code = [int]$p[1]
        if ($code -gt 0 -and $code -lt 65536) {
          $scan = [Forge.Input]::VkKeyScanW([char]$code)
          if ($scan -ne -1) {
            $vk = $scan -band 0xFF
            $mods = ($scan -shr 8) -band 0x07
            $wanted = @()
            if ($mods -band 1) { $wanted += ${VK_SHIFT} }
            if ($mods -band 2) { $wanted += ${VK_CONTROL} }
            if ($mods -band 4) { $wanted += ${VK_MENU} }
            foreach ($m in $wanted) { [Forge.Input]::keybd_event([byte]$m, 0, 0, [System.UIntPtr]::Zero) }
            [Forge.Input]::keybd_event([byte]$vk, 0, 0, [System.UIntPtr]::Zero)
            [Forge.Input]::keybd_event([byte]$vk, 0, ${KEY_UP}, [System.UIntPtr]::Zero)
            # Released in the reverse order they were pressed, so a character
            # needing Ctrl+Alt does not leave Ctrl down over the next one.
            [array]::Reverse($wanted)
            foreach ($m in $wanted) { [Forge.Input]::keybd_event([byte]$m, 0, ${KEY_UP}, [System.UIntPtr]::Zero) }
          }
        }
      }
    }
  } catch {
  }
}
`

/**
 * One input, as the line the child understands — or '' when it is not an
 * instruction at all.
 *
 * Pure, and exported for scripts/input-check.mjs, which is the only way to
 * prove the mapping without moving the cursor of whoever is running the tests.
 * `at` is where the pointer belongs in physical pixels, and is ignored for a
 * key stroke, which has no position.
 */
export function lineFor(input: MirrorInput, at: ScreenPoint): string {
  const x = Math.round(at.x)
  const y = Math.round(at.y)
  switch (input.a) {
    case 'move':
      return `m ${x} ${y}`
    case 'down':
      return `b ${MOUSE_DOWN[input.button]} ${x} ${y}`
    case 'up':
      return `b ${MOUSE_UP[input.button]} ${x} ${y}`
    case 'wheel':
      return `w ${input.wheel * WHEEL_DELTA} ${x} ${y}`
    case 'key': {
      const key = KEYS[input.key]
      if (!key) return ''
      const flags = (key.extended ? KEY_EXTENDED : 0) | (input.down ? 0 : KEY_UP)
      return `k ${key.vk} ${flags}`
    }
    default:
      // Typing is many strokes and this returns one line. See `linesFor`.
      return ''
  }
}

/**
 * One input, as every line the child needs for it.
 *
 * The shape `lineFor` cannot have: a phrase is one instruction on the wire and
 * a stroke per character at the operating system, so the only honest return
 * type for the general case is a list. Everything except `text` is the single
 * line `lineFor` already produced, and an empty list means there was nothing to
 * perform.
 *
 * Surrogate pairs are dropped, not split. `VkKeyScanW` takes a UTF-16 code
 * unit, so half of an emoji would either answer -1 or — worse — answer with
 * whatever key happens to match a lone surrogate. Dropping the whole character
 * is the only reading that cannot type something nobody said.
 */
export function linesFor(input: MirrorInput, at: ScreenPoint): string[] {
  if (input.a !== 'text') {
    const line = lineFor(input, at)
    return line ? [line] : []
  }
  const lines: string[] = []
  for (const character of input.text) {
    if (character.length !== 1) continue
    const code = character.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) continue
    lines.push(`t ${code}`)
  }
  return lines
}

/** Only Windows has a `user32` and a PowerShell to reach it with. */
export function canDriveDesktop(): boolean {
  return process.platform === 'win32'
}

/**
 * How long the helper survives with nothing to do.
 *
 * Long enough that pausing to read something on the mirrored screen does not
 * cost the next click its half-second of .NET start-up, short enough that a
 * television switched off in the middle of an evening does not leave a
 * PowerShell sitting in the process list until the desktop reboots.
 */
const IDLE_MS = 120_000

/**
 * How long to wait before spawning again after a child died on its own.
 *
 * A helper that cannot start — no PowerShell on PATH, a policy that refuses to
 * compile the P/Invoke block — must not be retried once per pointer move. The
 * feature simply does not work on that machine, and it should fail quietly at
 * one attempt every few seconds rather than forking a process sixty times a
 * second while somebody waggles a D-pad.
 */
const RESPAWN_MS = 5_000

/**
 * One line waiting for the child, and whether it is worth less than the line
 * behind it.
 *
 * The flag is the whole of the difference between the two things this queue
 * holds. A pointer line describes *where the cursor is now*, so a backlog of
 * them is stale by definition and the newest is the only one that matters. A
 * character is not like that: it is part of a sentence somebody spoke, it does
 * not go out of date while PowerShell compiles, and the one thing that must
 * never happen to it is arriving with its beginning missing.
 */
interface Pending {
  line: string
  /** Droppable: a pointer or a key, superseded by whatever comes next. */
  stale: boolean
}

/**
 * Lines written while the child is still compiling its P/Invoke block.
 *
 * Two ceilings, because the two kinds of line above want opposite things.
 * Pointer lines get a small one and lose their oldest when it is reached —
 * half a second of cursor history is worth nothing. Text gets a large one,
 * because the helper is *cold at the start of every watch* (it is torn down
 * with the mirror), which made the small ceiling apply to the very first thing
 * anybody dictated: a phrase over about thirty characters was thrown away
 * silently, which is every phrase. The larger number is still a ceiling rather
 * than a licence — a paired device typing faster than a desktop can accept is
 * bounded here as everywhere else.
 */
const MAX_PENDING_STALE = 32
const MAX_PENDING_TEXT = 4_096

let child: ChildProcess | null = null
let ready = false
let pending: Pending[] = []
let idleTimer: NodeJS.Timeout | null = null
let lastFailedAt = 0

function armIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => stopDesktopInput(), IDLE_MS)
}

function spawnHelper(): void {
  if (child) return
  if (Date.now() - lastFailedAt < RESPAWN_MS) return
  let started: ChildProcess
  try {
    started = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        // The loop is handed over as base64 UTF-16LE rather than as `-Command`
        // text: it contains quotes, newlines and `$` sigils, and every one of
        // those is a way for a shell quoting rule to turn a program into a
        // different program. Encoded, there is nothing left to quote.
        '-EncodedCommand',
        Buffer.from(LOOP, 'utf16le').toString('base64')
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
    )
  } catch {
    lastFailedAt = Date.now()
    return
  }
  child = started
  ready = false

  // 'ready' is written once, after the P/Invoke block has compiled. Waiting for
  // it is what makes the queue above finite: before it, a write would go into a
  // pipe the child is not reading yet.
  started.stdout?.on('data', (chunk: Buffer) => {
    if (ready || !chunk.toString().includes('ready')) return
    ready = true
    const queued = pending
    pending = []
    for (const held of queued) writeLine(held.line)
  })

  const gone = (): void => {
    if (child !== started) return
    child = null
    ready = false
    pending = []
    lastFailedAt = Date.now()
  }
  started.on('error', gone)
  started.on('exit', gone)
}

function writeLine(line: string): void {
  const stdin = child?.stdin
  if (!stdin || stdin.destroyed) return
  // Unwatched on purpose: a failed write is one lost pointer event, and the
  // next one is already on its way. The child's own exit handler is what
  // notices a helper that has genuinely gone.
  stdin.write(`${line}\n`, () => {})
}

/**
 * Perform one input on this desktop.
 *
 * Silent about everything: an unsupported platform, a helper that will not
 * start, a line that describes nothing. The caller is a relay for a remote
 * control in another room, and there is no failure here it could act on.
 */
export function driveDesktop(input: MirrorInput, at: ScreenPoint): void {
  if (!canDriveDesktop()) return
  const lines = linesFor(input, at)
  if (lines.length === 0) return
  spawnHelper()
  if (!child) return
  armIdle()
  if (ready) {
    for (const line of lines) writeLine(line)
    return
  }
  // A phrase is all of it or none of it, and it waits in the roomy half of the
  // queue: the helper is cold at the start of every watch, so this is the
  // ordinary path for the first thing anybody says, not an edge of it. Only a
  // phrase that would not fit even there is refused, and then whole — half a
  // sentence appearing on somebody's desk is worse than none of it.
  if (input.a === 'text') {
    const held = pending.reduce((count, line) => (line.stale ? count : count + 1), 0)
    if (held + lines.length > MAX_PENDING_TEXT) return
    for (const line of lines) pending.push({ line, stale: false })
    return
  }
  // The newest instruction matters more than the oldest: what is being
  // dropped is where the pointer was half a second ago. Text queued alongside
  // it keeps its place — the search is for the oldest *stale* line, so a
  // waggled D-pad cannot evict the sentence in front of it.
  const stale = pending.reduce((count, line) => (line.stale ? count + 1 : count), 0)
  if (stale >= MAX_PENDING_STALE) {
    const oldest = pending.findIndex((line) => line.stale)
    if (oldest >= 0) pending.splice(oldest, 1)
  }
  for (const line of lines) pending.push({ line, stale: true })
}

/**
 * Start the helper, wait for it to say it is ready, and stop it again —
 * without performing a single input.
 *
 * The one question this module cannot answer by reasoning: *does this machine
 * actually let a normal process compile a P/Invoke block and call user32?* A
 * locked-down PowerShell, a missing .NET compiler or an execution policy that
 * refuses the encoded command all fail here, at a moment somebody is looking,
 * rather than the first time somebody on a sofa presses OK and nothing moves.
 *
 * Returns '' when the helper came up, or a sentence naming what did not. Used
 * by scripts/input-check.mjs, which is why it proves readiness with no `m` or
 * `b` line: a test that moved the cursor of whoever ran it would be a test
 * nobody runs twice.
 */
export function probeDesktopInput(timeoutMs = 15_000): Promise<string> {
  if (!canDriveDesktop()) return Promise.resolve('Only Windows can be driven from a remote.')
  return new Promise((resolve) => {
    let done = false
    const finish = (answer: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        probe.kill()
      } catch {
        /* already gone */
      }
      resolve(answer)
    }
    const timer = setTimeout(() => finish('The input helper did not answer in time.'), timeoutMs)
    let probe: ChildProcess
    try {
      probe = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(LOOP, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      )
    } catch {
      finish('PowerShell would not start at all.')
      return
    }
    probe.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) finish('')
    })
    // Collected, never acted on by itself. PowerShell writes a `#< CLIXML`
    // preamble to stderr whenever its streams are redirected, so *anything on
    // stderr* is not a failure — only a helper that dies without saying ready
    // is, and then this is the most useful thing to repeat back.
    let complaint = ''
    probe.stderr?.on('data', (chunk: Buffer) => {
      complaint += chunk.toString()
    })
    const died = (): void => {
      const line = complaint
        .split('\n')
        .map((text) => text.trim())
        .find((text) => text && !text.startsWith('#<') && !text.startsWith('<Objs'))
      finish(line ?? 'The input helper exited before it was ready.')
    }
    probe.on('error', () => finish('PowerShell could not be run.'))
    probe.on('exit', died)
  })
}

/**
 * Close the helper down. Idempotent, and safe when there never was one.
 *
 * Called when the mirror ends, when control is switched off, and on the idle
 * timer — the child holds no state worth keeping, so the only cost of stopping
 * early is the next start-up.
 */
export function stopDesktopInput(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const running = child
  child = null
  ready = false
  pending = []
  if (!running) return
  // stdin's end is the loop's end: `ReadLine` returns null at EOF and the
  // script falls off the bottom. `kill` is the belt to that brace, for a child
  // that has stopped reading.
  try {
    running.stdin?.end()
  } catch {
    /* already closed */
  }
  try {
    running.kill()
  } catch {
    /* already gone */
  }
}
