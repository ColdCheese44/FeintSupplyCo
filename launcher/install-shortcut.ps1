$ErrorActionPreference = "Stop"

function Get-ProjectRoot {
  return Split-Path -Parent $PSScriptRoot
}

function Ensure-Icon {
  $iconPath = Join-Path $PSScriptRoot "fsc.ico"
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
  $shortcut.Description = "Feint Supply Co Commerce Autopilot"
  $shortcut.Save()
}

$projectRoot = Get-ProjectRoot
$desktopPath = [Environment]::GetFolderPath("Desktop")
$startMenuPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\FeintSupplyCo.lnk"
$desktopShortcutPath = Join-Path $desktopPath "FeintSupplyCo.lnk"
$iconPath = Ensure-Icon
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
# Launch the WPF control panel hidden (no console window behind the GUI), in a single-threaded apartment.
$arguments = "-ExecutionPolicy Bypass -STA -WindowStyle Hidden -File `"$projectRoot\launcher\fsc-app.ps1`""

New-Shortcut -ShortcutPath $desktopShortcutPath -TargetPath $powershellPath -Arguments $arguments -WorkingDirectory $projectRoot -IconLocation $iconPath
New-Shortcut -ShortcutPath $startMenuPath -TargetPath $powershellPath -Arguments $arguments -WorkingDirectory $projectRoot -IconLocation $iconPath

# Second shortcut: "FeintSupplyCo Terminal" opens the dashboard directly as a chromeless app window.
$terminalArgs = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$projectRoot\launcher\fsc-terminal.ps1`""
$terminalDesktop = Join-Path $desktopPath "FeintSupplyCo Terminal.lnk"
$terminalStartMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\FeintSupplyCo Terminal.lnk"
New-Shortcut -ShortcutPath $terminalDesktop -TargetPath $powershellPath -Arguments $terminalArgs -WorkingDirectory $projectRoot -IconLocation $iconPath
New-Shortcut -ShortcutPath $terminalStartMenu -TargetPath $powershellPath -Arguments $terminalArgs -WorkingDirectory $projectRoot -IconLocation $iconPath

Write-Host "Shortcuts installed: 'FeintSupplyCo' (control panel) and 'FeintSupplyCo Terminal' (dashboard app window) on your desktop."
