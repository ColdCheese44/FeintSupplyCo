param(
  [string[]]$TestInputs,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"

function Get-ProjectRoot {
  return Split-Path -Parent $PSScriptRoot
}

function Get-EnvPath {
  return Join-Path (Get-ProjectRoot) ".env"
}

function Get-LauncherLogPath {
  return Join-Path $PSScriptRoot "launcher.log"
}

function Ensure-LauncherLogDirectory {
  $logDirectory = Split-Path -Parent (Get-LauncherLogPath)
  if (-not (Test-Path -LiteralPath $logDirectory)) {
    New-Item -ItemType Directory -Path $logDirectory | Out-Null
  }
}

function Write-LauncherLog {
  param(
    [string]$Action
  )

  Ensure-LauncherLogDirectory
  Add-Content -LiteralPath (Get-LauncherLogPath) -Value "$(Get-Date -Format s) $Action"
}

function Read-DryRunState {
  if (-not (Test-Path -LiteralPath (Get-EnvPath))) {
    return "UNKNOWN"
  }

  $line = Select-String -Path (Get-EnvPath) -Pattern "^DRY_RUN=" | Select-Object -Last 1
  if (-not $line) {
    return "UNKNOWN"
  }

  $value = $line.Line.Split("=", 2)[1].Trim().ToLowerInvariant()
  if ($value -eq "true") {
    return "DRY_RUN ACTIVE"
  }
  if ($value -eq "false") {
    return "LIVE OPERATION"
  }
  return "UNKNOWN"
}

function Get-ReadinessStatus {
  Push-Location (Get-ProjectRoot)
  try {
    $output = & npm.cmd run audit --silent 2>&1
  } finally {
    Pop-Location
  }

  $joined = ($output | Out-String)
  $match = [regex]::Match($joined, "FeintSupplyCo is (\d+)% ready to run live\. (\d+) of (\d+) required keys are valid\.")
  if (-not $match.Success) {
    return @{
      Percent = "?"
      Valid = "?"
      Total = "?"
      Raw = $joined
    }
  }

  return @{
    Percent = $match.Groups[1].Value
    Valid = $match.Groups[2].Value
    Total = $match.Groups[3].Value
    Raw = $joined
  }
}

function New-BorderLine {
  param(
    [char]$Left,
    [char]$Fill,
    [char]$Right
  )

  return "$Left$($Fill.ToString() * 50)$Right"
}

function New-ContentLine {
  param(
    [string]$Content
  )

  $innerWidth = 50
  $trimmed = if ($Content.Length -gt $innerWidth) { $Content.Substring(0, $innerWidth) } else { $Content }
  return ("{0}{1}{2}" -f [char]0x2551, $trimmed.PadLeft([math]::Floor(($innerWidth + $trimmed.Length) / 2)).PadRight($innerWidth), [char]0x2551)
}

function Show-Banner {
  param(
    [string]$DryRunState,
    [hashtable]$Readiness
  )

  $host.UI.RawUI.WindowTitle = "FEINT SUPPLY CO $([char]0x2014) Etsy Commerce Autopilot"
  $host.UI.RawUI.BackgroundColor = "Black"
  $host.UI.RawUI.ForegroundColor = "Green"
  Clear-Host

  Write-Host (New-BorderLine -Left ([char]0x2554) -Fill ([char]0x2550) -Right ([char]0x2557)) -ForegroundColor Green
  Write-Host (New-ContentLine -Content "J A R V I S") -ForegroundColor Green
  Write-Host (New-ContentLine -Content "Etsy Commerce Automation System") -ForegroundColor Green
  Write-Host (New-ContentLine -Content "") -ForegroundColor Green
  Write-Host (New-ContentLine -Content ("Status: {0}" -f $DryRunState)) -ForegroundColor Green
  Write-Host (New-BorderLine -Left ([char]0x255A) -Fill ([char]0x2550) -Right ([char]0x255D)) -ForegroundColor Green
  Write-Host ""

  if ($DryRunState -eq "DRY_RUN ACTIVE") {
    Write-Host "DRY_RUN ACTIVE" -ForegroundColor Yellow
  } elseif ($DryRunState -eq "LIVE OPERATION") {
    Write-Host "LIVE OPERATION" -ForegroundColor Red
  } else {
    Write-Host "DRY_RUN STATE UNKNOWN" -ForegroundColor Yellow
  }

  Write-Host ("READINESS: {0}% - {1}/{2} required keys valid" -f $Readiness.Percent, $Readiness.Valid, $Readiness.Total) -ForegroundColor Cyan
  Write-Host ""
}

function Get-NextChoice {
  if ($script:TestInputQueue.Count -gt 0) {
    $choice = $script:TestInputQueue[0]
    if ($script:TestInputQueue.Count -gt 1) {
      $script:TestInputQueue = @($script:TestInputQueue[1..($script:TestInputQueue.Count - 1)])
    } else {
      $script:TestInputQueue = @()
    }
    Write-Host "Selected (test): $choice" -ForegroundColor DarkGreen
    return $choice
  }

  return Read-Host "Choose an action"
}

function Pause-IfNeeded {
  if ($NoPause) {
    return
  }
  if ($script:TestInputQueue.Count -gt 0) {
    return
  }
  [void](Read-Host "Press Enter to continue")
}

function Invoke-ProjectCommand {
  param(
    [string]$ActionLabel,
    [string[]]$Command
  )

  Write-LauncherLog $ActionLabel
  Push-Location (Get-ProjectRoot)
  try {
    if ($Command.Count -le 1) {
      & $Command[0]
    } else {
      & $Command[0] @($Command[1..($Command.Count - 1)])
    }
  } finally {
    Pop-Location
  }
}

function Open-Dashboard {
  Write-LauncherLog "Open dashboard"
  $projectRoot = Get-ProjectRoot
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-Command", "Set-Location '$projectRoot'; npm.cmd run dashboard"
  ) -WorkingDirectory $projectRoot -WindowStyle Normal | Out-Null

  Start-Sleep -Seconds 2
  Start-Process "http://localhost:4200" | Out-Null
}

function Show-LatestLogs {
  Write-LauncherLog "View latest logs"
  $jarvisLog = Join-Path (Get-ProjectRoot) "data\feintsupply.log"
  $launcherLog = Get-LauncherLogPath

  Write-Host ""
  Write-Host "Launcher log" -ForegroundColor Cyan
  if (Test-Path -LiteralPath $launcherLog) {
    Get-Content -LiteralPath $launcherLog -Tail 20
  } else {
    Write-Host "No launcher log yet." -ForegroundColor Yellow
  }

  Write-Host ""
  Write-Host "FeintSupplyCo log" -ForegroundColor Cyan
  if (Test-Path -LiteralPath $jarvisLog) {
    Get-Content -LiteralPath $jarvisLog -Tail 40
  } else {
    Write-Host "No feintsupply.log file yet." -ForegroundColor Yellow
  }
}

function Run-TshirtCollection {
  Write-LauncherLog "Run tshirts:preview"
  Push-Location (Get-ProjectRoot)
  try {
    & npm.cmd run tshirts:preview
    if ($LASTEXITCODE -ne 0) {
      return
    }

    if ($script:TestInputQueue.Count -gt 0) {
      $confirm = $script:TestInputQueue[0]
      if ($script:TestInputQueue.Count -gt 1) {
        $script:TestInputQueue = @($script:TestInputQueue[1..($script:TestInputQueue.Count - 1)])
      } else {
        $script:TestInputQueue = @()
      }
      Write-Host "Publish collection (test): $confirm" -ForegroundColor DarkGreen
    } else {
      $confirm = Read-Host "Run live t-shirt collection now? (y/n)"
    }

    if ($confirm -match '^(y|yes)$') {
      Write-LauncherLog "Run tshirts"
      & npm.cmd run tshirts
    }
  } finally {
    Pop-Location
  }
}

$script:TestInputQueue = @($TestInputs)
$script:ShouldExit = $false

while ($true) {
  $dryRunState = Read-DryRunState
  $readiness = Get-ReadinessStatus
  Show-Banner -DryRunState $dryRunState -Readiness $readiness

  Write-Host "[1] Run heartbeat (one cycle)"
  Write-Host "[2] Run order watch (one check)"
  Write-Host "[3] View cost dashboard"
  Write-Host "[4] Run smoke test"
  Write-Host "[5] Run audit"
  Write-Host "[6] Open Dashboard"
  Write-Host "[7] Register OpenClaw Skills"
  Write-Host "[8] Generate Sticker Collection"
  Write-Host "[9] Generate T-Shirt Collection"
  Write-Host "[10] Preview Discord digest"
  Write-Host "[11] Diagnose Pinterest"
  Write-Host "[12] Go live (Etsy must be approved)"
  Write-Host "[13] View latest logs"
  Write-Host "[0] Exit"
  Write-Host ""

  $choice = Get-NextChoice
  switch ($choice) {
    "1" { Invoke-ProjectCommand -ActionLabel "Run heartbeat" -Command @("npm.cmd", "run", "heartbeat"); Pause-IfNeeded }
    "2" { Invoke-ProjectCommand -ActionLabel "Run orderwatch" -Command @("npm.cmd", "run", "orderwatch"); Pause-IfNeeded }
    "3" { Invoke-ProjectCommand -ActionLabel "Run costs" -Command @("npm.cmd", "run", "costs"); Pause-IfNeeded }
    "4" { Invoke-ProjectCommand -ActionLabel "Run smoke" -Command @("npm.cmd", "run", "smoke"); Pause-IfNeeded }
    "5" { Invoke-ProjectCommand -ActionLabel "Run audit" -Command @("npm.cmd", "run", "audit"); Pause-IfNeeded }
    "6" { Open-Dashboard; Pause-IfNeeded }
    "7" { Invoke-ProjectCommand -ActionLabel "Run register:skills" -Command @("npm.cmd", "run", "register:skills"); Pause-IfNeeded }
    "8" { Invoke-ProjectCommand -ActionLabel "Run stickers:preview" -Command @("npm.cmd", "run", "stickers:preview"); Pause-IfNeeded }
    "9" { Run-TshirtCollection; Pause-IfNeeded }
    "10" { Invoke-ProjectCommand -ActionLabel "Run preview-digest" -Command @("npm.cmd", "run", "preview-digest"); Pause-IfNeeded }
    "11" { Invoke-ProjectCommand -ActionLabel "Run diagnose:pinterest" -Command @("npm.cmd", "run", "diagnose:pinterest"); Pause-IfNeeded }
    "12" { Invoke-ProjectCommand -ActionLabel "Run go-live" -Command @("npm.cmd", "run", "go-live"); Pause-IfNeeded }
    "13" { Show-LatestLogs; Pause-IfNeeded }
    "0" {
      Write-LauncherLog "Exit"
      $script:ShouldExit = $true
    }
    default {
      Write-Host "Unknown option." -ForegroundColor Yellow
      Pause-IfNeeded
    }
  }

  if ($script:ShouldExit) {
    break
  }
}
