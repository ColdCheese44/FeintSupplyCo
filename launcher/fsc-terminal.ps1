<#
  FeintSupplyCo Terminal - opens the dashboard as a fullscreen Brave desktop app window,
  the FeintTrade-style shell. Starts the dashboard server first if it is not already running.
#>
param([int]$Port = 4200)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Url = "http://localhost:$Port"
. (Join-Path $PSScriptRoot "feint-browser.ps1")

# Returns whether something is already listening on the dashboard port.
function Test-DashboardUp {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne(400)
    $connected = $ok -and $client.Connected
    $client.Close()
    return $connected
  } catch { return $false }
}

# Start the dashboard server hidden if it is not up yet, then wait for it.
if (-not (Test-DashboardUp)) {
  $cmd = "Set-Location -LiteralPath '$ProjectRoot'; npm run dashboard"
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", $cmd) `
    -WorkingDirectory $ProjectRoot | Out-Null
  for ($i = 0; $i -lt 40; $i++) {
    if (Test-DashboardUp) { break }
    Start-Sleep -Milliseconds 500
  }
}

# A dedicated user-data-dir gives the app window its own identity and taskbar entry.
$profileDir = Join-Path $env:LOCALAPPDATA "FeintSupplyCoTerminal"
$openedWithBrave = Open-FeintBrowser -Url $Url -App -ExtraArguments @(
  "--window-size=1480,920",
  "--user-data-dir=$profileDir"
)

if ($openedWithBrave) {
  Write-Host "FeintSupplyCo Terminal opened in Brave app mode at $Url"
} else {
  Write-Host "Brave unavailable; opened $Url in the default browser."
}
