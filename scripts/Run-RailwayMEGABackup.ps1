$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$backupScript = Join-Path $repo 'scripts\Backup-RailwayToMEGA.ps1'
$localDir = Join-Path $repo 'pipeline\data\backups'

try {
    Write-Host "=== Trading AI Railway -> MEGA scheduled backup ==="
    & $backupScript

    if (-not (Test-Path -LiteralPath $localDir)) {
        Write-Host '[OK] Backup completed; local backup directory does not exist.'
        exit 0
    }

    $dbFiles = @(
        Get-ChildItem -LiteralPath $localDir -File -Filter 'railway-trading-db-*.sqlite' |
        Sort-Object LastWriteTime -Descending
    )

    # Keep only the newest local SQLite copy; MEGA is the remote archive.
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
    exit 0
}
catch {
    Write-Error $_
    exit 1
}