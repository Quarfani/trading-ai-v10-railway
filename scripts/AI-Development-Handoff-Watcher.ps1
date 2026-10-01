param(
  [int]$IntervalSeconds = 60
)

$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root ".runtime"
$handoff = Join-Path $root "AI_DEVELOPMENT_HANDOFF_CURRENT.md"
$pidFile = Join-Path $runtime "ai-handoff.pid"

New-Item -ItemType Directory -Path $runtime -Force | Out-Null

if (Test-Path $pidFile) {
  $existingPid = (Get-Content $pidFile -Raw).Trim()
  if ($existingPid -and $existingPid -ne $PID) {
    if (Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue) { exit 0 }
  }
}
Set-Content -Path $pidFile -Value $PID -Encoding UTF8

function Get-Git([string[]]$Args) {
  try {
    $value = & git -C $root @Args 2>$null
    return (($value | Out-String).Trim())
  } catch { return "" }
}

function Write-Handoff {
  $head = Get-Git @("rev-parse","HEAD")
  $short = Get-Git @("rev-parse","--short","HEAD")
  $branch = Get-Git @("rev-parse","--abbrev-ref","HEAD")
  $subject = Get-Git @("log","-1","--pretty=%s")
  $status = Get-Git @("status","--porcelain")
  $recent = Get-Git @("log","-5","--date=iso","--pretty=%h | %ad | %s")

  $nextTask = "See AI_DEVELOPMENT_HANDOFF.md"
  $source = Join-Path $root "AI_DEVELOPMENT_HANDOFF.md"
  if (Test-Path $source) {
    $raw = Get-Content $source -Raw
    $match = [regex]::Match($raw, "(?ms)^## NEXT TASK\s*(?<body>.*?)^## ACCEPTANCE CRITERIA")
    if ($match.Success) { $nextTask = $match.Groups["body"].Value.Trim() }
  }

  $ci = "unavailable locally"
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    try {
      $ciJson = & gh run list --limit 5 --json headSha,status,conclusion,name 2>$null
      if ($LASTEXITCODE -eq 0 -and $ciJson) {
        $ci = ($ciJson | Out-String).Trim()
      }
    } catch {}
  }

  $dirty = if ($status) { "WORKTREE MODIFIED" } else { "WORKTREE CLEAN" }
  $content = @(
    "# LOCAL AI DEVELOPMENT HANDOFF",
    "",
    "Generated: $(Get-Date -Format o)",
    "Repository: $root",
    "Branch: $branch",
    "HEAD: $head",
    "Short HEAD: $short",
    "Latest commit: $subject",
    "Worktree: $dirty",
    "",
    "## NEXT TASK",
    $nextTask,
    "",
    "## RECENT COMMITS",
    $recent,
    "",
    "## CI SNAPSHOT",
    $ci,
    "",
    "## WORKTREE STATUS",
    ($(if ($status) { $status } else { "(clean)" })),
    "",
    "## RESUME INSTRUCTION",
    "Read this file first, then read AI_DEVELOPMENT_HANDOFF.md. Continue from NEXT TASK and verify HEAD before changing code.",
    ""
  ) -join [Environment]::NewLine

  Set-Content -Path $handoff -Value $content -Encoding UTF8
}

try {
  Write-Handoff
  while ($true) {
    Start-Sleep -Seconds ([Math]::Max(10, $IntervalSeconds))
    Write-Handoff
  }
} finally {
  if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
}