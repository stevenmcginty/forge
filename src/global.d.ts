import type { ForgeApi } from '@shared/api'

declare global {
  interface Window {
    /** Injected by electron/preload.ts via contextBridge. */
    forge: ForgeApi
  }
}

export {}
