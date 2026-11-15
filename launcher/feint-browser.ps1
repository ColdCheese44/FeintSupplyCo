function Get-FeintBravePath {
  if ($env:FEINT_BROWSER_PATH -and (Test-Path -LiteralPath $env:FEINT_BROWSER_PATH)) {
    return $env:FEINT_BROWSER_PATH
  }

  if ($env:FEINT_BROWSER) {
    $requestedBrowser = $env:FEINT_BROWSER.Trim()
    if ($requestedBrowser -match '^(default|system)$') {
      return $null
    }
    if (Test-Path -LiteralPath $requestedBrowser) {
      return $requestedBrowser
    }
  }

  $paths = @(
    "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
    "C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
    "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"
  )

  foreach ($path in $paths) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      return $path
    }
  }

  foreach ($command in @("brave.exe", "brave-browser.exe", "brave")) {
    $resolved = Get-Command $command -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($resolved) {
      return $resolved.Source
    }
  }

  return $null
}

function Get-FeintBrowserMode {
  param([string]$Mode = $env:FEINT_BROWSER_MODE)

  if (-not $Mode) {
    return "fullscreen"
  }

  switch ($Mode.Trim().ToLowerInvariant()) {
    "fullscreen" { return "fullscreen" }
    "maximized" { return "maximized" }
    "normal" { return "normal" }
    "kiosk" { return "kiosk" }
    default { return "fullscreen" }
  }
}

function Get-FeintBrowserArguments {
  param(
    [Parameter(Mandatory=$true)]
    [string]$Url,

    [string]$Mode = $env:FEINT_BROWSER_MODE,

    [switch]$App,

    [string[]]$ExtraArguments = @()
  )

  $resolvedMode = Get-FeintBrowserMode -Mode $Mode
  $args = @()

  if ($App) {
    $args += "--app=$Url"
  } else {
    $args += "--new-window"
  }

  switch ($resolvedMode) {
    "fullscreen" { $args += "--start-fullscreen" }
    "maximized" { $args += "--start-maximized" }
    "kiosk" { $args += "--kiosk" }
    "normal" { }
  }

  if ($ExtraArguments) {
    $args += $ExtraArguments
  }

  if (-not $App) {
    $args += $Url
  }

  return $args
}

function Open-FeintBrowser {
  param(
    [Parameter(Mandatory=$true)]
    [string]$Url,

    [string]$Mode = $env:FEINT_BROWSER_MODE,

    [switch]$App,

    [string[]]$ExtraArguments = @()
  )

  $brave = Get-FeintBravePath

  if ($brave) {
    $args = Get-FeintBrowserArguments -Url $Url -Mode $Mode -App:$App -ExtraArguments $ExtraArguments
    Start-Process -FilePath $brave -ArgumentList $args | Out-Null
    return $true
  }

  Write-Warning "Brave not found. Falling back to default browser."
  Start-Process $Url | Out-Null
  return $false
}
