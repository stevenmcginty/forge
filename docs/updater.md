# How Forge updates itself

Paths are from branch `updater-rollback`. `HEAD:` means the old code (`git show HEAD:<path>`).

## 1. Which updater runs where

| Where Forge runs | Updater | Code | What "update" means |
|---|---|---|---|
| Installed build (NSIS, `%LOCALAPPDATA%\Programs\forge`) | electron-updater feed + PowerShell apply helper | `electron/updater.ts`, `electron/update-apply.ts`, `scripts/apply-update.ps1` | Download the setup.exe, hand it to the helper, helper swaps the folder |
| Everyday checkout (Steve's machine, `npm run dev`, stable profile) | `git pull` from origin | `electron/source-updater.ts:214-221` (off when packaged, off when `FORGE_CHANNEL=dev`, off without `.git`) | Pull, install deps if needed, restart |
| `FORGE_CHANNEL=dev` checkout | Rebuild strip only | `electron/stale-watcher.ts` (wired in `electron/main.ts:122`) | Tells you `out/` is newer than the running process. No download, no pull |

Packaged mode needs `app.isPackaged` (`shared/tools.ts:791-800`); `FORGE_FAKE_UPDATE=<version>`
simulates a feed in any build. Steve's Forge uses `git pull`, which is why updates "worked for Steve".

## 2. The new flow

Forge never calls `quitAndInstall` now (`electron/updater.ts:28`). It hands a
verified installer to a helper that runs outside the install folder.

1. **Check and download.** `checkForUpdate` runs 8 s after start, every 15 min
   (`updater.ts:41,52`), and on focus, wake and unlock. `autoDownload` and
   `autoInstallOnAppQuit` are off (`updater.ts:227-231`). The banner shows
   `available`, then `downloading`, then `ready`.
2. **Click "Update now" and confirm.** `installUpdate` (`updater.ts:350`)
   refuses unless the install folder is sane (`canApplyUpdate`,
   `update-apply.ts:181`). It needs the installer file and its sha-512.
3. **Hand-off.** `applyUpdate` (`update-apply.ts:226`) copies the helper and the
   installer into `%LOCALAPPDATA%\forge-updater\apply\<id>\`, deletes any stale
   health and go file, writes state `starting`, and starts the helper with
   `cmd.exe /d /c start "" /b powershell.exe ...` (hidden, `update-apply.ts:293-321`).
   Not `detached: true`: that is `DETACHED_PROCESS`, and Windows PowerShell 5.1
   with no console exits 0 without running the script. Not a plain child either:
   libuv puts it in a kill-on-close job, so it would die with Forge. `cmd` exits
   at once, so until the first state write the pid Forge holds is the launcher's.
4. **Preflight (helper).** Checks the install folder, the installer, its sha-512,
   free disk space (3x installer size) and removes a stale `.update-backup`
   (`apply-update.ps1:536-571`). On failure the state is `aborted`. Forge stays
   open and nothing has changed.
5. **Handshake.** Forge polls the state file for up to 20 s
   (`update-apply.ts:39,327-401`). On `waiting-for-exit` it writes
   `update-go.json` (`{ "id", "at" }`, atomic) to commit to quitting, then shows
   "Closing Forge...", allows close, kills the speech sidecar and quits. If the go
   file cannot be written, Forge stays open as on a timeout. On `aborted` it
   stays open and shows the reason. On timeout it kills the helper and reports
   "The updater did not start".
   The helper waits up to 10 s after `waiting-for-exit` for a go file with its
   id and touches nothing before it: no watchdog pause, no wait, no kill. With
   no go file it writes `aborted` ("Forge did not confirm the update in time;
   nothing was changed.", acknowledged if Forge is still running, so the next
   launch shows it only in Settings) and exits 1, relaunching nothing. A helper
   that starts when the state already says `aborted` for its id exits 1 without
   writing anything. So a helper that starts after Forge gave up can never close
   Forge or touch the install (`apply-update.ps1:588-602`, `:809-826`, `:869-875`).
6. **Helper phases** (`apply-update.ps1:799-857`):
   `preflight` -> `waiting-for-exit` -> `stopping-processes` -> `backing-up` ->
   `installing` -> `verifying` -> `launching` -> `waiting-for-health` ->
   `succeeded`.
   - It waits for Forge's go file (step 5); without it: `aborted`, nothing touched.
   - It pauses the watchdog (`watchdog.pause` in the data root).
   - It waits `ExitTimeoutSec` (30 s) for Forge, then kills Forge and its children.
   - It kills the watchdog's `wscript`/`cscript` launcher, then every process
     running from the install folder (`apply-update.ps1:263-280`, `:332`).
   - It renames `forge` to `forge.update-backup`. A rename that works proves
     nothing holds the folder. If it fails after 10 tries: `aborted`, old app relaunched.
   - It runs `setup.exe /S --updated /D=<InstallDir>` into the now-empty folder.
   - It exports the registry keys, then checks the exit code, exe, `app.asar` and version.
   - It starts the new Forge and waits up to 120 s for a health file.
7. **Health.** The new Forge runs `reconcileUpdateOnStartup`
   (`update-apply.ts:392`). It writes `update-health.json` 5 s after the window
   loads, only if the renderer did not crash, the state id matches and its
   version equals `to` (`shouldWriteUpdateHealth`, `shared/tools.ts:875`;
   `update-apply.ts:419-446`).
8. **Success.** The helper writes `succeeded`, deletes the backup, resumes the
   watchdog. Forge shows "updated" once (`shared/tools.ts:895-935`).
9. **Failure after the swap.** `Invoke-Rollback` (`apply-update.ps1:715`)
   deletes the new folder, renames the backup back, re-imports the registry,
   writes `rolled-back` and relaunches the old Forge. If the rename back fails:
   `rollback-failed`, a message box, backup left in place (see section 5).

## 3. Old failure modes

Old code = `HEAD:`. Harness = `npm run update-apply:check` (`scripts/update-apply-check.mjs`, ~70-80 s, fast lane, `scripts/run-checks.mjs:79`). Test machine = Windows with an older installed Forge and a newer release. Install folder: `%LOCALAPPDATA%\Programs\forge`.

**1. Installer spawned before Forge quit.**
- Symptom: "Failed to uninstall old application files", or nothing happens.
- Cause: `quitAndInstall` starts the installer while `claude.exe`, `OpenConsole.exe` and the speech engine still hold files.
- Evidence: `HEAD:electron/updater.ts:250-256`; `node_modules/electron-updater/out/NsisUpdater.js:131`.
- Reproduce: open a Claude pane, click Update now, watch the installer start while the pane's `claude.exe` still runs.
- Now: helper waits for Forge's pid, then sweeps the folder (`apply-update.ps1:573-595`, `:319-348`). Harness: "survivor process is killed", "Forge that never exits is killed".

**2. Watchdog vbs respawns Forge mid-install.**
- Symptom: random "file in use", Cancel, or a half-installed folder.
- Cause: the installer kills `Forge.exe` run by the watchdog. The vbs loop restarts it 15 s later from the folder being replaced.
- Evidence: `electron-builder.yml:78-79` ships the vbs; `apply-update.ps1:263-269` documents the 15 s loop.
- Reproduce: enable the watchdog in Settings, start an old-style update, and watch `Forge.exe` return in Task Manager during the install.
- Now: pause file first, launcher killed first (`apply-update.ps1:431-452`, `:266-276`). Harness: "watchdog pause" covers the pause file only. Killing the launcher itself is not covered.

**3. Old app deleted before the new one is copied.**
- Symptom: no Forge at all after a failed or cancelled update.
- Cause: NSIS runs the old uninstaller first, then copies. Any failure after that leaves an empty folder.
- Evidence: `node_modules/app-builder-lib/templates/nsis/include/installUtil.nsh:108-135`.
- Reproduce: start an update, then lock a file in the install folder (open a file from it in a text editor), or power off during the copy.
- Now: the old folder is renamed aside and put back on any failure (`apply-update.ps1:715-766`). Harness: "installer fails midway", "new app never reports healthy", "new app reports the wrong version", "outside process holds a file open".

**4. Silent spawn failure with `logger = null`.**
- Symptom: click Update now, Forge closes (or not), nothing changes, no log anywhere.
- Cause: a failed installer spawn only reaches the `error` event, and the logger was off.
- Evidence: `HEAD:electron/updater.ts:147`, `:172-180`.
- Reproduce: break the spawn (for example, take `powershell.exe` off PATH on a test machine), then click Update now.
- Now: `updater.logger = updaterLogger` (`updater.ts:232`); every step writes to `updater.log`. A helper that does not start is reported after the 20 s handshake (`update-apply.ts:348-355`). Not run by the harness (it drives the .ps1 only).

**5. Error phase hidden by the banner.**
- Symptom: the update fails and the banner just disappears.
- Cause: the old banner returned `null` for `error`.
- Evidence: `HEAD:src/components/UpdateBanner.tsx:40`. Now `UpdateBanner.tsx:80-88,286,331` shows the error, with the log path.
- Reproduce: go offline after a download starts, or point the feed at a missing asset.
- Now: banner shows the message, "Try again" and the log path. UI only; not in the harness.

**6. Background-check error clobbers `ready`.**
- Symptom: the "Restart" button vanishes under the cursor.
- Cause: the global `error` handler set `error` for any failure, including a periodic check while a download sat ready.
- Evidence: `HEAD:electron/updater.ts:172-180`. Now `statusAfterUpdateError`/`isUpdateBusy` (`shared/tools.ts:831-852`), called from `updater.ts:119-127`. The `error` event only logs (`updater.ts:266-268`).
- Reproduce: download an update, switch the network off, wait for the next 15 min check (or refocus the window).
- Now: pure logic; the unit check is `scripts/updates-check.mjs:472`. Not in the apply harness.

**7. `isForceRunAfter` ignored when not silent.**
- Symptom: the new Forge never opens after the installer finishes.
- Cause: `quitAndInstall(false, true)` runs a visible installer. The "run after" flag does not take effect there. The user has to click through install-mode and Finish pages.
- Evidence: `HEAD:electron/updater.ts:256`; `NsisUpdater.js:108-113` (flags are only args). Behaviour of the NSIS side: research-nsis.md.
- Reproduce: update an installed copy and watch the installer's Finish page.
- Now: the helper installs with `/S` and starts the new Forge itself (`apply-update.ps1:409-428`). Harness: "happy path" asserts the launch.

**8. `release.yml` not gated on checks.**
- Symptom: a broken build can reach users.
- Cause: `release.yml` runs on every master push (`:3-6`) and goes straight to `npm run release -- --ci` (`:75`). It has no `needs` and does not run `npm run check`. `checks.yml` is a separate workflow.
- Reproduce: push a failing commit to master and watch both workflows start.
- Now: unchanged. The rollback limits the damage of a bad build but does not prevent it.

## 4. Logs and state files

| File | Path | Written by |
|---|---|---|
| Updater log | `%APPDATA%\Forge\logs\updater.log` (`<userData>\logs`, `update-log.ts:23`) | Forge `[main]`, helper `[helper]` |
| Old log | `updater.old.log` beside it. Made at startup when the log is over 1 MB (`update-log.ts:21,28`) | Forge |
| State | `<userData>\updates\update-state.json` (`update-apply.ts:49-55`) | Forge writes `starting` and `acknowledged`; the helper writes the rest (its "did not confirm" abort is written acknowledged while Forge still runs) |
| Health | `<userData>\updates\update-health.json` | The new Forge |
| Go | `<userData>\updates\update-go.json` (`{ "id", "at" }`) | Forge only, when it commits to quitting; deleted when the next apply is prepared |
| Work dir | `%LOCALAPPDATA%\forge-updater\apply\<id>\` (installer copy, helper copy, `.reg` backups) | Forge, helper |
| Backup | `%LOCALAPPDATA%\Programs\forge.update-backup` | Helper |
| Pause file | `<userData>\watchdog.pause` (holds an expiry in epoch ms) | Helper |

Lines look like `2026-10-11T12:34:56.789Z [main] message`. The Settings Updates
section has an "open the log" button (`updater.ts:414`).

A healthy run reads, in order:

```
[main]   updater started: mode real, Forge 0.3.270
[main]   downloaded 0.3.271: ...setup.exe (sha512 present)
[main]   install requested for 0.3.271
[main]   apply <id>: helper spawned, pid N
[helper] helper started: id <id>, 0.3.270 -> 0.3.271 ...
[helper] phase -> preflight / installer sha512 ... / preflight passed
[helper] phase -> waiting-for-exit
[main]   apply <id>: go file written
[main]   apply <id>: handshake complete at waiting-for-exit - quitting
[helper] Forge confirmed at <time>
[helper] Forge (pid N) exited / phase -> stopping-processes / backing-up
[helper] renamed ...\forge -> ...\forge.update-backup (attempt 1)
[helper] phase -> installing / installer exit code 0 / verified the new install
[helper] phase -> launching / waiting-for-health
[main]   startup: state waiting-for-health ... this Forge is 0.3.271
[main]   health: window loaded; writing in 5 s ... / health: written for <id>
[helper] health reported: version 0.3.271 / phase -> succeeded
[helper] deleted the backup ... / helper exit 0
```

A failed run shows `rolling back: <why>`, then `rolled-back` or `rollback-failed`.
Helper exit codes: 0 succeeded, 1 aborted, 2 rolled back, 3 rollback failed.

Helper details (`apply-update.ps1`):
- Resets `PSModulePath` to Windows PowerShell paths at start (a pwsh path hides `Get-FileHash`); restores Forge's value only to launch the app (`:69-87`, `:409-428`).
- A health file with the right id but wrong version fails at once (`:690-696`).
- After `ExitTimeoutSec` it kills `AppPid` by handle plus children, never its own subtree (`:573-595`).
- On `rollback-failed` the watchdog stays paused until the pause file expires; the task is not re-run (`:762`).
- The pause file holds an expiry in epoch ms (exit + install + health timeouts + 180 s). It is removed only if its content is still what the helper wrote (`:443-470`).

## 5. Manual recovery

Forge will not open and the Programs folder looks wrong:

1. Open `%APPDATA%\Forge\logs\updater.log` and read the last `[helper]` lines.
   Open `%APPDATA%\Forge\updates\update-state.json` and read `phase`.
2. **`rollback-failed`** (the helper showed a message box): the old copy is in
   `backupDir`, normally `%LOCALAPPDATA%\Programs\forge.update-backup`.
   Delete or rename any `forge` folder that is there, then rename
   `forge.update-backup` to `forge`. Start `Forge.exe`.
3. **Anything else, or no backup left:** download the latest `Forge-<version>-setup.exe`
   from the GitHub release page and run it. Your data lives in
   `%APPDATA%\Forge` and the installer does not touch it.
4. If the watchdog is enabled and stays quiet, delete `%APPDATA%\Forge\watchdog.pause`.
   It expires by itself.
5. A `starting` or `preflight` state that never moves means the helper died.
   Forge shows "The updater stopped unexpectedly" on the next start
   (`shared/tools.ts:934-937`). Dismiss it and try again.

## 6. Known limits

- A copy older than this change still has the old `quitAndInstall` path. It takes
  one last update the old way. Only the update after that runs through the helper.
- CI never runs the real NSIS installer end to end. The harness swaps in a fake
  installer and fake apps (`update-apply-check.mjs`).
- The harness does not cover: registry export/import, the progress window and
  message box, `schtasks /Run`, killing the watchdog launcher, the
  `rollback-failed` path, and the 15 s "no process runs from the folder" rule.
- A copy missing `Uninstall Forge.exe`, `app.asar` or the shipped helper points to the
  download page instead (`update-apply.ts:181-197`, `updater.ts:365-375`).
