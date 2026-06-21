param(
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][int]$Width,
  [Parameter(Mandatory = $true)][int]$Height,
  [Parameter(Mandatory = $true)][string]$StoreName,
  [Parameter(Mandatory = $true)][string]$Tagline,
  [Parameter(Mandatory = $true)][string]$PrimaryColor,
  [Parameter(Mandatory = $true)][string]$SecondaryColor,
  [Parameter(Mandatory = $true)][string]$AccentColor,
  [Parameter(Mandatory = $true)][string]$BackgroundColor,
  [Parameter(Mandatory = $true)][string]$TextColor,
  [Parameter(Mandatory = $true)][string]$Variant
)

Add-Type -AssemblyName System.Drawing

function Convert-HexToColor {
  param(
    [string]$Hex,
    [int]$Alpha = 255
  )

  $clean = $Hex.Trim().TrimStart('#')
  if ($clean.Length -ne 6) {
    throw "Invalid hex color: $Hex"
  }

  $r = [Convert]::ToInt32($clean.Substring(0, 2), 16)
  $g = [Convert]::ToInt32($clean.Substring(2, 2), 16)
  $b = [Convert]::ToInt32($clean.Substring(4, 2), 16)
  return [System.Drawing.Color]::FromArgb($Alpha, $r, $g, $b)
}

function New-FontSafe {
  param(
    [string]$Name,
    [float]$Size,
    [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular
  )

  try {
    return New-Object System.Drawing.Font($Name, $Size, $Style)
  } catch {
    return New-Object System.Drawing.Font("Segoe UI", $Size, $Style)
  }
}

[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($OutputPath)) | Out-Null

$bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

$primary = Convert-HexToColor $PrimaryColor
$secondary = Convert-HexToColor $SecondaryColor
$accent = Convert-HexToColor $AccentColor
$background = Convert-HexToColor $BackgroundColor
$text = Convert-HexToColor $TextColor
$lightBackground = [System.Drawing.Color]::FromArgb(255, 245, 247, 250)
$transparent = [System.Drawing.Color]::FromArgb(0, 0, 0, 0)

$graphics.Clear($transparent)

if ($Variant -notin @("logo-primary", "watermark")) {
  $bgBrush = New-Object System.Drawing.SolidBrush($background)
  $graphics.FillRectangle($bgBrush, 0, 0, $Width, $Height)
  $bgBrush.Dispose()
}

if ($Variant -eq "logo-light") {
  $lightBrush = New-Object System.Drawing.SolidBrush($lightBackground)
  $graphics.FillRectangle($lightBrush, 0, 0, $Width, $Height)
  $lightBrush.Dispose()
}

$borderPen = New-Object System.Drawing.Pen($secondary, [Math]::Max(2, [Math]::Round($Width * 0.006)))
$thinPen = New-Object System.Drawing.Pen($secondary, [Math]::Max(1, [Math]::Round($Width * 0.002)))
$accentPen = New-Object System.Drawing.Pen($accent, [Math]::Max(2, [Math]::Round($Width * 0.003)))
$textBrush = New-Object System.Drawing.SolidBrush($(if ($Variant -eq "logo-light") { $primary } else { $text }))
$monoBrush = New-Object System.Drawing.SolidBrush($secondary)
$mutedBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(85, $secondary.R, $secondary.G, $secondary.B))

$headlineSize = [Math]::Max(20, [Math]::Round($Height * 0.11))
$subheadSize = [Math]::Max(12, [Math]::Round($Height * 0.045))
$smallSize = [Math]::Max(11, [Math]::Round($Height * 0.03))

$headlineFont = New-FontSafe "Segoe UI Semibold" $headlineSize ([System.Drawing.FontStyle]::Bold)
$subheadFont = New-FontSafe "Consolas" $subheadSize
$smallFont = New-FontSafe "Consolas" $smallSize

$titleText = $StoreName.ToUpper()
$taglineText = $Tagline

switch ($Variant) {
  "logo-primary" {
    $chevronPoints = @(
      (New-Object System.Drawing.PointF($Width * 0.16, $Height * 0.2)),
      (New-Object System.Drawing.PointF($Width * 0.34, $Height * 0.5)),
      (New-Object System.Drawing.PointF($Width * 0.16, $Height * 0.8))
    )
    $graphics.DrawLines($borderPen, $chevronPoints)
    $titleRect = New-Object System.Drawing.RectangleF($Width * 0.4, $Height * 0.25, $Width * 0.5, $Height * 0.28)
    $taglineRect = New-Object System.Drawing.RectangleF($Width * 0.4, $Height * 0.58, $Width * 0.5, $Height * 0.12)
    $graphics.DrawString($titleText, $headlineFont, $textBrush, $titleRect)
    $graphics.DrawString($taglineText, $subheadFont, $monoBrush, $taglineRect)
  }
  "logo-dark" {
    $graphics.DrawRectangle($thinPen, $Width * 0.08, $Height * 0.08, $Width * 0.84, $Height * 0.84)
    $graphics.DrawLine($borderPen, $Width * 0.12, $Height * 0.74, $Width * 0.82, $Height * 0.74)
    $graphics.DrawString($titleText, $headlineFont, $textBrush, (New-Object System.Drawing.RectangleF($Width * 0.12, $Height * 0.2, $Width * 0.76, $Height * 0.32)))
    $graphics.DrawString($taglineText, $subheadFont, $monoBrush, (New-Object System.Drawing.RectangleF($Width * 0.12, $Height * 0.56, $Width * 0.76, $Height * 0.14)))
  }
  "logo-light" {
    $graphics.DrawRectangle($thinPen, $Width * 0.08, $Height * 0.08, $Width * 0.84, $Height * 0.84)
    $graphics.DrawLine($borderPen, $Width * 0.12, $Height * 0.74, $Width * 0.82, $Height * 0.74)
    $graphics.DrawString($titleText, $headlineFont, $textBrush, (New-Object System.Drawing.RectangleF($Width * 0.12, $Height * 0.2, $Width * 0.76, $Height * 0.32)))
    $graphics.DrawString($taglineText, $subheadFont, $monoBrush, (New-Object System.Drawing.RectangleF($Width * 0.12, $Height * 0.56, $Width * 0.76, $Height * 0.14)))
  }
  "logo-icon" {
    $graphics.DrawRectangle($borderPen, $Width * 0.18, $Height * 0.18, $Width * 0.64, $Height * 0.64)
    $iconFont = New-FontSafe "Segoe UI Semibold" ([Math]::Round($Height * 0.34)) ([System.Drawing.FontStyle]::Bold)
    $graphics.DrawString("FSC", $iconFont, $textBrush, (New-Object System.Drawing.RectangleF($Width * 0.22, $Height * 0.34, $Width * 0.56, $Height * 0.28)))
    $iconFont.Dispose()
  }
  "profile-icon" {
    $graphics.DrawRectangle($borderPen, $Width * 0.14, $Height * 0.14, $Width * 0.72, $Height * 0.72)
    $iconFont = New-FontSafe "Segoe UI Semibold" ([Math]::Round($Height * 0.32)) ([System.Drawing.FontStyle]::Bold)
    $graphics.DrawString("FS", $iconFont, $textBrush, (New-Object System.Drawing.RectangleF($Width * 0.24, $Height * 0.34, $Width * 0.52, $Height * 0.24)))
    $iconFont.Dispose()
  }
  "shop-banner" {
    $graphics.DrawLine($borderPen, $Width * 0.08, $Height * 0.64, $Width * 0.72, $Height * 0.64)
    $graphics.DrawString($StoreName, $headlineFont, $textBrush, (New-Object System.Drawing.RectangleF($Width * 0.08, $Height * 0.18, $Width * 0.6, $Height * 0.26)))
    $graphics.DrawString($taglineText, $subheadFont, $monoBrush, (New-Object System.Drawing.RectangleF($Width * 0.08, $Height * 0.68, $Width * 0.56, $Height * 0.12)))
    for ($i = 0; $i -lt 8; $i++) {
      $x = $Width * 0.72 + ($i * ($Width * 0.025))
      $graphics.DrawLine($thinPen, $x, $Height * 0.2, $x + ($Width * 0.04), $Height * 0.8)
    }
  }
  "pinterest-template" {
    $graphics.DrawRectangle($borderPen, $Width * 0.06, $Height * 0.04, $Width * 0.88, $Height * 0.92)
    $graphics.DrawString($StoreName, $subheadFont, $textBrush, (New-Object System.Drawing.RectangleF($Width * 0.1, $Height * 0.08, $Width * 0.72, $Height * 0.08)))
    $graphics.DrawLine($borderPen, $Width * 0.1, $Height * 0.18, $Width * 0.86, $Height * 0.18)
    for ($i = 1; $i -le 5; $i++) {
      $graphics.DrawRectangle($thinPen, $Width * 0.16, $Height * (0.22 + ($i * 0.11)), $Width * 0.68, $Height * 0.05)
    }
    $graphics.DrawString("PRODUCT OVERLAY AREA", $smallFont, $mutedBrush, (New-Object System.Drawing.RectangleF($Width * 0.2, $Height * 0.48, $Width * 0.56, $Height * 0.08)))
  }
  "social-header" {
    $graphics.DrawLine($borderPen, $Width * 0.1, $Height * 0.68, $Width * 0.82, $Height * 0.68)
    $graphics.DrawString($StoreName, $headlineFont, $textBrush, (New-Object System.Drawing.RectangleF($Width * 0.1, $Height * 0.18, $Width * 0.6, $Height * 0.24)))
    $graphics.DrawString($taglineText, $subheadFont, $monoBrush, (New-Object System.Drawing.RectangleF($Width * 0.1, $Height * 0.72, $Width * 0.56, $Height * 0.12)))
  }
  "email-header" {
    $graphics.DrawString($StoreName, $headlineFont, $textBrush, (New-Object System.Drawing.RectangleF($Width * 0.08, $Height * 0.18, $Width * 0.7, $Height * 0.28)))
    $graphics.DrawLine($borderPen, $Width * 0.08, $Height * 0.62, $Width * 0.82, $Height * 0.62)
    $graphics.DrawString($taglineText, $smallFont, $monoBrush, (New-Object System.Drawing.RectangleF($Width * 0.08, $Height * 0.68, $Width * 0.72, $Height * 0.12)))
  }
  "watermark" {
    $watermarkBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(64, 255, 255, 255))
    $iconFont = New-FontSafe "Segoe UI Semibold" ([Math]::Round($Height * 0.44)) ([System.Drawing.FontStyle]::Bold)
    $graphics.DrawString("FSC", $iconFont, $watermarkBrush, (New-Object System.Drawing.RectangleF($Width * 0.08, $Height * 0.22, $Width * 0.6, $Height * 0.4)))
    $watermarkBrush.Dispose()
    $iconFont.Dispose()
  }
  default {
    $graphics.DrawString($StoreName, $headlineFont, $textBrush, (New-Object System.Drawing.RectangleF($Width * 0.08, $Height * 0.28, $Width * 0.76, $Height * 0.24)))
    $graphics.DrawString($taglineText, $subheadFont, $monoBrush, (New-Object System.Drawing.RectangleF($Width * 0.08, $Height * 0.58, $Width * 0.76, $Height * 0.12)))
  }
}

$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$headlineFont.Dispose()
$subheadFont.Dispose()
$smallFont.Dispose()
$borderPen.Dispose()
$thinPen.Dispose()
$accentPen.Dispose()
$textBrush.Dispose()
$monoBrush.Dispose()
$mutedBrush.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
