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

Dim sh, fso, root, dir, logFile, started, elapsed, code, marker, profile, ts, line, attempt

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)

' Which profile this checkout owns, from the untracked .forge-profile file -
' the same one scripts/dev.mjs reads. No marker means the stable checkout and
' the real data. This must not be hardcoded: this file is tracked, so a
' hardcoded "Forge Dev" travels to the stable checkout on the next pull and
' sends the everyday app to an empty profile.
profile = "Forge"
marker = fso.BuildPath(root, ".forge-profile")
If fso.FileExists(marker) Then
  Set ts = fso.OpenTextFile(marker, 1)
  If Not ts.AtEndOfStream Then
    line = Trim(ts.ReadLine)
    If line <> "" Then profile = line
  End If
  ts.Close
End If

' The app's own data folder - the log belongs with it, not in the repo
' working tree.
dir = sh.ExpandEnvironmentStrings("%APPDATA%") & "\" & profile
If Not fso.FolderExists(dir) Then fso.CreateFolder(dir)
logFile = dir & "\dev.log"

sh.CurrentDirectory = root

' Reap zombies BEFORE the log is opened. A dev tree whose window died ugly
' still holds dev.log's write handle; the `> log` redirect below then fails
' with a sharing violation before npm - and the cleanup it would run - ever
' starts. Nothing can be launched until someone kills the zombie, so that
' someone is this line, whose own output goes to nul precisely because the
' log may be the thing that is stuck.
sh.Run "cmd /c node ""scripts\predev-cleanup.mjs"" >nul 2>&1", 0, True

' Belt and braces: if dev.log is still locked (a holder the cleanup could not
' see), take a sibling name rather than dying on the redirect. A launch must
' never fail because of where its log goes.
On Error Resume Next
Set ts = fso.OpenTextFile(logFile, 8, True)
If Err.Number <> 0 Then
  Err.Clear
  logFile = dir & "\dev-2.log"
Else
  ts.Close
End If
On Error GoTo 0

' Two attempts, not one. The common startup failure is not broken code - it is
' closing Forge and reopening it before the old process tree has finished
' dying, so the new one loses the fight over a port or the single-instance
' lock. That resolves itself in seconds, so a fast failure gets one quiet
' retry after a pause. Only when the retry also dies fast is it a real
' failure worth a popup and the log.
For attempt = 1 To 2
  started = Timer

  ' 0 = hidden window, True = wait for it to exit. This script stays alive for
  ' the life of the session as an invisible wscript.exe, which is what lets it
  ' report a startup failure after the fact.
  code = sh.Run("cmd /c npm run dev > """ & logFile & """ 2>&1", 0, True)

  elapsed = Timer - started
  If elapsed < 0 Then elapsed = elapsed + 86400  ' Timer resets at midnight

  If code = 0 Or elapsed >= 20 Then Exit For
  If attempt = 1 Then WScript.Sleep 4000
Next

If code <> 0 And elapsed < 20 Then
  sh.Popup "Forge could not start. Opening the log.", 10, "Forge", 48
  sh.Run "notepad.exe """ & logFile & """", 1, False
End If
