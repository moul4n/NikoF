@echo off
REM ============================================================================
REM  NikoF - launch the standalone desktop display window (Tauri shell).
REM
REM  Runs in DEV mode: the window is served by the Vite dev server, so the
REM  avatar, animations (VRMA), and hot-reload all work without a packaged
REM  bundle. The backend (startup.bat / ops dashboard) should be running for
REM  live session + speech; the avatar itself renders without it.
REM
REM  First run compiles the Rust shell (a few minutes); later runs are fast.
REM
REM  Prerequisites (one-time):
REM    1. Rust toolchain        -> https://rustup.rs   (rustup, defaults to MSVC)
REM    2. MSVC C++ Build Tools  -> "Desktop development with C++" workload
REM    3. WebView2 runtime      -> ships with Windows 11
REM ============================================================================
setlocal
cd /d "%~dp0"

REM Per-user Rust toolchain on PATH (rustup installed without touching global PATH).
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

where cargo >nul 2>nul
if errorlevel 1 (
  echo.
  echo [NikoF] Rust/cargo was not found on PATH.
  echo         Install Rust ^(https://rustup.rs^) and the MSVC C++ Build Tools,
  echo         then open a NEW terminal and run this script again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\@tauri-apps\cli" (
  echo [NikoF] Installing desktop shell dependencies ^(Tauri CLI^)...
  call npm install
  if errorlevel 1 (
    echo [NikoF] npm install failed.
    pause
    exit /b 1
  )
)

REM The desktop shell starts its own Vite on the project's strict port 5173.
REM If a dev server is already bound there (e.g. a browser-preview "npm run dev"),
REM that collision aborts the launch, so free the port first.
set "PORTPID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":5173 "') do set "PORTPID=%%p"
if defined PORTPID (
  echo [NikoF] Port 5173 is already in use by PID %PORTPID% ^(an existing dev server^).
  echo         Stopping it so the desktop window can use the port...
  taskkill /F /PID %PORTPID% >nul 2>nul
  REM brief pause to let the socket release
  ping -n 2 127.0.0.1 >nul
)

echo [NikoF] Launching desktop display window...
call npm run tauri:dev

echo.
echo [NikoF] The desktop window has exited.
pause
endlocal
