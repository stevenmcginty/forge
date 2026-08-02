import { useEffect, useRef, useState, type ReactNode } from 'react'
import { shortPath } from '@/lib/paths'
import { useApp } from '@/state/AppState'
import { Popover, PopoverSection } from './Popover'
import './AddProjectMenu.css'

export interface AddProjectMenuProps {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
}

/** The `parentDir` keys the main process' allow-list understands. */
type ParentKey = 'desktop' | 'documents' | 'projectsroot'

/**
 * The "make a brand-new project folder from a name" form. The + next to it is
 * the way into an existing folder; this menu is the way into a new one, so it
 * does not repeat the picker.
 *
 * Creating goes through the same fenced handler as the voice agent's
 * `create_project` (electron/main.ts → `dialog:make-project-folder`): the name
 * is sanitised, Windows' reserved names are refused, and an existing folder is
 * never silently adopted — so a duplicate comes back here as an error carrying
 * the folder's path, and the only thing left to do is open it. A dialog choice
 * is an explicit human act, but the folder itself is still only ever created
 * inside Desktop, Documents or the Settings projects root.
 */
export function AddProjectMenu({ anchor, open, onClose }: AddProjectMenuProps): ReactNode {
  const { state, actions } = useApp()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [name, setName] = useState('')
  const [parentDir, setParentDir] = useState<ParentKey>('desktop')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; path?: string } | null>(null)

  const projectsRoot = state.settings.projectsRoot?.trim() ?? ''
  const hasProjectsRoot = projectsRoot.length > 0

  // A fresh menu every time it opens: blank name, the default location, no
  // stale error, and the cursor already sitting in the name box.
  useEffect(() => {
    if (!open) return
    setName('')
    setParentDir(hasProjectsRoot ? 'projectsroot' : 'desktop')
    setError(null)
    setBusy(false)
    const t = setTimeout(() => inputRef.current?.select(), 0)
    return () => clearTimeout(t)
  }, [open, hasProjectsRoot])

  const create = async (): Promise<void> => {
    const next = name.trim()
    if (!next || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.forge.makeProjectFolder({ name: next, parentDir })
      if (!res.ok) {
        setError({ message: res.error, path: res.path })
        return
      }
      actions.addProjectPath(res.path, res.name)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const openExisting = (): void => {
    if (!error?.path) return
    actions.addProjectPath(error.path)
    onClose()
  }

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="start" width={288} label="Add project">
      <PopoverSection title="New project">
        <div className="field">
          <label className="field__label" htmlFor="apm-name">
            Name
          </label>
          <input
            id="apm-name"
            ref={inputRef}
            className="field__input"
            value={name}
            spellCheck={false}
            disabled={busy}
            placeholder="my-project"
            onChange={(e) => {
              setName(e.target.value)
              if (error) setError(null)
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') void create()
            }}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="apm-parent">
            Create in
          </label>
          <select
            id="apm-parent"
            className="field__input"
            value={parentDir}
            disabled={busy}
            onChange={(e) => setParentDir(e.target.value as ParentKey)}
          >
            <option value="desktop">Desktop</option>
            <option value="documents">Documents</option>
            {hasProjectsRoot ? (
              <option value="projectsroot" title={projectsRoot}>
                Projects — {shortPath(projectsRoot, 2)}
              </option>
            ) : null}
          </select>
        </div>

        <div className="popover__hint">An empty folder, added straight to the rail.</div>

        <div className="popover__actions">
          <button type="button" className="ghost-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="cta-btn" disabled={!name.trim() || busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>

        {error ? (
          <div className="apm__error">
            <span className="apm__error-text">{error.message}</span>
            {error.path ? (
              <button type="button" className="ghost-btn" onClick={openExisting}>
                Open it instead
              </button>
            ) : null}
          </div>
        ) : null}
      </PopoverSection>
    </Popover>
  )
}
