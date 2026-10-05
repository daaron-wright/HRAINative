@echo off
REM Double-click to start the workshop room on Windows. Close this window to stop it.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 room.py
) else (
  python room.py
)
pause
