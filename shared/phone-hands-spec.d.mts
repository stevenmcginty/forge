/** Types for ./phone-hands-spec.mjs — see that file. */

export type PhoneOp =
  | 'status'
  | 'look'
  | 'read'
  | 'tap'
  | 'type'
  | 'scroll'
  | 'key'
  | 'open_app'
  | 'open_link'
  | 'apps'
  | 'notifications'
  | 'reply'
  | 'find_contact'

export interface PhoneParamSpec {
  type: 'string' | 'number' | 'integer' | 'boolean'
  description: string
  enum?: string[]
}

export interface PhoneToolSpec {
  name: string
  op: PhoneOp
  description: string
  params: Record<string, PhoneParamSpec>
  required: string[]
}

export const PHONE_OPS: readonly PhoneOp[]
export const PHONE_TIMEOUT_MS: number
export const PHONE_NOT_CONNECTED: string
export const PHONE_TIMED_OUT: string
export const PHONE_CONFIRM_RULE: string
export const PHONE_RECIPE_GENERAL: string
export const PHONE_EXAMPLE_UBER: string
export const PHONE_EXAMPLE_WHATSAPP: string
export const PHONE_INSTRUCTION_LINE: string
export const PHONE_TOOL_SPECS: readonly PhoneToolSpec[]
export const PHONE_PAIR_WORDS: string
export const PHONE_PAIR_LAN_NOTE: string
export const PHONE_PAIR_OFF: string
export const PHONE_SETUP_RULE: string
/** phone_pair: runs on the PC, so it has no contract op. */
export const PHONE_PAIR_SPEC: Omit<PhoneToolSpec, 'op'>
