' Start the PACKAGED Forge - the fast one.
'
' This is the launcher the desktop shortcut should point at for everyday use.
'
' The other one, "Start Forge (silent).vbs", runs `npm run dev`. That is a
' development server, and using it as the everyday launcher is why Forge takes
' so long to appear. Every single launch, before Electron even starts, it:
'
'   - boots node and npm and resolves the dependency tree
'   - rebuilds electron/main with rollup   (~660ms, measured, in dev.log)
'   - rebuilds electron/preload with rollup
'   - starts a Vite dev server on 5173
'
' and then the renderer loads as several hundred separate unbundled ES modules,
' each transformed on the fly - including the two 1,400-line files (AppState and
' VoiceAgent) and the whole of xterm.
'
' None of that work produces anything a user wants. It exists so that saving a
' file updates the running app, which is worth a lot while writing code and
' nothing at all while using it.
'
' This launcher skips all of it and runs the built application directly.
'
' THE ONE CATCH: the packaged build is a snapshot, frozen at the moment it was
' made. It does not pick up source changes. After changing any code, run
'
'     npm run dist
'
' or the packaged app keeps running the old version - which looks exactly like
' a change that silently did not work. The check below is there to stop that
' being a mystery: if the build is missing entirely it says so rather than
' failing with nothing on screen.

Option Explicit

Dim sh, fso, root, exePath, built

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root    = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = fso.BuildPath(root, "release\win-unpacked\Forge.exe")

If Not fso.FileExists(exePath) Then
  sh.Popup _
    "No packaged build found at" & vbCrLf & vbCrLf & _
    exePath & vbCrLf & vbCrLf & _
    "Run  npm run dist  in the Forge folder to make one." & vbCrLf & _
    "Until then, use ""Start Forge (silent).vbs"".", _
    20, "Forge", 48
  WScript.Quit 1
End If

built = fso.GetFile(exePath).DateLastModified

' 1 = normal window, False = do not wait. Unlike the dev launcher there is no
' console to hide and no log to tail: this is the application itself, so once it
' is running this script has no further job and should not linger as a stray
' wscript.exe for the life of the session.
sh.Run """" & exePath & """", 1, False
