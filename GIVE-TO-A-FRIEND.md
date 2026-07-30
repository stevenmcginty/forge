# Forge

A grid of real terminals for running coding agents — Claude Code, Kimi, Gemini —
side by side, one project per column. Split panes, tabbed workspaces, a
screenshot shelf you can drag straight into a chat box, and optional on-device
dictation.

Windows 10/11, 64-bit. Nothing is uploaded anywhere unless you turn the voice
agent on and give it your own Gemini key.

## Get it running

**Take `Forge-0.1.0-win.zip`.** No installer, nothing written to your registry.

1. Right-click the zip → **Extract All…**, and put the folder anywhere you like
   (Desktop is fine). The extracted folder *is* the app.
2. Open it and double-click **Forge.exe**.
3. Windows SmartScreen will show a blue **"Windows protected your PC"** box,
   because the app is not code-signed — signing costs a few hundred pounds a
   year and Forge is a personal project. Click **More info → Run anyway**. You
   only have to do this once.
4. The welcome card asks you three things. All three are skippable.

To move it, move the folder. To uninstall, delete the folder — and
`%APPDATA%\Forge` if you want your settings gone too.

There is also **`Forge-0.1.0-setup.exe`** if you would rather have a Start-menu
entry and a desktop shortcut. It installs per-user, so no admin password and no
UAC prompt. Same app, same SmartScreen click.

## What you need to install separately

Forge is a terminal grid. It *runs* agents; it does not contain any. Whichever
of these you want, install it yourself — the welcome card tells you which ones
it found on your machine, and links to the rest.

| Pane | Needs | Where |
| --- | --- | --- |
| **PowerShell** | nothing — it is your shell | already there |
| **Claude Code** | the `claude` CLI + an Anthropic account | <https://claude.com/claude-code> |
| **Kimi** | the `kimi` CLI + a Moonshot key | <https://platform.moonshot.ai> |
| **Gemini** | the `gemini` CLI + a Google account | <https://github.com/google-gemini/gemini-cli> |

If a command is not installed, the pane still opens — it is a real PowerShell
session, so you just get `'claude' is not recognized`. Nothing breaks.

Forge defaults its shell to **PowerShell 7** (`pwsh.exe`). If you have not got
it, either install it (`winget install Microsoft.PowerShell`) or change the
shell to `powershell.exe` in Settings.

## What downloads on first use

Nothing at all, unless you ask for it.

- **The speech model** — ~660 MB, once, only if you turn dictation on. It goes
  to `%APPDATA%\Forge\models`, resumes if your connection drops, and after that
  dictation is entirely offline: your voice never leaves the machine. Start it
  from the welcome card or from Settings; skip it and dictation simply stays
  off.
- **Nothing else.** No telemetry, no update check, no analytics. The only
  outbound request Forge itself ever makes is to Google's Gemini API, and only
  once you have pasted in your own key and are using the voice panel.

The speech *engine* is already in the download (about 130 MB of it), so you do
not need Python.

## Your keys and your data

- Everything Forge keeps lives in **`%APPDATA%\Forge`** — settings, your project
  list, saved pane layouts, and the screenshot shelf. That folder is yours; the
  app never sends it anywhere.
- A Gemini key you paste is stored in `settings.json` in that folder, in plain
  text. It is sent only to `generativelanguage.googleapis.com`, and only when
  the voice panel is actually talking to Gemini.
- If you want a completely separate copy — a second Forge with its own projects
  and its own settings — set `FORGE_DATA_DIR` to a folder before launching it.

## First things to try

1. **Add a project** (the `+` in the left rail, or the welcome card). Panes open
   in that folder.
2. **Ctrl+T** for a new tab, **Ctrl+\\** to split a pane. Pick which agent the
   pane launches from the chooser.
3. Take a screenshot with **Win+Shift+S**. It lands on the shelf under the
   project rail — drag it straight into a Claude pane.
4. **Ctrl+Shift+M** shows every live pane in the project at once as small live
   tiles.

## If something goes wrong

- **"Windows protected your PC"** → More info → Run anyway. See above.
- **A pane opens and immediately says a command is not recognised** → that agent
  is not installed. See the table above.
- **Nothing opens at all** → check you extracted the zip rather than running
  `Forge.exe` from inside it. Windows runs it from a temporary folder otherwise
  and it cannot write its own data.
- **Dictation says the model is missing** → open Settings and download it, or
  point it at a folder that already has `parakeet-tdt-0.6b-v2` in it.
- **Antivirus is unhappy about `forge-stt.exe`** → that is the speech engine, a
  Python program frozen with PyInstaller. Unsigned frozen Python is a shape
  antivirus vendors are twitchy about. It is in `resources\stt-bin\` if you want
  to look, and deleting it only turns dictation off.

## Building it yourself

```
npm install
npm run dist
```

`npm run dist` typechecks, builds the renderer and main bundles, freezes the
speech sidecar with PyInstaller, generates the icon, packages both artifacts
into `release\`, and runs a secrets audit that fails the build if anything
key-shaped ended up inside. Freezing the sidecar needs a Python with
`onnx-asr`, `onnxruntime`, `sounddevice` and `pyinstaller` in it — point
`FORGE_STT_PYTHON` at it, or run `npm run dist:nostt` to package without the
standalone speech engine.
