# forge-bridge — the cross-agent bridge

An MCP server that Forge ships and registers into every **Claude Code** pane, so
Claude can do things it otherwise cannot: watch a video, generate and edit real
images, generate real video, and get a second opinion from a different model
family.

`bridge/gemini-bridge.mjs` is a plain Node script speaking MCP over stdio, with
no dependencies beyond the MCP SDK and no state of its own. Every one of its
five tools calls Google's REST API directly: nothing here shells out, and the
whole file is REST plus the node standard library.

---

## Auth model

**One key, one road.** Every tool needs `GEMINI_API_KEY` in the environment.
Forge writes it into the `env` block of the `mcp.json` it generates (see *How
Forge registers it* below) from the same Gemini key the voice agent uses. That
generated file, under `%APPDATA%\Forge\bridge\`, and `settings.json` beside it
are the only two places Forge ever puts a key; nothing is written into this repo
or the packaged app. Pasting a new key in settings rewrites the config
immediately, though a pane has to be reopened to pick it up — Claude reads the
config once, at launch.

With no key every tool returns a specific, actionable error naming exactly where
to set one. None of them invents a path, an answer or a summary in its place.

### Why the Gemini CLI is gone

`ask_gemini` and `summarize_video` used to shell out to the `gemini` binary on
PATH, using whatever Google login it held in `%USERPROFILE%\.gemini`. That road
is closed. Google retired the free individual-account tier behind the CLI: it
now answers `UNSUPPORTED_CLIENT` and tells you to migrate to the Antigravity
suite, so on this machine both tools were simply dead — no login could fix them,
because the login itself no longer exists.

So they were moved onto the same direct REST calls the media tools already used,
and every trace of the CLI was deleted from the bridge: the PATH search, the npm
cmd-shim reader (`gemini.cmd` → the real `gemini.js`), the `spawn` funnel, the
environment scrubbing, the exit-code table (41/42/52), the signed-out stderr
sniffing, and the `FORGE_GEMINI_JS` override. About 230 lines. `bridge-smoke`
asserts they stay gone, and that the header still records *why* — otherwise
someone will helpfully add them back.

Forge's interactive **Gemini launch profile** — the pane that runs `gemini` as a
terminal agent — is a separate feature and is untouched by any of this. The
settings panel already flags that its Google-account login is retired.

---

## Tools

### `ask_gemini(prompt, files?)`

General query. One `POST /v1beta/models/<model>:generateContent`, answer back as
plain text.

**Model.** `gemini-3.6-flash` — fast, cheap, and it reads images, PDF, audio and
video as well as text. Verified working on this key. Override with
`FORGE_GEMINI_ASK_MODEL`.

**`files`** takes absolute paths to **files, not directories** — a directory is
refused by name, telling the caller to list what it actually wants read. Each
file takes one of three roads:

| The file | How it travels |
| --- | --- |
| text of any extension, ≤ 1 MB | an inline text part, headed by its absolute path |
| an image (`.png .jpg .jpeg .webp .gif .bmp .heic .heif`) ≤ 20 MB | an inline `inline_data` part — no upload hop |
| anything else Gemini reads — PDF, audio, video, or text over 1 MB | uploaded to the Files API, then a `file_data` part |
| anything else at all | **not sent**, and said so in the reply |

"Text" is decided by the *bytes*, not the extension: a NUL byte or more than 2%
odd control characters in the first 8 KB means binary. So `.ts`, `.rs`, `.toml`,
`.env` and extensionless files all attach as text without needing a table, while
UTF-8 accents and emoji stay text.

Inline attachments share a 15 MB budget; whatever will not fit is reported.
Uploads are capped at 200 MB each (the API's own limit is 2 GB, but the body is
buffered in memory in one shot). Every path that could not travel — missing,
a directory, too big, an unreadable type — comes back in a trailing
`(Not attached — …)` note rather than being silently dropped.

Use it for a genuine second opinion, Google-flavoured knowledge, or an
independent review of a design or diagnosis.

### `summarize_video(url_or_path, focus?)`

Builds a structured-summary prompt, pairs it with the video as a `file_data`
part, and sends both to the same model as `ask_gemini`.

Three input shapes, all verified live 2026-07-30:

| Input | Part sent |
| --- | --- |
| a YouTube URL (`youtube.com`, `youtu.be`, `youtube-nocookie.com`) | `{ file_data: { file_uri: <url> } }` — **no mime type** |
| any other public `https` video URL | `{ file_data: { file_uri: <url>, mime_type: "video/…" } }` — Google fetches it, but wants to be told what it is |
| an absolute local path | uploaded to the Files API first, then `{ file_data: { file_uri, mime_type } }` |

YouTube ingestion is native and cheap — a 19-second clip costs ~1,700 video
tokens and answers in about 4 s. A local file is slower because it has to go up
first: a 4.9 MB mp4 took ~2 s to upload and ingest, ~13 s round trip in total.
Local files must carry a video extension (`.mp4 .mov .webm .mpeg .mpg .avi .wmv
.flv .3gp`); anything else is refused before a byte is sent.

Returns Markdown with fixed sections — **Gist**, **Timeline** (beats with
timestamps), **Key points**, **Actionable**. Two dishonesty guards: if Gemini
replies with an apology instead of a summary, the tool returns that as an error
rather than passing it off as a summary; and a video Google cannot fetch
(private, deleted, age-gated, region-locked) comes back as a bare
`400 INVALID_ARGUMENT` with no explanation at all, which is translated into a
sentence that says the file was never read and that its contents must not be
guessed at.

#### The Files API, as it actually behaves

Worth writing down, because step 1's answer is in the **headers** and its body is
empty:

```
1. POST /upload/v1beta/files
     X-Goog-Upload-Protocol: resumable
     X-Goog-Upload-Command: start
     X-Goog-Upload-Header-Content-Length: <size>
     X-Goog-Upload-Header-Content-Type: <mime>
     { "file": { "display_name": "…" } }
   → 200, header x-goog-upload-url: <one-shot session URL>     ← empty body

2. POST <that URL>
     X-Goog-Upload-Command: "upload, finalize"
     X-Goog-Upload-Offset: 0
     <the raw bytes>
   → { "file": { "name": "files/<id>", "uri": …, "state": "PROCESSING" } }

3. GET /v1beta/files/<id>   until state is ACTIVE
   → PROCESSING → ACTIVE  (a 4.9 MB mp4: ~2 s, two polls)
   → FAILED, with an `error` explaining why
```

Step 3 is not optional: handing a `PROCESSING` file to `generateContent` is an
error, not a wait. The response also advertises
`x-goog-upload-chunk-granularity: 8388608`, so a chunked upload is possible —
the bridge does not bother, sending the whole body in one `upload, finalize`
POST instead, which is why the 200 MB cap exists.

Google expires uploads after 48 h by itself (`expirationTime` comes back in the
response). The bridge does not wait for that: it `DELETE`s each file as soon as
the answer is in hand, in a `finally`, so nothing of the user's is left sitting
on Google's side. A failed delete is not reported — it expires regardless.

#### Two model-behaviour notes

- `gemini-3.6-flash` returns its **private reasoning** as extra parts carrying
  `thought: true` (and a `thoughtSignature` on the real ones). Only parts
  *without* `thought: true` are joined into the answer; forgetting that turns
  "bridge-ok" into a page of deliberation.
- A refusal or an empty answer arrives as HTTP 200 with no usable text and a
  `finishReason`. That is reported as a refusal, with `MAX_TOKENS` called out
  separately, and never as an answer.

### `make_image(description, out_dir?, count?, aspect?)`

Really generates an image and returns the absolute path it was saved to. Default
output directory is `%APPDATA%\Forge\bridge-out\` (overridden by the
`FORGE_BRIDGE_OUT` environment variable, which Forge sets).

`count` is 1–4 and `aspect` is one of `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9
21:9`. Both are validated before anything is spent.

**How.** A POST to
`generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` with
`responseModalities: ['IMAGE']`, which returns the bytes inline. (This tool
never had a CLI route to lose: the Gemini CLI had **no image-generation tool at
all** — verified against v0.53.0, whose tool registry has none and whose README
points at an external MCP server,
[`mcp-genmedia`](https://github.com/GoogleCloudPlatform/vertex-ai-creative-studio/tree/main/experiments/mcp-genmedia),
for media instead.)

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
| Timeout | Every fetch is aborted: 300 s for text and uploads, 120 s for an image or one Veo round trip, 360 s for a whole Veo render |
| No key | A specific error naming where to set one — never a bare 401 |
| Bad arguments | Returned as a tool error, so the agent can correct itself |
| Subprocesses | None. The bridge is REST plus the node standard library |
| The key in error text | Scrubbed (`scrubKey`) out of every message before it is returned |
| Honesty | No tool ever returns a path, an answer or a summary it did not actually get |

Model overrides, all validated against `^[a-zA-Z0-9][a-zA-Z0-9.\-_]{1,64}$` and
falling back to the default if malformed:

| Variable | Default |
| --- | --- |
| `FORGE_GEMINI_ASK_MODEL` | `gemini-3.6-flash` |
| `FORGE_GEMINI_IMAGE_MODEL` | `gemini-2.5-flash-image` |
| `FORGE_GEMINI_VIDEO_MODEL` | `veo-3.1-lite-generate-preview` |

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
        "FORGE_GEMINI_VIDEO_MODEL": "<only when set in Forge's own environment>",
        "FORGE_GEMINI_ASK_MODEL": "<only when set in Forge's own environment>"
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
npm run bridge:smoke        # protocol, degradation, live text route  (155 checks)
npm run bridge:smoke -- --live-image       # + a real image generated and edited
npm run bridge:smoke -- --live-video       # + a real ~4s Veo clip (~35s, costs more)
npm run bridge:register     # config generation + claude accepts it (22 checks)
npm run bridge:register -- --live-claude   # + a real headless Claude run
node scripts/bridge-smoke.mjs --force-absent   # only the no-key branch (offline)
```

### `scripts/bridge-smoke.mjs`

Speaks the MCP wire protocol by hand (no SDK client, so a broken server cannot
make a broken test pass): `initialize` → `tools/list` → `tools/call`.

1. **No key** — every one of the five tools must return an actionable error
   naming the *key* fix, and the two text tools must additionally forbid
   answering in Gemini's place. Argument validation (`count`, `aspect`,
   `duration`, missing fields) is asserted here too, because it has to happen
   before anything is spent.
2. **Live text route** — with a key, a real `ask_gemini` round trip
   ("bridge-ok", asserted short enough to prove the model's *thinking* parts are
   not leaking into the answer), a real attachment round trip (a magic word in a
   temp file, which Gemini has to read back), and a real `summarize_video`
   against **"Me at the zoo"** — 19 seconds, public, the oldest video on
   YouTube — asserted to mention elephants, which no amount of URL
   pattern-matching would produce. Unreachable videos, non-video files, missing
   files, missing attachments and directories are all asserted to be reported
   rather than papered over. These run **by default**: together they cost a
   three-word answer and 1,700 video tokens.
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

   The same suite also polices the **retirement**: that the bridge still imports
   nothing from `node:child_process`, that no shim resolver, exit-code table or
   "run `gemini` once" instruction has crept back in, and that the header still
   records *why* they went. Plus the shape of the new text route — the pinned
   ask model and its override, the mime-less YouTube part, the three-step
   resumable upload, the delete-afterwards, and the `thought !== true` filter.
   Nothing here is duplicated from `gemini-media.ts`, which is media-only, so
   these are shape assertions rather than drift ones.
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
a headless `claude -p` run asserting the tool names come back. It is
opt-in because it spends tokens. Note that `claude mcp list` is **not** a valid
check here: the `mcp` subcommand silently ignores `--mcp-config` and lists only
account-level connectors.
