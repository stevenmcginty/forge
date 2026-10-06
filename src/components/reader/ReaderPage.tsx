import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { ReaderDoc } from '@shared/reader'
import { uiCommands } from '@/lib/uiCommands'
import { useApp } from '@/state/AppState'
import { renderMarkdown } from '../../../web/src/lib/markdown'
import { browserBridge } from '../browser/bridge'
import { Icon } from '../Icon'
import { baseName, dirName, folderLabel, timeAgo, useNow } from './readerFormat'
import { prepareMarkdown, READER_LINK_HOST, slugify, wordCount } from './readerMarkdown'
import {
  isDirty,
  readerApi,
  readerState,
  samePath,
  setDraft,
  settlePending,
  useReaderState
} from './readerStore'

/**
 * The page: one file, read or edited.
 *
 *   reading   the shared Markdown renderer in a measured column. The file is
 *             watched; a change on disk re-reads it in place, scroll kept, and
 *             says "Updated just now". Every link click is caught here — an
 *             unhandled one would navigate the whole window.
 *   editing   the raw Markdown in a plain text box. Save (or Ctrl+S) writes
 *             with the hash it was read at, so a file changed underneath is a
 *             conflict, offered as exactly two choices, never a silent
 *             overwrite. Unsaved text lives in the reader store, so leaving
 *             Read and coming back keeps it.
 */

const UPDATED_MS = 4000

type Leave = 'reading' | 'file' | null

export function ReaderPage({
  path,
  projectRoot,
  projectName,
  active
}: {
  path: string
  projectRoot: string | null
  projectName: string | null
  active: boolean
}): ReactNode {
  const { actions: app } = useApp()
  const reader = useReaderState()
  const now = useNow()
  const [doc, setDoc] = useState<ReaderDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [diskDoc, setDiskDoc] = useState<ReaderDoc | null>(null)
  const [conflict, setConflict] = useState<ReaderDoc | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(0)
  const [leaveTo, setLeaveTo] = useState<Leave>(null)
  const scroll = useRef<HTMLDivElement | null>(null)
  const article = useRef<HTMLElement | null>(null)
  const keepScroll = useRef<number | null>(null)
  const docRef = useRef(doc)
  docRef.current = doc

  const draft = reader.draft && samePath(reader.draft.path, path) ? reader.draft : null
  const editing = !!draft
  const dirty = isDirty(draft)
  const name = baseName(path)
  const leaving: Leave = reader.pending && dirty ? 'file' : leaveTo

  /* ------------------------------------------------------------ load + watch */

  useEffect(() => {
    setDoc(null)
    setError(null)
    setDiskDoc(null)
    setConflict(null)
    setLeaveTo(null)
    setUpdatedAt(0)
    if (scroll.current) scroll.current.scrollTop = 0
    const api = readerApi()
    if (!api) return undefined
    let live = true
    api.read(path).then(
      (r) => {
        if (!live) return
        if ('error' in r) setError(r.error)
        else setDoc(r)
      },
      (err: unknown) => {
        if (live) setError(String(err))
      }
    )
    api.watch(path).then(
      (r) => {
        if (!r.ok) console.warn('[reader] cannot watch', path, r.error)
      },
      () => undefined
    )
    const off = api.onChanged((changed) => {
      if (!samePath(changed, path)) return
      api.read(path).then(
        (r) => {
          if (!live || 'error' in r) return
          const cur = docRef.current
          // Forge's own save fires this too: same bytes, nothing to say.
          if (cur && r.hash === cur.hash) return
          const d = readerState().draft
          if (d && samePath(d.path, path)) {
            if (d.text === d.original) {
              // Editing but untouched: follow the file quietly.
              setDraft({ path: d.path, text: r.text, original: r.text, baseHash: r.hash })
              setDoc(r)
            } else setDiskDoc(r)
            return
          }
          keepScroll.current = scroll.current?.scrollTop ?? null
          setDoc(r)
          setUpdatedAt(Date.now())
        },
        () => undefined
      )
    })
    return () => {
      live = false
      off()
      api.unwatch(path)
    }
  }, [path])

  // A live re-read keeps your place.
  useLayoutEffect(() => {
    if (keepScroll.current !== null && scroll.current) scroll.current.scrollTop = keepScroll.current
    keepScroll.current = null
  }, [doc])

  useEffect(() => {
    if (!updatedAt) return undefined
    const t = window.setTimeout(() => setUpdatedAt(0), UPDATED_MS)
    return () => window.clearTimeout(t)
  }, [updatedAt])

  /* ---------------------------------------------------------------- edit */

  const startEdit = (): void => {
    if (!doc) return
    setSavedAt(0)
    setDraft({ path, text: doc.text, original: doc.text, baseHash: doc.hash })
  }

  const save = useCallback(
    async (baseOverride?: string): Promise<boolean> => {
      const api = readerApi()
      const d = readerState().draft
      if (!api || !d || !samePath(d.path, path)) return false
      setSaving(true)
      try {
        const r = await api.write(d.path, d.text, baseOverride ?? d.baseHash)
        if (r.ok) {
          const nowDraft = readerState().draft
          setDoc({ path: d.path, text: d.text, mtimeMs: r.mtimeMs, hash: r.hash })
          if (nowDraft && samePath(nowDraft.path, d.path)) setDraft({ ...nowDraft, original: d.text, baseHash: r.hash })
          setConflict(null)
          setDiskDoc(null)
          setSavedAt(Date.now())
          return true
        }
        if ('conflict' in r) {
          setConflict(r.doc)
          return false
        }
        app.setNotice(`Could not save ${baseName(d.path)} — ${r.error}`)
        return false
      } catch (err) {
        app.setNotice(`Could not save ${baseName(d.path)} — ${String(err)}`)
        return false
      } finally {
        setSaving(false)
      }
    },
    [path, app]
  )

  const loadTheirs = (theirs: ReaderDoc): void => {
    setConflict(null)
    setDiskDoc(null)
    setDraft(null)
    setDoc(theirs)
  }

  const stopEditing = (): void => {
    if (dirty) setLeaveTo('reading')
    else setDraft(null)
  }

  /** The leave prompt's answers. */
  const proceed = (): void => {
    setLeaveTo(null)
    setConflict(null)
    setDiskDoc(null)
    if (reader.pending) settlePending(true)
    else setDraft(null)
  }
  const stay = (): void => {
    setLeaveTo(null)
    settlePending(false)
  }
  const saveThenProceed = async (): Promise<void> => {
    // A failed save (a conflict, an error) stays here, where its banner can be answered.
    if (await save()) proceed()
    else stay()
  }

  // Asked to leave, then the edits were typed back to what is on disk: nothing to ask about.
  useEffect(() => {
    if (reader.pending && !dirty) settlePending(true)
  }, [reader.pending, dirty])

  // Ctrl+S while editing, wherever the focus is on this page.
  const live = useRef({ editing, active, save })
  live.current = { editing, active, save }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const l = live.current
      if (!l.editing || !l.active) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        e.stopPropagation()
        void l.save()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  /* --------------------------------------------------------------- links */

  const scrollToHeading = (hash: string): void => {
    const want = slugify(decodeURIComponent(hash))
    const heads = article.current?.querySelectorAll<HTMLElement>('.md__h') ?? []
    for (const h of heads) {
      if (slugify(h.textContent ?? '') === want) {
        h.scrollIntoView({ block: 'start', behavior: 'smooth' })
        return
      }
    }
  }

  const onLink = (e: MouseEvent<HTMLElement>): void => {
    const a = (e.target as Element | null)?.closest?.('a')
    if (!a) return
    e.preventDefault()
    if (e.type === 'auxclick' && e.button !== 1) return
    const href = a.getAttribute('href') ?? ''
    let url: URL
    try {
      url = new URL(href)
    } catch {
      return
    }
    if (url.hostname === READER_LINK_HOST) {
      const hash = url.searchParams.get('hash')
      if (hash !== null) {
        scrollToHeading(hash)
        return
      }
      const to = url.searchParams.get('to') ?? ''
      const [rawFile = '', frag] = to.split('#')
      let file = rawFile
      try {
        file = decodeURIComponent(rawFile)
      } catch {
        /* keep it as written */
      }
      if (!file) {
        if (frag) scrollToHeading(frag)
        return
      }
      const api = readerApi()
      if (!api) return
      void api.resolve(file, dirName(path)).then(
        (found) => {
          if (!found) {
            app.setNotice(/\.(md|markdown)$/i.test(file) ? `Could not find ${file}` : `Read opens Markdown files only — ${file}`)
            return
          }
          if (samePath(found, path)) {
            if (frag) scrollToHeading(frag)
            return
          }
          void api.open(found, 'app').then((r) => {
            if (!r.ok) app.setNotice(`Could not open ${baseName(found)} — ${r.error}`)
          })
        },
        () => undefined
      )
      return
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const browser = browserBridge()
      if (!browser) {
        app.setNotice('The built-in browser needs a restart of Forge')
        return
      }
      uiCommands.run('set-mode', 'browser')
      void browser.open({ url: url.href }).then((r) => {
        if (!r.ok) app.setNotice(`The built-in browser could not open it — ${r.text}`)
      })
    }
  }

  /* -------------------------------------------------------------- render */

  const text = doc?.text ?? ''
  const body = useMemo(() => (doc ? renderMarkdown(prepareMarkdown(doc.text)) : null), [doc])
  const words = useMemo(() => wordCount(text), [text])
  const minutes = Math.max(1, Math.round(words / 230))

  const reveal = (): void => {
    const api = readerApi()
    if (!api) return
    void api.revealFolder(path).then((r) => {
      if (!r.ok) app.setNotice(`Could not show the folder — ${r.error}`)
    })
  }

  const status = !editing ? null : saving ? 'Saving…' : dirty ? 'Not saved' : savedAt ? 'Saved' : 'No changes yet'

  return (
    <section className="rpage" aria-label={name} data-editing={editing ? 'true' : undefined}>
      <header className="rpage__head">
        <span className="rpage__titles">
          <span className="rpage__name truncate" title={path}>
            {name}
          </span>
          <span className="rpage__meta">
            <span className="rpage__folder truncate" title={dirName(path)}>
              {folderLabel(path, projectRoot, projectName)}
            </span>
            {doc ? (
              <>
                <span className="rpage__sep" aria-hidden="true">
                  ·
                </span>
                <span title={new Date(doc.mtimeMs).toLocaleString()}>Updated {timeAgo(doc.mtimeMs, now)}</span>
                {!editing ? (
                  <>
                    <span className="rpage__sep" aria-hidden="true">
                      ·
                    </span>
                    <span className="rpage__words">
                      {words.toLocaleString()} words · {minutes} min read
                    </span>
                  </>
                ) : null}
              </>
            ) : null}
          </span>
        </span>

        {updatedAt && !editing ? (
          <span className="rpage__updated" role="status">
            <Icon name="refresh" size={12} />
            Updated just now
          </span>
        ) : null}

        {editing ? (
          <span className="rpage__status" data-state={dirty ? 'dirty' : savedAt ? 'saved' : 'clean'} role="status">
            {dirty ? <span className="rpage__dot" aria-hidden="true" /> : savedAt ? <Icon name="check" size={12} /> : null}
            {status}
          </span>
        ) : null}

        <span className="rpage__acts">
          {editing ? (
            <>
              <button type="button" className="rbtn" onClick={stopEditing} title={dirty ? 'Back to reading — asks before dropping your changes' : 'Back to reading'}>
                {dirty ? 'Cancel' : 'Done'}
              </button>
              <button
                type="button"
                className="rbtn rbtn--go"
                onClick={() => void save()}
                disabled={saving || !dirty}
                title="Save to the file (Ctrl+S)"
              >
                <Icon name="check" size={12} />
                Save
              </button>
            </>
          ) : (
            <>
              <button type="button" className="rbtn" onClick={reveal} title="Show the file's folder in Explorer">
                <Icon name="folder" size={13} />
                Show in folder
              </button>
              <button type="button" className="rbtn rbtn--edit" onClick={startEdit} disabled={!doc} title="Edit the Markdown">
                <Icon name="pencil" size={13} />
                Edit
              </button>
            </>
          )}
        </span>
      </header>

      {editing && conflict ? (
        <div className="rbanner" data-kind="conflict" role="alert">
          <Icon name="refresh" size={14} />
          <span className="rbanner__text">
            <strong>{name} changed on disk</strong> since you started editing, so nothing was saved. Which version should the file keep?
          </span>
          <span className="rbanner__acts">
            <button type="button" className="rbtn rbtn--go" onClick={() => void save(conflict.hash)} disabled={saving}>
              Keep mine (save anyway)
            </button>
            <button type="button" className="rbtn" onClick={() => loadTheirs(conflict)}>
              Load the new version
            </button>
          </span>
        </div>
      ) : editing && diskDoc ? (
        <div className="rbanner" role="status">
          <Icon name="refresh" size={14} />
          <span className="rbanner__text">
            <strong>{name} changed on disk</strong> while you were editing. Your text is still here; Save will ask which version to keep.
          </span>
        </div>
      ) : null}

      {editing && draft ? (
        <div className="rpage__editwrap">
          <textarea
            className="redit reader__scroll"
            value={draft.text}
            spellCheck={false}
            aria-label={`Markdown of ${name}`}
            autoFocus
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          />
        </div>
      ) : (
        <div className="rpage__scroll reader__scroll" ref={scroll}>
          {error ? (
            <div className="rpage__error">
              <p className="rpage__errortitle">Could not open {name}</p>
              <p>{error}</p>
              <p className="rpage__errorhint">It may have been moved or deleted. Pick another file from the list.</p>
            </div>
          ) : body ? (
            <article key={path} className="rdoc" ref={article} onClick={onLink} onAuxClick={onLink}>
              {body}
            </article>
          ) : null}
        </div>
      )}

      {leaving ? (
        <div className="rprompt" role="alertdialog" aria-modal="true" aria-label="Unsaved changes">
          <div className="rprompt__card">
            <p className="rprompt__title">Unsaved changes in {name}</p>
            <p className="rprompt__body">
              {leaving === 'file' && reader.pending
                ? `Save them before you open ${baseName(reader.pending)}?`
                : 'Save them before you go back to reading?'}
            </p>
            <div className="rprompt__acts">
              <button type="button" className="rbtn" onClick={stay}>
                Keep editing
              </button>
              <button type="button" className="rbtn rbtn--quiet" onClick={proceed}>
                Discard
              </button>
              <button type="button" className="rbtn rbtn--go" onClick={() => void saveThenProceed()} disabled={saving} autoFocus>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
