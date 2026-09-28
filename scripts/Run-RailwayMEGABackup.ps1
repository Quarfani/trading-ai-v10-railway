$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$backupScript = Join-Path $repo 'scripts\Backup-RailwayToMEGA.ps1'
$localDir = Join-Path $repo 'pipeline\data\backups'
$logDir = Join-Path $repo 'pipeline\data\backups\logs'
$logFile = Join-Path $logDir 'scheduled-backup.log'

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

# MEGAcmd is commonly installed here on Windows.
$megaCmdPath = Join-Path $env:LOCALAPPDATA 'MEGAcmd'
if (Test-Path -LiteralPath $megaCmdPath) {
    $env:PATH = "$megaCmdPath;$env:PATH"
}

"=== $(Get-Date -Format s) scheduled backup start ===" |
    Tee-Object -FilePath $logFile -Append

try {
    Write-Host "=== Trading AI Railway -> MEGA scheduled backup ==="

    & $backupScript 2>&1 |
        Tee-Object -FilePath $logFile -Append

    if ($LASTEXITCODE -ne 0) {
        throw "Backup client exited with code $LASTEXITCODE"
    }

    if (-not (Test-Path -LiteralPath $localDir)) {
        Write-Host '[OK] Backup completed; local backup directory does not exist.'
        exit 0
    }

    $dbFiles = @(
        Get-ChildItem -LiteralPath $localDir -File -Filter 'railway-trading-db-*.sqlite' |
        Sort-Object LastWriteTime -Descending
    )

    if ($dbFiles.Count -gt 1) {
        $dbFiles | Select-Object -Skip 1 | ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue

            $sha = "$($_.FullName).sha256"
            if (Test-Path -LiteralPath $sha) {
                Remove-Item -LiteralPath $sha -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Write-Host "[OK] Local retention cleanup complete. Kept $([Math]::Min(1,$dbFiles.Count)) local SQLite backup."
    "=== $(Get-Date -Format s) scheduled backup success ===" |
        Tee-Object -FilePath $logFile -Append

    exit 0
}
catch {
    $msg = $_ | Out-String
    $msg | Tee-Object -FilePath $logFile -Append
    "=== $(Get-Date -Format s) scheduled backup FAILED ===" |
        Tee-Object -FilePath $logFile -Append
    exit 1
}