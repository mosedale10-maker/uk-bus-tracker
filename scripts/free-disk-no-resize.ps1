# Free Postgres disk — deletes only. Restart separately after.
$ErrorActionPreference = "Continue"
Set-Location "D:\Projects\uk-bus-tracker"

Write-Host "Deleting old trail DB files (Plus accounts kept)..." -ForegroundColor Cyan
$vol = "77151d7b-1f51-4258-9164-501b610d28ff"
$files = @(
  "/pgdata/base/16384/40973",
  "/pgdata/base/16384/40998",
  "/pgdata/base/16384/41000",
  "/pgdata/base/16384/40996",
  "/pgdata/base/16384/41001",
  "/pgdata/base/16384/40999"
)

$ok = 0
foreach ($f in $files) {
  Write-Host "  $f"
  railway volume files --volume postgres-volume delete $f --yes
  if ($LASTEXITCODE -eq 0) { $ok++ }
}

Write-Host ""
Write-Host "Deleted $ok / $($files.Count) files." -ForegroundColor $(if ($ok -gt 0) { "Green" } else { "Yellow" })
Write-Host "Volume:"
railway volume list --json
Write-Host ""
if ($ok -gt 0) {
  Write-Host "Now restarting Postgres..."
  railway restart --service Postgres --yes
  Write-Host "Done. Reply 'done' in Cursor." -ForegroundColor Green
} else {
  Write-Host "Nothing deleted. If you see 'Refusing: agents', this window is fine — paste any error here." -ForegroundColor Yellow
}
Read-Host "Press Enter to close"
