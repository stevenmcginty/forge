' Run the Forge watchdog (scripts/watchdog.mjs) with no console window, and
' keep it running: if node ever exits, wait a moment and start it again.
'
' This is what the "Forge Watchdog" logon task points at - see
' scripts/watchdog-install.mjs. Run it by hand to start the watchdog now.
'
' The watchdog is per checkout, like the launchers next to it: it reads the
' untracked .forge-profile the same way, watches that profile's heartbeat, and
' only ever kills processes whose command line names this folder.

Option Explicit

Dim sh, fso, root, code
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root

Do
  ' 0 = hidden, True = wait. A healthy watchdog never returns; exit code 0
  ' means it found another copy already running for this checkout and stood
  ' down, so this launcher should too. Anything else is a crash: restart it.
  code = sh.Run("cmd /c node ""scripts\watchdog.mjs"" >nul 2>&1", 0, True)
  If code = 0 Then Exit Do
  WScript.Sleep 15000
Loop
