# forge-bridge — the cross-agent bridge

An MCP server that Forge ships and registers into every **Claude Code** pane, so
Claude can hand work to the **Gemini CLI**: things Claude cannot do itself
(watch a video, generate an image) and second opinions from a different model
family.

`bridge/gemini-bridge.mjs` is a plain Node script speaking MCP over stdio. It
holds no state and stores nothing — every call shells out to the `gemini` binary
on PATH and returns its output.

---

## Auth model

**Forge never sees a credential.** There is no API key in Forge's settings, no
token in `%APPDATA%\Forge`, and nothing in this repo.

The bridge spawns the Gemini CLI, and the CLI authenticates with whatever login
*it* already holds in `%USERPROFILE%\.gemini`. Signing in is a one-off, manual,
browser-based step that Forge deliberately does not automate:

```pwsh
gemini          # opens a browser, sign in with your Google account, then quit
```

Until that is done, every tool returns a readable error telling Claude to ask
the user to run it. Nothing hangs and nothing is faked.

Install the CLI itself with:

```pwsh
npm install -g @google/gemini-cli
```

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

### `make_image(description, out_dir?)`

Generates an image and returns the path it was saved to. Default output
directory is `%APPDATA%\Forge\bridge-out\` (overridden by the `FORGE_BRIDGE_OUT`
environment variable, which Forge sets).

**Honest capability note:** the Gemini CLI **has no built-in image-generation
tool.** Verified against v0.53.0 — its tool registry has no image tool, and its
own README points at an external MCP server
([`mcp-genmedia`](https://github.com/GoogleCloudPlatform/vertex-ai-creative-studio/tree/main/experiments/mcp-genmedia),
exposing Imagen/Veo/Lyria) for media generation. The `generateImage` symbols
inside the CLI bundle belong to the bundled `@google/genai` SDK and are not
reachable as a user tool.

So `make_image` **probes at call time** (`gemini extensions list`) for an
installed image/media extension:

- **Nothing found** → returns a clear error naming exactly what to install, and
  explicitly instructs the agent not to claim an image exists.
- **Something found** → asks Gemini to generate and write the file, then
  **verifies on disk** (a named path must exist, otherwise the newest image file
  in `out_dir` is used). If no file appeared, it returns an error saying so
  rather than reporting a path that isn't there.

It never fabricates a path.

---

## Behaviour common to every tool

| Concern | Behaviour |
| --- | --- |
| Timeout | 120 s, then the child is killed and the timeout is reported |
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
      "env": { "FORGE_BRIDGE_OUT": "<abs>/bridge-out" }
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
npm run bridge:smoke        # MCP protocol + graceful degradation  (53 checks)
npm run bridge:register     # config generation + claude accepts it (17 checks)
npm run bridge:register -- --live-claude   # + a real headless Claude run (20)
node scripts/bridge-smoke.mjs --force-absent   # only the not-installed path
```

### `scripts/bridge-smoke.mjs`

Speaks the MCP wire protocol by hand (no SDK client, so a broken server cannot
make a broken test pass): `initialize` → `tools/list` → `tools/call`. It runs the
suite twice — once with the CLI hidden from the server via a stripped `PATH` to
prove the graceful-degradation path, once against the real CLI. When Gemini is
signed out it prints the CLI's exact message and asserts the error is
actionable; when signed in it asserts a live round trip.

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
