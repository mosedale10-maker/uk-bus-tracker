# Keep PC trail host + Cloudflare tunnel running for live tails/replay.
# Railway TRAIL_REMOTE_URL must match the trycloudflare URL printed below.

$ErrorActionPreference = "Stop"
Set-Location "D:\Projects\uk-bus-tracker"

$port = 8787
$dataDir = Join-Path (Get-Location) "data\trails"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$vars = railway variables -s uk-bus-tracker --json | ConvertFrom-Json
if ($vars.BODS_API_KEY) { $env:BODS_API_KEY = [string]$vars.BODS_API_KEY }
$env:TRAIL_DATA_DIR = $dataDir
$env:TRAIL_PC_PORT = "$port"

# Avoid stale named-tunnel credentials breaking quick tunnels
$cfDir = Join-Path $env:USERPROFILE ".cloudflared"
if (Test-Path $cfDir) {
  Rename-Item $cfDir "$cfDir.bak-$(Get-Date -Format yyyyMMddHHmmss)" -ErrorAction SilentlyContinue
}

Write-Host "Starting trail host on :$port (data: $dataDir)" -ForegroundColor Cyan
$hostProc = Start-Process -FilePath "node" -ArgumentList "scripts\trail-pc-host.mjs" -WorkingDirectory (Get-Location) -PassThru -WindowStyle Minimized
Start-Sleep -Seconds 2

Write-Host "Starting Cloudflare tunnel. Copy the https://….trycloudflare.com URL," -ForegroundColor Cyan
Write-Host "then run: railway variables -s uk-bus-tracker --set TRAIL_REMOTE_URL=<that-url>" -ForegroundColor Yellow
Write-Host "Keep this window open while using tails on the live site." -ForegroundColor Gray
Write-Host ""

try {
  cloudflared tunnel --url "http://127.0.0.1:$port" --protocol http2 --edge-ip-version 4
} finally {
  if ($hostProc -and -not $hostProc.HasExited) { Stop-Process -Id $hostProc.Id -Force -ErrorAction SilentlyContinue }
}
