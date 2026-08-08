# Forge

An agentic development environment for Windows: a grid of real terminals for
running coding agents side by side.

## Download

**[Download the latest release →](https://github.com/stevenmcginty/forge/releases/latest)**

Take **`Forge-<version>-setup.exe`** and run it. It installs per-user, so there
is no admin prompt and no UAC dialog; your projects, layouts and screenshots
live in `%APPDATA%\Forge` and survive an uninstall.

Forge is not code-signed, so Windows will interrupt you once:

> **Windows protected your PC** → **More info** → **Run anyway**

That is SmartScreen saying "nobody has paid for a certificate", not "this is
broken". It stops asking after the first run.

## Updates

Forge keeps itself current. It checks about eight seconds after launch and
every six hours after that, and when a newer release exists a banner appears at
the top of the window: click it to download, then click **Restart to finish**.

Nothing is downloaded or installed behind your back — the check is automatic,
the megabytes are not. Saying no to one version does not mute the next one.

After each update, Forge shows a card saying what changed. It appears once per
version and never again; **Settings → Updates & tools → What's new** brings it
back.

Its text comes from the commits in the release, so nothing has to be written
twice. A commit body line beginning `Highlight:` becomes a headline bullet — the
customer-facing sentence, written when the change is fresh and the version number
does not exist yet:

```
The rail learns to share: five notes every agent can read

Highlight: Push a plan from one agent and have another review it — the new
Share section in the left rail keeps five markdown notes inside the project
that Claude, Codex, Antigravity and the rest can all read and write.
```

Every other commit subject is listed under "Also changed". The same text becomes
the GitHub release body, so the page and the card can never disagree.

Releases up to and including v0.2.0 also carried a `Forge-<version>-win.zip`,
a portable copy that ran without installing anything. It could never update
itself, so it is no longer built. If you are running one, install the `.exe`
over it — the zip will sit at its own version indefinitely.

## Sharing work between agents

A project can have five panes open — three Claude Code, one Codex, one
Antigravity — and none of them can see the others. No vendor offers a way for one
agent to read another's session, so Forge does it with files.

Switch on **Settings → Appearance → Left rail → Share** and the rail grows a
fifth section: five markdown notes, kept in `.forge/share` inside the project,
that every agent working there can read and write. Draft a plan in one pane, hand
it to another for review, capture a failing build off a third. `.forge/` is added
to that clone's `.git/info/exclude`, never to your `.gitignore`, so nothing is
committed.

Any agent can use it with the tools it already has — "read
`.forge/share/slot-2.md`" is a relative path in its own workspace.
**Settings → Agents → Shared scratchpad tools** additionally gives Claude Code,
Codex, OpenCode and Qwen a `forge_share` tool set, which refuses to overwrite a
note somebody else changed while they were thinking. It carries no API key and
opens no network connection.

## Forge Mobile

There is an Android companion that pairs with your desktop and updates itself
the same way. See **[docs/MOBILE-SETUP.md](docs/MOBILE-SETUP.md)**.

## Running from source

```
npm install
npm run dev
```

A dev run opens as **Forge Dev** and uses `%APPDATA%\Forge Dev` for its
settings, projects, browser profile, screenshots, logs, and single-instance
lock. Stable Forge uses `%APPDATA%\Forge`, so both can run at the same time
without touching each other. The `FORGE_DATA_DIR` environment variable or
`--data-dir <path>` argument can still override the Dev data root for tests.

Forge Dev never updates itself — it is a checkout, and an updater that
overwrote uncommitted work would be a bug, not a feature.

### Promoting Dev to a new Forge version

Forge Dev is the workspace. Stable Forge is a packaged release, not the
checkout used to write Forge. When the Dev build is ready:

1. Run the typecheck and packaged checks.
2. Commit the approved Dev changes.
3. Bump `package.json` to the next version and commit it.
4. Run `npm run release` from `master`.

That produces and publishes the new Forge version. Existing stable installs
then receive it through the normal updater; the Dev checkout remains isolated
and continues to be the place where the next version is built.

### Push-to-release

The repository also publishes desktop Forge automatically on every push to
`master`. GitHub Actions uses a clean Windows runner to build the installer,
verify `latest.yml`, and publish the release that the updater watches. The
first push uses the unreleased version in `package.json`; later pushes advance
the patch version automatically. No local packaging step is needed.
