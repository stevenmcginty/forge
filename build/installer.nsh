# The frozen speech engine (resources/stt-bin/forge-stt.exe) is a separate
# process that runs from inside the install directory. The app kills it before
# quitAndInstall (electron/stt-sidecar.ts killSttSidecarSync), but this
# installer can also be run when the app never got that chance — an orphan
# from a crashed Forge, an older Forge that predates the sync kill, or a
# person double-clicking the setup exe by hand. A live forge-stt.exe holds its
# own files open and the install dies with "Failed to uninstall old
# application files", so the installer reaps it too before touching anything.
#
# nsExec rather than ExecWait so no console window flashes; the exit code is
# popped and ignored because "no such process" is the happy path.

!macro customInit
  nsExec::Exec 'taskkill /IM forge-stt.exe /F'
  Pop $0
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /IM forge-stt.exe /F'
  Pop $0
!macroend
