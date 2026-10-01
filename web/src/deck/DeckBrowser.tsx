import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import {
  BROWSER_CTRL_LETTERS,
  BROWSER_KEYS,
  BROWSER_MIRROR_FEATURE,
  MAX_BROWSER_SCROLL,
  MAX_BROWSER_TEXT,
  MAX_BROWSER_URL,
  type BrowserCopyStatus,
  type BrowserStateFrame,
  type BrowserTabSummary
} from '@shared/browser-mirror'
import { mapToPage, scaleToPage, type Size } from '@shared/chat-mirror'
import {
  browserNav,
  closeBrowserTab,
  openBrowserTab,
  sendBrowserInput,
  subscribeBrowserTabs,
  watchBrowser
} from '../lib/client'
import { useDeskFeature } from '../lib/features'
import { useActiveProject, useForge } from '../state'
import './DeckBrowser.css'

/*
 * The deck's Browser view: the desktop's Browser tabs (shared/browser-mirror.ts),
 * a tab strip, an address bar, and a live picture of the tab on screen that
 * takes clicks, the wheel, typing and paste. Mostly for signing in from far
 * away — every Browser tab at home shares the one login.
 *
 * The picture is of an offscreen copy the desktop keeps for this browser, sized
 * to this box, as a chat tab's is (../components/ChatMirror.tsx). Watched only
 * while it is on screen: switching tab or leaving the Browser unwatches.
 */

/** A box has to hold its size this long before the desktop is asked to redraw at it. */
const RESIZE_SETTLE_MS = 200
/** The sharpest picture asked for: frames stay small on a slow tunnel. */
const MAX_DPR = 1.5
/** Which tab was on screen, per project, in this browser. */
const PICKS_KEY = 'forge-web-browser-tab'
/** The fewest milliseconds between two pointer moves sent to the desktop (about 20 a second). */
const MOVE_EVERY_MS = 50

type Shown = 'update' | 'reconnecting' | BrowserCopyStatus

const STATE_WORD: Record<Shown, string> = {
  update: 'Needs update',
  reconnecting: 'Reconnecting',
  loading: 'Loading',
  live: 'Live',
  error: "Can't load"
}

/** Each state as a shape as well as a word: a filled dot, a dashed ring, a ring, a cross. */
function StateGlyph({ state }: { state: Shown }): ReactNode {
  return (
    <svg className="dk-browser__glyph" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      {state === 'live' ? <circle cx="5" cy="5" r="3.6" fill="currentColor" /> : null}
      {state === 'loading' || state === 'reconnecting' ? (
        <circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 1.6" />
      ) : null}
      {state === 'update' ? <circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.4" /> : null}
      {state === 'error' ? (
        <path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      ) : null}
    </svg>
  )
}

function loadPicks(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(PICKS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function savePicks(picks: Record<string, string>): void {
  try {
    window.localStorage.setItem(PICKS_KEY, JSON.stringify(picks))
  } catch {
    /* this page still remembers until it reloads */
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function tabName(tab: BrowserTabSummary): string {
  return tab.title.trim() || hostOf(tab.url) || 'New tab'
}

/**
 * What the address box means: an address with its scheme as typed, a bare
 * host given https, and anything with a space or no dot a search.
 */
function toAddress(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  let url: string
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^about:/i.test(text)) url = text
  else if (/\s/.test(text) || !/[.:]/.test(text)) url = `https://www.google.com/search?q=${encodeURIComponent(text)}`
  else url = `https://${text}`
  return url.slice(0, MAX_BROWSER_URL)
}

const NAMED_KEYS = new Set<string>(BROWSER_KEYS)
const CTRL_LETTERS = new Set<string>(BROWSER_CTRL_LETTERS)

export function DeckBrowser(): ReactNode {
  const { state } = useForge()
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  const supported = useDeskFeature(BROWSER_MIRROR_FEATURE)
  const project = useActiveProject()
  const projectId = project?.id ?? ''

  const [tabs, setTabs] = useState<BrowserTabSummary[] | null>(null)
  const [picks, setPicks] = useState<Record<string, string>>(loadPicks)
  const [opening, setOpening] = useState(false)
  const [hint, setHint] = useState('')
  const stripRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!supported) return undefined
    return subscribeBrowserTabs(setTabs)
  }, [supported])

  const shownTabs = (tabs ?? []).filter((t) => t.project === projectId || t.project === '')
  const selected = shownTabs.find((t) => t.id === picks[projectId]) ?? shownTabs[0] ?? null

  const pick = (tabId: string): void => {
    setPicks((prev) => {
      const next = { ...prev, [projectId]: tabId }
      savePicks(next)
      return next
    })
  }

  // The tab on screen is kept in view in a strip that has scrolled sideways.
  const selectedId = selected?.id ?? ''
  useEffect(() => {
    if (!selectedId) return
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(selectedId)}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedId])

  /** Close any tab, as the desktop's own close does; closing the one on screen puts its neighbour there. */
  const closeTab = (tabId: string): void => {
    if (!live) return
    if (tabId === selected?.id) {
      const at = shownTabs.findIndex((t) => t.id === tabId)
      const next = shownTabs[at + 1] ?? shownTabs[at - 1]
      if (next) pick(next.id)
    }
    closeBrowserTab(tabId)
  }

  const openTab = (): void => {
    if (!live || opening) return
    setOpening(true)
    setHint('')
    openBrowserTab(projectId)
      .then((tabId) => pick(tabId))
      .catch((error: unknown) => setHint(error instanceof Error ? error.message : 'The desktop could not open a tab.'))
      .finally(() => setOpening(false))
  }

  if (!supported) {
    return (
      <div className="dk-browser">
        <p className="dk-browser__empty">Update the desktop to use the Browser here.</p>
      </div>
    )
  }

  return (
    <div className="dk-browser">
      <div
        ref={stripRef}
        className="dk-browser__strip"
        role="tablist"
        aria-label="Browser tabs on the desktop"
        onWheel={(e) => {
          // An up-and-down wheel turns into sideways, so a full strip scrolls
          // with any wheel; a touchpad's sideways swipe scrolls it as it is.
          const el = e.currentTarget
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) el.scrollLeft += e.deltaY
        }}
      >
        {shownTabs.map((tab) => {
          const on = tab.id === selected?.id
          const name = tabName(tab)
          const owned = tab.ownerId !== 'user'
          return (
            <div
              key={tab.id}
              className="dk-browser__tab"
              data-on={on ? 'true' : 'false'}
              data-tab-id={tab.id}
              onMouseDown={(e) => {
                // No autoscroll circle from a middle press: it closes the tab instead.
                if (e.button === 1) e.preventDefault()
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return
                e.preventDefault()
                closeTab(tab.id)
              }}
            >
              <button
                type="button"
                role="tab"
                className="dk-browser__tab-btn"
                aria-selected={on}
                title={`${name}${owned ? ` — ${tab.ownerLabel}'s tab` : ''}\n${tab.url}`}
                onClick={() => pick(tab.id)}
              >
                <Icon name="globe" size={12} />
                <span className="dk-browser__tab-name truncate">{name}</span>
                {owned ? <span className="dk-browser__owner truncate">{tab.ownerLabel}&apos;s tab</span> : null}
              </button>
              <button
                type="button"
                className="dk-browser__tab-close"
                disabled={!live}
                aria-label={`Close ${name}`}
                title={live ? `Close ${name} on the desktop` : 'The desktop is not answering, so it cannot close one'}
                onClick={() => closeTab(tab.id)}
              >
                <Icon name="close" size={10} />
              </button>
            </div>
          )
        })}
        <button
          type="button"
          className="dk-browser__new"
          disabled={!live || opening}
          aria-label="New Browser tab"
          title={live ? 'New Browser tab — it opens on the desktop too' : 'The desktop is not answering, so it cannot open one'}
          onClick={openTab}
        >
          <Icon name="plus" size={13} />
        </button>
      </div>

      {hint ? <p className="dk-browser__hint" role="alert">{hint}</p> : null}

      {selected ? (
        <BrowserTabView key={selected.id} tab={selected} live={live} />
      ) : (
        <p className="dk-browser__empty">
          {tabs === null
            ? live
              ? "Asking the desktop for its Browser tabs…"
              : 'The link to your PC dropped. The tabs come back when it reconnects.'
            : 'No Browser tabs in this project. Press + to open one.'}
        </p>
      )}
    </div>
  )
}

/** One tab: its address bar and its live picture. Keyed on the tab, so a switch starts clean. */
function BrowserTabView({ tab, live }: { tab: BrowserTabSummary; live: boolean }): ReactNode {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const keysRef = useRef<HTMLTextAreaElement | null>(null)
  /** The page's CSS size the picture on screen shows — what a click maps onto. */
  const pageRef = useRef<Size>({ width: 0, height: 0 })
  const [box, setBox] = useState<Size | null>(null)
  const [copy, setCopy] = useState<BrowserStateFrame | null>(null)
  const [pictured, setPictured] = useState(false)
  const [typing, setTyping] = useState(false)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)

  // The box, measured; a change is passed on once it has held still.
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return undefined
    let timer = 0
    const read = (): Size => {
      const r = el.getBoundingClientRect()
      return { width: Math.round(r.width), height: Math.round(r.height) }
    }
    setBox(read())
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const next = read()
        setBox((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next))
      }, RESIZE_SETTLE_MS)
    })
    observer.observe(el)
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [])

  const width = box?.width ?? 0
  const height = box?.height ?? 0
  const watching = live && width >= 50 && height >= 50

  useEffect(() => {
    if (!watching) return undefined
    const dpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1))
    return watchBrowser(
      tab.id,
      { width, height, dpr },
      {
        onFrame: (frame) => {
          pageRef.current = { width: frame.width, height: frame.height }
          const img = imgRef.current
          if (img) img.src = `data:image/jpeg;base64,${frame.jpeg}`
          setPictured(true)
        },
        onState: (frame) => setCopy(frame)
      }
    )
  }, [watching, tab.id, width, height])

  const status: BrowserCopyStatus = copy?.status ?? 'loading'
  const shown: Shown = !live ? 'reconnecting' : status
  const url = copy?.url || tab.url
  const canTouch = watching && pictured
  const pageLoading = copy?.loading === true

  /* ------------------------------------------------------------ address */

  const go = (e: FormEvent): void => {
    e.preventDefault()
    const next = toAddress(address)
    if (!next || !live) return
    browserNav(tab.id, 'go', next)
    setEditing(false)
    keysRef.current?.focus({ preventScroll: true })
  }

  /* ------------------------------------------------------------ pointer */

  const pagePoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = stageRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    return mapToPage({ x: clientX - r.left, y: clientY - r.top }, { width: r.width, height: r.height }, pageRef.current)
  }

  // A touchpad sends a wheel event per frame or faster: they are summed and
  // sent once an animation frame.
  const wheel = useRef<{ x: number; y: number; dx: number; dy: number; raf: number }>({ x: 0, y: 0, dx: 0, dy: 0, raf: 0 })
  useEffect(() => {
    const pending = wheel.current
    return () => window.cancelAnimationFrame(pending.raf)
  }, [])

  // The pointer over the picture, sent at most every MOVE_EVERY_MS, the last
  // place always sent: the page sees hover and answers with its cursor.
  const pointer = useRef<{ x: number; y: number; sent: number; timer: number }>({ x: 0, y: 0, sent: 0, timer: 0 })
  useEffect(() => {
    const pending = pointer.current
    return () => window.clearTimeout(pending.timer)
  }, [])

  const flushMove = (): void => {
    const p = pointer.current
    p.timer = 0
    p.sent = performance.now()
    // No picture yet, so no map from the box to the page: nothing is sent.
    const at = pagePoint(p.x, p.y)
    if (at) sendBrowserInput({ tabId: tab.id, kind: 'move', x: at.x, y: at.y })
  }

  const flushWheel = (): void => {
    const w = wheel.current
    w.raf = 0
    const el = stageRef.current
    const at = pagePoint(w.x, w.y)
    if (!el || !at) {
      w.dx = 0
      w.dy = 0
      return
    }
    const r = el.getBoundingClientRect()
    const boxSize = { width: r.width, height: r.height }
    const clamp = (v: number): number => Math.max(-MAX_BROWSER_SCROLL, Math.min(MAX_BROWSER_SCROLL, v))
    const dx = clamp(scaleToPage(w.dx, boxSize, pageRef.current))
    const dy = clamp(scaleToPage(w.dy, boxSize, pageRef.current))
    w.dx = 0
    w.dy = 0
    if (dx !== 0 || dy !== 0) sendBrowserInput({ tabId: tab.id, kind: 'scroll', x: at.x, y: at.y, dx, dy })
  }

  /* ----------------------------------------------------------- keyboard */

  const sendText = (text: string): void => {
    if (!text || !canTouch) return
    sendBrowserInput({ tabId: tab.id, kind: 'text', text: text.slice(0, MAX_BROWSER_TEXT) })
  }

  const flushTyped = (): void => {
    const el = keysRef.current
    if (!el || !el.value) return
    const text = el.value
    el.value = ''
    sendText(text)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || e.key === 'Dead' || !canTouch) return
    const mods = { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey }
    // Ctrl with a letter (not AltGr, which a UK keyboard reports as Ctrl+Alt
    // and which types a character): select all, copy, cut, undo, redo.
    const letter = e.key.length === 1 ? e.key.toLowerCase() : ''
    if ((e.ctrlKey || e.metaKey) && !e.altKey && CTRL_LETTERS.has(letter)) {
      e.preventDefault()
      sendBrowserInput({ tabId: tab.id, kind: 'key', key: letter, mods: { ctrl: true, shift: e.shiftKey } })
      return
    }
    // A space is typed as text, never as the Space key.
    if (e.key !== ' ' && NAMED_KEYS.has(e.key)) {
      e.preventDefault()
      sendBrowserInput({ tabId: tab.id, kind: 'key', key: e.key, mods })
    }
  }

  /* ------------------------------------------------------------- words */

  const notice = !live
    ? 'The link to your PC dropped. The page comes back when it reconnects.'
    : status === 'error'
      ? copy?.error || `Can't load ${tabName(tab)} on your PC.`
      : !pictured
        ? `Opening ${tabName(tab)} on your PC…`
        : ''

  return (
    <div className="dk-browser__tabview">
      <form className="dk-browser__nav" onSubmit={go}>
        <button
          type="button"
          className="dk-browser__navbtn"
          disabled={!live || !copy?.canGoBack}
          aria-label="Back"
          title="Back"
          onClick={() => browserNav(tab.id, 'back')}
        >
          <Icon name="chevronLeft" size={14} />
        </button>
        <button
          type="button"
          className="dk-browser__navbtn"
          disabled={!live || !copy?.canGoForward}
          aria-label="Forward"
          title="Forward"
          onClick={() => browserNav(tab.id, 'forward')}
        >
          <Icon name="chevronRight" size={14} />
        </button>
        <button
          type="button"
          className="dk-browser__navbtn"
          disabled={!live}
          aria-label={pageLoading ? 'Stop' : 'Reload'}
          title={pageLoading ? 'Stop loading' : 'Reload'}
          onClick={() => browserNav(tab.id, pageLoading ? 'stop' : 'reload')}
        >
          <Icon name={pageLoading ? 'close' : 'refresh'} size={13} />
        </button>
        <input
          className="dk-browser__address"
          type="text"
          inputMode="url"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Address"
          placeholder="Type an address or a search"
          value={editing ? address : url}
          onFocus={(e) => {
            setAddress(url)
            setEditing(true)
            e.currentTarget.select()
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.currentTarget.blur()
          }}
        />
        <span className="dk-browser__state" role="status" data-state={shown}>
          <StateGlyph state={shown} />
          {STATE_WORD[shown]}
        </span>
      </form>

      <div
        ref={stageRef}
        className="dk-browser__stage"
        data-pictured={pictured ? 'true' : undefined}
        data-typing={typing ? 'true' : undefined}
        // The picture has no pointer drawn in it: this one is the page's own.
        style={{ cursor: canTouch ? copy?.cursor || 'default' : 'default' }}
        onPointerMove={(e) => {
          if (!canTouch || e.pointerType === 'touch') return
          const p = pointer.current
          p.x = e.clientX
          p.y = e.clientY
          if (p.timer) return
          const wait = MOVE_EVERY_MS - (performance.now() - p.sent)
          if (wait <= 0) flushMove()
          else p.timer = window.setTimeout(flushMove, wait)
        }}
        onMouseDown={(e) => {
          // Keep the caret in the capture box: a press on the picture is the page's.
          if (canTouch) e.preventDefault()
        }}
        onClick={(e) => {
          if (!canTouch) return
          keysRef.current?.focus({ preventScroll: true })
          const at = pagePoint(e.clientX, e.clientY)
          if (at) sendBrowserInput({ tabId: tab.id, kind: 'click', x: at.x, y: at.y, count: e.detail >= 2 ? 2 : 1 })
        }}
        onWheel={(e) => {
          if (!canTouch) return
          // Lines and pages turned into pixels; positive = the page scrolls down/right.
          const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (stageRef.current?.clientHeight ?? 600) : 1
          const w = wheel.current
          w.x = e.clientX
          w.y = e.clientY
          w.dx += e.deltaX * unit
          w.dy += e.deltaY * unit
          if (!w.raf) w.raf = window.requestAnimationFrame(flushWheel)
        }}
      >
        <img ref={imgRef} className="dk-browser__picture" alt={`${tabName(tab)}, as the desktop shows it`} draggable={false} />
        {/*
          Where the keys go: a box nobody sees, focused by a click on the
          picture. Text comes through `input` (so a UK keyboard's dead keys and
          AltGr characters arrive composed), named keys through keydown, and a
          paste as one piece of text — how a password gets in.
        */}
        <textarea
          ref={keysRef}
          className="dk-browser__keys"
          aria-label={`Type into ${tabName(tab)}`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          tabIndex={-1}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
          onKeyDown={onKeyDown}
          onChange={(e) => {
            if (!(e.nativeEvent as InputEvent).isComposing) flushTyped()
          }}
          onCompositionEnd={flushTyped}
          onPaste={(e) => {
            e.preventDefault()
            sendText(e.clipboardData.getData('text/plain'))
          }}
        />
        {notice ? (
          <div className="dk-browser__notice" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <p>{notice}</p>
          </div>
        ) : null}
      </div>

      <p className="dk-browser__typing" data-typing={typing ? 'true' : undefined}>
        <Icon name={typing ? 'check' : 'key'} size={12} />
        {typing ? 'Typing goes to this page' : 'Click the page to type'}
      </p>
    </div>
  )
}
