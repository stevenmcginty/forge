' Start Forge with no console window.
'
' The desktop shortcut points here rather than at Start Forge.cmd, because
' `npm run dev` is a console program: run it from a .cmd and Windows gives you a
' CMD window for the whole session, and closing that window kills Forge.
'
' So the dev server runs hidden and its output goes to a log instead of a
' console. The one thing worth not losing is a startup failure - a port in use,
' a syntax error in main, a missing node_modules - where nothing appears on
' screen and no window to read. Hence the elapsed-time check at the
' bottom: die in the first 20 seconds and the log opens in Notepad. Exit later
' than that and Forge started fine and you closed it, whatever the exit code.
'
' Start Forge.cmd is still there and still works. Use it when you want to watch
' the dev server live.

Option Explicit

Dim sh, fso, root, dir, logFile, started, elapsed, code

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)

' %APPDATA%\Forge is the app's own data folder - the log belongs with it, not
' in the repo working tree.
dir = sh.ExpandEnvironmentStrings("%APPDATA%") & "\Forge"
If Not fso.FolderExists(dir) Then fso.CreateFolder(dir)
logFile = dir & "\dev.log"

sh.CurrentDirectory = root

started = Timer

' 0 = hidden window, True = wait for it to exit. This script stays alive for the
' life of the session as an invisible wscript.exe, which is what lets it report
' a startup failure after the fact.
code = sh.Run("cmd /c npm run dev > """ & logFile & """ 2>&1", 0, True)

elapsed = Timer - started
If elapsed < 0 Then elapsed = elapsed + 86400  ' Timer resets at midnight

If code <> 0 And elapsed < 20 Then
  sh.Popup "Forge could not start. Opening the log.", 10, "Forge", 48
  sh.Run "notepad.exe """ & logFile & """", 1, False
End If
