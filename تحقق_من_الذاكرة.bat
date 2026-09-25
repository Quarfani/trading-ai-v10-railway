@echo off
setlocal
chcp 65001 >nul
powershell -NoProfile -Command "$os=Get-CimInstance Win32_OperatingSystem; $free=[math]::Round($os.FreePhysicalMemory/1024); $total=[math]::Round($os.TotalVisibleMemorySize/1024); Write-Host ('RAM total: {0} MB' -f $total); Write-Host ('RAM free:  {0} MB' -f $free); if($free -lt 800){exit 2}else{exit 0}"
if errorlevel 2 (
  echo [WARNING] Less than 800 MB free. Do not start the local bot yet.
) else (
  echo [OK] Enough free RAM for LOCAL 4GB PAPER mode.
)
echo.
pause
endlocal
