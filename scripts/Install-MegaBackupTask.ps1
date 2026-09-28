$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $repo 'scripts\Run-RailwayMEGABackup.ps1'
$taskName = 'TradingAI-MEGA-Backup-Every-6h'
$pwsh = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path -LiteralPath $runner)) {
    throw "Backup runner not found: $runner"
}

$action = New-ScheduledTaskAction `
    -Execute $pwsh `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`"" `
    -WorkingDirectory $repo

$trigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Hours 6) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel LeastPrivilege

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Force | Out-Null

Write-Host "[OK] Scheduled task installed: $taskName"
Write-Host "[OK] Runs every 6 hours while this Windows user is logged in."
Write-Host "[OK] Uses Railway -> MEGA backup client."
Write-Host "[OK] Keeps only the newest local SQLite backup."