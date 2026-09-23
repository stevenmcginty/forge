import { BrowserLink } from '../browser-panes/link'

/**
 * The brain link: how a CLI brain's MCP server (bridge/brain-mcp.mjs) reaches
 * the host's Forge tools. It is the browser link's class — a named pipe, a
 * fresh random token per start, the token checked in constant time before the
 * op is read — with a link file of its own under the directory given
 * (`<data dir>\brain\link.json`), so the two never share a credential.
 *
 * Two ops, both answered as JSON in the reply's `text`:
 *   tools/list                → the host's `listLinkTools()`
 *   tools/call {name, args}   → the host's `callLinkTool(name, args)`, an MCP result
 *
 * No Electron import: electron/voice-agent/ipc.ts starts the real one, and
 * scripts/brain-adapters-check.mjs starts one against a host with a fake
 * renderer.
 */

export interface LinkToolHost {
  listLinkTools(): unknown
  callLinkTool(name: string, args: unknown): Promise<unknown>
}

export function createBrainLink(dir: string, host: () => LinkToolHost): BrowserLink {
  return new BrowserLink(dir, async (op, args) => {
    if (op === 'tools/list') return { ok: true, text: JSON.stringify(host().listLinkTools()) }
    if (op === 'tools/call') {
      const result = await host().callLinkTool(String(args['name'] ?? ''), args['args'] ?? {})
      return { ok: true, text: JSON.stringify(result) }
    }
    return { ok: false, text: `The brain link does not know "${op}".` }
  })
}
