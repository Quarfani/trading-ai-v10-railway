$taskName = 'TradingAI-MEGA-Backup-Every-6h'
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "[OK] Removed scheduled task: $taskName"
