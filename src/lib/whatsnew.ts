import generated from '../generated/whats-new.json'
import { isEmptyNotes, type WhatsNew } from '@shared/whatsnew'

/**
 * The release notes this build carries.
 *
 * A static import, so the notes are *in the bundle* rather than fetched: the card
 * opens on the first launch after an update, which is the one moment a laptop is
 * as likely as not to be on a train. No network, no HTML to sanitise, no second
 * copy of the text that could describe a different release than the GitHub page
 * does — scripts/whats-new.mjs writes this file and the release body in the same
 * run.
 *
 * The file is generated (and gitignored): `predev` and the start of `build` both
 * run the generator, so it is always there, and in a checkout it describes the
 * unreleased work since the last tag.
 */
const notes = generated as WhatsNew

/** The notes, or null when there is genuinely nothing to say about this build. */
export function whatsNew(): WhatsNew | null {
  if (isEmptyNotes(notes)) return null
  return notes
}

/**
 * Should the card open by itself?
 *
 * Only when the running version is not the one already seen — which makes it a
 * one-time card per release rather than a banner — and only when there is
 * something in it. A "what's new" card with nothing new in it is the worst
 * possible version of this feature.
 */
export function shouldOpenWhatsNew(version: string, lastSeen: string): boolean {
  if (!version) return false
  if (version === lastSeen) return false
  return !isEmptyNotes(notes)
}
