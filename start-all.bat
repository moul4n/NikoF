@echo off
REM ============================================================================
REM  NikoF - full local bring-up: backend (8000) + control frontend (5173) +
REM  stage desktop window (Tauri on its own Vite, 5174).
REM  Double-click this to start everything each session.
REM ============================================================================
setlocal
set "ROOT=%~dp0"
set "PS_EXE="

for /f "usebackq delims=" %%I in (`where pwsh 2^>nul`) do ( set "PS_EXE=%%~fI" & goto :have_shell )
for /f "usebackq delims=" %%I in (`where powershell 2^>nul`) do ( set "PS_EXE=%%~fI" & goto :have_shell )

echo Could not locate PowerShell (pwsh/powershell).
pause
exit /b 1

:have_shell
"%PS_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%start-all.ps1"
endlocal
