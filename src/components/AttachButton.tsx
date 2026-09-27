import { useRef, type ReactNode } from 'react'
import { filePaths } from '@/lib/paths'
import { Icon } from './Icon'

/**
 * The paperclip on a pane's bar: pick files, and their paths go to the pane
 * exactly as a file dropped on it would. The dialog is the browser's own file
 * box; the preload turns each pick into its real path, so nothing is copied
 * or uploaded anywhere — the agent reads the file where it already sits.
 */
export function AttachButton({
  name,
  className,
  size,
  onPaths
}: {
  /** The pane's name, for the label. */
  name: string
  className: string
  size: number
  onPaths: (paths: string[]) => void
}): ReactNode {
  const inputRef = useRef<HTMLInputElement | null>(null)
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={`Attach a file to ${name}`}
        title="Attach a file — its path goes into this terminal"
        onClick={(e) => {
          e.stopPropagation()
          inputRef.current?.click()
        }}
      >
        <Icon name="paperclip" size={size} />
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(e) => {
          const paths = filePaths(e.currentTarget.files)
          // Cleared, so picking the same file twice still fires a change.
          e.currentTarget.value = ''
          if (paths.length > 0) onPaths(paths)
        }}
      />
    </>
  )
}
