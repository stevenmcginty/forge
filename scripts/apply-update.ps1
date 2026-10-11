<#
  apply-update.ps1 - installs a downloaded Forge update from OUTSIDE the install
  folder, and puts the old version back if the new one does not come up.

  Why this exists: electron-updater's quitAndInstall spawns NSIS while Forge is
  still running, and NSIS deletes the old app BEFORE it copies the new one. Any
  failure after that point (a locked file, a Cancel, a power cut) leaves the
  user with no working Forge. So Forge never calls quitAndInstall. It verifies
  the installer, copies it and this script into
  %LOCALAPPDATA%\forge-updater\apply\<id>\, starts this script hidden and,
  when the state file says `waiting-for-exit`, writes update-go.json with this
  id and quits. This script then:

    1. preflight            checks everything; touches nothing
    2. waiting-for-exit     waits up to ConfirmTimeoutSec for Forge's go file;
                            without it: `aborted`, Forge and the disk untouched,
                            nothing relaunched. With it: pauses the watchdog,
                            waits for Forge to quit
    3. stopping-processes   kills the watchdog launcher and every process
                            running from the install folder
    4. backing-up           renames the install folder to <dir>.update-backup
                            (a same-parent rename is atomic, and it succeeding
                            is the proof that nothing holds a file in there)
    5. installing           runs NSIS silently into the now-empty folder
    6. verifying            exit code 0, the exe and app.asar exist
    7. launching /          starts the new Forge and waits for it to write
       waiting-for-health   update-health.json with this id and version
    8. succeeded            deletes the backup, resumes the watchdog
    9. rolling-back         on any failure in 5-7: deletes the new folder,
                            renames the backup back, relaunches the old Forge

  The full contract (parameters, phases, file schemas, exit codes) is shared
  with Forge's side in electron/update-apply.ts. Keep the two in step.

  Windows PowerShell 5.1 on purpose: it is on every Windows 10/11 machine. So
  no `??`, no `&&`, no PS7-only cmdlets, and this file stays plain ASCII (5.1
  reads a BOM-less script as ANSI, so a literal ellipsis would be mangled; the
  one in the progress text is built from its code point instead).

  Exit codes are informational - Forge reads the state file, not these:
    0 succeeded, 1 aborted, 2 rolled-back, 3 rollback-failed.

  Tested by scripts/update-apply-check.mjs (npm run update-apply:check), which
  drives every success, abort and rollback path against fake installs with
  -NoUi -LaunchHidden -SkipRegistry.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Id,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Sha512,
  [Parameter(Mandatory = $true)][string]$FromVersion,
  [Parameter(Mandatory = $true)][string]$ToVersion,
  [Parameter(Mandatory = $true)][int]$AppPid,
  [Parameter(Mandatory = $true)][string]$StateDir,
  [Parameter(Mandatory = $true)][string]$LogFile,
  [Parameter(Mandatory = $true)][string]$DataRoot,
  [string]$WatchdogTask = '',
  [string]$ExeName = 'Forge.exe',
  [string]$InstallerArgs = '/S --updated',
  [int]$ExitTimeoutSec = 30,
  [int]$InstallTimeoutSec = 600,
  [int]$HealthTimeoutSec = 120,
  [int]$ConfirmTimeoutSec = 10,
  [switch]$NoUi,
  [switch]$LaunchHidden,
  [switch]$SkipRegistry
)

$ErrorActionPreference = 'Stop'

# Started from a PowerShell 7 process, Windows PowerShell inherits pwsh's
# PSModulePath, finds pwsh's Microsoft.PowerShell.Utility first, cannot load
# it, and Get-FileHash, ConvertTo-Json and Add-Type simply do not exist. So
# this process uses the Windows PowerShell module path. Forge's own value is
# kept and handed back to the app this starts (Start-App).
$script:OrigPSModulePath = $env:PSModulePath
# Plain .NET only until the path is fixed: any cmdlet here could be the
# broken one.
$winPsModules = [System.Collections.Generic.List[string]]::new()
$candidates = @(
  [IO.Path]::Combine([Environment]::GetFolderPath('MyDocuments'), 'WindowsPowerShell\Modules'),
  [IO.Path]::Combine([Environment]::GetFolderPath('ProgramFiles'), 'WindowsPowerShell\Modules'),
  [IO.Path]::Combine($PSHOME, 'Modules')
)
$machineModules = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')
if ($machineModules) { $candidates += $machineModules.Split(';') }
foreach ($c in $candidates) {
  if ($c -and -not $winPsModules.Contains($c)) { $winPsModules.Add($c) }
}
$env:PSModulePath = [string]::Join(';', $winPsModules.ToArray())

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding $false
$script:Ell = [string][char]0x2026
$script:StateFile = Join-Path $StateDir 'update-state.json'
$script:HealthFile = Join-Path $StateDir 'update-health.json'
$script:GoFile = Join-Path $StateDir 'update-go.json'
$script:PauseFile = Join-Path $DataRoot 'watchdog.pause'
$script:Backup = ''
$script:Stage = 'preflight'        # preflight | waiting | moved | rolling | done
$script:Form = $null
$script:Label = $null
$script:AppProc = $null
$script:InstallerProc = $null
$script:PauseWritten = ''
$script:LauncherWasRunning = $false
$script:RegFiles = @()

# ------------------------------------------------------------------ basics

function Get-NowIso {
  [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
}

# One line per event, appended, UTF-8 without BOM. Forge's main process
# appends to the same file, so the stream is opened shared and retried; and a
# log that cannot be written must never stop an update.
function Write-Log([string]$Message) {
  $line = (Get-NowIso) + ' [helper] ' + (($Message -replace "`r?`n", ' | ')) + "`n"
  $bytes = $script:Utf8NoBom.GetBytes($line)
  for ($i = 0; $i -lt 5; $i++) {
    try {
      $dir = Split-Path -Parent $LogFile
      if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void][IO.Directory]::CreateDirectory($dir) }
      $fs = New-Object IO.FileStream($LogFile, [IO.FileMode]::Append, [IO.FileAccess]::Write,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
      try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
      return
    } catch {
      Start-Sleep -Milliseconds 30
    }
  }
}

function Test-Ui { return ($null -ne $script:Form) }

function Wait-Ms([int]$Ms) {
  if (Test-Ui) {
    $end = [DateTime]::UtcNow.AddMilliseconds($Ms)
    while ([DateTime]::UtcNow -lt $end) {
      try { [System.Windows.Forms.Application]::DoEvents() } catch { }
      Start-Sleep -Milliseconds 40
    }
  } else {
    Start-Sleep -Milliseconds $Ms
  }
}

# The state file is Forge's only view of what happened, so it is written
# atomically: a *.tmp beside it, then swapped in. A reader never sees half.
# -Acknowledged only for an abort a still-running Forge has already reported.
function Write-State([string]$Phase, [string]$Reason = '', [string]$BackupDir = '', [bool]$Acknowledged = $false) {
  $o = [ordered]@{ id = $Id; from = $FromVersion; to = $ToVersion; phase = $Phase }
  if ($Reason) { $o['reason'] = $Reason }
  if ($BackupDir) { $o['backupDir'] = $BackupDir }
  $o['helperPid'] = $PID
  $o['at'] = Get-NowIso
  $o['acknowledged'] = $Acknowledged
  $json = New-Object PSObject -Property $o | ConvertTo-Json -Compress
  $tmp = $script:StateFile + '.tmp'
  $written = $false
  for ($i = 0; $i -lt 20 -and -not $written; $i++) {
    try {
      if (-not (Test-Path -LiteralPath $StateDir)) { [void][IO.Directory]::CreateDirectory($StateDir) }
      [IO.File]::WriteAllText($tmp, $json, $script:Utf8NoBom)
      if ([IO.File]::Exists($script:StateFile)) {
        # [NullString]: a plain $null reaches .NET as '' and Replace throws.
        [IO.File]::Replace($tmp, $script:StateFile, [NullString]::Value)
      } else {
        [IO.File]::Move($tmp, $script:StateFile)
      }
      $written = $true
    } catch {
      $err = $_.Exception.Message
      Start-Sleep -Milliseconds 100
    }
  }
  if (-not $written) {
    # Last resort: not atomic, but a stale phase is worse than a torn write.
    try { [IO.File]::WriteAllText($script:StateFile, $json, $script:Utf8NoBom); $written = $true } catch { $err = $_.Exception.Message }
  }
  if ($Reason) { Write-Log ("phase -> $Phase (reason: $Reason)") } else { Write-Log "phase -> $Phase" }
  if (-not $written) { Write-Log "could not write the state file: $err" }
}

# Native tools (reg, schtasks) write to stderr; under 'Stop' 5.1 turns that
# into a terminating error, so they run with this scope's preference relaxed.
function Invoke-Native([string]$Exe, [string[]]$ArgList) {
  $ErrorActionPreference = 'Continue'
  $out = & $Exe @ArgList 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  return @{ Code = $code; Out = ((@($out) | Where-Object { $_ }) -join ' | ') }
}

# ------------------------------------------------------------- progress ui

function Show-Ui {
  if ($NoUi) { return }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $f = New-Object System.Windows.Forms.Form
    $f.Text = 'Updating Forge'
    $f.TopMost = $true
    $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $f.ControlBox = $false
    $f.MinimizeBox = $false
    $f.MaximizeBox = $false
    $f.ShowInTaskbar = $true
    $f.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $f.ClientSize = New-Object System.Drawing.Size(400, 80)
    $l = New-Object System.Windows.Forms.Label
    $l.Dock = [System.Windows.Forms.DockStyle]::Fill
    $l.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
    $l.Font = New-Object System.Drawing.Font('Segoe UI', 10)
    $f.Controls.Add($l)
    $f.Show()
    $script:Form = $f
    $script:Label = $l
    [System.Windows.Forms.Application]::DoEvents()
  } catch {
    $script:Form = $null
    $script:Label = $null
    Write-Log "progress window unavailable: $($_.Exception.Message)"
  }
}

function Set-Ui([string]$Text) {
  if (-not (Test-Ui)) { return }
  try {
    $script:Label.Text = $Text
    [System.Windows.Forms.Application]::DoEvents()
  } catch { }
}

function Close-Ui {
  if (-not (Test-Ui)) { return }
  try { $script:Form.Close(); $script:Form.Dispose() } catch { }
  $script:Form = $null
  $script:Label = $null
}

function Show-Message([string]$Text) {
  if ($NoUi) { return }
  Close-Ui
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($Text, 'Forge update', 'OK', 'Warning')
  } catch {
    Write-Log "could not show the message box: $($_.Exception.Message)"
  }
}

# --------------------------------------------------------------- processes

function Get-Procs {
  return @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue)
}

function Test-UnderInstall([string]$Path) {
  if (-not $Path) { return $false }
  return $Path.StartsWith($InstallDir + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-InstallProcs($All) {
  return @($All | Where-Object { $_.ProcessId -ne $PID -and (Test-UnderInstall $_.ExecutablePath) })
}

# The watchdog's vbs loop restarts its node 15 s after it is killed, so the
# launcher itself goes first. Only this install's launcher: its command line
# names the vbs AND this folder.
function Get-Launchers($All) {
  return @($All | Where-Object {
      ($_.Name -ieq 'wscript.exe' -or $_.Name -ieq 'cscript.exe') -and $_.ProcessId -ne $PID -and $_.CommandLine -and
      $_.CommandLine.IndexOf('Start Forge Watchdog.vbs', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $_.CommandLine.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
}

# Children of $RootPid, deepest first. Never walks into this helper: Forge is
# this script's parent, so a plain `taskkill /T` on Forge would kill the
# updater mid-update. A child must also be younger than its parent, or its
# ParentProcessId is a reused pid and it is not a child at all.
function Get-Descendants($All, [int]$RootPid) {
  $byPid = @{}
  foreach ($p in $All) { $byPid[[int]$p.ProcessId] = $p }
  $found = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($RootPid)
  $seen = @{ $RootPid = $true }
  while ($queue.Count -gt 0) {
    $parentPid = [int]$queue.Dequeue()
    $parent = $byPid[$parentPid]
    foreach ($c in $All) {
      $cp = [int]$c.ProcessId
      if ([int]$c.ParentProcessId -ne $parentPid -or $seen.ContainsKey($cp) -or $cp -eq $PID) { continue }
      if ($parent -and $parent.CreationDate -and $c.CreationDate -and $c.CreationDate -lt $parent.CreationDate) { continue }
      $seen[$cp] = $true
      [void]$found.Add($c)
      $queue.Enqueue($cp)
    }
  }
  $arr = $found.ToArray()
  [array]::Reverse($arr)
  return @($arr)
}

function Stop-Tree($Proc, $All, [string]$Why, [hashtable]$Killed) {
  $victims = @(Get-Descendants $All ([int]$Proc.ProcessId)) + @($Proc)
  foreach ($v in $victims) {
    $vp = [int]$v.ProcessId
    if ($vp -eq $PID -or $Killed.ContainsKey($vp)) { continue }
    $Killed[$vp] = $true
    try {
      Stop-Process -Id $vp -Force -ErrorAction Stop
      Write-Log "killed $($v.Name) pid $vp path $($v.ExecutablePath) ($Why)"
    } catch {
      Write-Log "could not kill $($v.Name) pid $vp path $($v.ExecutablePath): $($_.Exception.Message)"
    }
  }
}

# One pass: launchers, then everything running from the install folder.
# Returns how many it went after.
function Invoke-Sweep([string]$Why) {
  $all = Get-Procs
  $killed = @{}
  $n = 0
  foreach ($l in (Get-Launchers $all)) { Stop-Tree $l $all "watchdog launcher, $Why" $killed; $n++ }
  foreach ($p in (Get-InstallProcs $all)) {
    if ($killed.ContainsKey([int]$p.ProcessId)) { continue }
    Stop-Tree $p $all "runs from the install folder, $Why" $killed
    $n++
  }
  return $n
}

function Stop-InstallProcesses([int]$BudgetSec, [string]$Why) {
  $deadline = [DateTime]::UtcNow.AddSeconds($BudgetSec)
  $pass = 0
  while ($true) {
    $pass++
    $n = Invoke-Sweep $Why
    if ($n -eq 0) {
      Write-Log "sweep $pass ($Why): nothing left running from the install folder"
      return
    }
    if ([DateTime]::UtcNow -ge $deadline) {
      Write-Log "sweep $pass ($Why): processes still running after $BudgetSec s; going on"
      return
    }
    Wait-Ms 500
  }
}

function Get-Blockers {
  $names = @()
  foreach ($p in (Get-InstallProcs (Get-Procs))) { $names += "$($p.Name) (pid $($p.ProcessId))" }
  return $names
}

# ------------------------------------------------------------------- files

function Remove-Dir([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  try {
    [IO.Directory]::Delete($Path, $true)
    return $true
  } catch {
    $first = $_.Exception.Message
  }
  # A read-only file stops Directory.Delete; clear the flags and go again.
  try {
    Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object { -not $_.PSIsContainer -and ($_.Attributes -band [IO.FileAttributes]::ReadOnly) } |
      ForEach-Object { $_.Attributes = [IO.FileAttributes]::Normal }
    [IO.Directory]::Delete($Path, $true)
    return $true
  } catch {
    Write-Log "could not delete $Path : $first / $($_.Exception.Message)"
    return $false
  }
}

function Move-DirOnce([string]$From, [string]$To) {
  try {
    [IO.Directory]::Move($From, $To)
    return ''
  } catch {
    return $_.Exception.Message
  }
}

function Get-Sha512Base64([string]$Path) {
  $hex = (Get-FileHash -LiteralPath $Path -Algorithm SHA512).Hash
  $bytes = New-Object byte[] ($hex.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
  return [Convert]::ToBase64String($bytes)
}

# A small JSON file (state, health, go), or $null when missing, torn or empty.
function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $t = [IO.File]::ReadAllText($Path, $script:Utf8NoBom)
    if ($t.Length -gt 0 -and $t[0] -eq [char]0xFEFF) { $t = $t.Substring(1) }
    if (-not $t.Trim()) { return $null }
    return ($t | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Read-Health { return (Read-JsonFile $script:HealthFile) }

# -------------------------------------------------------------- the app

function Start-App([string]$Which) {
  $exe = Join-Path $InstallDir $ExeName
  # Forge's env is inherited; the watchdog's switch must not be.
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $ours = $env:PSModulePath
  $env:PSModulePath = $script:OrigPSModulePath
  try {
    $sp = @{ FilePath = $exe; WorkingDirectory = $InstallDir; PassThru = $true }
    if ($LaunchHidden) { $sp['WindowStyle'] = 'Hidden' }
    $p = Start-Process @sp
    Write-Log "started the $Which ($exe) pid $($p.Id)"
    return $p
  } catch {
    Write-Log "could not start the $Which ($exe): $($_.Exception.Message)"
    return $null
  } finally {
    $env:PSModulePath = $ours
  }
}

# ---------------------------------------------------------------- watchdog

function Suspend-Watchdog {
  $script:LauncherWasRunning = ((Get-Launchers (Get-Procs)).Count -gt 0)
  Write-Log "watchdog launcher running: $($script:LauncherWasRunning)"
  if (Test-Path -LiteralPath $script:PauseFile) {
    $existing = ''
    try { $existing = ([IO.File]::ReadAllText($script:PauseFile)).Trim() } catch { }
    Write-Log "watchdog pause file already exists ('$existing'); leaving it as it is"
    return
  }
  # watchdog.mjs reads the file as epoch milliseconds (0 = until resumed) and
  # deletes it once expired, so an expiry means a helper that dies can never
  # leave the watchdog off for good. Long enough for every wait below.
  $budgetSec = $ExitTimeoutSec + $InstallTimeoutSec + $HealthTimeoutSec + 180
  $until = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ([int64]$budgetSec * 1000)
  try {
    if (-not (Test-Path -LiteralPath $DataRoot)) { [void][IO.Directory]::CreateDirectory($DataRoot) }
    [IO.File]::WriteAllText($script:PauseFile, [string]$until, $script:Utf8NoBom)
    $script:PauseWritten = [string]$until
    Write-Log "watchdog paused until $until ($budgetSec s) via $($script:PauseFile)"
  } catch {
    Write-Log "could not write the watchdog pause file: $($_.Exception.Message)"
  }
}

function Resume-Watchdog {
  if ($script:PauseWritten) {
    try {
      if (Test-Path -LiteralPath $script:PauseFile) {
        $now = ([IO.File]::ReadAllText($script:PauseFile)).Trim()
        if ($now -eq $script:PauseWritten) {
          Remove-Item -LiteralPath $script:PauseFile -Force
          Write-Log 'watchdog pause file removed'
        } else {
          Write-Log "watchdog pause file was changed by someone else ('$now'); leaving it"
        }
      } else {
        Write-Log 'watchdog pause file already gone'
      }
    } catch {
      Write-Log "could not remove the watchdog pause file: $($_.Exception.Message)"
    }
    $script:PauseWritten = ''
  }
  if ($script:LauncherWasRunning) {
    if ($WatchdogTask) {
      $r = Invoke-Native 'schtasks.exe' @('/Run', '/TN', $WatchdogTask)
      Write-Log "schtasks /Run /TN `"$WatchdogTask`" exit $($r.Code): $($r.Out)"
    } else {
      Write-Log 'the watchdog launcher was running but no -WatchdogTask was given; not restarting it'
    }
  }
}

# ---------------------------------------------------------------- registry

function Export-Registry {
  if ($SkipRegistry) { Write-Log 'registry: skipped (-SkipRegistry)'; return }
  try {
    $base = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
    $key = ''
    foreach ($k in @(Get-ChildItem -LiteralPath $base -ErrorAction SilentlyContinue)) {
      $p = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
      if (-not $p) { continue }
      $loc = [string]$p.InstallLocation
      $us = [string]$p.UninstallString
      if (($loc -and $loc.Trim('"').TrimEnd('\') -ieq $InstallDir) -or
        ($us -and $us.IndexOf($InstallDir + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0)) {
        $key = $k.PSChildName
        break
      }
    }
    if (-not $key) { Write-Log 'registry: no uninstall key points at the install folder; nothing exported'; return }
    $work = Split-Path -Parent $Installer
    $pairs = @(
      @("HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\$key", (Join-Path $work 'uninstall-key.reg')),
      @("HKCU\Software\$key", (Join-Path $work 'install-key.reg'))
    )
    foreach ($pair in $pairs) {
      if (-not (Test-Path -LiteralPath ('Registry::HKEY_CURRENT_USER' + $pair[0].Substring(4)))) {
        Write-Log "registry: $($pair[0]) does not exist; skipped"
        continue
      }
      $r = Invoke-Native 'reg.exe' @('export', $pair[0], $pair[1], '/y')
      Write-Log "registry: reg export $($pair[0]) -> $($pair[1]) exit $($r.Code)"
      if ($r.Code -eq 0) { $script:RegFiles += $pair[1] }
    }
  } catch {
    Write-Log "registry export failed (ignored): $($_.Exception.Message)"
  }
}

function Import-Registry {
  foreach ($f in $script:RegFiles) {
    try {
      $r = Invoke-Native 'reg.exe' @('import', $f)
      Write-Log "registry: reg import $f exit $($r.Code)"
    } catch {
      Write-Log "registry import of $f failed (ignored): $($_.Exception.Message)"
    }
  }
}

# ------------------------------------------------------------------ steps

# Returns '' when every check passes, else the plain-English reason.
function Test-Preflight {
  $full = [IO.Path]::GetFullPath($InstallDir)
  $root = [IO.Path]::GetPathRoot($full)
  if ($full.TrimEnd('\') -ieq $root.TrimEnd('\')) { return "The install folder is a whole drive ($full), which is not a Forge install." }
  $parent = Split-Path -Parent $InstallDir
  if (-not $parent -or -not (Test-Path -LiteralPath $parent -PathType Container)) { return "The folder that holds Forge's install folder was not found ($parent)." }
  if (-not (Test-Path -LiteralPath $InstallDir -PathType Container)) { return "Forge's install folder was not found ($InstallDir)." }
  foreach ($rel in @($ExeName, 'resources\app.asar', 'Uninstall Forge.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir $rel))) {
      return "The install folder $InstallDir does not look like a Forge install: $rel is missing."
    }
  }
  if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { return "The downloaded installer is missing ($Installer)." }
  $actual = Get-Sha512Base64 $Installer
  Write-Log "installer sha512 $actual (expected $Sha512)"
  if ($actual -cne $Sha512) { return 'The downloaded update is damaged: its checksum does not match. Download it again.' }
  $size = (Get-Item -LiteralPath $Installer).Length
  try {
    $drive = New-Object IO.DriveInfo($root)
    $free = $drive.AvailableFreeSpace
    Write-Log "free space on $root : $free bytes; installer $size bytes"
    if ($free -lt (3 * $size)) {
      return ("Not enough free disk space on $root to update Forge: it needs about {0} MB and {1} MB are free." -f [math]::Ceiling(3 * $size / 1MB), [math]::Floor($free / 1MB))
    }
  } catch {
    Write-Log "could not read the free space on $root ($($_.Exception.Message)); going on"
  }
  if (Test-Path -LiteralPath $script:Backup) {
    Write-Log "removing a stale backup from an earlier run: $($script:Backup)"
    if (-not (Remove-Dir $script:Backup)) {
      return "An old update backup could not be removed ($($script:Backup)). Delete that folder and try again."
    }
    Write-Log 'removed the stale backup'
  }
  return ''
}

# Forge writes update-go.json with this id once it has seen waiting-for-exit
# and committed to quitting. Forge gives up on the handshake after 20 s and
# tells the user the update failed; a helper that only gets here after that
# (a slow start, an antivirus scan) must then leave Forge and the disk alone.
# Returns $true when the go file for this id arrived in time.
function Wait-Go {
  Write-Log "waiting up to $ConfirmTimeoutSec s for Forge to confirm via $($script:GoFile)"
  $deadline = [DateTime]::UtcNow.AddSeconds($ConfirmTimeoutSec)
  $lastBad = ''
  while ($true) {
    $g = Read-JsonFile $script:GoFile
    if ($g) {
      $gid = [string]$g.id
      if ($gid -ceq $Id) { Write-Log "Forge confirmed at $($g.at)"; return $true }
      if ($gid -ne $lastBad) { Write-Log "ignoring a go file for another update (id $gid)"; $lastBad = $gid }
    }
    if ([DateTime]::UtcNow -ge $deadline) { return $false }
    Wait-Ms 100
  }
}

function Wait-AppExit {
  $p = $script:AppProc
  if (-not $p) { Write-Log "Forge (pid $AppPid) was not running; nothing to wait for"; return }
  Write-Log "waiting up to $ExitTimeoutSec s for Forge (pid $AppPid) to exit"
  $deadline = [DateTime]::UtcNow.AddSeconds($ExitTimeoutSec)
  while (-not $p.HasExited -and [DateTime]::UtcNow -lt $deadline) { Wait-Ms 200 }
  if ($p.HasExited) { Write-Log "Forge (pid $AppPid) exited"; return }
  Write-Log "Forge (pid $AppPid) did not exit within $ExitTimeoutSec s; killing it"
  foreach ($c in (Get-Descendants (Get-Procs) $AppPid)) {
    try { Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop; Write-Log "killed $($c.Name) pid $($c.ProcessId) path $($c.ExecutablePath) (child of Forge)" } catch { }
  }
  try {
    $path = ''
    $name = ''
    try { $path = $p.MainModule.FileName; $name = [IO.Path]::GetFileName($path) } catch { }
    $p.Kill()
    [void]$p.WaitForExit(5000)
    Write-Log "killed $name pid $AppPid path $path (did not exit in time)"
  } catch {
    Write-Log "could not kill Forge (pid $AppPid): $($_.Exception.Message)"
  }
}

# Returns '' on success, else the reason the rename failed for good.
function Move-InstallAside {
  for ($attempt = 1; $attempt -le 10; $attempt++) {
    $err = Move-DirOnce $InstallDir $script:Backup
    if (-not $err) {
      Write-Log "renamed $InstallDir -> $($script:Backup) (attempt $attempt)"
      return ''
    }
    Write-Log "rename attempt $attempt failed: $err"
    if ($attempt -lt 10) {
      Wait-Ms 1000
      [void](Invoke-Sweep "rename retry $attempt")
    }
  }
  $blockers = @(Get-Blockers)
  if ($blockers.Count -gt 0) {
    $who = $blockers -join ', '
  } else {
    $who = 'another program'
  }
  return "Files in use by $who, so the update could not start. Nothing was changed; close it and try the update again."
}

# Steps 5-7. Returns '' when the new version reported healthy, else why not.
function Install-New {
  Write-State 'installing'
  Set-Ui "Installing Forge $ToVersion$($script:Ell)"
  if (Test-Path -LiteralPath $script:HealthFile) {
    try { Remove-Item -LiteralPath $script:HealthFile -Force; Write-Log 'removed an old health file' } catch { Write-Log "could not remove the old health file: $($_.Exception.Message)" }
  }
  # NSIS takes everything after /D= as the folder, spaces and all: it must be
  # the last argument and must not be quoted.
  $argLine = ("$InstallerArgs /D=$InstallDir").Trim()
  Write-Log "running the installer: `"$Installer`" $argLine (timeout $InstallTimeoutSec s)"
  try {
    $p = Start-Process -FilePath $Installer -ArgumentList $argLine -WindowStyle Hidden -PassThru
    $null = $p.Handle   # keeps ExitCode readable after the process is gone
    $script:InstallerProc = $p
  } catch {
    return "The installer could not be started: $($_.Exception.Message)"
  }
  Write-Log "installer pid $($p.Id)"
  $deadline = [DateTime]::UtcNow.AddSeconds($InstallTimeoutSec)
  while (-not $p.HasExited -and [DateTime]::UtcNow -lt $deadline) { Wait-Ms 250 }
  if (-not $p.HasExited) {
    Write-Log "the installer did not finish within $InstallTimeoutSec s; killing it"
    $killed = @{}
    $all = Get-Procs
    $self = @($all | Where-Object { [int]$_.ProcessId -eq $p.Id })
    if ($self.Count -gt 0) { Stop-Tree $self[0] $all 'installer timed out' $killed }
    return "The installer did not finish within $InstallTimeoutSec seconds."
  }
  $p.WaitForExit()
  $code = $p.ExitCode
  Write-Log "installer exit code $code"

  Write-State 'verifying'
  Set-Ui "Checking the new version$($script:Ell)"
  if ($code -ne 0) { return "The installer stopped with error code $code." }
  $exe = Join-Path $InstallDir $ExeName
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return "The installer finished but $ExeName is missing." }
  if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'resources\app.asar') -PathType Leaf)) { return 'The installer finished but resources\app.asar is missing.' }
  $vi = (Get-Item -LiteralPath $exe).VersionInfo
  $ver = ''
  if ($vi) {
    if ($vi.ProductVersion) { $ver = [string]$vi.ProductVersion } elseif ($vi.FileVersion) { $ver = [string]$vi.FileVersion }
  }
  if ($ver) {
    Write-Log "installed $ExeName version $ver"
    if (-not $ver.Trim().StartsWith($ToVersion, [StringComparison]::OrdinalIgnoreCase)) {
      return "The installed Forge is version $ver, not $ToVersion."
    }
  } else {
    Write-Log "$ExeName carries no version; skipping the version check"
  }
  Write-Log 'verified the new install'

  Write-State 'launching'
  Set-Ui "Starting the new version$($script:Ell)"
  $launched = [DateTime]::UtcNow
  $app = Start-App 'new version'
  if (-not $app) { return 'The new version could not be started.' }
  Write-State 'waiting-for-health'
  Write-Log "waiting up to $HealthTimeoutSec s for $($script:HealthFile)"
  $deadline = $launched.AddSeconds($HealthTimeoutSec)
  $lastSeen = $launched
  $nextProcCheck = $launched
  $lastBad = ''
  while ([DateTime]::UtcNow -lt $deadline) {
    $h = Read-Health
    if ($h) {
      $hid = [string]$h.id
      $hver = [string]$h.version
      if ($hid -ceq $Id -and $hver -ceq $ToVersion) {
        Write-Log "health reported: version $hver pid $($h.pid) at $($h.at)"
        return ''
      }
      if ($hid -ceq $Id) {
        Write-Log "health reported the wrong version: $hver (expected $ToVersion)"
        return "The new version reported itself as $hver instead of $ToVersion."
      }
      $bad = "id $hid version $hver"
      if ($bad -ne $lastBad) { Write-Log "ignoring a health file for another update ($bad)"; $lastBad = $bad }
    }
    $now = [DateTime]::UtcNow
    if ($now -ge $nextProcCheck) {
      if ((Get-InstallProcs (Get-Procs)).Count -gt 0) {
        $lastSeen = $now
      } elseif (($now - $lastSeen).TotalSeconds -ge 15) {
        Write-Log 'no process has run from the install folder for 15 s'
        return 'The new version closed straight after it started.'
      }
      $nextProcCheck = $now.AddSeconds(2)
    }
    Wait-Ms 250
  }
  return "The new version did not report that it started correctly within $HealthTimeoutSec seconds."
}

function Invoke-Rollback([string]$Why) {
  $script:Stage = 'rolling'
  Write-Log "rolling back: $Why"
  Write-State 'rolling-back'
  Set-Ui "Putting the old version back$($script:Ell)"
  $p = $script:InstallerProc
  if ($p -and -not $p.HasExited) {
    $killed = @{}
    $all = Get-Procs
    $self = @($all | Where-Object { [int]$_.ProcessId -eq $p.Id })
    if ($self.Count -gt 0) { Stop-Tree $self[0] $all 'rolling back' $killed }
  }
  Stop-InstallProcesses 20 'rolling back'
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $attempt = 0
  $restored = $false
  while ($true) {
    $attempt++
    if (Test-Path -LiteralPath $InstallDir) {
      if (Remove-Dir $InstallDir) { Write-Log "deleted the new install folder (attempt $attempt)" }
    }
    if (-not (Test-Path -LiteralPath $InstallDir)) {
      $err = Move-DirOnce $script:Backup $InstallDir
      if (-not $err) {
        Write-Log "renamed $($script:Backup) -> $InstallDir (attempt $attempt)"
        $restored = $true
        break
      }
      Write-Log "rename back attempt $attempt failed: $err"
    }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Wait-Ms 1000
    [void](Invoke-Sweep "rollback retry $attempt")
  }
  if ($restored) {
    Import-Registry
    $reason = "Forge $ToVersion could not be installed: $Why Forge $FromVersion has been put back."
    Write-State 'rolled-back' $reason
    [void](Start-App 'old version')
    Resume-Watchdog
    $script:Stage = 'done'
    return 2
  }
  $reason = "Forge $ToVersion could not be installed ($Why) and the previous version could not be put back. Your old copy is in $($script:Backup): rename that folder to $InstallDir to get Forge back."
  Write-State 'rollback-failed' $reason $script:Backup
  # Nothing to run, so the watchdog stays paused rather than spinning on a
  # missing Forge.exe; the pause file's expiry ends that by itself.
  Write-Log 'the watchdog stays paused until its pause file expires'
  $script:Stage = 'done'
  Show-Message $reason
  return 3
}

function Invoke-Update {
  Write-State 'preflight'
  $why = Test-Preflight
  if ($why) {
    Write-State 'aborted' $why
    Write-Log 'aborted at preflight; Forge is still open, so nothing is relaunched'
    $script:Stage = 'done'
    return 1
  }
  Write-Log 'preflight passed'

  # The handshake. Nothing may touch Forge, the watchdog or the disk until
  # Forge has confirmed, so $script:Stage stays 'preflight' (an error here
  # aborts without relaunching anything).
  Write-State 'waiting-for-exit'
  if (-not (Wait-Go)) {
    # A Forge still running has already shown the user a failure (or will,
    # from this state), so its next launch need not show it again.
    $ack = ($null -ne $script:AppProc -and -not $script:AppProc.HasExited)
    Write-State 'aborted' 'Forge did not confirm the update in time; nothing was changed.' '' $ack
    Write-Log 'aborted before touching anything: no go file from Forge; nothing is relaunched'
    $script:Stage = 'done'
    return 1
  }

  $script:Stage = 'waiting'
  Show-Ui
  Suspend-Watchdog
  Set-Ui "Waiting for Forge to close$($script:Ell)"
  Wait-AppExit

  Write-State 'stopping-processes'
  Set-Ui "Closing Forge's background programs$($script:Ell)"
  Stop-InstallProcesses 20 'stopping'

  Write-State 'backing-up'
  Set-Ui "Keeping a copy of the current version$($script:Ell)"
  $why = Move-InstallAside
  if ($why) {
    Write-State 'aborted' $why
    Set-Ui "The update could not start. Reopening Forge$($script:Ell)"
    [void](Start-App 'old version')
    Resume-Watchdog
    $script:Stage = 'done'
    return 1
  }
  $script:Stage = 'moved'
  Export-Registry

  $why = Install-New
  if ($why) { return (Invoke-Rollback $why) }

  Write-State 'succeeded'
  Set-Ui "Forge $ToVersion is installed."
  $script:Stage = 'done'
  if (Remove-Dir $script:Backup) { Write-Log "deleted the backup $($script:Backup)" } else { Write-Log "the backup $($script:Backup) is left behind" }
  Resume-Watchdog
  return 0
}

# -------------------------------------------------------------------- main

$exitCode = 1
try {
  $InstallDir = [IO.Path]::GetFullPath($InstallDir)
  if ($InstallDir.Length -gt 3) { $InstallDir = $InstallDir.TrimEnd('\') }
  $script:Backup = $InstallDir + '.update-backup'
  Write-Log ("helper started: id $Id, $FromVersion -> $ToVersion, pid $PID, Forge pid $AppPid, install $InstallDir, " +
    "installer $Installer, exe $ExeName, args '$InstallerArgs', timeouts exit $ExitTimeoutSec s install $InstallTimeoutSec s health $HealthTimeoutSec s, " +
    "ui $(-not $NoUi), hidden launch $LaunchHidden, registry $(-not $SkipRegistry), watchdog task '$WatchdogTask'")
  # Forge records `aborted` itself when the handshake times out. A helper that
  # starts after that has nothing to do: Forge told the user it failed.
  $prior = Read-JsonFile $script:StateFile
  if ($prior -and ([string]$prior.id -ceq $Id) -and ([string]$prior.phase -ceq 'aborted')) {
    Write-Log 'the state file already says aborted for this update (Forge gave up on the handshake); exiting without touching anything'
    $script:Stage = 'done'
    $exitCode = 1
  } else {
    # A handle now pins the process: a pid looked up later could be reused.
    try {
      $script:AppProc = [Diagnostics.Process]::GetProcessById($AppPid)
      $null = $script:AppProc.Handle
    } catch {
      $script:AppProc = $null
      Write-Log "Forge (pid $AppPid) is not running"
    }
    $exitCode = Invoke-Update
  }
} catch {
  $msg = "$($_.Exception.Message) ($($_.InvocationInfo.ScriptLineNumber))"
  Write-Log "unexpected error during stage $($script:Stage): $msg"
  try {
    if ($script:Stage -eq 'preflight') {
      Write-State 'aborted' "The updater hit an unexpected error before changing anything: $($_.Exception.Message)"
      $exitCode = 1
    } elseif ($script:Stage -eq 'waiting') {
      if (-not (Test-Path -LiteralPath $InstallDir) -and (Test-Path -LiteralPath $script:Backup)) {
        # The rename went through just before the error: treat it as moved.
        $exitCode = Invoke-Rollback "the updater hit an unexpected error: $($_.Exception.Message)."
      } else {
        Write-State 'aborted' "The updater hit an unexpected error before changing anything: $($_.Exception.Message)"
        [void](Start-App 'old version')
        Resume-Watchdog
        $exitCode = 1
      }
    } elseif ($script:Stage -eq 'moved') {
      $exitCode = Invoke-Rollback "the updater hit an unexpected error: $($_.Exception.Message)."
    } elseif ($script:Stage -eq 'rolling') {
      $reason = "Forge $ToVersion could not be installed and putting the previous version back failed ($($_.Exception.Message)). If $InstallDir is missing or broken, your old copy is in $($script:Backup): rename that folder to $InstallDir to get Forge back."
      Write-State 'rollback-failed' $reason $script:Backup
      Show-Message $reason
      $exitCode = 3
    }
  } catch {
    Write-Log "recovery after the error failed too: $($_.Exception.Message)"
    $exitCode = 3
  }
} finally {
  Close-Ui
}
Write-Log "helper exit $exitCode"
exit $exitCode
