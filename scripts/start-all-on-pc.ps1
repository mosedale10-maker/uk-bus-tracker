# Run the FULL UK Bus Tracker on this PC for free (no Railway needed for serving).
# Starts: local Postgres + website + Cloudflare public tunnel.
# Data: D:\Projects\uk-bus-tracker\data\

$ErrorActionPreference = "Stop"
Set-Location "D:\Projects\uk-bus-tracker"

Write-Host "=== UK Bus Tracker — all on PC (free) ===" -ForegroundColor Cyan

# Stop trail-only host if still running on 8787
Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

# Pull secrets from Railway once (for PayPal/BODS/auth secret) — site itself runs locally
$rv = railway variables -s uk-bus-tracker --json | ConvertFrom-Json
$env:AUTH_SECRET = [string]$rv.AUTH_SECRET
$env:BODS_API_KEY = [string]$rv.BODS_API_KEY
$env:PAYPAL_CLIENT_ID = [string]$rv.PAYPAL_CLIENT_ID
$env:PAYPAL_CLIENT_SECRET = [string]$rv.PAYPAL_CLIENT_SECRET
$env:PAYPAL_MODE = [string]($rv.PAYPAL_MODE)
$env:PLUS_AMOUNT = [string]($rv.PLUS_AMOUNT)
$env:PLUS_CURRENCY = [string]($rv.PLUS_CURRENCY)
$env:PLUS_PRICE_LABEL = [string]($rv.PLUS_PRICE_LABEL)
$env:RESEND_API_KEY = [string]$rv.RESEND_API_KEY
$env:MAIL_FROM = [string]$rv.MAIL_FROM
# Important: do NOT use Railway trail proxy — trails stay on this PC
Remove-Item Env:TRAIL_REMOTE_URL -ErrorAction SilentlyContinue
$env:TRAIL_DATA_DIR = Join-Path (Get-Location) "data\trails"
$env:PC_PG_PORT = "54329"
$env:PC_PG_PASSWORD = "ukbus-local"
$env:PORT = "4173"

New-Item -ItemType Directory -Force -Path "data\trails","data\pg" | Out-Null

Write-Host "Starting local Postgres..." -ForegroundColor Cyan
$pgProc = Start-Process -FilePath "node" -ArgumentList "scripts\pc-postgres.mjs" -WorkingDirectory (Get-Location) -PassThru -WindowStyle Minimized
$deadline = (Get-Date).AddMinutes(3)
while (-not (Test-Path "data\pc-database.url")) {
  if ((Get-Date) -gt $deadline) { throw "Postgres did not become ready (data\pc-database.url missing)" }
  Start-Sleep -Seconds 2
}
$env:DATABASE_URL = (Get-Content "data\pc-database.url" -Raw).Trim()
Write-Host "Postgres ready." -ForegroundColor Green

# One-time migrate Plus users from Railway if local users table empty
Write-Host "Migrating Plus accounts from Railway (if needed)..." -ForegroundColor Cyan
$tunnel = Start-Process -FilePath "railway" -ArgumentList "connect","Postgres","--tunnel-only","-P","15440" -PassThru -WindowStyle Minimized
Start-Sleep -Seconds 4
try {
  $env:RAILWAY_DATABASE_URL = [string]$rv.DATABASE_URL
  $env:TUNNEL_HOST = "127.0.0.1"
  $env:TUNNEL_PORT = "15440"
  node scripts/migrate-users-from-railway.mjs
} catch {
  Write-Host "Migrate skipped/failed (you can still sign up locally): $($_.Exception.Message)" -ForegroundColor Yellow
} finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
}

Write-Host "Building frontend..." -ForegroundColor Cyan
npm run build

Write-Host "Starting website on http://127.0.0.1:$($env:PORT) ..." -ForegroundColor Cyan
$appProc = Start-Process -FilePath "node" -ArgumentList "server.mjs" -WorkingDirectory (Get-Location) -PassThru -WindowStyle Minimized

# Avoid broken named-tunnel creds for quick tunnels
$cfDir = Join-Path $env:USERPROFILE ".cloudflared"
if (Test-Path $cfDir) {
  Rename-Item $cfDir "$cfDir.bak-$(Get-Date -Format yyyyMMddHHmmss)" -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Starting public Cloudflare tunnel..." -ForegroundColor Cyan
Write-Host "Your free public URL will look like https://….trycloudflare.com" -ForegroundColor Yellow
Write-Host "Keep this window open. Ctrl+C stops the tunnel (site processes keep running until you close them)." -ForegroundColor Gray
Write-Host ""

try {
  cloudflared tunnel --url "http://127.0.0.1:$($env:PORT)" --protocol http2 --edge-ip-version 4
} finally {
  Write-Host "Tunnel stopped. Postgres pid=$($pgProc.Id) app pid=$($appProc.Id)" -ForegroundColor Gray
}
