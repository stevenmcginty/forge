' Run the Forge watchdog (scripts/watchdog.mjs) with no console window, and
' keep it running: if node ever exits, wait a moment and start it again.
'
' This is what the "Forge Watchdog (<profile>)" logon task points at - see
' electron/watchdog-host.ts (the Settings toggle) and scripts/watchdog-install.mjs.
' Run it by hand to start the watchdog now.
'
' Optional arguments, all three or none:
'   1. the node executable  - "node", or Forge.exe when packaged (it is run
'                             with ELECTRON_RUN_AS_NODE=1, which makes Electron
'                             behave as plain node)
'   2. the watchdog script  - scripts\watchdog.mjs, wherever it was shipped
'   3. the config file      - <data root>\watchdog.json, which tells the script
'                             what to relaunch and which folder is "this Forge"
'
' With no arguments it runs the checkout next to it, the way it always did.
'
' The watchdog is per checkout/install, like the launchers next to it: it only
' ever kills processes whose command line names its own root folder.

Option Explicit

Dim sh, fso, root, code, nodeExe, script, config, cmd, logPath
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root

nodeExe = "node"
script  = fso.BuildPath(root, "scripts\watchdog.mjs")
config  = ""
If WScript.Arguments.Count >= 3 Then
  nodeExe = WScript.Arguments(0)
  script  = WScript.Arguments(1)
  config  = WScript.Arguments(2)
End If

' Forge.exe as node: harmless for real node, essential for Electron.
If LCase(Right(nodeExe, 4)) = ".exe" And InStr(LCase(nodeExe), "node.exe") = 0 Then
  sh.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"
End If

cmd = """" & nodeExe & """ """ & script & """"
If config <> "" Then cmd = cmd & " --config """ & config & """"

' Where a launcher that cannot start node says so. `>nul 2>&1` hid exactly
' that for two days -- cmd was returning 1 without a word and this loop just
' span -- and node's own output cannot go here instead: the healthy watchdog
' would hold the file open, and the copy the task starts every 10 minutes would
' fail to redirect onto it and spin for ever. So: the exit code, appended on
' failure only, by a handle that is closed straight away.
logPath = ""
If config <> "" Then logPath = fso.BuildPath(fso.GetParentFolderName(config), "watchdog-launcher.log")
cmd = cmd & " >nul 2>&1"

' The whole command wrapped in one more pair of quotes, which is not
' decoration: `cmd /c "node" "<script>" ...` begins with a quote, and cmd then
' strips the first and last quote of the line, mangling it into something that
' exits 1 without a word. `cmd /c "..."` is the documented form that makes cmd
' strip the outer pair and run the rest verbatim.
cmd = "cmd /c """ & cmd & """"

Do
  ' 0 = hidden, True = wait. A healthy watchdog never returns; exit code 0
  ' means it found another copy already running for this profile and stood
  ' down, so this launcher should too. Anything else is a crash: restart it.
  code = sh.Run(cmd, 0, True)
  If code = 0 Then Exit Do
  Note "node exited " & code & " -- retrying in 15s: " & cmd
  WScript.Sleep 15000
Loop

Sub Note(line)
  Dim f
  If logPath = "" Then Exit Sub
  On Error Resume Next
  Set f = fso.OpenTextFile(logPath, 8, True)
  f.WriteLine Now & " " & line
  f.Close
End Sub
