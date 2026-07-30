# forge-bridge — the cross-agent bridge

An MCP server that Forge ships and registers into every **Claude Code** pane, so
Claude can do things it otherwise cannot: watch a video, generate and edit real
images, generate real video, and get a second opinion from a different model
family.

`bridge/gemini-bridge.mjs` is a plain Node script speaking MCP over stdio, with
no dependencies beyond the MCP SDK and no state of its own. `ask_gemini` and
`summarize_video` shell out to the `gemini` binary on PATH; `make_image`,
`edit_image` and `make_video` call Google's REST API directly, because the CLI
has no media tools at all.

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

**`make_image`, `edit_image` and `make_video` call Google's REST API directly**
and need `GEMINI_API_KEY` in the environment. Forge writes it into the `env` block of the
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

### `make_video(description, out_dir?, aspect?, duration?)`

Really generates a short video (Google **Veo**) and returns the absolute path of
the `.mp4` it was saved to. Same default output directory as the image tools.

**It takes 1–3 minutes.** The tool description says so in capitals, the voice
agent's manifest says so, and the provisional chip in the voice panel says so —
because an agent that thinks this is as quick as `make_image` will call it twice
and then narrate a wait nobody was warned about.

`aspect` is `16:9` or `9:16` — **not** the image list. `duration` is 4–8
seconds. Both are validated locally before the call, because a Veo request is
far more expensive than an image one.

**The API's shape**, all verified live against Steve's key (2026-07-30) rather
than taken from documentation. This is the part that made it a separate job from
the image tools — three calls, not one:

```
1. POST /v1beta/models/<model>:predictLongRunning
     { "instances": [{ "prompt": "…" }],
       "parameters": { "aspectRatio": "16:9", "durationSeconds": 4 } }
   → 200 { "name": "models/<model>/operations/<id>" }        ← nothing else

2. GET /v1beta/models/<model>/operations/<id>
   → { "name": … }                                          ← still running
   → { "name": …, "done": true, "response": { "generateVideoResponse": {
        "generatedSamples": [ { "video": { "uri": "…" } } ] } } }
   → { "name": …, "done": true, "error": { "code", "message" } }   ← failed

3. GET <that uri>
   → video/mp4 bytes
```

There is **no progress percentage** — `done` is the only signal, so the tool
polls at 5 s, 10 s, then every 15 s, giving up after 6 minutes with a message
that says the render may still be running on Google's side and that no file
exists.

**Download auth** was the one genuinely unknown piece, so all three plausible
forms were tried against a real result URI:

| Request | Result |
| --- | --- |
| the URI bare, no auth | **403** `PERMISSION_DENIED` — "Method doesn't allow unregistered callers" |
| `x-goog-api-key: <key>` header | **200** `video/mp4` |
| `?key=<key>` appended | **200** `video/mp4` |

The header is used, for the same reason as everywhere else in Forge: a key in a
URL ends up in logs. Note the URI already arrives carrying `:download?alt=media`
— nothing needs appending. Because that URI is chosen by the *API* and is then
sent an API key, it is parsed and checked against
`generativelanguage.googleapis.com` before the request is made; anything else is
refused rather than fetched.

**Model.** `veo-3.1-lite-generate-preview` — the cheapest of the three and the
one proven to work on this key. `veo-3.1-fast-generate-preview` and
`veo-3.1-generate-preview` are also present in `/v1beta/models` for the same
key; reach them with `FORGE_GEMINI_VIDEO_MODEL`.

Measured on a live run: lite, 4 s of 16:9 → operation `done` at ~47 s, 4.9 MB,
`ftypisom`, `mvhd` duration exactly 4.00 s.

Limits, confirmed by deliberately invalid requests (which are rejected at
*submit* time, so they cost nothing):

- `aspectRatio` accepts **only** `16:9` and `9:16`. `1:1`, `4:3`, `3:4`, `21:9`
  and `16:10` are all refused with *"`aspectRatio` does not support `x`"*.
- `durationSeconds` must be **4–8 inclusive** — *"out of bound. Please provide a
  value between 4 and 8, inclusive"*.
- An empty prompt is refused with *"Text to video requires prompt to be set."*

Failure modes get their own sentences, as with the image tools, plus one the
images do not need: **`tier`**. Veo is billing-only on a plain AI Studio key, and
that is neither a quota problem (waiting will not fix it) nor a bad key, so it is
reported as exactly what it is — *enable billing on the Google Cloud project
behind the key*. The bytes are checked for the ISO `ftyp` signature before
anything is written, so an error page can never land on disk named `.mp4`, and
the file is written tmp-then-renamed like every other artefact here.

`summarize_video` remains the tool for *watching* a video.

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
        "FORGE_GEMINI_IMAGE_MODEL": "<only when overridden in settings>",
        "FORGE_GEMINI_VIDEO_MODEL": "<only when set in Forge's own environment>"
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
npm run bridge:smoke        # MCP protocol + graceful degradation  (129 checks)
npm run bridge:smoke -- --live-image       # + a real image generated and edited
npm run bridge:smoke -- --live-video       # + a real ~4s Veo clip (~35s, costs more)
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
   the default image *and* video models, both aspect lists, the count, size,
   clip-length and timeout ceilings, the poll schedule, the accepted input
   types, and that each file still points at the other. Two behaviours are
   pinned by name as well, because neither can be proven on a working key: the
   **`tier`** (paid-only) branch, and `safeVideoUri` — the host check that stops
   the API key being sent to whatever URL the operation happened to return. The
   duplication is deliberate (the bridge must run under bare `node`); silent
   divergence is not.
4. **`--live-image`** — generates a real image, asserts the file exists, is over
   10 KB and starts with real PNG/JPEG magic bytes (not an apology saved with a
   `.png` name), then edits it and asserts the edit is a *new* file and the
   original is byte-for-byte unchanged. The key comes from `GEMINI_API_KEY` or,
   failing that, `Desktop\DictationMic\gemini.key`. Opt-in: it spends quota.
5. **`--live-video`** — generates one real ~4 s clip and asserts the file exists,
   is over 100 KB and carries the ISO `ftyp` signature at offset 4. A **refusal
   is a pass** here, but only an honest one: if the key is not billed for Veo the
   suite asserts the tool named a cause and did *not* claim a file. Verified on
   Steve's key 2026-07-30: 32.1 s, 1.8 MB, H.264 + AAC, `mvhd` duration exactly
   4.00 s.

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
