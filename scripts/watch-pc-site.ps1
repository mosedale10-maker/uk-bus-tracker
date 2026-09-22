# UK Bus Tracker - PC watchdog (keeps site up 24/7 while this PC is on).
# Supervises: embedded Postgres, node server.mjs (4173), cloudflared http2 tunnel.
# Logs: logs\pc-watchdog.log  (+ per-process logs under logs\)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\watch-pc-site.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\watch-pc-site.ps1 -RegisterLogonTask
#   powershell -ExecutionPolicy Bypass -File .\scripts\watch-pc-site.ps1 -Once

param(
  [switch]$RegisterLogonTask,
  [switch]$UnregisterLogonTask,
  [switch]$Once,
  [int]$PollSeconds = 15
)

$ErrorActionPreference = "Continue"
$Root = "D:\Projects\uk-bus-tracker"
$Port = 4173
$PgPort = 54329
$TaskName = "UKBusTrackerWatch"
$LogDir = Join-Path $Root "logs"
$PidFile = Join-Path $LogDir "watch-pc-site.pid"
$EnvCache = Join-Path $Root "data\pc-env.cache.json"
$DbUrlFile = Join-Path $Root "data\pc-database.url"
$WatchLog = Join-Path $LogDir "pc-watchdog.log"
$script:LastRailwayFetchAt = [datetime]::MinValue
$script:SecretsLoaded = $false
$script:ServerFailStreak = 0
$script:TunnelFailStreak = 0
$script:PostgresFailStreak = 0
$script:ServerHeapUpgraded = $false
$script:NeedsHeapUpgradeStart = $false
$script:AccountsFixAttempted = $false
$script:LastWalInfoAt = [datetime]::MinValue

New-Item -ItemType Directory -Force -Path $LogDir, (Join-Path $Root "data\trails"), (Join-Path $Root "data\pg") | Out-Null
Set-Location $Root

function Write-WatchLog {
  param([string]$Message, [string]$Level = "INFO")
  $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
  Add-Content -Path $WatchLog -Value $line -Encoding UTF8
  if ($Level -eq "ERROR") { Write-Host $line -ForegroundColor Red }
  elseif ($Level -eq "WARN") { Write-Host $line -ForegroundColor Yellow }
  else { Write-Host $line }
}

function Test-ProcessAlive {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return $false }
  try {
    $p = Get-Process -Id $ProcessId -ErrorAction Stop
    return -not $p.HasExited
  } catch { return $false }
}

function Get-CmdLine {
  param([int]$ProcessId)
  try {
    return [string](Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop).CommandLine
  } catch { return "" }
}

function Find-NodeByScript {
  param([string]$ScriptFragment)
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$ScriptFragment*") } |
    Select-Object -First 1
}

function Test-CloudflaredService {
  try {
    $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    return [bool]($svc -and $svc.Status -eq "Running")
  } catch { return $false }
}

function Find-NamedCloudflared {
  # Manual / watcher-started tunnel (has a useful CommandLine).
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -match 'cloudflared' -and
      $_.CommandLine -and
      ($_.CommandLine -like '*uk-bus-tracker*' -or $_.CommandLine -like '*tunnel*run*')
    })
}

function Find-Cloudflared {
  $named = Find-NamedCloudflared | Select-Object -First 1
  if ($named) { return $named }
  # Windows service process often has an empty CommandLine (parented by services.exe).
  if (Test-CloudflaredService) {
    return [pscustomobject]@{ ProcessId = 0; CommandLine = "Cloudflared Windows service" }
  }
  return $null
}

function Set-AboveNormalPriority {
  param([int]$ProcessId, [string]$Label)
  if ($ProcessId -le 0) { return }
  try {
    $p = Get-Process -Id $ProcessId -ErrorAction Stop
    if ($p.PriorityClass -ne [System.Diagnostics.ProcessPriorityClass]::AboveNormal) {
      $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::AboveNormal
      Write-WatchLog "Set $Label pid=$ProcessId priority AboveNormal"
    }
  } catch {
    # Non-fatal (access denied / process exited).
  }
}

function Get-PortPids {
  param([int]$ListenPort)
  $pids = @()
  try {
    $conns = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      if ($c.OwningProcess -and $pids -notcontains $c.OwningProcess) {
        $pids += [int]$c.OwningProcess
      }
    }
  } catch {
    $lines = netstat -ano | Select-String ":$ListenPort\s+.*LISTENING"
    foreach ($line in $lines) {
      $parts = ($line.ToString() -split '\s+') | Where-Object { $_ }
      $opid = [int]$parts[-1]
      if ($opid -gt 0 -and $pids -notcontains $opid) { $pids += $opid }
    }
  }
  return $pids
}

function Test-LocalHealthy {
  # Single cheap probe. Keep timeout short - port-up is the hard signal.
  $urls = @(
    "http://127.0.0.1:$Port/api/health",
    "http://127.0.0.1:$Port/api/auth/config"
  )
  foreach ($url in $urls) {
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
    } catch {
      # try next
    }
  }
  return $false
}

function Test-AccountsEnabled {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/auth/config" -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -ne 200) { return $true } # don't recycle on probe failure
    $j = $r.Content | ConvertFrom-Json
    return [bool]$j.accounts
  } catch {
    return $true
  }
}

function Stop-PidTree {
  param([int]$ProcessId, [string]$Reason)
  if ($ProcessId -le 0) { return }
  Write-WatchLog "Stopping pid=$ProcessId ($Reason)" "WARN"
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 400
}

function Assert-SingleWatcher {
  if (Test-Path $PidFile) {
    $old = 0
    try { $old = [int]((Get-Content $PidFile -Raw).Trim()) } catch { $old = 0 }
    if ($old -gt 0 -and $old -ne $PID -and (Test-ProcessAlive $old)) {
      $cmd = Get-CmdLine $old
      if ($cmd -like '*watch-pc-site.ps1*') {
        Write-WatchLog "Another watcher already running (pid=$old). Exiting." "WARN"
        exit 0
      }
    }
  }
  Set-Content -Path $PidFile -Value "$PID" -Encoding ASCII
}

function Clear-WatcherPid {
  if (Test-Path $PidFile) {
    try {
      $old = [int]((Get-Content $PidFile -Raw).Trim())
      if ($old -eq $PID) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
    } catch { }
  }
}

function Import-DotEnvFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { return }
    $name = $line.Substring(0, $eq).Trim()
    $val = $line.Substring($eq + 1).Trim()
    if ($val.StartsWith('"') -and $val.EndsWith('"')) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    if ($name) { Set-Item -Path "Env:$name" -Value $val }
  }
}

function Save-EnvCache {
  $keys = @(
    'AUTH_SECRET','BODS_API_KEY','BUSMAPS_API_KEY','TRANSPORTAPI_APP_ID','TRANSPORTAPI_APP_KEY','PAYPAL_CLIENT_ID','PAYPAL_CLIENT_SECRET','PAYPAL_MODE',
    'PLUS_AMOUNT','PLUS_CURRENCY','PLUS_PRICE_LABEL','RESEND_API_KEY','MAIL_FROM',
    'STRIPE_SECRET_KEY','STRIPE_PRICE_ID','PUBLIC_SITE_URL'
  )
  $obj = [ordered]@{}
  foreach ($k in $keys) {
    $v = [string](Get-Item "Env:$k" -ErrorAction SilentlyContinue).Value
    if ($v) { $obj[$k] = $v }
  }
  ($obj | ConvertTo-Json) | Set-Content -Path $EnvCache -Encoding UTF8
}

function Load-EnvCache {
  if (-not (Test-Path $EnvCache)) { return $false }
  try {
    $obj = Get-Content $EnvCache -Raw | ConvertFrom-Json
    foreach ($p in $obj.PSObject.Properties) {
      Set-Item -Path "Env:$($p.Name)" -Value ([string]$p.Value)
    }
    return $true
  } catch {
    Write-WatchLog "Failed to load env cache: $($_.Exception.Message)" "WARN"
    return $false
  }
}

function Ensure-Secrets {
  Import-DotEnvFile (Join-Path $Root ".env")

  $haveCore = [bool]$env:AUTH_SECRET -and [bool]$env:BODS_API_KEY
  if ($script:SecretsLoaded) {
    $age = (Get-Date) - $script:LastRailwayFetchAt
    if ($haveCore -and $age.TotalHours -lt 6) { return }
    if (-not $haveCore -and $age.TotalMinutes -lt 10) { return }
  }

  if (-not $haveCore) {
    if (Load-EnvCache) {
      Write-WatchLog "Loaded secrets from data\pc-env.cache.json"
      $script:SecretsLoaded = $true
      $script:LastRailwayFetchAt = Get-Date
      $haveCore = [bool]$env:AUTH_SECRET -and [bool]$env:BODS_API_KEY
      if ($haveCore) { return }
    }
  }

  try {
    $rvJson = railway variables -s uk-bus-tracker --json 2>$null
    if ($rvJson) {
      $rv = $rvJson | ConvertFrom-Json
      foreach ($name in @(
        'AUTH_SECRET','BODS_API_KEY','BUSMAPS_API_KEY','TRANSPORTAPI_APP_ID','TRANSPORTAPI_APP_KEY','PAYPAL_CLIENT_ID','PAYPAL_CLIENT_SECRET','PAYPAL_MODE',
        'PLUS_AMOUNT','PLUS_CURRENCY','PLUS_PRICE_LABEL','RESEND_API_KEY','MAIL_FROM',
        'STRIPE_SECRET_KEY','STRIPE_PRICE_ID','PUBLIC_SITE_URL'
      )) {
        $val = [string]$rv.$name
        if ($val) { Set-Item -Path "Env:$name" -Value $val }
      }
      Save-EnvCache
      $script:LastRailwayFetchAt = Get-Date
      $script:SecretsLoaded = $true
      Write-WatchLog "Loaded secrets from Railway (cached to data\pc-env.cache.json)"
      return
    }
  } catch {
    Write-WatchLog "Railway variables failed: $($_.Exception.Message)" "WARN"
  }

  if (-not $script:SecretsLoaded) {
    if (Load-EnvCache) {
      Write-WatchLog "Using cached secrets (Railway unavailable)" "WARN"
      $script:SecretsLoaded = $true
    } else {
      Write-WatchLog "No Railway secrets and no cache - Plus/auth may be limited" "WARN"
      $script:SecretsLoaded = $true
    }
  }
  $script:LastRailwayFetchAt = Get-Date
}

function Set-PcRuntimeEnv {
  Remove-Item Env:TRAIL_REMOTE_URL -ErrorAction SilentlyContinue
  $env:TRAIL_DATA_DIR = Join-Path $Root "data\trails"
  $env:PC_PG_PORT = "$PgPort"
  $env:PC_PG_PASSWORD = "ukbus-local"
  $env:PORT = "$Port"
  if (Test-Path $DbUrlFile) {
    $env:DATABASE_URL = (Get-Content $DbUrlFile -Raw).Trim()
  }
}

function Start-LoggedProcess {
  param([string]$FilePath, [string]$ArgumentList, [string]$LogName)
  $outLog = Join-Path $LogDir "$LogName.out.log"
  $errLog = Join-Path $LogDir "$LogName.err.log"
  foreach ($f in @($outLog, $errLog)) {
    if (Test-Path $f) {
      $len = (Get-Item $f).Length
      if ($len -gt 20MB) {
        Move-Item $f ($f + ".old") -Force -ErrorAction SilentlyContinue
      }
    }
  }
  $p = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList `
    -WorkingDirectory $Root -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  return $p
}

function Ensure-Postgres {
  $listen = @(Get-PortPids $PgPort)
  $nodePg = Find-NodeByScript "pc-postgres.mjs"

  if ($listen.Count -gt 0 -and (Test-Path $DbUrlFile)) {
    if (-not $nodePg) {
      Write-WatchLog "Postgres listening on $PgPort (pid=$($listen -join ',')) - adopting"
    }
    $env:DATABASE_URL = (Get-Content $DbUrlFile -Raw).Trim()
    return $true
  }

  if ($nodePg -and $listen.Count -eq 0) {
    Write-WatchLog "pc-postgres.mjs running but port $PgPort not listening - restarting" "WARN"
    Stop-PidTree ([int]$nodePg.ProcessId) "stale pc-postgres"
  }

  Write-WatchLog "Starting embedded Postgres (scripts\pc-postgres.mjs)"
  $null = Start-LoggedProcess -FilePath "node" -ArgumentList "scripts\pc-postgres.mjs" -LogName "pc-postgres"
  $deadline = (Get-Date).AddMinutes(3)
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path $DbUrlFile) -and ((Get-PortPids $PgPort).Count -gt 0)) {
      $env:DATABASE_URL = (Get-Content $DbUrlFile -Raw).Trim()
      Write-WatchLog "Postgres ready"
      return $true
    }
    Start-Sleep -Seconds 2
  }
  Write-WatchLog "Postgres did not become ready within 3 minutes" "ERROR"
  return $false
}

function Ensure-Server {
  $listen = @(Get-PortPids $Port)
  $serverProc = Find-NodeByScript "server.mjs"
  $processUp = ($listen.Count -gt 0)
  $httpOk = $false
  # Heap headroom for 24/7 map + trails without OOM kills. Default V8 heap is too small under load.
  # Larger UV threadpool so scrypt (login) does not queue behind zlib/gzip of map JSON.
  $serverNodeArgs = "--max-old-space-size=2048 server.mjs"
  if (-not $env:UV_THREADPOOL_SIZE) { $env:UV_THREADPOOL_SIZE = "16" }

  # Process/port up is the primary signal. HTTP can time out when the Node
  # event loop is busy (trails/BODS) - do NOT restart just for slow HTTP.
  if ($processUp) {
    $httpOk = Test-LocalHealthy
    if ($httpOk) {
      $script:ServerFailStreak = 0
      foreach ($opid in $listen) { Set-AboveNormalPriority $opid "server" }
      # If an older server lacks the heap flag, recycle once so 24/7 has headroom.
      if ($serverProc) {
        $cmd = [string]$serverProc.CommandLine
        if ($cmd -and ($cmd -notlike '*max-old-space-size*')) {
          if (-not $script:ServerHeapUpgraded) {
            Write-WatchLog "Recycling server to apply --max-old-space-size=2048" "WARN"
            foreach ($opid in $listen) { Stop-PidTree $opid "heap flag upgrade" }
            if (Test-ProcessAlive ([int]$serverProc.ProcessId)) {
              Stop-PidTree ([int]$serverProc.ProcessId) "heap flag upgrade"
            }
            # Fall through to start below; mark upgraded only after a successful bind.
            $script:NeedsHeapUpgradeStart = $true
            $processUp = $false
          } else {
            return $true
          }
        } else {
          # Server started without DATABASE_URL → login shows "Accounts are not available".
          if ((Test-Path $DbUrlFile) -and -not (Test-AccountsEnabled)) {
            if (-not $script:AccountsFixAttempted) {
              $script:AccountsFixAttempted = $true
              Write-WatchLog "Auth accounts=false while pc-database.url exists - recycling server with DATABASE_URL" "WARN"
              foreach ($opid in $listen) { Stop-PidTree $opid "accounts disabled" }
              if ($serverProc -and (Test-ProcessAlive ([int]$serverProc.ProcessId))) {
                Stop-PidTree ([int]$serverProc.ProcessId) "accounts disabled"
              }
              $processUp = $false
            } else {
              return $true
            }
          } else {
            return $true
          }
        }
      } else {
        return $true
      }
    }
    if ($processUp) {
      $script:ServerFailStreak++
      if ($script:ServerFailStreak -eq 1 -or ($script:ServerFailStreak % 20) -eq 0) {
        Write-WatchLog "Server port $Port is up but HTTP slow/failing (streak=$script:ServerFailStreak) - leaving process alone" "WARN"
      }
      # Only force-restart if HTTP has been bad for a long time (~5 min at 15s poll)
      if ($script:ServerFailStreak -lt 20) {
        return $true
      }
      Write-WatchLog "Server HTTP unhealthy for streak=$script:ServerFailStreak - recycling" "WARN"
    }
  } else {
    $script:ServerFailStreak++
    Write-WatchLog "Nothing listening on port $Port (streak=$script:ServerFailStreak)" "WARN"
  }

  if ($processUp -or $script:ServerFailStreak -ge 20 -or $script:NeedsHeapUpgradeStart) {
    foreach ($opid in @(Get-PortPids $Port)) {
      Stop-PidTree $opid "recycling port $Port"
    }
    $serverProc = Find-NodeByScript "server.mjs"
    if ($serverProc -and (Test-ProcessAlive ([int]$serverProc.ProcessId))) {
      Stop-PidTree ([int]$serverProc.ProcessId) "recycling server.mjs"
    }
  }

  Set-PcRuntimeEnv
  if (-not $env:DATABASE_URL -and (Test-Path $DbUrlFile)) {
    $env:DATABASE_URL = (Get-Content $DbUrlFile -Raw).Trim()
  }

  Write-WatchLog "Starting server.mjs on port $Port (heap=2048MB)"
  $started = Start-LoggedProcess -FilePath "node" -ArgumentList $serverNodeArgs -LogName "server"
  if ($started) { Set-AboveNormalPriority ([int]$started.Id) "server" }

  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    $bound = @(Get-PortPids $Port)
    if ($bound.Count -gt 0) {
      $script:ServerFailStreak = 0
      if ($script:NeedsHeapUpgradeStart) {
        $script:ServerHeapUpgraded = $true
        $script:NeedsHeapUpgradeStart = $false
      }
      foreach ($opid in $bound) { Set-AboveNormalPriority $opid "server" }
      Write-WatchLog "Server listening on port $Port"
      return $true
    }
    Start-Sleep -Seconds 2
  }
  Write-WatchLog "Server failed to bind port $Port after start" "ERROR"
  return $false
}

function Ensure-Tunnel {
  # The named `uk-bus-tracker` connector is what actually fronts ukbustracker.co.uk.
  # A separate Cloudflared Windows service may also run (token-based) but does not
  # reliably replace the named tunnel — do not kill the named connector when the
  # service is present.
  $named = @(Find-NamedCloudflared | Where-Object {
    $_.CommandLine -like '*uk-bus-tracker*'
  })

  if ($named.Count -gt 0) {
    for ($i = 1; $i -lt $named.Count; $i++) {
      Stop-PidTree ([int]$named[$i].ProcessId) "extra named cloudflared"
    }
    $script:TunnelFailStreak = 0
    return $true
  }

  $cloudflared = $null
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "cloudflared\cloudflared.exe"),
    (Join-Path $env:ProgramFiles "cloudflared\cloudflared.exe")
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { $cloudflared = $c; break }
  }
  if (-not $cloudflared) {
    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd) { $cloudflared = $cmd.Source }
  }
  if (-not $cloudflared) {
    Write-WatchLog "cloudflared not found on PATH / Program Files" "ERROR"
    return $false
  }

  Write-WatchLog "Starting cloudflared tunnel (http2) uk-bus-tracker"
  $null = Start-LoggedProcess -FilePath $cloudflared -ArgumentList "tunnel --protocol http2 run uk-bus-tracker" -LogName "cloudflared"
  Start-Sleep -Seconds 3
  $up = @(Find-NamedCloudflared | Where-Object { $_.CommandLine -like '*uk-bus-tracker*' })
  if ($up.Count -gt 0) {
    Write-WatchLog "cloudflared running (pid=$($up[0].ProcessId))"
    return $true
  }
  Write-WatchLog "cloudflared failed to stay up - see logs\cloudflared.err.log" "ERROR"
  return $false
}

function Register-LogonTask {
  $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $script = Join-Path $Root "scripts\watch-pc-site.ps1"
  $arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
  try {
    $action = New-ScheduledTaskAction -Execute $psExe -Argument $arg -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
      -Settings $settings -Description "UK Bus Tracker PC watchdog (postgres + server + cloudflared)" `
      -Force | Out-Null
    Write-WatchLog "Scheduled task '$TaskName' registered (At log on for $env:USERNAME)"
    return $true
  } catch {
    Write-WatchLog "Could not register scheduled task: $($_.Exception.Message)" "WARN"
    Write-Host ""
    Write-Host "To auto-start after reboot, run this in an elevated PowerShell:" -ForegroundColor Yellow
    Write-Host ("  schtasks /Create /TN `{0}` /SC ONLOGON /RL LIMITED /F /TR `"'{1}' {2}`"" -f $TaskName, $psExe, $arg)
    return $false
  }
}

function Unregister-LogonTask {
  try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-WatchLog "Scheduled task '$TaskName' removed"
  } catch {
    Write-WatchLog "Unregister failed: $($_.Exception.Message)" "WARN"
  }
}

# --- entry ---
if ($UnregisterLogonTask) {
  Unregister-LogonTask
  exit 0
}

if ($RegisterLogonTask) {
  $ok = Register-LogonTask
  if ($Once -and -not $ok) { exit 1 }
}

if (-not $Once) { Assert-SingleWatcher }
Write-WatchLog "=== Watchdog start (pid=$PID, poll=${PollSeconds}s) ==="
Ensure-Secrets
Set-PcRuntimeEnv

try {
  do {
    try {
      Ensure-Secrets
      Set-PcRuntimeEnv
      $pgOk = Ensure-Postgres
      $srvOk = $false
      if ($pgOk) {
        $srvOk = Ensure-Server
      } else {
        Write-WatchLog "Skipping server until Postgres is up" "WARN"
      }
      $tunOk = Ensure-Tunnel

      $walPath = Join-Path $Root "data\trails\trails.sqlite-wal"
      if (Test-Path $walPath) {
        $walMb = [math]::Round((Get-Item $walPath).Length / 1MB, 1)
        if ($walMb -ge 500) {
          Write-WatchLog "Trails WAL is ${walMb}MB (>=500MB) - checkpoint may be stuck; check disk" "WARN"
        } elseif ($walMb -ge 100) {
          $sinceInfo = (Get-Date) - $script:LastWalInfoAt
          if ($sinceInfo.TotalMinutes -ge 30) {
            $script:LastWalInfoAt = Get-Date
            Write-WatchLog "Trails WAL is ${walMb}MB (>=100MB) - watching checkpoint cadence" "WARN"
          }
        }
      }

      # Keep process logs from ballooning forever (rotate already happens at start; trim .old).
      foreach ($oldLog in (Get-ChildItem $LogDir -Filter "*.log.old" -ErrorAction SilentlyContinue)) {
        if ($oldLog.Length -gt 50MB) {
          Write-WatchLog "Removing oversized $($oldLog.Name) ($([math]::Round($oldLog.Length/1MB,1))MB)"
          Remove-Item $oldLog.FullName -Force -ErrorAction SilentlyContinue
        }
      }

      if ($Once) {
        $healthyNow = Test-LocalHealthy
        Write-WatchLog "Once-check done: pg=$pgOk server=$srvOk tunnel=$tunOk healthy=$healthyNow"
        break
      }
    } catch {
      Write-WatchLog "Watch loop error: $($_.Exception.Message)" "ERROR"
    }
    Start-Sleep -Seconds ([Math]::Max(5, $PollSeconds))
  } while (-not $Once)
} finally {
  Clear-WatcherPid
  Write-WatchLog "=== Watchdog stopped ==="
}
