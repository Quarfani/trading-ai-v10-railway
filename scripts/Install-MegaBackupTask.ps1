$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$pipeline = Join-Path $repo 'pipeline'
$python = Join-Path $pipeline 'venv\Scripts\python.exe'
$taskName = 'TradingAI-MEGA-Backup-Every-6h'

if (-not (Test-Path $python)) {
  Write-Host '[ERROR] Python virtual environment not found. Run SETUP_WINDOWS.bat first.'
  exit 1
}

$action = New-ScheduledTaskAction -Execute $python -Argument 'run_all.py backup' -WorkingDirectory $pipeline
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel LeastPrivilege
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "[OK] Scheduled task installed: $taskName"
Write-Host 'The task runs every 6 hours while this Windows user is logged in.'
