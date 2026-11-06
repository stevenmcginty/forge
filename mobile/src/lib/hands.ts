import { registerPlugin } from '@capacitor/core'

/**
 * The web bridge onto the native phone-hands layer (mobile/native/
 * ForgeHandsPlugin.kt). The settings card reads status and flips the master
 * switch through this; every op the *desk* drives goes over the socket, never
 * through here.
 *
 * Every method answers with the fresh status, so the card re-renders off one
 * round trip whether the user flipped the switch, granted a permission, or
 * came back from a Settings screen.
 */
export interface HandsStatus {
  /** The accessibility service is granted and bound. */
  accessibility: boolean
  /** Notification access (the listener) is granted. */
  notifications: boolean
  /** READ_CONTACTS is granted. */
  contacts: boolean
  /** The master switch, stored natively. */
  enabled: boolean
  screenOn: boolean
  locked: boolean
  /** Foreground package, or '' when unknown. */
  app: string
  /** The APK's versionName. */
  version: string
  /** POST_NOTIFICATIONS runtime permission (true below Android 13). */
  postNotifications: boolean
  /** Battery optimisations are off for Forge. */
  batteryUnrestricted: boolean
  /** The hands socket has a live, hello-acked link to the desk. */
  linked: boolean
  /** The paired desktop's name, or ''. */
  desktopName: string
  /** A device token is stored, so the phone has been paired at least once. */
  paired: boolean
}

export interface ForgeHandsPlugin {
  getStatus(): Promise<HandsStatus>
  setEnabled(options: { on: boolean }): Promise<HandsStatus>
  syncIdentity(options: { id: string; name: string }): Promise<void>
  openAccessibilitySettings(): Promise<void>
  openNotificationAccess(): Promise<void>
  openAppInfo(): Promise<void>
  requestIgnoreBattery(): Promise<HandsStatus>
  requestContacts(): Promise<HandsStatus>
  requestNotifications(): Promise<HandsStatus>
}

export const ForgeHands = registerPlugin<ForgeHandsPlugin>('ForgeHands')
