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

**Install with the `.exe` if you want this.** The `.zip` on the release page is
a portable copy for handing to someone on a memory stick: it runs without
installing anything, and it never updates itself. Whatever you unzip is what
you keep.

## Forge Mobile

There is an Android companion that pairs with your desktop and updates itself
the same way. See **[docs/MOBILE-SETUP.md](docs/MOBILE-SETUP.md)**.

## Running from source

```
npm install
npm run dev
```

A dev run never updates itself — it is a checkout, and an updater that
overwrote uncommitted work would be a bug, not a feature.
