import { useMemo, useState, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { useRepo } from '../lib/repo'
import type { TreeEntry } from '../lib/github'

/**
 * The repository, as folders.
 *
 * GitHub answers `git/trees?recursive=1` with a flat list of blob paths, which
 * is one request instead of one per directory — the right trade when this mode
 * exists precisely because the network is the only thing there is. The shape a
 * person expects is a tree, so it is built here, from the paths, once.
 *
 * Folders start closed and open on click. That is not a default copied from
 * somewhere: this repository is thousands of files, and a tree that painted all
 * of them would be several seconds of layout before anything was readable, on
 * the connection this mode assumes.
 *
 * A file with an uncommitted edit wears a dot, in the same place and the same
 * accent the desktop's git panel marks a changed file. Nothing that is only in
 * this browser is allowed to look like something that is on GitHub.
 */

interface Folder {
  name: string
  path: string
  folders: Folder[]
  files: Array<{ name: string; path: string; size: number }>
}

export function FileTree(): ReactNode {
  const { state, actions } = useRepo()
  const root = useMemo(() => buildTree(state.tree), [state.tree])
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set())
  const drafted = useMemo(() => new Set(state.drafts.map((d) => d.path)), [state.drafts])

  const toggle = (path: string): void => {
    setOpenFolders((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (state.tree.length === 0) {
    return (
      <p className="ghtree__empty">
        {state.stage.kind === 'reading' ? 'Reading the tree from GitHub…' : 'That ref has no files in it.'}
      </p>
    )
  }

  return (
    <div className="ghtree" data-testid="github-tree">
      {state.truncated ? (
        <p className="ghtree__cut">
          GitHub cut this listing at its ceiling, so the tail of the repository is not below. The files that are shown
          are real; the ones missing are missing from the listing, not from the repository.
        </p>
      ) : null}
      <Level
        folder={root}
        depth={0}
        openFolders={openFolders}
        onToggle={toggle}
        drafted={drafted}
        activePath={state.open?.path ?? ''}
        onOpen={actions.openFile}
      />
    </div>
  )
}

function Level({
  folder,
  depth,
  openFolders,
  onToggle,
  drafted,
  activePath,
  onOpen
}: {
  folder: Folder
  depth: number
  openFolders: Set<string>
  onToggle: (path: string) => void
  drafted: Set<string>
  activePath: string
  onOpen: (path: string) => void
}): ReactNode {
  return (
    <>
      {folder.folders.map((child) => {
        const open = openFolders.has(child.path)
        return (
          <div key={child.path}>
            <button
              type="button"
              className="ghrow"
              data-kind="folder"
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              aria-expanded={open}
              onClick={() => onToggle(child.path)}
            >
              <span className="ghrow__chev">
                <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
              </span>
              <Icon name="folder" size={12} />
              <span className="ghrow__name truncate">{child.name}</span>
            </button>
            {open ? (
              <Level
                folder={child}
                depth={depth + 1}
                openFolders={openFolders}
                onToggle={onToggle}
                drafted={drafted}
                activePath={activePath}
                onOpen={onOpen}
              />
            ) : null}
          </div>
        )
      })}

      {folder.files.map((file) => (
        <button
          key={file.path}
          type="button"
          className="ghrow"
          data-kind="file"
          data-active={file.path === activePath ? 'true' : undefined}
          data-drafted={drafted.has(file.path) ? 'true' : undefined}
          style={{ paddingLeft: `${8 + depth * 12 + 13}px` }}
          title={file.path}
          onClick={() => onOpen(file.path)}
        >
          <Icon name="file" size={12} />
          <span className="ghrow__name truncate">{file.name}</span>
          {drafted.has(file.path) ? <span className="ghrow__dot" title="Edited here, not yet committed" /> : null}
        </button>
      ))}
    </>
  )
}

/** Flat blob paths into folders. Directories exist only where a blob implies one. */
function buildTree(entries: TreeEntry[]): Folder {
  const root: Folder = { name: '', path: '', folders: [], files: [] }
  for (const entry of entries) {
    const parts = entry.path.split('/')
    let here = root
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let next = here.folders.find((f) => f.path === path)
      if (!next) {
        next = { name: parts[i], path, folders: [], files: [] }
        here.folders.push(next)
      }
      here = next
    }
    here.files.push({ name: parts[parts.length - 1], path: entry.path, size: entry.size })
  }
  return root
}
