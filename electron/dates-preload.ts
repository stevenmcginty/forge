import type { IpcRenderer, IpcRendererEvent } from 'electron'
import { DATES_IPC, type DateItem, type DateNotice, type DatesApi, type DatesWeeklyView } from '@shared/dates'

/**
 * `window.forgeDates`, built from the preload's ipcRenderer. A separate global
 * like `window.forgeHub`, so Dates needs no change to ForgeApi; the renderer
 * reaches it only through src/lib/datesApi.ts, which treats it as optional.
 */
export function datesPreloadApi(ipc: IpcRenderer): DatesApi {
  const on = <A extends unknown[]>(channel: string, cb: (...args: A) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
    ipc.on(channel, listener)
    return () => {
      ipc.removeListener(channel, listener)
    }
  }
  return {
    list: () => ipc.invoke(DATES_IPC.list),
    add: (input) => ipc.invoke(DATES_IPC.add, input),
    update: (id, patch) => ipc.invoke(DATES_IPC.update, id, patch),
    complete: (id) => ipc.invoke(DATES_IPC.complete, id),
    snooze: (id, until) => ipc.invoke(DATES_IPC.snooze, id, until),
    remove: (id) => ipc.invoke(DATES_IPC.remove, id),
    onChange: (cb) => on<[DateItem[]]>(DATES_IPC.changed, cb),
    onOpen: (cb) => on<[]>(DATES_IPC.open, () => cb()),
    onAlert: (cb) => on<[DateNotice]>(DATES_IPC.alert, cb),
    weekly: {
      get: () => ipc.invoke(DATES_IPC.weeklyGet),
      set: (patch) => ipc.invoke(DATES_IPC.weeklySet, patch),
      runNow: () => ipc.invoke(DATES_IPC.weeklyRun),
      onChange: (cb) => on<[DatesWeeklyView]>(DATES_IPC.weeklyChanged, cb)
    },
    tool: (name, args) => ipc.invoke(DATES_IPC.tool, name, args)
  }
}
