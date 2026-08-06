import type { ReactNode } from 'react'
import type { GitFileChange, GitSnapshot } from '@shared/types'
import { changeLetter, changeTone, fileName, groupChanges } from '@/lib/gitview'
import { PATH_DRAG_TYPE } from '@/lib/mosaicLayout'

/**
 * What has changed, folded into folders.
 *
 * Folders rather than a full tree: at rail width, "the folder, then its files"
 * is readable and three levels of indent are not, and the list is nearly always
 * short enough that deeper structure would be ceremony rather than help.
 *
 * **Every row is draggable, and that is the point of the list.** This is not a
 * report to read — it is where you pick a file up and hand it to an agent. A row
 * dropped on a pane arrives as its quoted absolute path, exactly as a file
 * dragged out of Explorer does, because handing a file to an agent should be the
 * same gesture wherever you picked it up from. See PATH_DRAG_TYPE for why it
 * cannot travel as a real file.
 */
export function GitChangesList({ snap }: { snap: GitSnapshot }): ReactNode {
  const groups = groupChanges(snap.files)
  const hidden = snap.changed - snap.files.length

  return (
    <div className="gchg">
      {groups.map((group) => (
        <div className="gchg__group" key={group.dir || '.'}>
          <div className="gchg__dir mono truncate" title={group.dir || 'the repository root'}>
            {group.dir || './'}
          </div>
          {group.files.map((file) => (
            <ChangeRow key={file.path} file={file} />
          ))}
        </div>
      ))}

      {/*
        The counts on the snapshot are taken before the list is cut, so this can
        say how many are missing rather than quietly showing five hundred and
        calling it everything.
      */}
      {hidden > 0 ? <div className="gchg__cut">and {hidden} more not shown</div> : null}
    </div>
  )
}

function ChangeRow({ file }: { file: GitFileChange }): ReactNode {
  const letter = changeLetter(file.xy)
  const name = fileName(file.path)

  return (
    <div
      className="gfrow"
      data-tone={changeTone(letter)}
      data-conflicted={file.conflicted ? 'true' : undefined}
      title={`${file.absPath}${file.from ? `\nrenamed from ${file.from}` : ''}\n\nDrag onto a pane to hand it over`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PATH_DRAG_TYPE, file.absPath)
        // text/plain as well, so dropping the row into an editor, a chat or the
        // address bar of anything else on the machine still says something useful.
        e.dataTransfer.setData('text/plain', file.absPath)
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <span className="gfrow__letter mono">{letter}</span>
      <span className="gfrow__name truncate">{name}</span>
      {file.submodule ? <span className="gfrow__tag eyebrow">sub</span> : null}
    </div>
  )
}
