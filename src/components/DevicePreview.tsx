import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { MobileStatus, PreviewDevCommand } from '@shared/types'
import {
  defaultPreviewMode,
  DEFAULT_DEV_COMMAND,
  effectiveDevCommand,
  fitScale,
  isSelfPreview,
  normalizePreviewUrl,
  PREVIEW_DEVICES,
  previewUrl,
  probeTarget,
  resolvePreviewUrl,
  siteViewport,
  usableDetectedUrl,
  type DevicePreset,
  type PreviewMode
} from '@/lib/devicePreview'
import { useActiveProject, useActiveWorkspace, useApp } from '@/state/AppState'
import { Icon } from './Icon'
import './DevicePreview.css'

/**
 * The Devices preview — two phones on the desk, showing the project that is
 * open. Every row in the project rail has a button straight into here, so the
 * phones for any project are one click away from anywhere.
 *
 * **This project** (the default) points both frames at whatever the open project
 * is serving. Nobody types a port for it in the normal case: the dev server
 * prints its URL, TerminalHost reads it out of the project's own terminals
 * (`scanForDevUrl`), and the workspace remembers it — so starting `npm run dev`
 * in one tab is the whole setup. A URL typed into the header beats the detected
 * one and is remembered per project, which is also how a deployed site or a
 * server on a port nothing announced gets in.
 *
 * That URL is a memory rather than a promise, and dev servers die. So the frames
 * are mounted only while a `no-cors` probe says something is still answering
 * there (`probeTarget`), and when nothing is, the stage says which URL went
 * quiet and offers to run the project's own dev script — instead of framing
 * Chromium's connection-refused page, which is white, fires `onLoad` like any
 * other page, and used to leave two blank phones under a chip saying "Live".
 * That script is a guess off package.json and the box under the button is where
 * it stops being one: whatever is typed there is this project's start command
 * from then on, so a folder Forge cannot read still gets the same button.
 *
 * **Forge Mobile** is the original preview, unchanged, and now reached from one
 * project only: the checkout this Forge is running from, which is the one place
 * project mode cannot work (`defaultPreviewMode`) and therefore the one place
 * the switch is drawn — everywhere else "what the phones show" is the project,
 * and a question with one answer is not a question. Each frame is the real
 * bundle served by the real `MobileServer`, paired through the same single-use
 * code door a QR takes, driving the same PTYs. Its two frames are sequenced,
 * never parallel — pairing codes are single-use *and* single-pending (a second
 * mint replaces the first), so the Android frame waits until the iPhone frame
 * has spent its code; its device row appearing in the status is the signal,
 * because a cross-origin iframe cannot be asked anything.
 *
 * What is simulated in both modes is the *phone around it* — the viewport, the
 * bezel, the system bars — because the look of a page on a phone is exactly what
 * this view exists to show without owning one of each. Where the two modes part
 * company is where those bars go: Forge Mobile reserves them (`?sim=`) so they
 * are drawn over the frame, and an arbitrary website reserves nothing, so they
 * become part of the shell instead. See `siteViewport`.
 */

/** How long to wait for a frame's device row before minting the next code anyway. */
const DEVICE_WAIT_MS = 8000

/**
 * How often project mode asks its URL whether anything is still listening.
 *
 * Fast enough that a dev server started from the button below appears here
 * without anyone reaching for reload, and slow enough to be free: a refused
 * loopback connection costs microseconds and never leaves the machine.
 */
const PROBE_MS = 2500

/**
 * What the last probe found. `checking` is the truthful gap before the first
 * answer, and it renders as neither phones nor an apology — showing either one
 * would be a guess, and both guesses are wrong roughly as often as they are
 * right.
 */
type Reach = 'checking' | 'up' | 'down'

interface FrameState {
  /** Bumped for a hard reload — a new key is a new page load, not a re-render. */
  key: number
  src: string
  /** When this frame was (re)loaded, to tell fresh device rows from stale ones. */
  startedAt: number
  error: string
}

const EMPTY_FRAME: FrameState = { key: 0, src: '', startedAt: 0, error: '' }

export function DevicePreview(): ReactNode {
  const { actions } = useApp()
  const project = useActiveProject()
  const workspace = useActiveWorkspace()
  const [mode, setMode] = useState<PreviewMode>('project')
  const [status, setStatus] = useState<MobileStatus | null>(null)
  const [frames, setFrames] = useState<Record<string, FrameState>>({})
  /** The status stream as a ref too, so the loader can test "already live" synchronously. */
  const statusRef = useRef<MobileStatus | null>(null)
  /** Cancels a superseded load run (a reload, a port change) mid-sequence. */
  const runRef = useRef(0)
  /** The port the current frames were built against, so a change re-runs the loader. */
  const loadedPortRef = useRef(0)
  const startedRef = useRef(false)
  /**
   * The project whose mode toggle has been touched. A choice made by hand is
   * the last word for as long as that project is the open one — the same rule
   * the URL and command fields follow — and opening a different project hands
   * the decision back to `defaultPreviewMode`.
   */
  const modeChosenRef = useRef('')

  useEffect(() => {
    void window.forge.mobile.status().then(setStatus)
    return window.forge.mobile.onStatus((s) => {
      statusRef.current = s
      setStatus(s)
    })
  }, [])

  /* ------------------------------------------------------- project mode */

  const manual = workspace.previewUrl ?? ''
  const detected = usableDetectedUrl(workspace.detectedUrl)
  const resolved = resolvePreviewUrl(manual, detected)
  const projectId = project?.id ?? ''

  /**
   * The detected URL, offered rather than applied, when a typed one is standing
   * in front of it. With nothing typed there is nothing to offer — the detected
   * URL is already what the frames are showing.
   */
  const adoptable = manual && detected && normalizePreviewUrl(manual) !== detected ? detected : ''

  const [draft, setDraft] = useState(manual)
  // The field follows the project, and follows a URL adopted or cleared from
  // elsewhere in this header. It does not follow itself: `manual` only moves
  // once something is committed, so typing is never yanked out from under you.
  useEffect(() => {
    setDraft(manual)
  }, [projectId, manual])

  const commitUrl = useCallback((): void => {
    if (!project) return
    const next = normalizePreviewUrl(draft)
    setDraft(next)
    if (next !== manual) actions.setPreviewUrl(project.id, next)
  }, [actions, draft, manual, project])

  /**
   * Per-frame reload counters. A project frame is a plain iframe with no pairing
   * to redo, so a reload is only ever "be a new element": the counter goes into
   * the React key beside the URL, which means a changed URL reloads by itself
   * and the "Live" chip resets with it.
   */
  const [siteNonce, setSiteNonce] = useState<Record<string, number>>({})
  /** The frame key each phone finished loading, so a stale load cannot claim Live. */
  const [siteLoaded, setSiteLoaded] = useState<Record<string, string>>({})
  const siteKey = (preset: DevicePreset): string => `${resolved}#${siteNonce[preset.id] ?? 0}`

  const reloadSite = useCallback((id: string): void => {
    setSiteNonce((n) => ({ ...n, [id]: (n[id] ?? 0) + 1 }))
  }, [])

  const reloadSites = useCallback((): void => {
    setSiteNonce((n) => {
      const next = { ...n }
      for (const p of PREVIEW_DEVICES) next[p.id] = (next[p.id] ?? 0) + 1
      return next
    })
  }, [])

  /**
   * Is anything actually there?
   *
   * The frames are only mounted once the answer is yes, which is the whole
   * point: an iframe pointed at a dead port loads Chromium's refused page, which
   * is white and fires `onLoad` like any other, so the chip used to say "Live"
   * over two blank phones. The poll keeps running while the view is open, so a
   * server that dies takes its frames with it and a server that starts brings
   * them back without anybody pressing anything.
   *
   * `wasDown` is why a recovery shows the site rather than a cached error page:
   * the frames that were mounted before the outage are still holding whatever
   * they loaded, so the first probe after a down spell reloads them.
   */
  const [reach, setReach] = useState<Reach>('checking')
  const wasDownRef = useRef(false)
  useEffect(() => {
    if (mode !== 'project' || !resolved) return
    const target = probeTarget(resolved)
    if (!target) {
      // Not ours to judge (a deployed site, an https address) — assume it is up
      // and let the frame report whatever it finds.
      setReach('up')
      return
    }
    let cancelled = false
    setReach('checking')
    const ask = async (): Promise<void> => {
      try {
        // `no-cors` because the answer is not the response — an opaque one is
        // proof enough that a socket was accepted, and only a refused or
        // unreachable connection rejects.
        await fetch(target, { mode: 'no-cors', cache: 'no-store' })
        if (cancelled) return
        if (wasDownRef.current) {
          wasDownRef.current = false
          reloadSites()
        }
        setReach('up')
      } catch {
        if (cancelled) return
        wasDownRef.current = true
        setReach('down')
      }
    }
    void ask()
    const timer = setInterval(() => void ask(), PROBE_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [mode, resolved, reloadSites])

  /**
   * How this project would start its own dev server, so the empty states can
   * offer to do it. Asked once per project rather than on a timer: a
   * package.json's scripts do not change while somebody is looking at two
   * phones, and null is a perfectly good answer — the box below still takes a
   * command by hand.
   */
  const projectPath = project?.path ?? ''
  const [sniffed, setSniffed] = useState<PreviewDevCommand | null>(null)
  useEffect(() => {
    setSniffed(null)
    if (!projectPath) return
    let cancelled = false
    void window.forge.preview.devCommand(projectPath).then((found) => {
      if (!cancelled) setSniffed(found)
    })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  /**
   * What the Start button runs, and whether there is a button at all.
   *
   * The sniff is a suggestion; `workspace.devCommand` is a decision, and a
   * decision wins — the same rule the URL field above follows. `selfPreview` is
   * the one case with no command to offer on purpose: this checkout cannot
   * start itself, so the empty states offer the Forge Mobile mode instead.
   */
  const manualCommand = workspace.devCommand ?? ''
  const command = effectiveDevCommand(manualCommand, sniffed)
  const selfPreview = isSelfPreview(manualCommand, sniffed)
  const sniffedCommand = sniffed?.kind === 'command' ? sniffed.command : ''

  /** The toggle, and the empty state's button: a mode picked on purpose. */
  const chooseMode = useCallback(
    (next: PreviewMode): void => {
      modeChosenRef.current = projectId
      setMode(next)
    },
    [projectId]
  )

  /*
   * Where the view opens, and the only place the mode moves on its own.
   *
   * The switch above is drawn for this checkout alone, so the mode has to be
   * right without one for everybody else: an ordinary project *is* project
   * mode. It is an effect rather than an initial state because the sniff lands
   * after the first paint — the Forge checkout shows its own "no dev server"
   * empty state for an instant and then settles into Forge Mobile, which is the
   * cheap way round. Defaulting to `forge` and correcting would mint a pairing
   * code for every project on the way past, and codes are single-pending: one
   * spent here replaces an outstanding QR offer.
   */
  useEffect(() => {
    if (modeChosenRef.current === projectId) return
    setMode(defaultPreviewMode(manualCommand, sniffed))
  }, [projectId, manualCommand, sniffed])

  const [cmdDraft, setCmdDraft] = useState(manualCommand)
  // Follows the project and anything committed elsewhere, never itself — the
  // same contract as the URL draft above, for the same reason.
  useEffect(() => {
    setCmdDraft(manualCommand)
  }, [projectId, manualCommand])

  const commitCommand = useCallback((): void => {
    if (!project) return
    const next = cmdDraft.trim()
    setCmdDraft(next)
    if (next !== manualCommand) actions.setDevCommand(project.id, next)
  }, [actions, cmdDraft, manualCommand, project])

  /* --------------------------------------------------------- forge mode */

  /** Resolve when the named device checks in after `since`, or after `timeoutMs`. */
  const waitForDevice = useCallback((name: string, since: number, timeoutMs: number): Promise<void> => {
    return new Promise((resolve) => {
      const settle = (): void => {
        clearTimeout(timer)
        unsub()
        resolve()
      }
      const check = (s: MobileStatus): void => {
        if (s.devices.some((d) => d.name === name && d.lastSeenAt >= since)) settle()
      }
      const unsub = window.forge.mobile.onStatus(check)
      const timer = setTimeout(settle, timeoutMs)
      const current = statusRef.current
      if (current) check(current)
    })
  }, [])

  /**
   * Mint-and-load every frame in order. One code at a time, each spent before
   * the next is asked for — see the component header for why.
   */
  const loadAll = useCallback(async (): Promise<void> => {
    const run = ++runRef.current
    for (const preset of PREVIEW_DEVICES) {
      const offer = await window.forge.mobile.previewPair()
      if (run !== runRef.current) return
      if (!offer.ok) {
        setFrames((f) => ({
          ...f,
          [preset.id]: { ...(f[preset.id] ?? EMPTY_FRAME), error: offer.error }
        }))
        return
      }
      const startedAt = Date.now()
      setFrames((f) => ({
        ...f,
        [preset.id]: {
          key: (f[preset.id]?.key ?? 0) + 1,
          src: previewUrl(preset, offer.port, offer.code),
          startedAt,
          error: ''
        }
      }))
      await waitForDevice(preset.deviceName, startedAt, DEVICE_WAIT_MS)
      if (run !== runRef.current) return
    }
  }, [waitForDevice])

  /** Reload one frame only — same single-code rule, applied to a single slot. */
  const reloadOne = useCallback(
    async (preset: DevicePreset): Promise<void> => {
      const offer = await window.forge.mobile.previewPair()
      if (!offer.ok) {
        setFrames((f) => ({ ...f, [preset.id]: { ...(f[preset.id] ?? EMPTY_FRAME), error: offer.error } }))
        return
      }
      setFrames((f) => ({
        ...f,
        [preset.id]: {
          key: (f[preset.id]?.key ?? 0) + 1,
          src: previewUrl(preset, offer.port, offer.code),
          startedAt: Date.now(),
          error: ''
        }
      }))
    },
    []
  )

  // The loader runs when the link is up and there is a bundle to serve — once
  // per port. A plain restart on the same port needs nothing: the frames'
  // stored tokens survive (localStorage is per-origin) and the app reconnects
  // itself; only a *different* port invalidates the URLs.
  //
  // It also never runs while the frames are showing a project. Minting a pairing
  // code has real consequences — it replaces any outstanding QR offer — and a
  // preview nobody has switched to has no business spending one.
  useEffect(() => {
    if (mode !== 'forge') return
    if (!status || status.state !== 'listening' || !status.web) return
    if (startedRef.current && loadedPortRef.current === status.port) return
    startedRef.current = true
    loadedPortRef.current = status.port
    void loadAll()
  }, [mode, status, loadAll])

  // Escape leaves — bubble phase, and never out of a text field, exactly the
  // SettingsPage contract (a popover or picker that wants Escape gets it first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return
      actions.closeDevices()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions])

  const [scale, setScale] = useState(0)
  const rowRef = useRef<HTMLDivElement | null>(null)

  // Zoom-to-fit: the row's box against the largest phone, one shared scale so
  // the two frames sit level however tall the window is. The effect re-runs
  // when the stage appears because the row does not exist at first mount —
  // status starts null and the empty state renders instead, so an observer
  // attached then would watch a div that is yet to be, and the phones would
  // draw at scale 0 behind their "Live" chips. Switching mode swaps the row for
  // an empty state and back, which is the same problem by another door.
  // A project stage exists as soon as there is a URL to check — the row is
  // mounted (and measured) while the first probe runs, so the phones do not
  // arrive at scale 0 the instant it comes back. A `down` answer takes the whole
  // stage away and replaces it with the empty state.
  const forgeStaged = status?.state === 'listening' && !!status.web
  const staged = mode === 'project' ? Boolean(project) && resolved !== '' && reach !== 'down' : forgeStaged
  useEffect(() => {
    if (!staged) return
    const el = rowRef.current
    if (!el) return
    const measure = (): void => {
      const row = rowRef.current
      if (!row) return
      // The box a phone actually has: clientWidth/Height *include* the row's
      // own padding, and each cell spends a header row (the label/phase strip)
      // plus the cell gap before the phone starts — solve the fit against the
      // row and the taller preset's bottom bezel leaves the window instead of
      // scaling down. The paddings are read live; the 24px frame gap and the
      // 6px cell gap are the same constants the CSS uses.
      const cs = getComputedStyle(row)
      const innerW = row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const innerH = row.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      const meta = row.querySelector('.dprev__meta')
      const headH = (meta ? meta.getBoundingClientRect().height : 24) + 6
      const cell = (innerW - 24) / 2
      let s = 1
      for (const p of PREVIEW_DEVICES) {
        s = Math.min(
          s,
          fitScale(cell, innerH - headH, p.viewport.w + p.chrome.bezel * 2, p.viewport.h + p.chrome.bezel * 2)
        )
      }
      setScale(s)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // `reach` is in here for the same reason `mode` is: the row is mounted empty
    // while the first probe runs, so the header strip whose height this solves
    // against does not exist until the phones do.
  }, [staged, mode, reach])

  const frameFor = (id: string): FrameState | null => frames[id] ?? null
  const isLive = (preset: DevicePreset): boolean => {
    const f = frameFor(preset.id)
    if (!f || !status) return false
    return status.devices.some((d) => d.name === preset.deviceName && d.lastSeenAt >= f.startedAt)
  }

  const canReload = mode === 'project' ? staged : forgeStaged

  /**
   * The one-click way out of both project-mode empty states, and the reason the
   * sniff above exists.
   *
   * `openToolPane` opens a shell pane in this project with the command in it and
   * lands on the terminals, which is the right feedback rather than a detour:
   * the server boots where its output can be read, its banner is detected like
   * any other project's, and Ctrl+Shift+D comes back to phones that now have
   * something to show.
   *
   * Under the button is the command itself, editable and remembered per project.
   * The button is on every project: typed command, then the one sniffed from
   * package.json, then `npm run dev`. The box only matters for projects that
   * start some other way, and nothing typed there has to be typed into a
   * terminal to be useful a second time. Empty hands the decision back to the
   * sniff, which is why the sniffed command is the placeholder rather than the
   * value.
   *
   * The exception is this checkout, which cannot start itself (see
   * `isSelfPreview`): there the only honest button is the one that switches the
   * phones to Forge Mobile.
   */
  const startBlock = selfPreview ? (
    <button
      type="button"
      className="sbtn sbtn--go"
      title="Show the Forge Mobile app in both phones"
      onClick={() => chooseMode('forge')}
    >
      Open the Forge Mobile preview
    </button>
  ) : (
    <>
      <button
        type="button"
        className="sbtn sbtn--go"
        title={`Run ${command} in a new terminal pane`}
        onClick={() => actions.openToolPane('dev server', command, true)}
      >
        Start the dev server
      </button>
      <label className="dprev__cmd">
        <span className="eyebrow">runs in this project’s folder</span>
        <input
          className="field__input mono dprev__cmd-input"
          value={cmdDraft}
          spellCheck={false}
          placeholder={sniffedCommand || DEFAULT_DEV_COMMAND}
          aria-label="Start command"
          title="The command the button above types into a new terminal pane. Leave it empty to use the one Forge found in this project's package.json."
          onChange={(e) => setCmdDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          onBlur={commitCommand}
        />
      </label>
    </>
  )

  return (
    <div className="dprev">
      <header className="dprev__head">
        <button
          type="button"
          className="ghost-btn dprev__back"
          title="Back to terminals (Esc)"
          onClick={() => actions.closeDevices()}
        >
          <Icon name="chevronLeft" size={14} />
          Back
        </button>
        <h1 className="dprev__title">Devices</h1>
        <span className="dprev__hint eyebrow">esc to close</span>
        {/*
          Only this checkout gets the switch. Everywhere else the phones show
          the project — that is what the view is, and a toggle offering to
          preview Forge Mobile from somebody else's project was a choice
          nobody at this desk was asking to make.
        */}
        {selfPreview ? (
          <div className="dprev__modes" role="group" aria-label="What the phones show">
            <button
              type="button"
              className="ghost-btn dprev__mode"
              data-on={mode === 'project' ? 'true' : undefined}
              title="Preview the site this project is serving"
              onClick={() => chooseMode('project')}
            >
              This project
            </button>
            <button
              type="button"
              className="ghost-btn dprev__mode"
              data-on={mode === 'forge' ? 'true' : undefined}
              title="Preview the Forge Mobile app itself"
              onClick={() => chooseMode('forge')}
            >
              Forge Mobile
            </button>
          </div>
        ) : null}
        <div className="dprev__headspace" />
        {mode === 'project' ? (
          <>
            {adoptable ? (
              <button
                type="button"
                className="ghost-btn dprev__adopt mono"
                title={`Switch to the URL this project just printed: ${adoptable}`}
                onClick={() => project && actions.setPreviewUrl(project.id, adoptable)}
              >
                <Icon name="refresh" size={12} />
                {adoptable}
              </button>
            ) : null}
            <input
              className="field__input mono dprev__url"
              value={draft}
              spellCheck={false}
              disabled={!project}
              placeholder={detected || 'localhost:3000'}
              aria-label="Preview URL"
              title="The URL both phones load. Leave it empty to follow whatever this project's terminals print."
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              onBlur={commitUrl}
            />
          </>
        ) : null}
        {canReload ? (
          <button
            type="button"
            className="ghost-btn dprev__reload"
            title="Reload both previews"
            onClick={() => (mode === 'project' ? reloadSites() : void loadAll())}
          >
            <Icon name="refresh" size={13} />
            Reload both
          </button>
        ) : null}
      </header>

      {mode === 'project' ? (
        !project ? (
          <Empty
            title="No project open"
            body="Pick a project in the rail and its phones appear here — Forge watches that project's terminals for a local dev-server URL."
          />
        ) : !resolved ? (
          <Empty
            title={selfPreview ? 'Forge previews itself through Forge Mobile' : 'No dev server yet'}
            body={
              selfPreview
                ? `${project.name} is the checkout this Forge is running from — starting its dev server here would boot a second Forge on top of the one you are using, so that button is not offered. The real mobile app is the preview instead, and it is one click away.`
                : `Forge is watching ${project.name}'s terminals for a local URL — start the dev server in any pane and both phones follow it. The button below runs ${command} in a new pane for you; change the command in the box under it if this project starts differently. A URL typed in the box above wins over all of that, and is remembered for this project.`
            }
            action={startBlock}
          />
        ) : reach === 'down' ? (
          /* The honest half of the feature: a URL that resolves is not a server
             that is running, and two white phones under a "Live" chip is the
             worst way to find that out. */
          <Empty
            title={`Nothing is answering at ${resolved}`}
            body={
              selfPreview
                ? `That is where ${project.name} last announced itself, and nothing is listening there now. This is the checkout Forge is running from, so it will not offer to start it — a second Forge on top of the first is not a preview. The real mobile app is one click away instead.`
                : `That is where ${project.name} last announced itself, and nothing is listening there now — the dev server looks stopped. The button below runs ${command} in a new pane; you land in the terminals to watch it boot, and Ctrl+Shift+D comes back here. Forge keeps checking either way, so the phones return the moment something answers.`
            }
            action={startBlock}
          />
        ) : reach !== 'up' ? (
          /* The stage, mounted and empty, for the moment the first probe takes.
             It is what the fit maths measures against, so a row that only
             appeared once the answer was in would hand the phones a scale of 0
             — and neither guess is worth showing for a frame either way. */
          <div className="dprev__row" ref={rowRef} />
        ) : (
          <div className="dprev__row" ref={rowRef}>
            {PREVIEW_DEVICES.map((preset) => {
              const w = preset.viewport.w + preset.chrome.bezel * 2
              const h = preset.viewport.h + preset.chrome.bezel * 2
              const box = siteViewport(preset)
              const key = siteKey(preset)
              const live = siteLoaded[preset.id] === key
              return (
                <div className="dprev__cell" key={preset.id}>
                  <div className="dprev__meta">
                    <span className="dprev__label">{preset.label}</span>
                    <span className="dprev__phase" data-live={live ? 'true' : undefined}>
                      {live ? 'Live' : 'Loading…'}
                    </span>
                    <button
                      type="button"
                      className="ghost-btn dprev__frame-reload"
                      title={`Reload the ${preset.label} preview`}
                      onClick={() => reloadSite(preset.id)}
                    >
                      <Icon name="refresh" size={12} />
                    </button>
                  </div>
                  <div className="dprev__slot" style={{ width: w * scale, height: h * scale }}>
                    <div
                      className="dprev__scaler"
                      data-sim={preset.id}
                      style={{ width: w, height: h, transform: `scale(${scale})` }}
                    >
                      {/* The bars are shell furniture here, above and below the
                          page rather than over it — see siteViewport. */}
                      <div className="dprev__phone" data-shell="site">
                        <div className="dprev__notch" aria-hidden="true" />
                        <StatusBar preset={preset} />
                        <iframe
                          key={key}
                          className="dprev__frame"
                          src={resolved}
                          title={`${preset.label} — ${project.name}`}
                          style={{ width: box.w, height: box.h }}
                          onLoad={() => setSiteLoaded((s) => ({ ...s, [preset.id]: key }))}
                        />
                        <div className="dprev__homerow" style={{ height: preset.insets.bottom }} aria-hidden="true">
                          <div className="dprev__homebar" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )
      ) : !status || status.state === 'starting' ? (
        <Empty title={!status ? 'Loading…' : 'Starting the phone link…'} />
      ) : status.state === 'off' ? (
        <Empty
          title="The phone link is off"
          body="The previews are the real mobile app on this desktop's own server — turn the link on and they appear here."
          action={
            <button type="button" className="sbtn sbtn--go" onClick={() => void window.forge.mobile.start()}>
              Turn on the phone link
            </button>
          }
        />
      ) : status.state === 'error' ? (
        <Empty title="The phone link is in trouble" body={status.detail || 'Settings › Forge Mobile has the detail.'} />
      ) : !status.web ? (
        <Empty
          title="The mobile bundle is not built"
          body="Run `npm run mobile:build` in the Forge checkout, then reopen this page. A packaged Forge carries its own copy — reinstall if this one is missing."
        />
      ) : (
        <div className="dprev__row" ref={rowRef}>
          {PREVIEW_DEVICES.map((preset) => {
            const f = frameFor(preset.id)
            const live = isLive(preset)
            const w = preset.viewport.w + preset.chrome.bezel * 2
            const h = preset.viewport.h + preset.chrome.bezel * 2
            return (
              <div className="dprev__cell" key={preset.id}>
                <div className="dprev__meta">
                  <span className="dprev__label">{preset.label}</span>
                  <span className="dprev__phase" data-live={live ? 'true' : undefined}>
                    {f?.error ? f.error : live ? 'Live' : f ? 'Loading…' : 'Waiting'}
                  </span>
                  <button
                    type="button"
                    className="ghost-btn dprev__frame-reload"
                    title={`Reload the ${preset.label} preview`}
                    onClick={() => void reloadOne(preset)}
                  >
                    <Icon name="refresh" size={12} />
                  </button>
                </div>
                {f && !f.error ? (
                  <div className="dprev__slot" style={{ width: w * scale, height: h * scale }}>
                    <div
                      className="dprev__scaler"
                      data-sim={preset.id}
                      style={{ width: w, height: h, transform: `scale(${scale})` }}
                    >
                      <div className="dprev__phone">
                        <div className="dprev__notch" aria-hidden="true" />
                        <iframe
                          key={f.key}
                          className="dprev__frame"
                          src={f.src}
                          title={`${preset.label} preview`}
                          style={{ width: preset.viewport.w, height: preset.viewport.h }}
                        />
                        <StatusBar preset={preset} />
                        <div className="dprev__homebar" aria-hidden="true" />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="dprev__dead" style={{ width: preset.viewport.w * scale }}>
                    {f?.error ? 'Pairing could not start.' : 'Waiting for a pairing code…'}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }): ReactNode {
  return (
    <div className="dprev__empty">
      <h2>{title}</h2>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  )
}

/**
 * The fake system bar. Identical markup in both modes — where it *sits* is a CSS
 * question the shell answers (`data-shell="site"`), not a different bar.
 */
function StatusBar({ preset }: { preset: DevicePreset }): ReactNode {
  return (
    <div className="dprev__statusbar" data-sim={preset.id} aria-hidden="true">
      <span className="dprev__clock">9:41</span>
      <span className="dprev__signals">
        <SignalIcon />
        <WifiIcon />
        <BatteryIcon />
      </span>
    </div>
  )
}

/* Status-bar glyphs. Inline SVG rather than a font glyph, so the bars render
 * the same on every machine — they are furniture, not information. */

function SignalIcon(): ReactNode {
  return (
    <svg width="15" height="10" viewBox="0 0 15 10" className="dprev__glyph" aria-hidden="true">
      <rect x="0" y="6.5" width="2.5" height="3.5" rx="0.5" />
      <rect x="4" y="4.5" width="2.5" height="5.5" rx="0.5" />
      <rect x="8" y="2.5" width="2.5" height="7.5" rx="0.5" />
      <rect x="12" y="0.5" width="2.5" height="9.5" rx="0.5" />
    </svg>
  )
}

function WifiIcon(): ReactNode {
  return (
    <svg width="13" height="10" viewBox="0 0 13 10" className="dprev__glyph" aria-hidden="true">
      <path d="M6.5 9.4 4.6 7.3a2.7 2.7 0 0 1 3.8 0L6.5 9.4Z" />
      <path d="M2.5 5.1a5.7 5.7 0 0 1 8 0l1.2-1.3a7.4 7.4 0 0 0-10.4 0l1.2 1.3Z" />
      <path d="M0.2 1.8a9.2 9.2 0 0 1 12.6 0L11.4 3.2a7.3 7.3 0 0 0-9.8 0L0.2 1.8Z" opacity="0.9" />
    </svg>
  )
}

function BatteryIcon(): ReactNode {
  return (
    <svg width="22" height="10" viewBox="0 0 22 10" className="dprev__glyph" aria-hidden="true">
      <rect x="0.5" y="0.5" width="18" height="9" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1" />
      <rect x="2" y="2" width="13" height="6" rx="1.2" />
      <path d="M20 3.4v3.2c0.9-0.3 1.4-0.9 1.4-1.6S20.9 3.7 20 3.4Z" />
    </svg>
  )
}
