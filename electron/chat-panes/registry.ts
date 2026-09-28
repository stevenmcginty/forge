/**
 * Where each chat pane's page is right now, by ChatLeaf id.
 *
 * One module-level map shared by the desktop view (which learns the URL as the
 * page navigates) and the Forge Web link (which asks for it), so neither has to
 * import the other. Not persisted: a chat reopens at its bot's `homeUrl`
 * (shared/chatbots.ts) until the page reports where it went.
 *
 * No Electron in it, like electron/layout-engine.ts, so a check can drive it.
 */

const urls = new Map<string, string>()

/** Record the page a chat pane is showing. */
export function setChatUrl(leafId: string, url: string): void {
  urls.set(leafId, url)
}

/** The page a chat pane is showing, or undefined before it has reported one. */
export function chatUrl(leafId: string): string | undefined {
  return urls.get(leafId)
}

/** Drop a chat pane that has closed. */
export function forgetChat(leafId: string): void {
  urls.delete(leafId)
}
