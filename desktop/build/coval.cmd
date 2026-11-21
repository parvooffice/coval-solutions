@echo off
rem The coval command, installed with COVAL for Windows. It runs the CLI with COVAL's
rem built-in Node.js and the bundled engine, so nothing else needs to be installed.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
set "COVAL_HOME=%~dp0"
"%~dp0..\COVAL.exe" "%~dp0cli\bin\coval.mjs" %*
