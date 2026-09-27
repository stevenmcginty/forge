/**
 * What the UI calls a state. `muted` and `offline` are not phases of their
 * own in the engine — muted is a flag over any live phase, offline is `off` —
 * but to the eye they are states, so they get their own word and glyph.
 *
 * Kept in a file of its own, with no imports, so a leaf component (the
 * SynthesizerIndicator, Forge Web's phone Listen) can name a look without
 * pulling hubView's controller — and the whole desktop renderer — in behind it.
 */
export type HubLook = 'offline' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'error'
