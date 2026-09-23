import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { artifactUrl } from '@shared/browser'
import type { CanvasItem } from '@shared/hub'
import type { CanvasFeed } from '@/hooks/useHub'
import { popIn } from '@/lib/motion'
import { useApp } from '@/state/AppState'
import { renderMarkdown } from '../../../web/src/lib/markdown'
import { browserBridge } from '../browser/bridge'
import { Icon } from '../Icon'
import './Artifact.css'

/**
 * The artifact panel: one thing an agent made, open beside the panes.
 *
 *   HTML       rendered live in a sandboxed frame — scripts may run, and that
 *              is all they may do: `sandbox="allow-scripts"` alone gives the
 *              page an opaque origin (no parent.document, no window.forge, no
 *              cookies or storage of Forge's), no top navigation, no forms,
 *              no pop-ups. The frame loads the file from main's
 *              forge-artifact:// scheme (electron/artifact-scheme.ts), whose
 *              response CSP shuts every network door (connect-src 'none')
 *              and allows inline script and style — its own policy, not the
 *              renderer's, which is why scripts run in a built Forge.
 *   Markdown   formatted by Forge Web's own renderer, which builds React
 *              elements and never injects HTML, so raw HTML in the source
 *              shows as text and cannot run. Links open outside Forge.
 *   text       as it is, in a code well.
 *   image/video  shown whole.
 *
 * Preview ⇄ Code flips the first two to their source. When an agent rewrites
 * the file the board's watcher changes the item's mtime, and the panel
 * re-reads it and says "Updated" for a moment, so a page an agent is building
 * refreshes in front of you as it works.
 */

/** The thumbnails' policy (srcdoc, scripts stripped): nothing leaves, nothing loads. */
export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:"

/** Put the CSP meta ahead of everything the page brings, after any doctype. */
export function sandboxedDocument(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) return `${doctype[0]}${meta}${html.slice(doctype[0].length)}`
  return `<!doctype html>${meta}${html}`
}

export function isMarkdown(item: CanvasItem): boolean {
  return item.kind === 'text' && (/markdown/i.test(item.mime) || /\.(md|markdown)$/i.test(item.name))
}

/** An item's whole text, re-read whenever the file changes on disk; `failed` once a read comes back empty-handed. */
function useArtifactRead(item: CanvasItem, feed: CanvasFeed): { text: string | null; failed: boolean } {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const { readText } = feed
  useEffect(() => {
    if (item.kind !== 'text' && item.kind !== 'html') return undefined
    let live = true
    readText(item.id).then(
      (t) => {
        if (!live) return
        setText(t)
        setFailed(t === null)
      },
      () => {
        if (live) setFailed(true)
      }
    )
    return () => {
      live = false
    }
  }, [item.id, item.kind, item.mtime, readText])
  return { text, failed }
}

/** An item's whole text, re-read whenever the file changes on disk. */
export function useArtifactText(item: CanvasItem, feed: CanvasFeed): string | null {
  return useArtifactRead(item, feed).text
}

/**
 * An item's forge-artifact: address. Its folder is its project's:
 * <dataDir>/canvas/<projectId>/<file>. The frame adds `?v=<mtime>`, so a
 * rewrite is a new address and the page reloads as the agent works.
 */
function artifactAddress(item: CanvasItem): string {
  return artifactUrl(item.path.split(/[\\/]/).slice(-2, -1)[0] ?? '', item.id)
}

/** Markdown, with its links sent to the system browser instead of this window. */
export function MarkdownBody({ source, className }: { source: string; className?: string }): ReactNode {
  const body = useMemo(() => renderMarkdown(source), [source])
  return (
    <div
      className={className ? `artifact__md ${className}` : 'artifact__md'}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        if (!a) return
        e.preventDefault()
        const href = a.getAttribute('href') ?? ''
        if (/^https?:\/\//i.test(href)) void window.forge.openExternal(href)
      }}
    >
      {body}
    </div>
  )
}

/** A still thumbnail of an HTML artifact: sandboxed with no permissions at all, scripts removed. */
export function HtmlThumb({ html, title }: { html: string; title: string }): ReactNode {
  // The empty sandbox already refuses script; dropping the tags just keeps the
  // console free of one refusal per tile.
  const doc = useMemo(() => sandboxedDocument(html.replace(/<script\b[\s\S]*?<\/script>/gi, '')), [html])
  return (
    <span className="artifact-thumb">
      <iframe className="artifact-thumb__frame" sandbox="" srcDoc={doc} title={title} tabIndex={-1} loading="lazy" referrerPolicy="no-referrer" />
    </span>
  )
}

function CodeWell({ text }: { text: string }): ReactNode {
  const lines = text.split('\n')
  return (
    <pre className="artifact__code">
      {lines.map((l, i) => (
        <span key={i} className="artifact__line">
          <span className="artifact__ln" aria-hidden="true">
            {i + 1}
          </span>
          {l || ' '}
        </span>
      ))}
    </pre>
  )
}

export interface ArtifactActions {
  /** "→ Everest": paste the path into the pane you are in. */
  toPane: () => void
  paneName: string | null
  copy: () => void
  copied: boolean
  remove: () => void
}

export function ArtifactView({
  item,
  feed,
  index,
  count,
  media,
  actions,
  onStep,
  onClose
}: {
  item: CanvasItem
  feed: CanvasFeed
  index: number
  count: number
  /** How to draw an image or video (the board's own preview). */
  media: ReactNode
  actions: ArtifactActions
  onStep: (delta: number) => void
  onClose: () => void
}): ReactNode {
  const { actions: app } = useApp()
  const ref = useRef<HTMLDivElement | null>(null)
  const { text, failed } = useArtifactRead(item, feed)
  const md = isMarkdown(item)
  const hasSource = item.kind === 'html' || md
  const [mode, setMode] = useState<'preview' | 'code'>('preview')
  const [updated, setUpdated] = useState(false)
  const lastMtime = useRef(item.mtime)
  const lastId = useRef(item.id)

  useLayoutEffect(() => {
    if (ref.current) popIn(ref.current, { from: 0.97, lift: 8 })
  }, [])

  // A rewrite of the open file: it re-reads itself (useArtifactText) and says so.
  useEffect(() => {
    if (lastId.current !== item.id) {
      lastId.current = item.id
      lastMtime.current = item.mtime
      setUpdated(false)
      return undefined
    }
    if (lastMtime.current === item.mtime) return undefined
    lastMtime.current = item.mtime
    setUpdated(true)
    const t = window.setTimeout(() => setUpdated(false), 2600)
    return () => window.clearTimeout(t)
  }, [item.id, item.mtime])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowRight' && count > 1) onStep(1)
      else if (e.key === 'ArrowLeft' && count > 1) onStep(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onStep, count])

  const openInBrowser = async (): Promise<void> => {
    const api = browserBridge()
    if (!api) {
      app.setNotice('The built-in browser needs a restart of Forge')
      return
    }
    // A read-only view, in a session of its own — never the signed-in one.
    const reply = await api.open({ url: artifactAddress(item) })
    if (!reply.ok) app.setNotice(`The built-in browser could not open it — ${reply.text}`)
  }

  const kindWord = item.kind === 'html' ? 'HTML' : md ? 'Markdown' : item.kind === 'text' ? 'Text' : item.kind === 'video' ? 'Video' : 'Image'

  return (
    <div className="artifact" ref={ref} role="dialog" aria-label={item.title} data-kind={item.kind}>
      <header className="artifact__head">
        <button type="button" className="artifact__back" onClick={onClose} title="Back to the board (Esc)">
          <Icon name="chevronLeft" size={14} />
          Board
        </button>
        <span className="artifact__titles">
          <span className="artifact__title">{item.title}</span>
          <span className="artifact__meta mono">
            {kindWord} · {index + 1} of {count}
          </span>
        </span>
        {failed ? (
          <span className="artifact__note" role="status" title="The file could not be read from the board’s folder. It may have been moved or deleted.">
            Failed to load
          </span>
        ) : null}
        {updated ? (
          <span className="artifact__updated" role="status">
            <span aria-hidden="true">↻</span> Updated
          </span>
        ) : null}
        {hasSource ? (
          <span className="artifact__seg" role="group" aria-label="View">
            <button type="button" data-on={mode === 'preview' ? 'true' : undefined} aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
              Preview
            </button>
            <button type="button" data-on={mode === 'code' ? 'true' : undefined} aria-pressed={mode === 'code'} onClick={() => setMode('code')}>
              Code
            </button>
          </span>
        ) : null}
        <span className="artifact__acts">
          <button type="button" className="artifact__act artifact__act--primary" onClick={actions.toPane} title={`Paste its path into ${actions.paneName ?? 'the pane you are in'}`}>
            <span aria-hidden="true">→</span>
            <span className="truncate">{actions.paneName ?? 'Pane'}</span>
          </button>
          {item.kind === 'html' ? (
            <button type="button" className="artifact__act" onClick={() => void openInBrowser()} title="Open in Forge's built-in browser">
              <Icon name="globe" size={12} />
              Browser
            </button>
          ) : null}
          <button type="button" className="artifact__act" onClick={actions.copy} title="Copy the picture, or the path">
            <Icon name={actions.copied ? 'check' : 'clipboard'} size={12} />
            {actions.copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="artifact__act" onClick={() => void window.forge.openPath(item.path)} title="Open in its own app">
            <Icon name="expand" size={12} />
          </button>
          <button type="button" className="artifact__act artifact__act--quiet" onClick={actions.remove} title="Take it off the board (deletes the file from the board’s folder)">
            <Icon name="trash" size={12} />
          </button>
        </span>
      </header>

      <div className="artifact__stage" data-mode={hasSource ? mode : 'preview'}>
        {item.kind === 'image' || item.kind === 'video' ? (
          <div className="artifact__media">{media}</div>
        ) : text === null ? (
          <p className="artifact__wait">{failed ? 'Failed — the file could not be read.' : 'Reading…'}</p>
        ) : mode === 'code' || (item.kind === 'text' && !md) ? (
          <CodeWell text={text} />
        ) : item.kind === 'html' ? (
          <iframe
            key={item.id}
            className="artifact__frame"
            title={item.title}
            sandbox="allow-scripts"
            src={`${artifactAddress(item)}?v=${item.mtime}`}
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="artifact__prose">
            <MarkdownBody source={text} />
          </div>
        )}
        {count > 1 ? (
          <>
            <button type="button" className="artifact__nav" data-dir="prev" onClick={() => onStep(-1)} aria-label="Previous (←)">
              <Icon name="chevronLeft" size={18} />
            </button>
            <button type="button" className="artifact__nav" data-dir="next" onClick={() => onStep(1)} aria-label="Next (→)">
              <Icon name="chevronRight" size={18} />
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}
