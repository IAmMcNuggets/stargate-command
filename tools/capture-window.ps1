<#
    Screenshot a top-level window by process name, for checking the desktop
    build without a human having to look at it.

        powershell -ExecutionPolicy Bypass -File .\tools\capture-window.ps1 -Process electron -Out shot.png
#>
[CmdletBinding()]
param(
    [string] $Process = 'electron',
    [string] $Out = "$env:TEMP\window.png",
    [switch] $Foreground
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
}
"@ -ErrorAction SilentlyContinue

$proc = Get-Process -Name $Process -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1

if (-not $proc) { throw "no '$Process' process with a visible window" }
$h = $proc.MainWindowHandle

if ($Foreground) {
    [Win]::ShowWindow($h, 9) | Out-Null   # restore
    [Win]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 700
}

$r = New-Object Win+RECT
[void][Win]::GetWindowRect($h, [ref] $r)
$w = $r.Right - $r.Left
$hh = $r.Bottom - $r.Top
if ($w -le 0 -or $hh -le 0) { throw "window has no size ($w x $hh)" }

$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $hh)))
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "captured $w x $hh from pid $($proc.Id) -> $Out"
