; Adds the folder with coval.cmd to the user's PATH so `coval` works in new terminals,
; and removes it again on uninstall. Per-user install, so no admin rights are needed.
; PowerShell is called by its full path: some computers don't have System32 on PATH.
; The NSIS strings use backticks so the PowerShell code can use both kinds of quotes.
!macro customInstall
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d='$INSTDIR\resources'; $$p=[Environment]::GetEnvironmentVariable('Path','User'); if (-not $$p) { $$p='' }; if (($$p -split ';') -notcontains $$d) { [Environment]::SetEnvironmentVariable('Path', ($$p.TrimEnd(';') + ';' + $$d).TrimStart(';'), 'User') }"`
!macroend

!macro customUnInstall
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d='$INSTDIR\resources'; $$p=[Environment]::GetEnvironmentVariable('Path','User'); if ($$p) { [Environment]::SetEnvironmentVariable('Path', ((($$p -split ';') | Where-Object { $$_ -and $$_ -ne $$d }) -join ';'), 'User') }"`
!macroend
