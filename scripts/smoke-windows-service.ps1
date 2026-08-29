param(
  [Parameter(Mandatory = $true)]
  [string]$BinaryPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$taskPattern = '^\\SelfTuneDaemon-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
$configDir = Join-Path $env:RUNNER_TEMP "selftune-service-smoke-$([guid]::NewGuid())"
$receiptPath = Join-Path $configDir "server-control/windows-service-installation.json"
$authPath = Join-Path $configDir "server-control/auth.json"
$manifestPath = Join-Path $configDir "server-control/server.json"
$binary = (Resolve-Path $BinaryPath).Path
$env:SELFTUNE_DESKTOP_RESOURCE_DIR = Split-Path -Parent $binary
$port = 0
$installedTaskName = $null
$lifecycleFailure = $null
$cleanupFailure = $null
$runtimePids = [System.Collections.Generic.HashSet[int]]::new()

function Assert-SmokeCondition {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    0
  )
  try {
    $listener.Start()
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  }
  finally {
    $listener.Stop()
  }
}

function Get-SelfTuneTaskNames {
  $schtasks = Join-Path $env:SystemRoot "System32/schtasks.exe"
  $lines = @(& $schtasks /query /fo CSV /nh 2>$null)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inventory Windows scheduled tasks (exit $LASTEXITCODE)."
  }

  $tasks = @()
  foreach ($lineValue in $lines) {
    $line = [string]$lineValue
    if ($line -notmatch '^"((?:[^"]|"")*)"') {
      continue
    }
    $taskName = $Matches[1].Replace('""', '"')
    if ($taskName -imatch $taskPattern) {
      $tasks += $taskName
    }
  }
  return $tasks
}

function Invoke-ServiceAction {
  param([string]$Action)

  $arguments = @(
    "service",
    $Action,
    "--config-dir",
    $configDir,
    "--port",
    [string]$port,
    "--owner",
    "cli",
    "--json"
  )
  $stdout = @(& $binary @arguments)
  if ($LASTEXITCODE -ne 0) {
    throw "SelfTune service $Action failed with exit code $LASTEXITCODE."
  }
  $lines = @($stdout | ForEach-Object { [string]$_ } | Where-Object { $_.Trim().Length -gt 0 })
  if ($lines.Count -eq 0) {
    throw "SelfTune service $Action returned no JSON response."
  }
  try {
    return $lines[-1] | ConvertFrom-Json
  }
  catch {
    throw "SelfTune service $Action returned invalid JSON: $($lines[-1])"
  }
}

function Invoke-ServiceMaintenance {
  param([string]$Action)

  $stdout = @(& $binary service $Action --json)
  $exitCode = $LASTEXITCODE
  $lines = @($stdout | ForEach-Object { [string]$_ } | Where-Object { $_.Trim().Length -gt 0 })
  if ($lines.Count -eq 0) {
    throw "SelfTune service $Action returned no JSON response."
  }
  $response = $lines[-1] | ConvertFrom-Json
  if ($exitCode -ne 0 -and $response.ok -ne $false) {
    throw "SelfTune service $Action failed with exit code $exitCode."
  }
  return $response
}

function Install-StaleLegacyLockFixture {
  $localAppData = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::LocalApplicationData
  )
  $controlDir = [System.IO.Path]::GetFullPath(
    (Join-Path $localAppData "SelfTune/service-control")
  ).TrimEnd("\\").ToLowerInvariant()
  $lockPath = Join-Path $controlDir "windows-service-mutation.lock"
  New-Item -ItemType Directory -Path $controlDir -Force | Out-Null
  $fixturePid = 2147483000
  Assert-SmokeCondition `
    ($null -eq (Get-Process -Id $fixturePid -ErrorAction SilentlyContinue)) `
    "The stale-lock fixture PID unexpectedly exists."
  $payload = [ordered]@{
    controlDir = $controlDir
    namespace = "selftune-user-service-v1"
    pid = $fixturePid
    startedAt = "2026-07-16T11:00:00.000Z"
    token = "PLACEHOLDER_WINDOWS_SERVICE_TOKEN"
    userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value.ToUpperInvariant()
    version = 2
  }
  [System.IO.File]::WriteAllText(
    $lockPath,
    (($payload | ConvertTo-Json -Compress) + "`n"),
    [System.Text.UTF8Encoding]::new($false)
  )
}

function Assert-RunningService {
  param(
    [object]$Response,
    [string]$Action
  )

  Assert-SmokeCondition ($Response.ok -eq $true) "$Action did not report success."
  Assert-SmokeCondition ($Response.action -eq $Action) "$Action returned the wrong action."
  Assert-SmokeCondition ($Response.status.platform -eq "win32") "$Action used the wrong backend."
  Assert-SmokeCondition ($Response.status.registered -eq $true) "$Action did not register the task."
  Assert-SmokeCondition ($Response.status.running -eq $true) "$Action did not start the service."
}

function Assert-AuthenticatedStatus {
  param([object]$Response)

  Assert-RunningService $Response "status"
  $detail = @($Response.status.detail) -join "`n"
  Assert-SmokeCondition `
    ($detail.Contains("Serving http://127.0.0.1:$port ")) `
    "Service status did not include authenticated runtime evidence."

  $origin = "http://127.0.0.1:$port"
  $unauthenticated = Invoke-WebRequest `
    -Uri "$origin/api/health" `
    -Method Get `
    -SkipHttpErrorCheck `
    -TimeoutSec 5
  Assert-SmokeCondition `
    ($unauthenticated.StatusCode -eq 401) `
    "The supervised health endpoint accepted an unauthenticated request."

  $auth = Get-Content $authPath -Raw | ConvertFrom-Json
  Assert-SmokeCondition `
    ($auth.token -is [string] -and $auth.token.Length -ge 32) `
    "The supervised runtime did not persist a valid authentication token."

  $authenticated = Invoke-WebRequest `
    -Uri "$origin/api/health" `
    -Method Get `
    -Headers @{ Authorization = "Bearer $($auth.token)" } `
    -SkipHttpErrorCheck `
    -TimeoutSec 5
  Assert-SmokeCondition `
    ($authenticated.StatusCode -eq 200) `
    "The supervised health endpoint rejected its persisted authentication token."
  $health = $authenticated.Content | ConvertFrom-Json
  Assert-SmokeCondition ($health.ok -eq $true) "Authenticated health was not healthy."
  Assert-SmokeCondition `
    ($health.service -eq "selftune-dashboard") `
    "Authenticated health returned the wrong service identity."
  Assert-SmokeCondition ($health.pid -gt 0) "Authenticated health did not report a runtime PID."
  $null = $runtimePids.Add([int]$health.pid)
  Assert-SmokeCondition `
    ($detail.Contains("(pid $($health.pid),")) `
    "Service status and authenticated health PID evidence disagreed."
  Assert-SmokeCondition ($health.port -eq $port) "Service port evidence disagreed."
  Assert-SmokeCondition ($health.runtime_owner -eq "cli") "Service owner evidence disagreed."
  Assert-SmokeCondition `
    ($health.runtime_supervision -eq "os-service") `
    "Service supervision evidence disagreed."
  Assert-SmokeCondition `
    ([System.IO.Path]::GetFullPath([string]$health.owner_executable_path) -ieq $binary) `
    "Service executable evidence disagreed."
  Assert-SmokeCondition `
    ($health.service_installation_nonce -is [string] -and `
      $health.service_installation_nonce.Length -ge 32) `
    "Authenticated health did not bind the runtime to its installation nonce."
}

function Wait-SmokeRuntimeAbsent {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
  do {
    $alivePids = @(
      $runtimePids | Where-Object {
        $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue)
      }
    )

    $client = [System.Net.Sockets.TcpClient]::new()
    $listenerPresent = $false
    try {
      $connect = $client.ConnectAsync("127.0.0.1", $port)
      $listenerPresent = $connect.Wait(500) -and -not $connect.IsFaulted -and $client.Connected
    }
    catch {
      $listenerPresent = $false
    }
    finally {
      $client.Dispose()
    }

    if ($alivePids.Count -eq 0 -and -not $listenerPresent) {
      return
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTimeOffset]::UtcNow -lt $deadline)

  throw "Windows service smoke left runtime PIDs or its listener behind."
}

function Remove-SmokeTask {
  param([string]$TaskName)

  if ($TaskName -notmatch '^\\') {
    $TaskName = "\$TaskName"
  }
  if ($TaskName -inotmatch $taskPattern) {
    throw "Refusing fallback cleanup for unexpected task name: $TaskName"
  }
  $schtasks = Join-Path $env:SystemRoot "System32/schtasks.exe"
  $null = & $schtasks /end /tn $TaskName 2>&1
  $null = & $schtasks /delete /tn $TaskName /f 2>&1
}

$baselineTasks = [System.Collections.Generic.HashSet[string]]::new(
  [System.StringComparer]::OrdinalIgnoreCase
)
foreach ($taskName in Get-SelfTuneTaskNames) {
  $null = $baselineTasks.Add($taskName)
}

$port = Get-FreeTcpPort
New-Item -ItemType Directory -Path $configDir -Force | Out-Null

try {
  $initialDoctor = Invoke-ServiceMaintenance "doctor"
  Assert-SmokeCondition `
    ($initialDoctor.diagnostic.state -eq "ready_to_fence") `
    "A clean runner did not report a ready-to-fence service lock."

  Install-StaleLegacyLockFixture
  $staleDoctor = Invoke-ServiceMaintenance "doctor"
  Assert-SmokeCondition `
    ($staleDoctor.diagnostic.state -eq "legacy_stale_repairable") `
    "The legacy fixture was not diagnosed as safely repairable."
  $repair = Invoke-ServiceMaintenance "repair-lock"
  Assert-SmokeCondition ($repair.ok -eq $true) "Stale lock repair did not report success."
  Assert-SmokeCondition ($repair.result -eq "repaired") "Stale lock repair did not run."
  Assert-SmokeCondition `
    ($repair.diagnostic.state -eq "fenced") `
    "Stale lock repair did not install the compatibility fence."

  $install = Invoke-ServiceAction "install"
  Assert-RunningService $install "install"

  $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json
  Assert-SmokeCondition `
    ($receipt.taskName -is [string]) `
    "Service install did not persist its task name."
  $installedTaskName = [string]$receipt.taskName

  $status = Invoke-ServiceAction "status"
  Assert-AuthenticatedStatus $status
  $installedDoctor = Invoke-ServiceMaintenance "doctor"
  Assert-SmokeCondition `
    ($installedDoctor.diagnostic.state -eq "fenced") `
    "Installed service did not retain the compatibility fence."

  $restart = Invoke-ServiceAction "restart"
  Assert-RunningService $restart "restart"

  $restartedStatus = Invoke-ServiceAction "status"
  Assert-AuthenticatedStatus $restartedStatus

  $uninstall = Invoke-ServiceAction "uninstall"
  Assert-SmokeCondition ($uninstall.ok -eq $true) "Uninstall did not report success."
  Assert-SmokeCondition `
    ($uninstall.status.registered -eq $false) `
    "Uninstall left the service registered."
  Assert-SmokeCondition `
    ($uninstall.status.running -eq $false) `
    "Uninstall left the service running."
}
catch {
  $lifecycleFailure = $_
  Write-Host "Windows service lifecycle failed: $_"
}
finally {
  try {
    if (Test-Path $receiptPath) {
      $cleanupReceipt = Get-Content $receiptPath -Raw | ConvertFrom-Json
      if ($cleanupReceipt.taskName -is [string]) {
        $installedTaskName = [string]$cleanupReceipt.taskName
      }
    }
    if (Test-Path $manifestPath) {
      $cleanupManifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
      if ($cleanupManifest.pid -gt 0) {
        $null = $runtimePids.Add([int]$cleanupManifest.pid)
      }
    }

    if ($null -ne $lifecycleFailure -and $null -ne $installedTaskName) {
      $schtasks = Join-Path $env:SystemRoot "System32/schtasks.exe"
      [xml]$registeredTask = (& $schtasks /query /tn $installedTaskName /xml)
      $principalElementNames = @(
        $registeredTask.Task.Principals.Principal.ChildNodes | ForEach-Object { $_.LocalName }
      )
      $settingsElementNames = @(
        $registeredTask.Task.Settings.ChildNodes | ForEach-Object { $_.LocalName }
      )
      Write-Host "Registered task principal elements: $($principalElementNames -join ', ')"
      Write-Host "Registered task settings elements: $($settingsElementNames -join ', ')"
    }

    try {
      $null = Invoke-ServiceAction "uninstall"
    }
    catch {
      Write-Warning "Normal service cleanup failed; applying the scoped task fallback: $_"
    }

    $null = & $binary daemon stop --config-dir $configDir 2>&1

    if ($null -ne $installedTaskName) {
      Remove-SmokeTask $installedTaskName
    }
    foreach ($taskName in Get-SelfTuneTaskNames) {
      if (-not $baselineTasks.Contains($taskName)) {
        Remove-SmokeTask $taskName
      }
    }

    $remaining = @(
      Get-SelfTuneTaskNames | Where-Object { -not $baselineTasks.Contains($_) }
    )
    Assert-SmokeCondition `
      ($remaining.Count -eq 0) `
      "Windows service smoke left scheduled tasks behind: $($remaining -join ', ')"
    Wait-SmokeRuntimeAbsent
    Remove-Item -Path $configDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  catch {
    $cleanupFailure = $_
  }
}

if ($null -ne $lifecycleFailure) {
  throw $lifecycleFailure
}
if ($null -ne $cleanupFailure) {
  throw $cleanupFailure
}

Write-Host "Windows service lifecycle smoke passed on port $port."
