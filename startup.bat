@echo off
setlocal

set "ROOT=%~dp0"
set "MANAGER_SCRIPT=%ROOT%scripts\bootstrap\app-manager.ps1"
set "PS_EXE="

if not exist "%MANAGER_SCRIPT%" (
  echo app-manager.ps1 not found at "%MANAGER_SCRIPT%"
  goto :fail
)

for /f "usebackq delims=" %%I in (`where pwsh 2^>nul`) do (
  set "PS_EXE=%%~fI"
  goto :have_shell
)

for /f "usebackq delims=" %%I in (`where powershell 2^>nul`) do (
  set "PS_EXE=%%~fI"
  goto :have_shell
)

if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PS_EXE=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not defined PS_EXE if exist "%ProgramW6432%\PowerShell\7\pwsh.exe" set "PS_EXE=%ProgramW6432%\PowerShell\7\pwsh.exe"
if not defined PS_EXE if exist "%LocalAppData%\Microsoft\WindowsApps\pwsh.exe" set "PS_EXE=%LocalAppData%\Microsoft\WindowsApps\pwsh.exe"
if not defined PS_EXE if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if not defined PS_EXE (
  echo Could not locate PowerShell executable.
  goto :fail
)

:have_shell

"%PS_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%MANAGER_SCRIPT%" -OpenBrowser
if %errorlevel% neq 0 goto :fail

endlocal
exit /b 0

:fail
echo.
echo Startup failed. Press any key to close this window.
pause >nul
endlocal
exit /b 1
