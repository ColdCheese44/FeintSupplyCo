param(
  [switch]$WriteEtsyShopId,
  [switch]$ListOnly
)

$ErrorActionPreference = "Stop"

function Get-ProjectRoot {
  return Split-Path -Parent $PSScriptRoot
}

function Get-EnvFilePath {
  return Join-Path (Get-ProjectRoot) ".env"
}

function Read-EnvLines {
  $envPath = Get-EnvFilePath
  if (-not (Test-Path -LiteralPath $envPath)) {
    throw ".env was not found at $envPath"
  }

  return Get-Content -LiteralPath $envPath
}

function Get-EnvValue {
  param(
    [string]$Key,
    [string[]]$Lines
  )

  $matches = @($Lines | Where-Object { $_ -match "^$([regex]::Escape($Key))=" })
  if ($matches.Count -eq 0) {
    return $null
  }

  return $matches[-1].Split("=", 2)[1]
}

function Set-EnvValue {
  param(
    [string]$Key,
    [string]$Value,
    [string[]]$Lines
  )

  $replacement = "$Key=$Value"
  $updated = $false
  $newLines = foreach ($line in $Lines) {
    if ($line -match "^$([regex]::Escape($Key))=") {
      $updated = $true
      $replacement
    }
    else {
      $line
    }
  }

  if (-not $updated) {
    $newLines += $replacement
  }

  Set-Content -LiteralPath (Get-EnvFilePath) -Value $newLines
}

function Show-PrintifyRemediation {
  param(
    [string]$Reason
  )

  Write-Host ""
  Write-Host "Printify remediation required" -ForegroundColor Yellow
  Write-Host "Reason: $Reason" -ForegroundColor Yellow
  Write-Host "Dashboard: https://printify.com/app/stores" -ForegroundColor Cyan
  Write-Host "Guide: https://help.printify.com/hc/en-us/articles/4483617508241-How-can-I-connect-my-Etsy-shop-to-Printify" -ForegroundColor Cyan
  Write-Host "Next steps:" -ForegroundColor Cyan
  Write-Host "  1. Open Printify -> Manage my stores" -ForegroundColor Cyan
  Write-Host "  2. Click Connect and choose Etsy" -ForegroundColor Cyan
  Write-Host "  3. Complete Etsy sign-in and grant access" -ForegroundColor Cyan
  Write-Host "  4. Re-run this script after the shop shows as Etsy-connected" -ForegroundColor Cyan
}

$envLines = Read-EnvLines
$token = Get-EnvValue -Key "PRINTIFY_API_TOKEN" -Lines $envLines
if ([string]::IsNullOrWhiteSpace($token)) {
  Write-Host "PRINTIFY_API_TOKEN is missing from .env." -ForegroundColor Yellow
  exit 1
}

$response = Invoke-RestMethod -Method Get -Uri "https://api.printify.com/v1/shops.json" -Headers @{
  Authorization = "Bearer $token"
  Accept = "application/json"
}

$shops = @($response)
if ($shops.Count -eq 0) {
  Write-Host "Connect your Etsy shop to Printify first. No shops were returned by https://api.printify.com/v1/shops.json." -ForegroundColor Yellow
  exit 0
}

$shopTable = $shops | Select-Object `
  @{ Name = "Id"; Expression = { $_.id } }, `
  @{ Name = "Title"; Expression = { $_.title } }, `
  @{ Name = "Channel"; Expression = { $_.sales_channel } }

$shopTable | Format-Table -AutoSize

$etsyShops = @($shops | Where-Object { $_.sales_channel -eq "etsy" })
if ($etsyShops.Count -eq 0) {
  Show-PrintifyRemediation -Reason "No Etsy-linked shop was found in the Printify shops response."
  exit 0
}

$selectedShop = $null
if ($etsyShops.Count -eq 1) {
  $selectedShop = $etsyShops[0]
}
else {
  Write-Host ""
  Write-Host "Multiple Etsy-linked shops were found:" -ForegroundColor Cyan
  $etsyShops | Select-Object @{ Name = "Id"; Expression = { $_.id } }, @{ Name = "Title"; Expression = { $_.title } } | Format-Table -AutoSize
  $selectedId = Read-Host "Enter the Etsy-linked shop ID to write to PRINTIFY_SHOP_ID, or press Enter to skip"
  if (-not [string]::IsNullOrWhiteSpace($selectedId)) {
    $selectedShop = $etsyShops | Where-Object { "$($_.id)" -eq $selectedId } | Select-Object -First 1
  }
}

if (-not $selectedShop) {
  Write-Host "No Printify shop ID was written to .env." -ForegroundColor Yellow
  exit 0
}

if ($selectedShop.sales_channel -ne "etsy") {
  Show-PrintifyRemediation -Reason "The selected shop is not connected to Etsy."
  exit 0
}

if (-not $WriteEtsyShopId -and -not $ListOnly) {
  $answer = Read-Host "Write PRINTIFY_SHOP_ID=$($selectedShop.id) for Etsy shop '$($selectedShop.title)' to .env? [y/N]"
  if ($answer -notmatch "^(y|yes)$") {
    Write-Host "Skipped writing PRINTIFY_SHOP_ID." -ForegroundColor Yellow
    exit 0
  }
}

if (-not $ListOnly) {
  Set-EnvValue -Key "PRINTIFY_SHOP_ID" -Value "$($selectedShop.id)" -Lines $envLines
  Write-Host "Updated PRINTIFY_SHOP_ID=$($selectedShop.id) in .env." -ForegroundColor Green
}
