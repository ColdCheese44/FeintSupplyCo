<#
  Jarvis Terminal - opens the dashboard as a chromeless desktop app window (Edge/Chrome --app),
  the FeintTrade-style shell. Starts the dashboard server first if it is not already running.
#>
param([int]$Port = 4200)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Url = "http://localhost:$Port"

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

# Prefer Microsoft Edge, fall back to Chrome, then the default browser.
$candidates = @(
  (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe")
)
$browser = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if ($browser) {
  # A dedicated user-data-dir gives the app window its own identity and taskbar entry.
  $profileDir = Join-Path $env:LOCALAPPDATA "JarvisTerminal"
  Start-Process -FilePath $browser -ArgumentList @(
    "--app=$Url",
    "--window-size=1480,920",
    "--user-data-dir=$profileDir"
  ) | Out-Null
  Write-Host "Jarvis Terminal opened ($([System.IO.Path]::GetFileName($browser)) app window) at $Url"
} else {
  Start-Process $Url | Out-Null
  Write-Host "No Edge/Chrome found; opened $Url in the default browser."
}
