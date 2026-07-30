import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PtyDataEvent, PtyExitEvent } from '@shared/types'

/**
 * TerminalHost — the renderer-side owner of every xterm instance.
 *
 * Why a module-level singleton rather than React state: panes must survive
 * being unmounted. Switching project switches the whole terminal workspace,
 * but those shells keep running in the background and their scrollback must
 * still be there when you switch back. So the xterm instance and its DOM
 * wrapper live here, and React components merely *attach* a wrapper into their
 * container. A terminal is only destroyed when its pane is really closed.
 */

export type PaneStatus = 'idle' | 'starting' | 'live' | 'exited' | 'error'

export interface PaneRuntime {
  status: PaneStatus
  pid: number | null
  exitCode: number | null
  error: string | null
}

export interface TerminalSpec {
  cwd: string
  bootstrapCommand: string
  fontSize: number
  fontFamily: string
  /** Profile accent — used for the cursor and selection wash. */
  accent: string
}

const IDLE_RUNTIME: PaneRuntime = { status: 'idle', pid: null, exitCode: null, error: null }

const ACTIVITY_THROTTLE_MS = 90

interface Entry {
  paneId: string
  term: Terminal
  fit: FitAddon
  wrapper: HTMLDivElement
  spec: TerminalSpec
  runtime: PaneRuntime
  container: HTMLElement | null
  resizeObserver: ResizeObserver | null
  lastActivityNotify: number
  activityTimer: number | null
  disposers: Array<() => void>
}

interface Listeners {
  runtime: Set<(r: PaneRuntime) => void>
  activity: Set<() => void>
}

function baseTheme(accent: string): ITheme {
  return {
    background: '#0e0f12',
    foreground: '#e8eaed',
    cursor: accent,
    cursorAccent: '#0e0f12',
    selectionBackground: 'rgba(198, 255, 74, 0.20)',
    selectionForeground: undefined,
    black: '#15171b',
    red: '#ff6e6e',
    green: '#b8f04a',
    yellow: '#f2e56b',
    blue: '#7fb6ff',
    magenta: '#c08bff',
    cyan: '#6fe3d2',
    white: '#d6d9de',
    brightBlack: '#5a6068',
    brightRed: '#ff8f8f',
    brightGreen: '#ceff6e',
    brightYellow: '#ffef8f',
    brightBlue: '#a3ccff',
    brightMagenta: '#d5aeff',
    brightCyan: '#9bf0e4',
    brightWhite: '#f4f6f8'
  }
}

class TerminalHost {
  private entries = new Map<string, Entry>()
  private listeners = new Map<string, Listeners>()
  private wired = false

  /* ----------------------------------------------------------- plumbing */

  private wire(): void {
    if (this.wired) return
    this.wired = true

    window.forge.pty.onData((e: PtyDataEvent) => {
      const entry = this.entries.get(e.id)
      if (!entry) return
      entry.term.write(e.data)
      if (entry.runtime.status === 'starting') this.setRuntime(entry, { status: 'live' })
      this.pulse(entry)
    })

    window.forge.pty.onExit((e: PtyExitEvent) => {
      const entry = this.entries.get(e.id)
      if (!entry) return
      entry.term.write(
        `\r\n\x1b[38;2;106;112;120m── session ended (exit ${e.exitCode}) ─ press Enter to relaunch\x1b[0m\r\n`
      )
      this.setRuntime(entry, { status: 'exited', exitCode: e.exitCode, pid: null })
    })
  }

  private listenersFor(paneId: string): Listeners {
    let l = this.listeners.get(paneId)
    if (!l) {
      l = { runtime: new Set(), activity: new Set() }
      this.listeners.set(paneId, l)
    }
    return l
  }

  private setRuntime(entry: Entry, patch: Partial<PaneRuntime>): void {
    entry.runtime = { ...entry.runtime, ...patch }
    const l = this.listeners.get(entry.paneId)
    if (l) for (const cb of l.runtime) cb(entry.runtime)
  }

  private pulse(entry: Entry): void {
    const now = performance.now()
    const l = this.listeners.get(entry.paneId)
    if (!l || l.activity.size === 0) return
    if (now - entry.lastActivityNotify >= ACTIVITY_THROTTLE_MS) {
      entry.lastActivityNotify = now
      for (const cb of l.activity) cb()
      return
    }
    // Coalesce a burst into one trailing notification.
    if (entry.activityTimer !== null) return
    entry.activityTimer = window.setTimeout(() => {
      entry.activityTimer = null
      entry.lastActivityNotify = performance.now()
      const live = this.listeners.get(entry.paneId)
      if (live) for (const cb of live.activity) cb()
    }, ACTIVITY_THROTTLE_MS)
  }

  /* ---------------------------------------------------------- lifecycle */

  /**
   * Attach pane `paneId` into `container`, creating the terminal (and its PTY
   * session) on first call. Safe to call repeatedly.
   */
  attach(paneId: string, container: HTMLElement, spec: TerminalSpec): void {
    this.wire()
    let entry = this.entries.get(paneId)

    if (!entry) {
      entry = this.create(paneId, spec)
      this.entries.set(paneId, entry)
      container.appendChild(entry.wrapper)
      entry.container = container
      entry.term.open(entry.wrapper)
      void this.loadWebgl(entry)
      this.observe(entry, container)
      // Size against the real container before spawning, so the shell's very
      // first prompt is already the right width.
      this.fit(paneId)
      void this.start(entry)
      return
    }

    const existing = entry
    if (existing.container !== container) {
      container.appendChild(existing.wrapper)
      existing.container = container
      this.observe(existing, container)
    }
    requestAnimationFrame(() => {
      this.fit(paneId)
      existing.term.refresh(0, existing.term.rows - 1)
    })
  }

  detach(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    entry.resizeObserver?.disconnect()
    entry.resizeObserver = null
    if (entry.wrapper.parentElement) entry.wrapper.parentElement.removeChild(entry.wrapper)
    entry.container = null
  }

  private create(paneId: string, spec: TerminalSpec): Entry {
    const wrapper = document.createElement('div')
    wrapper.className = 'terminal-surface'
    wrapper.dataset['paneId'] = paneId

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      fontFamily: spec.fontFamily,
      fontSize: spec.fontSize,
      lineHeight: 1.24,
      letterSpacing: 0,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1.1,
      scrollback: 20000,
      smoothScrollDuration: 0,
      convertEol: false,
      macOptionIsMeta: false,
      windowsPty: { backend: 'conpty' },
      theme: baseTheme(spec.accent)
    })

    const fit = new FitAddon()
    term.loadAddon(fit)

    const entry: Entry = {
      paneId,
      term,
      fit,
      wrapper,
      spec,
      runtime: { ...IDLE_RUNTIME },
      container: null,
      resizeObserver: null,
      lastActivityNotify: 0,
      activityTimer: null,
      disposers: []
    }

    const dataSub = term.onData((data) => {
      if (entry.runtime.status === 'exited') {
        // Enter in a dead pane relaunches it — matches the hint printed on exit.
        if (data === '\r' || data === '\n') void this.restart(paneId)
        return
      }
      window.forge.pty.write(paneId, data)
    })
    entry.disposers.push(() => dataSub.dispose())

    const resizeSub = term.onResize(({ cols, rows }) => {
      window.forge.pty.resize(paneId, cols, rows)
    })
    entry.disposers.push(() => resizeSub.dispose())

    return entry
  }

  private async loadWebgl(entry: Entry): Promise<void> {
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl')
      const addon = new WebglAddon()
      addon.onContextLoss(() => addon.dispose())
      entry.term.loadAddon(addon)
      entry.disposers.push(() => addon.dispose())
    } catch (err) {
      // The DOM renderer is a perfectly good fallback; just say so once.
      console.warn('[forge] WebGL renderer unavailable, using DOM renderer', err)
    }
  }

  private observe(entry: Entry, container: HTMLElement): void {
    entry.resizeObserver?.disconnect()
    const ro = new ResizeObserver(() => this.fit(entry.paneId))
    ro.observe(container)
    entry.resizeObserver = ro
  }

  private async start(entry: Entry): Promise<void> {
    this.setRuntime(entry, { status: 'starting', error: null, exitCode: null })
    const result = await window.forge.pty.create({
      id: entry.paneId,
      cwd: entry.spec.cwd,
      cols: entry.term.cols,
      rows: entry.term.rows,
      bootstrapCommand: entry.spec.bootstrapCommand
    })
    if (result.ok) {
      this.setRuntime(entry, { status: 'live', pid: result.pid })
    } else {
      entry.term.write(`\r\n\x1b[38;2;255;92;72m✕ ${result.error}\x1b[0m\r\n`)
      this.setRuntime(entry, { status: 'error', error: result.error })
    }
  }

  /** Kill the shell (if any) and launch a fresh one in the same pane. */
  async restart(paneId: string): Promise<void> {
    const entry = this.entries.get(paneId)
    if (!entry) return
    if (entry.runtime.status === 'live' || entry.runtime.status === 'starting') {
      await window.forge.pty.kill(paneId)
    }
    entry.term.reset()
    await this.start(entry)
    entry.term.focus()
  }

  /** Tear the pane down for good: kill the shell, dispose the terminal. */
  dispose(paneId: string): void {
    const entry = this.entries.get(paneId)
    this.entries.delete(paneId)
    this.listeners.delete(paneId)
    if (!entry) {
      // Never created (e.g. a restored pane that was closed before being
      // viewed) — still make sure no orphan session lingers.
      void window.forge.pty.kill(paneId)
      return
    }
    if (entry.activityTimer !== null) clearTimeout(entry.activityTimer)
    entry.resizeObserver?.disconnect()
    for (const d of entry.disposers) {
      try {
        d()
      } catch {
        /* ignore */
      }
    }
    void window.forge.pty.kill(paneId)
    entry.wrapper.remove()
    entry.term.dispose()
  }

  disposeAll(ids: Iterable<string>): void {
    for (const id of ids) this.dispose(id)
  }

  /* ------------------------------------------------------------ actions */

  fit(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry || !entry.container) return
    const { clientWidth, clientHeight } = entry.container
    if (clientWidth < 8 || clientHeight < 8) return
    try {
      entry.fit.fit()
    } catch {
      /* xterm throws if measured mid-teardown — harmless */
    }
  }

  fitAll(): void {
    for (const id of this.entries.keys()) this.fit(id)
  }

  focus(paneId: string): void {
    this.entries.get(paneId)?.term.focus()
  }

  clear(paneId: string): void {
    this.entries.get(paneId)?.term.clear()
  }

  copySelection(paneId: string): string | null {
    const term = this.entries.get(paneId)?.term
    if (!term || !term.hasSelection()) return null
    return term.getSelection()
  }

  paste(paneId: string, text: string): void {
    this.entries.get(paneId)?.term.paste(text)
  }

  /**
   * Dictation insertion. Sends text to the shell as though it had been typed —
   * and deliberately never a carriage return: Steve reads what landed and
   * presses Enter himself, so a misheard word is never a submitted command.
   * (term.paste() is no good here: xterm folds newlines into \r, which submits.)
   *
   * Returns false when the pane has no live terminal, so the caller can fall
   * back to the clipboard instead of silently swallowing the words.
   */
  type(paneId: string, text: string): boolean {
    const entry = this.entries.get(paneId)
    if (!entry || entry.runtime.status === 'exited') return false
    window.forge.pty.write(paneId, text.replace(/[\r\n]+/g, ' '))
    return true
  }

  has(paneId: string): boolean {
    return this.entries.has(paneId)
  }

  scrollToBottom(paneId: string): void {
    this.entries.get(paneId)?.term.scrollToBottom()
  }

  runtime(paneId: string): PaneRuntime {
    return this.entries.get(paneId)?.runtime ?? IDLE_RUNTIME
  }

  applyTypography(fontSize: number, fontFamily: string): void {
    for (const entry of this.entries.values()) {
      entry.spec = { ...entry.spec, fontSize, fontFamily }
      entry.term.options.fontSize = fontSize
      entry.term.options.fontFamily = fontFamily
      this.fit(entry.paneId)
    }
  }

  /** Keep a live pane's spec in sync when its profile/accent is edited. */
  updateAccent(paneId: string, accent: string): void {
    const entry = this.entries.get(paneId)
    if (!entry || entry.spec.accent === accent) return
    entry.spec = { ...entry.spec, accent }
    entry.term.options.theme = baseTheme(accent)
  }

  /* ------------------------------------------------------ subscriptions */

  subscribeRuntime(paneId: string, cb: (r: PaneRuntime) => void): () => void {
    const l = this.listenersFor(paneId)
    l.runtime.add(cb)
    return () => {
      l.runtime.delete(cb)
    }
  }

  subscribeActivity(paneId: string, cb: () => void): () => void {
    const l = this.listenersFor(paneId)
    l.activity.add(cb)
    return () => {
      l.activity.delete(cb)
    }
  }

  liveCount(): number {
    let n = 0
    for (const e of this.entries.values()) {
      if (e.runtime.status === 'live' || e.runtime.status === 'starting') n++
    }
    return n
  }
}

export const terminalHost = new TerminalHost()
