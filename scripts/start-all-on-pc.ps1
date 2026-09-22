# Bootstrap / one-shot entry point. Prefer the always-on watchdog for 24/7 uptime.
# Starts (or adopts) Postgres + website + Cloudflare tunnel, then keeps them alive.
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-all-on-pc.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-all-on-pc.ps1 -RegisterLogonTask

param(
  [switch]$RegisterLogonTask,
  [switch]$NoWatch
)

$ErrorActionPreference = "Stop"
$Root = "D:\Projects\uk-bus-tracker"
Set-Location $Root

Write-Host "=== UK Bus Tracker — PC host (watchdog) ===" -ForegroundColor Cyan
Write-Host "Public: https://ukbustracker.co.uk" -ForegroundColor Green
Write-Host "Local:  http://127.0.0.1:4173" -ForegroundColor Green
Write-Host ""

$watch = Join-Path $Root "scripts\watch-pc-site.ps1"
if (-not (Test-Path $watch)) { throw "Missing $watch" }

if ($NoWatch) {
  # Legacy one-shot path: run a single health ensure then exit (no forever loop)
  & $watch -Once
  exit $LASTEXITCODE
}

$watchArgs = @()
if ($RegisterLogonTask) { $watchArgs += "-RegisterLogonTask" }

Write-Host "Handing off to watch-pc-site.ps1 (auto-restarts postgres/server/tunnel)." -ForegroundColor Cyan
Write-Host "Logs: logs\pc-watchdog.log" -ForegroundColor Gray
Write-Host "Keep this window open, or use -RegisterLogonTask so it starts at logon." -ForegroundColor Gray
Write-Host ""

& $watch @watchArgs
