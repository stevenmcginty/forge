# forge-bridge — the cross-agent bridge

An MCP server that Forge ships and registers into every **Claude Code** pane, so
Claude can do things it otherwise cannot: watch a video, generate and edit real
images, and get a second opinion from a different model family.

`bridge/gemini-bridge.mjs` is a plain Node script speaking MCP over stdio, with
no dependencies beyond the MCP SDK and no state of its own. `ask_gemini` and
`summarize_video` shell out to the `gemini` binary on PATH; `make_image` and
`edit_image` call Google's REST API directly, because the CLI has no image tool
at all.

---

## Auth model

Two halves, because the tools do two different things.

**`ask_gemini` and `summarize_video` shell out to the Gemini CLI.** The CLI
authenticates with whatever login *it* already holds in `%USERPROFILE%\.gemini`.
Signing in is a one-off, manual, browser-based step that Forge deliberately does
not automate:

```pwsh
gemini          # opens a browser, sign in with your Google account, then quit
```

Until that is done, both tools return a readable error telling Claude to ask the
user to run it. Nothing hangs and nothing is faked. If a `GEMINI_API_KEY` is in
the bridge's environment it is passed straight through to the CLI, which is
enough to make these two work with no browser login at all.

Install the CLI itself with:

```pwsh
npm install -g @google/gemini-cli
```

**`make_image` and `edit_image` call Google's REST API directly** and need
`GEMINI_API_KEY` in the environment. Forge writes it into the `env` block of the
`mcp.json` it generates (see *How Forge registers it* below) from the same
Gemini key the voice agent uses. That generated file, under
`%APPDATA%\Forge\bridge\`, and `settings.json` beside it are the only two places
Forge ever puts a key; nothing is written into this repo or the packaged app.
Pasting a new key in settings rewrites the config immediately, though a pane has
to be reopened to pick it up — Claude reads the config once, at launch.

With no key the two tools return a specific, actionable error naming exactly
where to set one. They never fall back to the CLI and never invent a path.

---

## Tools

### `ask_gemini(prompt, files?)`

General query. Runs `gemini -p "<prompt>" -o text`.

`files` takes absolute paths to files or directories. They are appended to the
prompt as Gemini `@path` references — the CLI's own file-inlining syntax — and
each containing directory is passed via `--include-directories` so the CLI is
allowed to read it. Paths that do not exist are reported back rather than
silently dropped.

Use it for a genuine second opinion, Google-flavoured knowledge, or an
independent review of a design or diagnosis.

### `summarize_video(url_or_path, focus?)`

Builds a structured-summary prompt and sends it to Gemini, which ingests
YouTube URLs natively. Local video files are passed as an `@path` reference;
whether they can be uploaded depends on the signed-in account's limits, so URLs
are the reliable path.

Returns Markdown with fixed sections — **Gist**, **Timeline** (beats with
timestamps), **Key points**, **Actionable**. If Gemini replies with an apology
instead of a summary (private, age-gated, region-locked or oversized video), the
tool detects that and returns an error rather than passing the apology off as a
summary.

### `make_image(description, out_dir?, count?, aspect?)`

Really generates an image and returns the absolute path it was saved to. Default
output directory is `%APPDATA%\Forge\bridge-out\` (overridden by the
`FORGE_BRIDGE_OUT` environment variable, which Forge sets).

`count` is 1–4 and `aspect` is one of `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9
21:9`. Both are validated before anything is spent.

**Why not the CLI:** the Gemini CLI **has no image-generation tool at all.**
Verified against v0.53.0 — its tool registry has none, and its own README points
at an external MCP server
([`mcp-genmedia`](https://github.com/GoogleCloudPlatform/vertex-ai-creative-studio/tree/main/experiments/mcp-genmedia))
for media. The `generateImage` symbols inside the CLI bundle belong to the
bundled `@google/genai` SDK and are not reachable as a user tool. So this tool
skips the CLI entirely and POSTs to
`generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` with
`responseModalities: ['IMAGE']`, which returns the bytes inline.

**Model.** `gemini-2.5-flash-image` by default — stable, public, and the one
that returns **PNG** at 1024², about 5–6 s per image. Override with
`FORGE_GEMINI_IMAGE_MODEL` (Forge sets it from the `geminiImageModel` setting
when that is non-empty). `gemini-3.1-flash-image` and `gemini-3-pro-image` also
work but return **JPEG** — the saved file's extension always follows the mime
type the API actually sends, so nothing is ever mislabelled.

Two API facts worth knowing, both verified live rather than assumed:

- `candidateCount: 2` is refused (*"Multiple candidates is not enabled for this
  model"*), so `count` is N separate requests — 4 images take roughly 4× as long,
  and a partial result is reported as a partial result.
- `responseMimeType` cannot be used to ask for PNG; the API only accepts text
  mime types there.

Every failure mode is a different, specific message: no key, quota exhausted
(429/`RESOURCE_EXHAUSTED`), key refused (401/403/`API_KEY_INVALID`), model not
available to this key (404), prompt blocked, and the common one — a refusal,
which arrives as HTTP 200 with `finishReason: NO_IMAGE` and no parts at all.
Files are written tmp-then-renamed, and a path is only ever returned after the
bytes are on disk. It never fabricates a path.

### `edit_image(path, instruction, out_dir?)`

Image + plain-English instruction → a **new** file. The input is read, never
modified. Same model, same key, same errors.

Accepts `.png .jpg .jpeg .webp .gif .bmp .heic .heif` under 20 MB (the inline
`generateContent` ceiling); anything else is refused before the call. The result
is named `<original stem>-edited-<timestamp>.<ext>`.

### Video

**Not built, deliberately.** Google's Veo models *are* reachable with a Gemini
API key — `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview` and
`veo-3.1-lite-generate-preview` all appear in `/v1beta/models`, and a live
`:predictLongRunning` submission with Steve's key returned an operation that
completed with a downloadable video. But it is a *different shape*: submit, poll
an operation, then download a file from a second URL, rather than the single
inline call both image tools use. Building that properly is its own job, so no
half-tool ships here. `summarize_video` can still *watch* a video.

---

## Behaviour common to every tool

| Concern | Behaviour |
| --- | --- |
| Timeout | 120 s — the CLI child is killed, or the fetch is aborted |
| stderr | Captured and tailed (last 1200 chars) into the error text |
| CLI missing | Error naming the `npm install -g @google/gemini-cli` fix |
| Signed out | Error naming the `gemini` sign-in step |
| Bad arguments | Returned as a tool error, so the agent can correct itself |
| Shell | Never used — prompts are passed as a literal argv entry, so quotes, backticks and newlines cannot be reinterpreted |

Exit codes are read from the CLI's own table (v0.53): `41` authentication,
`42` input, `52` config, `130` cancellation. The signed-out state is detected by
exit code *and* by stderr text, so neither alone has to be reliable.

### Windows note

Node has refused to `spawn` a `.cmd` file without `shell: true` since the 2024
argument-injection fix, and npm installs the CLI as `gemini.cmd`. Turning the
shell on would reintroduce quoting bugs for prompts full of quotes and newlines,
so the bridge instead reads the npm shim, extracts the real `gemini.js` path it
points at, and runs that under Node directly. Set `FORGE_GEMINI_JS` to an
absolute path to override the resolution.

---

## How Forge registers it

On app start (`electron/bridge/mcp-config.ts`) Forge writes
`%APPDATA%\Forge\bridge\mcp.json` with absolute paths:

```json
{
  "mcpServers": {
    "forge-bridge": {
      "command": "node",
      "args": ["<abs>/bridge/gemini-bridge.mjs"],
      "env": {
        "FORGE_BRIDGE_OUT": "<abs>/bridge-out",
        "GEMINI_API_KEY": "<the key from settings, omitted when unset>",
        "FORGE_GEMINI_IMAGE_MODEL": "<only when overridden in settings>"
      }
    }
  }
}
```

It is rewritten every start because the absolute path changes when Forge is
moved, reinstalled or run from another checkout, and a stale path would fail
silently inside Claude.

Any agent profile flagged `mcpBridge: true` — the **Claude Code** built-in —
then gets `--mcp-config "<that file>"` appended to its bootstrap command as it
passes through the PTY host. `--strict-mcp-config` is deliberately **not** used:
that would hide your own global MCP servers from every Forge pane.

To opt a profile out, set `"mcpBridge": false` on it in
`%APPDATA%\Forge\settings.json`.

---

## Testing

```pwsh
npm run bridge:smoke        # MCP protocol + graceful degradation  (89 checks)
npm run bridge:smoke -- --live-image       # + a real image generated and edited (92)
npm run bridge:register     # config generation + claude accepts it (17 checks)
npm run bridge:register -- --live-claude   # + a real headless Claude run (20)
node scripts/bridge-smoke.mjs --force-absent   # only the not-installed path
```

### `scripts/bridge-smoke.mjs`

Speaks the MCP wire protocol by hand (no SDK client, so a broken server cannot
make a broken test pass): `initialize` → `tools/list` → `tools/call`.

1. **CLI hidden and no key** — every tool must return an actionable error, and
   `make_image`/`edit_image` must name the *key* fix rather than the CLI one.
   Argument validation (`count`, `aspect`, missing fields) is asserted here too,
   because it has to happen before anything is spent.
2. **Real CLI, still no key** — asserts `make_image` refuses without ever
   reaching the CLI, and does a live `ask_gemini` round trip (printing the CLI's
   exact message when signed out).
3. **Drift guard** — reads both `gemini-bridge.mjs` and
   `electron/gemini-media.ts` and asserts the duplicated constants still agree:
   the default model, the aspect list, the count and size ceilings, the accepted
   input types, and that each file still points at the other. The duplication is
   deliberate (the bridge must run under bare `node`); silent divergence is not.
4. **`--live-image`** — generates a real image, asserts the file exists, is over
   10 KB and starts with real PNG/JPEG magic bytes (not an apology saved with a
   `.png` name), then edits it and asserts the edit is a *new* file and the
   original is byte-for-byte unchanged. The key comes from `GEMINI_API_KEY` or,
   failing that, `Desktop\DictationMic\gemini.key`. Opt-in: it spends quota.

### `scripts/bridge-register-check.mjs`

Bundles the real `electron/bridge/mcp-config.ts` with esbuild and runs it inside
a real Electron process, so `app.getAppPath()` and `app.getPath('appData')` are
genuine rather than stubbed. It then asserts the generated `mcp.json` has
absolute paths that exist, that `applyMcpBridge()` flags Claude and leaves
PowerShell/Kimi/Gemini alone and never doubles the flag, and finally hands the
file to the real `claude --mcp-config <path> --help`.

`--live-claude` adds the only proof that Claude actually *loads* the server —
a headless `claude -p` run asserting all three tool names come back. It is
opt-in because it spends tokens. Note that `claude mcp list` is **not** a valid
check here: the `mcp` subcommand silently ignores `--mcp-config` and lists only
account-level connectors.
