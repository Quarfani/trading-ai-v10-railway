$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repo 'bot\backend\.env'
$example = Join-Path $repo 'bot\backend\.env.local-4gb.example'
$dataDir = Join-Path $repo 'bot\backend\data'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }

if (-not (Test-Path $envFile)) {
    $session = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
    $password = ('TAI-' + [guid]::NewGuid().ToString('N').Substring(0, 28))
    $content = Get-Content -Raw -Encoding UTF8 $example
    $content = $content.Replace('DASHBOARD_PASSWORD=GENERATED_LOCALLY', "DASHBOARD_PASSWORD=$password")
    $content = $content.Replace('SESSION_SECRET=GENERATED_LOCALLY', "SESSION_SECRET=$session")
    Set-Content -Path $envFile -Value $content -Encoding UTF8
    Write-Host "Created safe local paper configuration: $envFile"
    Write-Host "Dashboard password generated locally and stored only in .env."
}

Write-Host 'Local profile: PAPER + Binance public market data + ML OFF.'
