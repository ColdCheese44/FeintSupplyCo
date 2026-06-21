$ErrorActionPreference = "Stop"

function Get-ProjectRoot {
  return Split-Path -Parent $PSScriptRoot
}

function Ensure-Icon {
  $iconPath = Join-Path $PSScriptRoot "jarvis.ico"
  if (-not (Test-Path -LiteralPath $iconPath)) {
    & (Join-Path $PSScriptRoot "generate-icon.ps1")
  }
  return $iconPath
}

function New-Shortcut {
  param(
    [string]$ShortcutPath,
    [string]$TargetPath,
    [string]$Arguments,
    [string]$WorkingDirectory,
    [string]$IconLocation
  )

  $directory = Split-Path -Parent $ShortcutPath
  if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
  }

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $TargetPath
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.IconLocation = $IconLocation
  $shortcut.WindowStyle = 1
  $shortcut.Description = "Jarvis Etsy Commerce Autopilot"
  $shortcut.Save()
}

$projectRoot = Get-ProjectRoot
$desktopPath = [Environment]::GetFolderPath("Desktop")
$startMenuPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Jarvis.lnk"
$desktopShortcutPath = Join-Path $desktopPath "Jarvis.lnk"
$iconPath = Ensure-Icon
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
# Launch the WPF control panel hidden (no console window behind the GUI), in a single-threaded apartment.
$arguments = "-ExecutionPolicy Bypass -STA -WindowStyle Hidden -File `"$projectRoot\launcher\jarvis-app.ps1`""

New-Shortcut -ShortcutPath $desktopShortcutPath -TargetPath $powershellPath -Arguments $arguments -WorkingDirectory $projectRoot -IconLocation $iconPath
New-Shortcut -ShortcutPath $startMenuPath -TargetPath $powershellPath -Arguments $arguments -WorkingDirectory $projectRoot -IconLocation $iconPath

# Second shortcut: "Jarvis Terminal" opens the dashboard directly as a chromeless app window.
$terminalArgs = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$projectRoot\launcher\jarvis-terminal.ps1`""
$terminalDesktop = Join-Path $desktopPath "Jarvis Terminal.lnk"
$terminalStartMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Jarvis Terminal.lnk"
New-Shortcut -ShortcutPath $terminalDesktop -TargetPath $powershellPath -Arguments $terminalArgs -WorkingDirectory $projectRoot -IconLocation $iconPath
New-Shortcut -ShortcutPath $terminalStartMenu -TargetPath $powershellPath -Arguments $terminalArgs -WorkingDirectory $projectRoot -IconLocation $iconPath

Write-Host "Shortcuts installed: 'Jarvis' (control panel) and 'Jarvis Terminal' (dashboard app window) on your desktop."
