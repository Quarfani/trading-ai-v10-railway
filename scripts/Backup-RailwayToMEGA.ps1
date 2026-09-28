param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$BaseUrl = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path $RepoRoot).Path
$pipelineRoot = Join-Path $repo 'pipeline'
$envFile = Join-Path $pipelineRoot '.env'
if (-not (Test-Path $envFile)) { throw "Missing $envFile" }

function Read-DotEnv([string]$Path) {
  $map = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $trim = $line.Trim()
    if (-not $trim -or $trim.StartsWith('#')) { continue }
    if ($trim -match '^([^=]+)=(.*)$') {
      $key = $Matches[1].Trim()
      $value = $Matches[2].Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $map[$key] = $value
    }
  }
  return $map
}

function Resolve-ConfigPath([string]$Value, [string]$BaseDir) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $BaseDir }
  if ([IO.Path]::IsPathRooted($Value)) { return $Value }
  return [IO.Path]::GetFullPath((Join-Path $BaseDir ($Value -replace '/', '\')))
}

$cfg = Read-DotEnv $envFile
$token = [string]$cfg['BACKUP_API_TOKEN']
if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 32) {
  throw 'BACKUP_API_TOKEN is missing or shorter than 32 characters in pipeline\.env'
}

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $BaseUrl = [string]$cfg['RAILWAY_BACKEND_URL']
}
if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $BaseUrl = 'https://trading-ai-v10-railway-production-8950.up.railway.app'
}
$BaseUrl = $BaseUrl.TrimEnd('/')

$megaFolder = if ($cfg.ContainsKey('MEGA_FOLDER') -and $cfg['MEGA_FOLDER']) { [string]$cfg['MEGA_FOLDER'] } else { '/TradingAI/backups' }
$localDir = if ($cfg.ContainsKey('MEGA_LOCAL_BACKUP_DIR') -and $cfg['MEGA_LOCAL_BACKUP_DIR']) {
  Resolve-ConfigPath ([string]$cfg['MEGA_LOCAL_BACKUP_DIR']) $pipelineRoot
} else {
  Join-Path $pipelineRoot 'data\backups'
}
$verifyRemote = $true
if ($cfg.ContainsKey('MEGA_VERIFY_REMOTE') -and $cfg['MEGA_VERIFY_REMOTE']) {
  $verifyRemote = ([string]$cfg['MEGA_VERIFY_REMOTE']).ToLowerInvariant() -in @('1','true','yes','on')
}

foreach ($cmd in @('mega-whoami','mega-mkdir','mega-put','mega-ls')) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "$cmd was not found in PATH. Open a new PowerShell after installing MEGAcmd."
  }
}

$who = & mega-whoami 2>&1
if ($LASTEXITCODE -ne 0) { throw "MEGAcmd is not logged in. Run mega-login first." }
Write-Host $who

New-Item -ItemType Directory -Force -Path $localDir | Out-Null
$verifyDir = Join-Path $localDir '_verify'
New-Item -ItemType Directory -Force -Path $verifyDir | Out-Null

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$fileName = "railway-trading-db-$stamp.sqlite"
$dbFile = Join-Path $localDir $fileName
$shaFile = "$dbFile.sha256"

try {
  $headers = @{ 'X-Backup-Token' = $token }
  Write-Host "`n[1/5] Downloading live Railway SQLite snapshot..."
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/api/backup/sqlite" -Headers $headers -OutFile $dbFile

  $size = (Get-Item $dbFile).Length
  if ($size -le 0) { throw 'Downloaded backup is empty.' }
  Write-Host "     Size: $size bytes"

  Write-Host "[2/5] Calculating SHA-256..."
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dbFile).Hash.ToLowerInvariant()
  Set-Content -Encoding ASCII -Path $shaFile -Value "$hash  $fileName"
  Write-Host "     SHA256: $hash"

  Write-Host "[3/5] Uploading to MEGA..."
  # Create the remote folder only if it does not already exist.
$__megaEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& mega-ls $megaFolder 2>$null | Out-Null
$__megaFolderLsExit = $LASTEXITCODE

if ($__megaFolderLsExit -ne 0) {
  & mega-mkdir -p $megaFolder 2>$null | Out-Null
  $__megaMkdirExit = $LASTEXITCODE
} else {
  $__megaMkdirExit = 0
}

$ErrorActionPreference = $__megaEap

if ($__megaMkdirExit -ne 0) {
  throw "mega-mkdir failed for $megaFolder."
}
  $__megaEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & mega-put $dbFile "$megaFolder/" 2>$null
  $__megaPutDbExit = $LASTEXITCODE
  $ErrorActionPreference = $__megaEap
  if ($__megaPutDbExit -ne 0) { throw 'mega-put failed for SQLite backup.' }
  $__megaEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & mega-put $shaFile "$megaFolder/" 2>$null
  $__megaPutShaExit = $LASTEXITCODE
  $ErrorActionPreference = $__megaEap
  if ($__megaPutShaExit -ne 0) { throw 'mega-put failed for SHA-256 sidecar.' }

  if ($verifyRemote) {
    Write-Host "[4/5] Verifying remote copy by downloading it once..."
    Get-ChildItem -LiteralPath $verifyDir -Force -ErrorAction SilentlyContinue | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
    $__megaEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & mega-get "$megaFolder/$fileName" $verifyDir 2>$null
    $__megaGetExit = $LASTEXITCODE
    $ErrorActionPreference = $__megaEap
    if ($__megaGetExit -ne 0) { throw 'mega-get failed during remote verification.' }
    $remote = Get-ChildItem -LiteralPath $verifyDir -File | Select-Object -First 1
    if (-not $remote) { throw 'Remote verification returned no file.' }
    $remoteHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $remote.FullName).Hash.ToLowerInvariant()
    if ($remoteHash -ne $hash) {
      throw "Remote SHA-256 mismatch. Local=$hash Remote=$remoteHash"
    }
    Write-Host "     Remote SHA256 matches."
  } else {
    Write-Host "[4/5] Remote verification disabled."
  }

  Write-Host "[5/5] Listing MEGA backup folder..."
  $__megaEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & mega-ls $megaFolder
  $__megaListExit = $LASTEXITCODE
  $ErrorActionPreference = $__megaEap
  if ($__megaListExit -ne 0) { throw 'mega-ls failed.' }

  Write-Host "`nBACKUP OK"
  Write-Host "Remote: $megaFolder/$fileName"
  Write-Host "Local : $dbFile"
  Write-Host "SHA256: $hash"
}
finally {
  Remove-Item -LiteralPath $verifyDir -Force -Recurse -ErrorAction SilentlyContinue
}
