@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0\pipeline"
if not exist "venv\Scripts\python.exe" (
  echo [ERROR] Python environment not ready. Run SETUP_WINDOWS.bat first.
  pause
  exit /b 1
)
call venv\Scripts\activate.bat

echo.
echo Trading AI - LOW RESOURCE DATA DOWNLOAD
 echo This downloads one year of BTCUSDT data only. No training is run.
echo.
python run_all.py download --market binance --years 1 --symbols BTCUSDT
if errorlevel 1 (
  echo [ERROR] Data download failed.
  pause
  exit /b 1
)
echo [OK] Data download finished.
pause
endlocal
