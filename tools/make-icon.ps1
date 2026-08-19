<#
    Draws the app icon (build/icon.png, 512x512) so the installer and the
    taskbar get a gate rather than a default Electron logo.
    electron-builder converts this to .ico at build time.

        powershell -ExecutionPolicy Bypass -File .\tools\make-icon.ps1
#>
[CmdletBinding()]
param([int] $Size = 512)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$build = Join-Path $here 'build'
if (-not (Test-Path $build)) { New-Item -ItemType Directory -Path $build | Out-Null }
$out = Join-Path $build 'icon.png'

$bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)

$c  = $Size / 2.0
$R  = $Size * 0.448          # outer edge of the gate body (chevrons overhang it)
$rt = $R * 0.885             # outer edge of the glyph track
$ra = $R * 0.74              # event horizon

function Disc($brush, $radius) {
    $g.FillEllipse($brush, $c - $radius, $c - $radius, $radius * 2, $radius * 2)
}

# Gate body.
$bodyOuter = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 58, 49, 38))
$bodyInner = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 34, 29, 21))
Disc $bodyOuter $R
Disc $bodyInner $rt

# Event horizon.
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddEllipse($c - $ra, $c - $ra, $ra * 2, $ra * 2)
$horizon = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
$horizon.CenterColor    = [System.Drawing.Color]::FromArgb(255, 198, 238, 255)
$horizon.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 12, 62, 140))
$horizon.CenterPoint    = New-Object System.Drawing.PointF($c, $c)
Disc $horizon $ra

# Glyph-cell rules on the track.
$rule = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120, 255, 206, 146)), ([single]($Size * 0.004))
for ($i = 0; $i -lt 39; $i++) {
    $a = $i * [Math]::PI * 2 / 39
    $x1 = $c + [Math]::Sin($a) * $ra
    $y1 = $c - [Math]::Cos($a) * $ra
    $x2 = $c + [Math]::Sin($a) * $rt
    $y2 = $c - [Math]::Cos($a) * $rt
    $g.DrawLine($rule, [single]$x1, [single]$y1, [single]$x2, [single]$y2)
}

# Nine chevrons; the one at top dead center is the locking chevron.
$degrees = @(40, 80, 120, 160, 200, 240, 0, 280, 320)
$idle = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 104, 88, 66))
$lit  = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 90, 31))

for ($i = 0; $i -lt $degrees.Count; $i++) {
    $a  = $degrees[$i] * [Math]::PI / 180
    $ca = [Math]::Cos($a); $sa = [Math]::Sin($a)
    $isTop = ($degrees[$i] -eq 0)
    [double] $s = 1.0
    if ($isTop) { $s = 1.25 }

    # Half-widths and radii in gate space (x across, y outward).
    [double] $wide = 0.085 * $s * $R
    [double] $neck = 0.034 * $s * $R
    [double] $rTop = -1.015 * $R
    [double] $rSho = -0.95 * $R
    [double] $rTip = -0.845 * $R

    $xs = @($(-$wide), $wide,  $wide,  $neck,  0.0,    $(-$neck), $(-$wide))
    $ys = @($rTop,     $rTop,  $rSho,  $rSho,  $rTip,  $rSho,     $rSho)

    $poly = New-Object System.Drawing.PointF[] $xs.Count
    for ($k = 0; $k -lt $xs.Count; $k++) {
        [double] $x = $xs[$k]
        [double] $y = $ys[$k]
        $poly[$k] = New-Object System.Drawing.PointF(
            [single]($c + $x * $ca - $y * $sa),
            [single]($c + $x * $sa + $y * $ca))
    }

    $brush = $idle
    if ($isTop) { $brush = $lit }
    $g.FillPolygon($brush, $poly)
}

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "wrote $out ($Size x $Size)"
