<#
    Creates a Start Menu (and optional desktop) shortcut for the dialing
    computer, with Ctrl+Alt+G bound as a global hotkey.

    Usage:
        powershell -ExecutionPolicy Bypass -File .\Install-Shortcut.ps1
        powershell -ExecutionPolicy Bypass -File .\Install-Shortcut.ps1 -Desktop
        powershell -ExecutionPolicy Bypass -File .\Install-Shortcut.ps1 -HotKey 'CTRL+ALT+S'
#>
[CmdletBinding()]
param(
    [switch] $Desktop,
    [string] $HotKey = 'CTRL+ALT+G'
)

$ErrorActionPreference = 'Stop'

$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $here 'Stargate.vbs'

if (-not (Test-Path -LiteralPath $target)) {
    throw "Stargate.vbs not found next to this script ($here)."
}

$shell    = New-Object -ComObject WScript.Shell
$startDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'Stargate Command'
if (-not (Test-Path -LiteralPath $startDir)) {
    New-Item -ItemType Directory -Path $startDir | Out-Null
}

$paths = @(Join-Path $startDir 'Stargate Command.lnk')
if ($Desktop) {
    $paths += Join-Path ([Environment]::GetFolderPath('Desktop')) 'Stargate Command.lnk'
}

foreach ($p in $paths) {
    $lnk = $shell.CreateShortcut($p)
    $lnk.TargetPath       = 'wscript.exe'
    $lnk.Arguments        = '"{0}"' -f $target
    $lnk.WorkingDirectory = $here
    $lnk.Description      = 'SGC dialing computer - app launcher'
    $lnk.IconLocation     = "$env:SystemRoot\System32\shell32.dll,13"
    $lnk.WindowStyle      = 7
    $lnk.HotKey           = $HotKey
    $lnk.Save()
    Write-Host "  created  $p"
}

Write-Host ""
Write-Host "Hotkey $HotKey is bound to the Start Menu shortcut." -ForegroundColor Yellow
Write-Host "Windows only honours shortcut hotkeys for shortcuts kept in the" -ForegroundColor DarkGray
Write-Host "Start Menu or on the Desktop - leave it where it is." -ForegroundColor DarkGray
