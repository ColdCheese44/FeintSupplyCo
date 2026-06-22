<#
  FeintSupplyCo Control Panel - native WPF desktop app for the Feint Supply Co autopilot.
  Launches the dashboard, the autonomous daemon, and every component, with live status.
  No external dependencies (uses WPF built into Windows). Falls back to the terminal menu if WPF is unavailable.
#>

# WPF needs a single-threaded apartment; relaunch under -STA if we are not already there.
# (Skipped during self-test, which only builds the UI tree and never shows the window.)
if (-not $env:FSC_APP_SELFTEST -and [System.Threading.Thread]::CurrentThread.GetApartmentState() -ne [System.Threading.ApartmentState]::STA) {
  Start-Process -FilePath "powershell.exe" -ArgumentList @("-STA", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", $PSCommandPath)
  return
}

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RunnerCmd = Join-Path $ProjectRoot "scripts\run-daemon.cmd"
$InstallerPs1 = Join-Path $ProjectRoot "scripts\install-daemon-task.ps1"
$TuiPs1 = Join-Path $PSScriptRoot "fsc-menu.ps1"
$IconPath = Join-Path $PSScriptRoot "fsc.ico"

try {
  Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml
} catch {
  # WPF unavailable - fall back to the terminal menu.
  Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-File", $TuiPs1) -WorkingDirectory $ProjectRoot
  return
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function New-Brush([string]$hex) { return New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($hex)) }

$Colors = @{
  Bg      = "#0D1117"
  Panel   = "#161B22"
  Card    = "#1B2230"
  Text    = "#E6EDF3"
  Muted   = "#8B949E"
  Green   = "#00A86B"
  Cyan    = "#38BDF8"
  Amber   = "#FFB000"
  Danger  = "#FF6B6B"
  Border  = "#30363D"
}

function Set-Output([string]$message, [string]$kind = "info") {
  $brush = switch ($kind) {
    "ok"   { New-Brush $Colors.Green }
    "warn" { New-Brush $Colors.Amber }
    "err"  { New-Brush $Colors.Danger }
    default { New-Brush $Colors.Muted }
  }
  $script:OutputText.Foreground = $brush
  $script:OutputText.Text = "$(Get-Date -Format 'HH:mm:ss')  $message"
}

# Launches an npm script in its own visible PowerShell window so output stays watchable.
function Start-NpmWindow([string]$scriptName, [string]$label) {
  $cmd = "Set-Location -LiteralPath '$ProjectRoot'; Write-Host 'FeintSupplyCo > npm run $scriptName' -ForegroundColor Green; npm run $scriptName"
  Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $cmd) -WorkingDirectory $ProjectRoot | Out-Null
  Set-Output "Launched: $label (npm run $scriptName)" "ok"
}

function Get-DaemonProcesses {
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*fsc-daemon*' })
}

function Test-DashboardUp {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect("127.0.0.1", 4200, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne(400)
    if ($ok -and $client.Connected) { $client.Close(); return $true }
    $client.Close(); return $false
  } catch { return $false }
}

function Get-DryRunState {
  $envPath = Join-Path $ProjectRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) { return "UNKNOWN" }
  $line = Select-String -Path $envPath -Pattern "^DRY_RUN=" | Select-Object -Last 1
  if (-not $line) { return "UNKNOWN" }
  $val = $line.Line.Split("=", 2)[1].Trim().ToLowerInvariant()
  if ($val -eq "true") { return "DRY_RUN" }
  if ($val -eq "false") { return "LIVE" }
  return "UNKNOWN"
}

function Update-Status {
  $mode = Get-DryRunState
  $script:ModeValue.Text = $mode
  $script:ModeValue.Foreground = if ($mode -eq "LIVE") { New-Brush $Colors.Danger } elseif ($mode -eq "DRY_RUN") { New-Brush $Colors.Amber } else { New-Brush $Colors.Muted }

  $daemon = (Get-DaemonProcesses).Count -gt 0
  $script:DaemonValue.Text = if ($daemon) { "RUNNING" } else { "STOPPED" }
  $script:DaemonValue.Foreground = if ($daemon) { New-Brush $Colors.Green } else { New-Brush $Colors.Muted }

  $dash = Test-DashboardUp
  $script:DashboardValue.Text = if ($dash) { "UP :4200" } else { "DOWN" }
  $script:DashboardValue.Foreground = if ($dash) { New-Brush $Colors.Green } else { New-Brush $Colors.Muted }
}

# ---------------------------------------------------------------------------
# Component actions
# ---------------------------------------------------------------------------

function Invoke-Component([string]$key) {
  try {
    switch ($key) {
      "dashboard" {
        # Opens the dashboard as a chromeless app window (FeintTrade-style terminal),
        # starting the server first if needed.
        $terminal = Join-Path $PSScriptRoot "fsc-terminal.ps1"
        Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", $terminal) -WorkingDirectory $ProjectRoot | Out-Null
        Set-Output "Opening FeintSupplyCo Terminal (app window)..." "ok"
      }
      "start-daemon" {
        if ((Get-DaemonProcesses).Count -gt 0) { Set-Output "Daemon is already running." "warn" }
        else {
          Start-Process -FilePath $RunnerCmd -WorkingDirectory $ProjectRoot -WindowStyle Hidden | Out-Null
          Set-Output "Autonomous daemon started (hidden)." "ok"
        }
      }
      "stop-daemon" {
        $procs = Get-DaemonProcesses
        if ($procs.Count -eq 0) { Set-Output "No daemon process running." "warn" }
        else {
          foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
          Set-Output "Stopped daemon ($($procs.Count) process(es))." "ok"
        }
      }
      "install-daemon" {
        $cmd = "Set-Location -LiteralPath '$ProjectRoot'; & '$InstallerPs1' -Start; Write-Host ''; Read-Host 'Press Enter to close'"
        Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $cmd) -WorkingDirectory $ProjectRoot | Out-Null
        Set-Output "Installing autostart + starting daemon..." "ok"
      }
      "uninstall-daemon" {
        $cmd = "Set-Location -LiteralPath '$ProjectRoot'; & '$InstallerPs1' -Uninstall; Write-Host ''; Read-Host 'Press Enter to close'"
        Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $cmd) -WorkingDirectory $ProjectRoot | Out-Null
        Set-Output "Removing daemon autostart..." "ok"
      }
      "tui"        { Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $TuiPs1) -WorkingDirectory $ProjectRoot | Out-Null; Set-Output "Opened terminal menu." "ok" }
      "logs"       { $log = Join-Path $ProjectRoot "data\feintsupply.log"; if (Test-Path $log) { Start-Process $log } else { Set-Output "No feintsupply.log yet." "warn" } }
      "data-folder"{ Start-Process (Join-Path $ProjectRoot "data") | Out-Null; Set-Output "Opened data folder." "ok" }
      "project"    { Start-Process $ProjectRoot | Out-Null; Set-Output "Opened project folder." "ok" }
      default      { Start-NpmWindow $key $key }
    }
    if ($key -in @("start-daemon", "stop-daemon", "dashboard")) { Start-Sleep -Milliseconds 300; Update-Status }
  } catch {
    Set-Output "Error: $($_.Exception.Message)" "err"
  }
}

# ---------------------------------------------------------------------------
# UI construction
# ---------------------------------------------------------------------------

$window = New-Object System.Windows.Window
$window.Title = "FEINT SUPPLY CO - Feint Supply Co. Control Panel"
$window.Width = 760
$window.Height = 660
$window.WindowStartupLocation = "CenterScreen"
$window.Background = New-Brush $Colors.Bg
$window.FontFamily = New-Object System.Windows.Media.FontFamily("Segoe UI")
if (Test-Path -LiteralPath $IconPath) {
  try { $window.Icon = New-Object System.Windows.Media.Imaging.BitmapImage ([Uri]$IconPath) } catch { }
}

$root = New-Object System.Windows.Controls.DockPanel
$root.Margin = "16"

# --- Header ---
$header = New-Object System.Windows.Controls.StackPanel
[System.Windows.Controls.DockPanel]::SetDock($header, "Top")
$title = New-Object System.Windows.Controls.TextBlock
$title.Text = "J A R V I S"
$title.FontSize = 26
$title.FontWeight = "Bold"
$title.Foreground = New-Brush $Colors.Green
$subtitle = New-Object System.Windows.Controls.TextBlock
$subtitle.Text = "Etsy Commerce Autopilot - control panel"
$subtitle.FontSize = 12
$subtitle.Foreground = New-Brush $Colors.Muted
$subtitle.Margin = "0,0,0,12"
$header.AddChild($title)
$header.AddChild($subtitle)

# --- Status bar ---
function New-StatusCell([string]$label) {
  $sp = New-Object System.Windows.Controls.StackPanel
  $sp.Margin = "0,0,28,0"
  $l = New-Object System.Windows.Controls.TextBlock
  $l.Text = $label; $l.FontSize = 10; $l.Foreground = New-Brush $Colors.Muted
  $v = New-Object System.Windows.Controls.TextBlock
  $v.Text = "..."; $v.FontSize = 14; $v.FontWeight = "Bold"; $v.Foreground = New-Brush $Colors.Text
  $sp.AddChild($l); $sp.AddChild($v)
  return @{ Panel = $sp; Value = $v }
}

$statusBar = New-Object System.Windows.Controls.Border
$statusBar.Background = New-Brush $Colors.Panel
$statusBar.BorderBrush = New-Brush $Colors.Border
$statusBar.BorderThickness = "1"
$statusBar.CornerRadius = "6"
$statusBar.Padding = "14,10"
$statusBar.Margin = "0,0,0,14"
[System.Windows.Controls.DockPanel]::SetDock($statusBar, "Top")
$statusInner = New-Object System.Windows.Controls.StackPanel
$statusInner.Orientation = "Horizontal"

$cellMode = New-StatusCell "MODE";       $script:ModeValue = $cellMode.Value
$cellDaemon = New-StatusCell "DAEMON";   $script:DaemonValue = $cellDaemon.Value
$cellDash = New-StatusCell "DASHBOARD";  $script:DashboardValue = $cellDash.Value
$statusInner.AddChild($cellMode.Panel)
$statusInner.AddChild($cellDaemon.Panel)
$statusInner.AddChild($cellDash.Panel)

$refreshBtn = New-Object System.Windows.Controls.Button
$refreshBtn.Content = "Refresh"
$refreshBtn.Padding = "12,4"
$refreshBtn.Background = New-Brush $Colors.Card
$refreshBtn.Foreground = New-Brush $Colors.Cyan
$refreshBtn.BorderBrush = New-Brush $Colors.Border
$refreshBtn.Cursor = "Hand"
$refreshBtn.VerticalAlignment = "Center"
$refreshBtn.Add_Click({ Update-Status; Set-Output "Status refreshed." "info" })
$statusInner.AddChild($refreshBtn)
$statusBar.Child = $statusInner

# --- Output line (bottom) ---
$outputBorder = New-Object System.Windows.Controls.Border
$outputBorder.Background = New-Brush $Colors.Panel
$outputBorder.BorderBrush = New-Brush $Colors.Border
$outputBorder.BorderThickness = "1"
$outputBorder.CornerRadius = "6"
$outputBorder.Padding = "12,8"
$outputBorder.Margin = "0,12,0,0"
[System.Windows.Controls.DockPanel]::SetDock($outputBorder, "Bottom")
$script:OutputText = New-Object System.Windows.Controls.TextBlock
$script:OutputText.Text = "Ready."
$script:OutputText.TextWrapping = "Wrap"
$script:OutputText.Foreground = New-Brush $Colors.Muted
$script:OutputText.FontFamily = New-Object System.Windows.Media.FontFamily("Consolas")
$script:OutputText.FontSize = 12
$outputBorder.Child = $script:OutputText

# --- Sections with buttons ---
$scroll = New-Object System.Windows.Controls.ScrollViewer
$scroll.VerticalScrollBarVisibility = "Auto"
$content = New-Object System.Windows.Controls.StackPanel

function New-ActionButton([string]$text, [string]$key, [string]$kind, [string]$tip) {
  $b = New-Object System.Windows.Controls.Button
  $b.Content = $text
  $b.Tag = $key
  $b.Width = 222
  $b.Height = 40
  $b.Margin = "0,0,10,10"
  $b.Cursor = "Hand"
  $b.HorizontalContentAlignment = "Left"
  $b.Padding = "12,0"
  $b.FontSize = 13
  $b.Background = New-Brush $Colors.Card
  $b.BorderThickness = "1"
  $b.ToolTip = $tip
  $accent = switch ($kind) {
    "green"  { $Colors.Green }
    "cyan"   { $Colors.Cyan }
    "danger" { $Colors.Danger }
    default  { $Colors.Border }
  }
  $b.BorderBrush = New-Brush $accent
  $b.Foreground = New-Brush $Colors.Text
  $b.Add_Click({ Invoke-Component $this.Tag })
  return $b
}

function Add-Section([string]$heading, [array]$buttons) {
  $h = New-Object System.Windows.Controls.TextBlock
  $h.Text = $heading.ToUpper()
  $h.FontSize = 12
  $h.FontWeight = "Bold"
  $h.Foreground = New-Brush $Colors.Cyan
  $h.Margin = "0,6,0,8"
  $content.AddChild($h)
  $wrap = New-Object System.Windows.Controls.WrapPanel
  $wrap.Margin = "0,0,0,8"
  foreach ($b in $buttons) { $wrap.AddChild($b) }
  $content.AddChild($wrap)
}

Add-Section "Dashboard & Autonomy" @(
  (New-ActionButton "Open Terminal"         "dashboard"        "green"  "Open the dashboard as a chromeless app window (starts the server if needed)"),
  (New-ActionButton "Start Daemon"          "start-daemon"     "green"  "Start the autonomous daemon now (hidden)"),
  (New-ActionButton "Stop Daemon"           "stop-daemon"      "danger" "Stop the running autonomous daemon"),
  (New-ActionButton "Install Autostart"     "install-daemon"   "cyan"   "Register autostart (scheduled task or logon launcher) and start now"),
  (New-ActionButton "Remove Autostart"      "uninstall-daemon" "danger" "Remove the daemon autostart")
)

Add-Section "Run a cycle" @(
  (New-ActionButton "Heartbeat"             "heartbeat"   "neutral" "Run one full heartbeat cycle"),
  (New-ActionButton "Order Watch"           "orderwatch"  "neutral" "Check orders + fulfillment once"),
  (New-ActionButton "Trend Miner"           "trend-mine"  "neutral" "Mine trend/holiday opportunities"),
  (New-ActionButton "Analytics"             "analytics"   "neutral" "Etsy performance digest -> Discord"),
  (New-ActionButton "Marketing"             "marketing"   "neutral" "Run the marketing engine"),
  (New-ActionButton "Trademark Hunter"      "trademark"   "neutral" "Run trademark screening"),
  (New-ActionButton "Cost Dashboard"        "costs"       "neutral" "Spend + profitability snapshot"),
  (New-ActionButton "IGM Status"            "igm:status"  "neutral" "Passive bandwidth income status")
)

Add-Section "Setup & Diagnostics" @(
  (New-ActionButton "Credential Audit"      "audit"             "neutral" "Check all API keys"),
  (New-ActionButton "Smoke Test"            "smoke"             "neutral" "Full read-only validation"),
  (New-ActionButton "Preview Discord Digest" "preview-digest"   "neutral" "Send a sample digest to Discord"),
  (New-ActionButton "Diagnose Pinterest"    "diagnose:pinterest" "neutral" "Debug Pinterest auth"),
  (New-ActionButton "Go-Live Wizard"        "go-live"           "amber"   "Interactive go-live wizard")
)

Add-Section "Files & Tools" @(
  (New-ActionButton "Open feintsupply.log"       "logs"        "neutral" "Open the structured log file"),
  (New-ActionButton "Open Data Folder"      "data-folder" "neutral" "Open the data directory"),
  (New-ActionButton "Open Project Folder"   "project"     "neutral" "Open the project root"),
  (New-ActionButton "Terminal Menu"         "tui"         "neutral" "Open the classic text menu")
)

$scroll.Content = $content

$root.AddChild($header)
$root.AddChild($statusBar)
$root.AddChild($outputBorder)
$root.AddChild($scroll)
$window.Content = $root

Update-Status
$window.Add_ContentRendered({ Update-Status })

if ($env:FSC_APP_SELFTEST -eq "1") {
  Write-Host "SELFTEST OK: window built ($($content.Children.Count) sections), mode=$($script:ModeValue.Text), daemon=$($script:DaemonValue.Text), dashboard=$($script:DashboardValue.Text)"
  return
}

[void]$window.ShowDialog()
