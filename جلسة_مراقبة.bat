@echo off
setlocal
cd /d "%~dp0"
call "%~dp0START.bat"
echo.
echo Close the monitoring session window when finished, then use STOP.bat.
pause
endlocal
