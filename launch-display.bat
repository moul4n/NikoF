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

REM The desktop shell runs its OWN Vite on a dedicated port (5174) so it never
REM collides with the control surface's dev server (5173). Free 5174 only — the
REM control surface on 5173 is left untouched, so both can run side by side.
set "PORTPID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":5174 "') do set "PORTPID=%%p"
if defined PORTPID (
  echo [NikoF] Port 5174 is already in use by PID %PORTPID% ^(a stale stage dev server^).
  echo         Stopping it so the desktop window can use the port...
  taskkill /F /PID %PORTPID% >nul 2>nul
  REM brief pause to let the socket release
  ping -n 2 127.0.0.1 >nul
)

REM The control surface (operator UI + gesture/character controls) is a SEPARATE
REM frontend on 5173, owned by the ops dashboard (Start-Frontend) or `npm run dev`.
REM This launcher only serves the stage on 5174. Warn if the control isn't up, or
REM commands fired from it will fail to reach the backend.
netstat -ano | findstr "LISTENING" | findstr ":5173 " >nul 2>nul
if errorlevel 1 (
  echo.
  echo [NikoF] NOTE: the control surface frontend ^(port 5173^) is not running.
  echo         Start it from the ops dashboard ^(http://127.0.0.1:8765^) or run
  echo         "npm run dev" in the frontend folder, or control-surface buttons
  echo         ^(gestures, character switch^) will fail to reach the backend.
  echo.
)

echo [NikoF] Launching desktop display window...
call npm run tauri:dev

echo.
echo [NikoF] The desktop window has exited.
pause
endlocal
