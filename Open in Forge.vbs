' Open a markdown file in the Read view of the Forge run from this checkout.
'
'   wscript "Open in Forge.vbs" "C:\path\to\notes.md"
'
' Explorer's "Open with > Forge" for .md files runs this (the source-run Forge
' registers it under HKCU\Software\Classes\Forge.Markdown at startup - see
' electron/reader.ts). A packaged Forge does not need it: Windows hands the file
' straight to Forge.exe.
'
' `npm run dev` ignores its arguments, so the path cannot ride along on a
' command line. Instead this drops one request file into the data folder's
' reader-inbox\, which Forge drains at boot and watches while it runs, and then
' starts Forge if it is not already up.
'
' "Is Forge up" is main's pid, written to reader-inbox\.forge-pid at boot and
' checked here against WMI. Starting a second Forge while one is running is not
' harmless - its predev cleanup would kill the running one's dev server - so a
' launch also leaves reader-inbox\.forge-launch behind, and a second
' double-click inside the next 90 seconds (Forge still starting, no pid yet)
' does not launch again. Forge deletes the stamp once it is up.

Option Explicit

Dim sh, fso, root, marker, ts, line, profile, dataRoot, envRoot, inbox
Dim target, stamp, name, tmpFile, pidFile, pid, running, wmi, procs, p, launchStamp

If WScript.Arguments.Count = 0 Then WScript.Quit 0

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
target = fso.GetAbsolutePathName(WScript.Arguments(0))

' Which profile this checkout owns - the same .forge-profile rule as
' Start Forge (silent).vbs. No marker means the stable checkout and the real data.
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

' And the data root the same way scripts/dev.mjs works it out: FORGE_DATA_DIR
' when set, otherwise %APPDATA%\<profile>.
envRoot = Trim(sh.ExpandEnvironmentStrings("%FORGE_DATA_DIR%"))
If envRoot <> "" And envRoot <> "%FORGE_DATA_DIR%" Then
  dataRoot = fso.GetAbsolutePathName(envRoot)
Else
  dataRoot = sh.ExpandEnvironmentStrings("%APPDATA%") & "\" & profile
End If
If Not fso.FolderExists(dataRoot) Then fso.CreateFolder(dataRoot)
inbox = dataRoot & "\reader-inbox"
If Not fso.FolderExists(inbox) Then fso.CreateFolder(inbox)

' One request per file, under a name nothing else will pick. Written as .tmp
' and renamed, so Forge never reads one half-written. Unicode mode is UTF-16LE
' with a BOM, so a path with non-ASCII characters in it survives.
Randomize
stamp = Year(Now) & Right("0" & Month(Now), 2) & Right("0" & Day(Now), 2) & "-" & _
        Right("0" & Hour(Now), 2) & Right("0" & Minute(Now), 2) & Right("0" & Second(Now), 2)
name = "req-" & stamp & "-" & CStr(Int(Rnd * 1000000000))
tmpFile = inbox & "\" & name & ".tmp"
Set ts = fso.CreateTextFile(tmpFile, True, True)
ts.Write target
ts.Close
fso.MoveFile tmpFile, inbox & "\" & name & ".req"

' Running? The pid Forge wrote, still alive, and still an Electron/Forge process
' (a pid can be reused by anything once Forge has gone).
running = False
pidFile = inbox & "\.forge-pid"
If fso.FileExists(pidFile) Then
  Set ts = fso.OpenTextFile(pidFile, 1)
  pid = ""
  If Not ts.AtEndOfStream Then pid = Trim(ts.ReadLine)
  ts.Close
  If pid <> "" And IsNumeric(pid) Then
    Set wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2")
    Set procs = wmi.ExecQuery("Select ProcessId, Name From Win32_Process Where ProcessId = " & CLng(pid))
    For Each p In procs
      If LCase(p.Name) = "electron.exe" Or LCase(p.Name) = "forge.exe" Then running = True
    Next
  End If
End If

If running Then WScript.Quit 0

' Not running. Unless a launch is already on its way, start Forge without
' waiting for it - Start Forge (silent).vbs stays alive for the whole session.
launchStamp = inbox & "\.forge-launch"
If fso.FileExists(launchStamp) Then
  If DateDiff("s", fso.GetFile(launchStamp).DateLastModified, Now) < 90 Then WScript.Quit 0
End If
Set ts = fso.CreateTextFile(launchStamp, True)
ts.Write CStr(Now)
ts.Close

sh.Run "wscript.exe """ & root & "\Start Forge (silent).vbs""", 0, False
