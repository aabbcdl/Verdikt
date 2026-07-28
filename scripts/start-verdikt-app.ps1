param(
  [int]$Port = 3849,
  [switch]$NoOpen,
  [switch]$NoRestart,
  [int]$RestartDelaySeconds = 2,
  [int]$MaxRestarts = 0,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "pnpm is required. Install it first, then run this script again."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required. Install Node.js 20 or newer, then run this script again."
}
if (-not (Test-Path "node_modules")) {
  pnpm install
}
if (-not $SkipBuild) {
  pnpm build
}

$launchArgs = @("dist/index.js", "app", "--port=$Port")
if ($NoOpen) { $launchArgs += "--no-open" }
$restartCount = 0

while ($true) {
  & node @launchArgs
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0 -or $NoRestart) { exit $exitCode }
  if ($MaxRestarts -gt 0 -and $restartCount -ge $MaxRestarts) {
    Write-Error "Verdikt exited with code $exitCode and reached the restart limit."
    exit $exitCode
  }

  $restartCount += 1
  Write-Warning "Verdikt exited with code $exitCode. Restarting in $RestartDelaySeconds second(s), attempt $restartCount."
  Start-Sleep -Seconds ([Math]::Max(0, $RestartDelaySeconds))
  if (-not ($launchArgs -contains "--no-open")) { $launchArgs += "--no-open" }
}
