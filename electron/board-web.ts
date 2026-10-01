import { open } from 'node:fs/promises'
import type { CanvasItem } from '@shared/hub'
import type { BoardFileHandle, BoardItemSummary, BoardMirrorHost } from '@shared/board-mirror'
import { safeId } from './hub-store'
import { canvasBoard, onCanvasChange } from './hub-ipc'

/**
 * The desktop's Board for Forge Web (shared/board-mirror.ts): one project's
 * item list, told again on every change, and an item's file read in pieces.
 *
 * Read-only, and a reader of the Board rather than a second Board: the list is
 * electron/canvas-board.ts's own (`peek`, which leaves the Board's diff
 * baseline alone), and the change signal is the one the windows get. A file is
 * only ever found by looking `name` up in that list — never joined onto a
 * path — so nothing outside the project's canvas folder can be asked for.
 */

function summary(item: CanvasItem): BoardItemSummary {
  return {
    name: item.name,
    title: item.title,
    kind: item.kind,
    mime: item.mime,
    bytes: item.bytes,
    mtime: item.mtime,
    order: item.order
  }
}

function itemsOf(project: string): CanvasItem[] {
  try {
    return canvasBoard().peek(project).items
  } catch (err) {
    console.error('[board-web] could not list the board:', err)
    return []
  }
}

function boardMirrorHost(): BoardMirrorHost {
  return {
    items(project) {
      return itemsOf(project).map(summary)
    },

    onItems(project, listener) {
      // Board changes name the project by its folder (safeId), as does the board.
      const key = safeId(project)
      return onCanvasChange((change) => {
        if (change.projectId === key) listener(change.snapshot.items.map(summary))
      })
    },

    async open(project, name): Promise<BoardFileHandle | null> {
      const item = itemsOf(project).find((i) => i.name === name)
      if (!item) return null
      const handle = await open(item.path, 'r')
      try {
        const total = (await handle.stat()).size
        return {
          mime: item.mime,
          total,
          async read(offset, length) {
            const buf = Buffer.alloc(length)
            const { bytesRead } = await handle.read(buf, 0, length, offset)
            return buf.subarray(0, bytesRead)
          },
          close() {
            handle.close().catch(() => {
              /* already closed */
            })
          }
        }
      } catch (err) {
        await handle.close().catch(() => {})
        throw err
      }
    }
  }
}

let shared: BoardMirrorHost | null = null

/** The one host Forge Web (electron/web-host.ts) is handed. */
export function sharedBoardMirrorHost(): BoardMirrorHost {
  shared ??= boardMirrorHost()
  return shared
}
