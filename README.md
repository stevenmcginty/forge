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

Releases up to and including v0.2.0 also carried a `Forge-<version>-win.zip`,
a portable copy that ran without installing anything. It could never update
itself, so it is no longer built. If you are running one, install the `.exe`
over it — the zip will sit at its own version indefinitely.

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
