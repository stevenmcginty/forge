import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { SHARE_MAX_BYTES } from '@shared/share'
import type { ShareSlot, ShareSlotBody, ShareWriteResult } from '@shared/types'
import { bytesLabel, slotMeta, slotRelPath, slotTooltip } from '@/lib/shareview'
import { Icon } from '../Icon'

/**
 * One slot, as a row — and, in the panel, as the thing the row opens into.
 *
 * The row is one line on purpose. Five of them plus a foot is the whole section,
 * which is what lets it live in 240px of rail next to four others; the body, the
 * author and the provenance are all one click or one hover away rather than
 * competing for that line.
 */
export function ShareSlotRow({
  slot,
  selected,
  busy,
  onOpen,
  onMenu
}: {
  slot: ShareSlot
  selected: boolean
  busy: boolean
  onOpen: () => void
  onMenu: (anchor: HTMLButtonElement) => void
}): ReactNode {
  const meta = slotMeta(slot)
  const moreRef = useRef<HTMLButtonElement | null>(null)

  return (
    <div
      className="shrow"
      data-filled={slot.filled ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      data-problem={slot.problem ? 'true' : undefined}
    >
      <button type="button" className="shrow__open" title={slotTooltip(slot)} disabled={busy} onClick={onOpen}>
        <span className="shrow__idx mono">{slot.index}</span>
        <span className="shrow__title truncate">{slot.filled ? slot.title : 'empty'}</span>
        {slot.truncated ? (
          <span className="shrow__chip" title={`Longer than ${bytesLabel(SHARE_MAX_BYTES)} — the end was dropped`}>
            cut
          </span>
        ) : null}
        <span className="shrow__meta mono">{meta}</span>
      </button>

      <button
        ref={moreRef}
        type="button"
        className="ghost-btn shrow__more"
        title={`What to do with slot ${slot.index}`}
        onClick={() => moreRef.current && onMenu(moreRef.current)}
      >
        <Icon name="dots" size={13} />
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------- detail */

/**
 * A slot, open.
 *
 * **Read-only until you say otherwise**, which is the one rule here worth the
 * words. Another pane may be part-way through writing this file; a textarea that
 * opened focused and ready would make the person the loser of a race they were
 * not told they had entered. So reading is the default, editing is a button, and
 * saving carries the `updatedAt` the draft was started from so main can refuse
 * rather than clobber.
 *
 * There is no autosave, for the same reason: a file three agents read is not a
 * place to publish half-typed sentences.
 */
export function ShareSlotDetail({
  slot,
  read,
  write,
  busy,
  onClose
}: {
  slot: ShareSlot
  read: (index: number) => Promise<ShareSlotBody | null>
  write: (req: { index: number; title: string; body: string; expectUpdatedAt?: number }) => Promise<ShareWriteResult>
  busy: boolean
  onClose: () => void
}): ReactNode {
  const [loaded, setLoaded] = useState<ShareSlotBody | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [title, setTitle] = useState('')
  const [conflict, setConflict] = useState<string | null>(null)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)

  /*
   * Re-read whenever the slot changes *or* the file does — `updatedAt` moving is
   * how this hears that somebody else wrote it. A draft in progress is left
   * exactly as it is: pulling the rug out from under a half-written sentence
   * because another pane saved is the behaviour the conflict guard exists to
   * replace, not to add to.
   */
  useEffect(() => {
    let alive = true
    setLoading(true)
    void read(slot.index).then((body) => {
      if (!alive) return
      setLoaded(body)
      setLoading(false)
      if (!editing) {
        setDraft(body?.body ?? '')
        setTitle(body?.title ?? (slot.filled ? slot.title : ''))
      }
    })
    return () => {
      alive = false
    }
  }, [slot.index, slot.updatedAt])

  const startEditing = (): void => {
    setConflict(null)
    setDraft(loaded?.body ?? '')
    setTitle(loaded?.title ?? '')
    setEditing(true)
    // One frame, so the textarea exists before it is asked for focus.
    requestAnimationFrame(() => areaRef.current?.focus())
  }

  const save = async (force = false): Promise<void> => {
    const result = await write({
      index: slot.index,
      title,
      body: draft,
      ...(force || loaded === null ? {} : { expectUpdatedAt: loaded.updatedAt })
    })
    if (result.conflict) {
      setConflict(result.error ?? 'Somebody else changed this slot while you were writing.')
      return
    }
    if (result.ok) {
      setConflict(null)
      setEditing(false)
    }
  }

  const reload = (): void => {
    setConflict(null)
    setEditing(false)
    void read(slot.index).then((body) => {
      setLoaded(body)
      setDraft(body?.body ?? '')
      setTitle(body?.title ?? '')
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void save()
      return
    }
    if (e.key === 'Escape') {
      // Escape belongs to the panel, which closes on it. While there are unsaved
      // words in here it belongs to the draft instead, and it asks first.
      e.stopPropagation()
      if (draft !== (loaded?.body ?? '') && !window.confirm('Discard what you have written in this slot?')) return
      setEditing(false)
      setDraft(loaded?.body ?? '')
    }
  }

  return (
    <div className="shdet" data-editing={editing ? 'true' : undefined}>
      <div className="shdet__head">
        {editing ? (
          <input
            className="shdet__title"
            value={title}
            placeholder={`Slot ${slot.index}`}
            aria-label="Slot title"
            onChange={(e) => setTitle(e.target.value)}
          />
        ) : (
          <span className="shdet__name truncate">{loaded?.title ?? `Slot ${slot.index}`}</span>
        )}
        <span className="shdet__path mono" title="Every agent in this project can read this file">
          {slotRelPath(slot.index)}
        </span>

        <div className="shdet__actions">
          {editing ? (
            <>
              <button type="button" className="cta-btn shdet__save" disabled={busy} onClick={() => void save()}>
                Save
              </button>
              <button type="button" className="ghost-btn" title="Stop editing" onClick={() => setEditing(false)}>
                <Icon name="close" size={13} />
              </button>
            </>
          ) : (
            <>
              <button type="button" className="ghost-btn shdet__edit" disabled={busy} onClick={startEditing}>
                Edit
              </button>
              <button type="button" className="ghost-btn" title="Close this slot" onClick={onClose}>
                <Icon name="chevronDown" size={13} />
              </button>
            </>
          )}
        </div>
      </div>

      {/*
        The refusal, with both ways out. "Overwrite anyway" is offered rather than
        hidden: sometimes the other pane wrote nonsense and you know it, and a tool
        that will not let you win an argument with a machine is a tool you work
        around.
      */}
      {conflict ? (
        <div className="shdet__conflict">
          <span>{conflict}</span>
          <button type="button" className="ghost-btn" onClick={reload}>
            Reload
          </button>
          <button type="button" className="ghost-btn shdet__force" onClick={() => void save(true)}>
            Overwrite anyway
          </button>
        </div>
      ) : null}

      {loading ? (
        <p className="shdet__quiet">Reading…</p>
      ) : editing ? (
        <textarea
          ref={areaRef}
          className="shdet__area mono"
          value={draft}
          spellCheck={false}
          placeholder="Anything an agent in another pane should be able to read. Markdown."
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : loaded?.body.trim() ? (
        <pre className="shdet__body mono">{loaded.body}</pre>
      ) : (
        <p className="shdet__quiet">
          Nothing in this slot yet.{' '}
          <button type="button" className="shdet__link" onClick={startEditing}>
            Write something
          </button>{' '}
          — or tell an agent to put it in <span className="mono">{slotRelPath(slot.index)}</span>.
        </p>
      )}

      {editing ? (
        <p className="shdet__quiet shdet__foot">
          Ctrl+Enter saves. Nothing is written until you do — and nothing is submitted to any agent.
        </p>
      ) : null}
    </div>
  )
}
