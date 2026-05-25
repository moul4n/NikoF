@echo off
setlocal

rem Typo-safe shim: forwards to the canonical startup launcher.
call "%~dp0startup.bat" %*

endlocal
