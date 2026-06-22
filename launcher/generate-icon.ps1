$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

function New-PngBytes {
  param(
    [int]$Size
  )

  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Black)

  $accent = [System.Drawing.Color]::FromArgb(0, 220, 110)
  $shadow = [System.Drawing.Color]::FromArgb(0, 90, 45)
  $pen = New-Object System.Drawing.Pen $shadow, ([Math]::Max(2, [int]($Size / 18)))
  $font = [System.Drawing.Font]::new(
    "Consolas",
    [single]([Math]::Max(10, [int]($Size * 0.62))),
    [System.Drawing.FontStyle]::Bold,
    [System.Drawing.GraphicsUnit]::Pixel
  )
  $stringBrush = New-Object System.Drawing.SolidBrush $accent
  $guideBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0, 40, 20))

  $graphics.FillRectangle($guideBrush, [int]($Size * 0.12), [int]($Size * 0.18), [int]($Size * 0.08), [int]($Size * 0.64))
  $graphics.DrawRectangle($pen, [int]($Size * 0.1), [int]($Size * 0.1), [int]($Size * 0.8), [int]($Size * 0.8))
  $graphics.DrawString("J", $font, $stringBrush, [System.Drawing.PointF]::new([single]($Size * 0.19), [single]($Size * 0.12)))

  $memoryStream = New-Object System.IO.MemoryStream
  $bitmap.Save($memoryStream, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes = $memoryStream.ToArray()

  $graphics.Dispose()
  $bitmap.Dispose()
  $memoryStream.Dispose()
  $pen.Dispose()
  $font.Dispose()
  $stringBrush.Dispose()
  $guideBrush.Dispose()

  return ,$pngBytes
}

function Write-IcoFile {
  param(
    [byte[][]]$Images,
    [int[]]$Sizes,
    [string]$Path
  )

  $fileStream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create)
  $writer = New-Object System.IO.BinaryWriter $fileStream

  $writer.Write([UInt16]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]$Images.Count)

  $offset = 6 + (16 * $Images.Count)
  for ($index = 0; $index -lt $Images.Count; $index++) {
    $size = $Sizes[$index]
    $bytes = $Images[$index]
    $writer.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))
    $writer.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$bytes.Length)
    $writer.Write([UInt32]$offset)
    $offset += $bytes.Length
  }

  foreach ($bytes in $Images) {
    $writer.Write($bytes)
  }

  $writer.Flush()
  $writer.Dispose()
  $fileStream.Dispose()
}

$launcherDirectory = $PSScriptRoot
$iconPath = Join-Path $launcherDirectory "fsc.ico"
$pngPath = Join-Path $launcherDirectory "fsc.png"
$sizes = @(16, 32, 48, 64, 128, 256)
$images = @()

foreach ($size in $sizes) {
  $images += ,(New-PngBytes -Size $size)
}

[System.IO.File]::WriteAllBytes($pngPath, $images[-1])
Write-IcoFile -Images $images -Sizes $sizes -Path $iconPath
Write-Host "Generated $iconPath"
