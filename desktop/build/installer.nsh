; Adds the folder with coval.cmd to the user's PATH so `coval` works in new terminals,
; and removes it again on uninstall. Per-user install, so no admin rights are needed.
!macro customInstall
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$d = \"$INSTDIR\resources\"; $$p = [Environment]::GetEnvironmentVariable(\"Path\", \"User\"); if (-not $$p) { $$p = \"\" }; if (($$p -split \";\") -notcontains $$d) { [Environment]::SetEnvironmentVariable(\"Path\", ($$p.TrimEnd(\";\") + \";\" + $$d).TrimStart(\";\"), \"User\") }"'
!macroend

!macro customUnInstall
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$d = \"$INSTDIR\resources\"; $$p = [Environment]::GetEnvironmentVariable(\"Path\", \"User\"); if ($$p) { [Environment]::SetEnvironmentVariable(\"Path\", (($$p -split \";\") | Where-Object { $$_ -and $$_ -ne $$d }) -join \";\", \"User\") }"'
!macroend
