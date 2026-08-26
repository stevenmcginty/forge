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

Dim sh, fso, root, code, nodeExe, script, config, cmd
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

Do
  ' 0 = hidden, True = wait. A healthy watchdog never returns; exit code 0
  ' means it found another copy already running for this profile and stood
  ' down, so this launcher should too. Anything else is a crash: restart it.
  code = sh.Run("cmd /c " & cmd & " >nul 2>&1", 0, True)
  If code = 0 Then Exit Do
  WScript.Sleep 15000
Loop
