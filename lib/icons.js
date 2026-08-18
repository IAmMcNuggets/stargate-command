'use strict';
/*
 * Program icons.
 *
 * A launcher that shows only text is doing half a job, so each catalog entry
 * gets the program's real icon, extracted once and cached.
 *
 *   shortcuts   Icon.ExtractAssociatedIcon on the .lnk itself, which honours
 *               the shortcut's own IconLocation rather than guessing from the
 *               target — that is what Explorer shows you.
 *   Store apps  the package manifest names a logo, and the install folder
 *               holds it at several target sizes; the unplated variants are
 *               the bare glyph without a coloured backing tile, which is what
 *               suits a dark console.
 *
 * Results are 32px PNGs held as data URIs in icons.json, keyed by catalog key.
 * Data URIs rather than paths on disk: the renderer is sandboxed and has no
 * business reading arbitrary files, so icons travel over the same IPC as
 * everything else.
 *
 * Extraction costs roughly 50ms per program, so it runs in the background
 * after a scan and the UI picks icons up when they arrive.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EXTRACT_PS1 = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$ProgressPreference    = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Drawing',
  '',
  '$inFile  = $args[0]',
  '$outFile = $args[1]',
  '$size    = 32',
  '',
  '$requests = Get-Content -LiteralPath $inFile -Raw | ConvertFrom-Json',
  '$result   = @{}',
  '',
  'function ConvertTo-Png($src, [int]$size) {',
  '    try {',
  '        $bmp = New-Object System.Drawing.Bitmap $size, $size',
  '        $g = [System.Drawing.Graphics]::FromImage($bmp)',
  "        $g.InterpolationMode = 'HighQualityBicubic'",
  "        $g.SmoothingMode = 'AntiAlias'",
  '        if ($src -is [System.Drawing.Icon]) {',
  '            $g.DrawIcon($src, (New-Object System.Drawing.Rectangle 0, 0, $size, $size))',
  '        } else {',
  '            $g.DrawImage($src, 0, 0, $size, $size)',
  '        }',
  '        $g.Dispose()',
  '        $ms = New-Object System.IO.MemoryStream',
  '        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
  '        $bmp.Dispose()',
  '        return [Convert]::ToBase64String($ms.ToArray())',
  '    } catch { return $null }',
  '}',
  '',
  'function Get-FileIcon([string]$p) {',
  '    if (-not $p -or -not (Test-Path -LiteralPath $p)) { return $null }',
  '    try {',
  '        $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($p)',
  '        if (-not $ico) { return $null }',
  '        $b64 = ConvertTo-Png $ico $size',
  '        $ico.Dispose()',
  '        return $b64',
  '    } catch { return $null }',
  '}',
  '',
  '# One pass over installed packages; querying per app would be far too slow.',
  '$pkgByFamily = @{}',
  'foreach ($p in (Get-AppxPackage -PackageTypeFilter Main)) {',
  '    if ($p.PackageFamilyName -and -not $pkgByFamily.ContainsKey($p.PackageFamilyName)) {',
  '        $pkgByFamily[$p.PackageFamilyName] = $p.InstallLocation',
  '    }',
  '}',
  '',
  'function Get-AppxIcon([string]$aumid) {',
  "    $family = ($aumid -split '!')[0]",
  "    $appId  = ($aumid -split '!')[1]",
  '    $root = $pkgByFamily[$family]',
  '    if (-not $root -or -not (Test-Path -LiteralPath $root)) { return $null }',
  '',
  "    $manifest = Join-Path $root 'AppxManifest.xml'",
  '    if (-not (Test-Path -LiteralPath $manifest)) { return $null }',
  '    try { [xml]$m = Get-Content -LiteralPath $manifest -Raw } catch { return $null }',
  '',
  '    $apps = @($m.Package.Applications.Application)',
  '    $appNode = $apps | Where-Object { $_.Id -eq $appId } | Select-Object -First 1',
  '    if (-not $appNode) { $appNode = $apps | Select-Object -First 1 }',
  '    if (-not $appNode) { return $null }',
  '',
  '    $logo = $appNode.VisualElements.Square44x44Logo',
  '    if (-not $logo) { $logo = $appNode.VisualElements.Square150x150Logo }',
  '    if (-not $logo) { return $null }',
  '',
  '    $dir  = Join-Path $root (Split-Path $logo -Parent)',
  '    $base = [IO.Path]::GetFileNameWithoutExtension($logo)',
  '    if (-not (Test-Path -LiteralPath $dir)) { return $null }',
  '',
  '    $files = Get-ChildItem -LiteralPath $dir -Filter "$base*" -File',
  '    if (-not $files) { return $null }',
  '',
  '    # Prefer an unplated glyph near our render size; a plated tile carries a',
  '    # coloured square that looks wrong on a dark console.',
  '    $pick = $null',
  "    foreach ($pat in @('targetsize-48_altform-unplated', 'targetsize-64_altform-unplated',",
  "                       'targetsize-96_altform-unplated', 'targetsize-48', 'targetsize-64',",
  "                       'targetsize-96', 'scale-100', 'scale-200')) {",
  '        $pick = $files | Where-Object { $_.Name -like "*$pat*" } | Select-Object -First 1',
  '        if ($pick) { break }',
  '    }',
  '    if (-not $pick) { $pick = $files | Sort-Object Length -Descending | Select-Object -First 1 }',
  '    if (-not $pick) { return $null }',
  '',
  '    try {',
  '        $img = [System.Drawing.Image]::FromFile($pick.FullName)',
  '        $b64 = ConvertTo-Png $img $size',
  '        $img.Dispose()',
  '        return $b64',
  '    } catch { return $null }',
  '}',
  '',
  'foreach ($r in $requests) {',
  '    $b64 = $null',
  "    if ($r.kind -eq 'appx') {",
  '        $b64 = Get-AppxIcon $r.launchPath',
  '    } else {',
  '        $b64 = Get-FileIcon $r.launchPath',
  '        if (-not $b64 -and $r.target) { $b64 = Get-FileIcon $r.target }',
  '    }',
  '    if ($b64) { $result[$r.key] = $b64 }',
  '}',
  '',
  '$json = $result | ConvertTo-Json -Depth 2 -Compress',
  '$utf8NoBom = New-Object System.Text.UTF8Encoding $false',
  '[IO.File]::WriteAllText($outFile, $json, $utf8NoBom)',
].join('\n');

function createIconStore(dataDir, log) {
  const say = log || (() => {});
  const iconFile = path.join(dataDir, 'icons.json');
  const scriptPath = path.join(dataDir, 'extract-icons.ps1');
  const reqPath = path.join(dataDir, 'icon-request.json');
  const resPath = path.join(dataDir, 'icon-result.json');

  let icons = {};
  let running = false;

  try {
    icons = JSON.parse(fs.readFileSync(iconFile, 'utf8')) || {};
  } catch (_) {
    icons = {};
  }

  function save() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(iconFile, JSON.stringify(icons), 'utf8');
    } catch (_) {
      /* best-effort */
    }
  }

  /**
   * Extract anything not already cached.
   * @param {Array} apps catalog entries
   * @param {boolean} force re-extract even when cached
   * @returns {Promise<number>} how many were added
   */
  function refresh(apps, force) {
    if (running) return Promise.resolve(0);

    const wanted = apps.filter((a) => (force || !icons[a.key]) && a.launchPath);
    if (!wanted.length) return Promise.resolve(0);

    running = true;
    return new Promise((resolve) => {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(scriptPath, EXTRACT_PS1, 'utf8');
        fs.writeFileSync(
          reqPath,
          JSON.stringify(
            wanted.map((a) => ({
              key: a.key,
              kind: a.kind,
              launchPath: a.launchPath,
              target: a.target || '',
            }))
          ),
          'utf8'
        );
      } catch (e) {
        running = false;
        say('icon extraction could not start: ' + e.message, true);
        return resolve(0);
      }

      const t0 = Date.now();
      const ps = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          reqPath,
          resPath,
        ],
        { windowsHide: true, stdio: 'ignore' }
      );

      const finish = (added) => {
        running = false;
        try {
          fs.unlinkSync(reqPath);
          fs.unlinkSync(resPath);
        } catch (_) {
          /* leftovers are harmless */
        }
        resolve(added);
      };

      ps.on('error', (e) => {
        say('icon extraction failed: ' + e.message, true);
        finish(0);
      });

      ps.on('exit', () => {
        let added = 0;
        try {
          const raw = fs.readFileSync(resPath, 'utf8').replace(/^﻿/, '');
          const out = JSON.parse(raw) || {};
          for (const [k, b64] of Object.entries(out)) {
            if (b64) {
              icons[k] = 'data:image/png;base64,' + b64;
              added++;
            }
          }
          if (added) save();
        } catch (e) {
          say('icon results unreadable: ' + e.message, true);
        }
        say(
          'icons: ' +
            added +
            ' of ' +
            wanted.length +
            ' extracted in ' +
            ((Date.now() - t0) / 1000).toFixed(1) +
            's'
        );
        finish(added);
      });
    });
  }

  /** Forget icons for entries no longer in the catalog. */
  function prune(apps) {
    const live = new Set(apps.map((a) => a.key));
    let removed = 0;
    for (const k of Object.keys(icons)) {
      if (!live.has(k)) {
        delete icons[k];
        removed++;
      }
    }
    if (removed) save();
    return removed;
  }

  return {
    get: (key) => icons[key] || null,
    refresh,
    prune,
    all: () => icons,
    get busy() {
      return running;
    },
  };
}

module.exports = { createIconStore };
