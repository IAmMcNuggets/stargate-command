'use strict';
/*
 * Program discovery.
 *
 * Walks the all-users and per-user Start Menu and Desktop folders for
 * shortcuts, resolving each one's real target, arguments and working
 * directory via WScript.Shell, then folds in Get-StartApps to pick up Store
 * apps. Results are cached so startup is instant after the first run.
 *
 * Shared by server.js (browser mode) and electron/main.js — the data
 * directory is injected because Electron must write to userData rather than
 * the install folder, which is not writable under Program Files.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCAN_PS1 = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference    = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$shell = New-Object -ComObject WScript.Shell
$out   = New-Object System.Collections.Generic.List[object]

$roots = New-Object System.Collections.Generic.List[string]
foreach ($f in 'CommonStartMenu','StartMenu','CommonDesktopDirectory','DesktopDirectory') {
    $p = [Environment]::GetFolderPath($f)
    if ($p -and (Test-Path -LiteralPath $p)) { [void]$roots.Add($p) }
}

foreach ($r in $roots) {
    Get-ChildItem -LiteralPath $r -Recurse -File -Force |
      Where-Object { $_.Extension -eq '.lnk' -or $_.Extension -eq '.url' } |
      ForEach-Object {
          $t  = ''
          $a  = ''
          $wd = ''
          if ($_.Extension -eq '.lnk') {
              try {
                  $sc = $shell.CreateShortcut($_.FullName)
                  $t  = $sc.TargetPath
                  $a  = $sc.Arguments
                  $wd = $sc.WorkingDirectory
              } catch { }
          }
          $grp = ''
          try { $grp = $_.DirectoryName.Substring($r.Length).Trim('\\') } catch { }
          [void]$out.Add([pscustomobject]@{
              n = $_.BaseName
              p = $_.FullName
              t = $t
              a = $a
              w = $wd
              g = $grp
              k = 'lnk'
          })
      }
}

Get-StartApps | ForEach-Object {
    [void]$out.Add([pscustomobject]@{
        n = $_.Name
        p = $_.AppID
        t = ''
        a = ''
        w = ''
        g = ''
        k = 'appx'
    })
}

if ($out.Count -eq 0) { '[]' } else { $out | ConvertTo-Json -Depth 3 -Compress }
`;

// Entries that are almost never something you want to *launch*.
const JUNK_NAME = new RegExp(
  [
    '^uninstall',
    'uninstall(er)?$',
    '^read ?me',
    '^release notes',
    '^documentation$',
    '^docs$',
    '^user (guide|manual)',
    '^help$',
    '^licen[cs]e',
    '^website$',
    '^home ?page$',
    '^changelog',
    '^report (a )?(bug|problem)',
    '^send feedback',
    '^modify( setup)?$',
    '^repair',
    '^check for updates',
    '^what.s new',
    '^visit ',
    '^support$',
  ].join('|'),
  'i'
);

const JUNK_TARGET = /\\Windows\\Installer\\|\\uninstall[^\\]*\.exe$|unins\d*\.exe$/i;

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.(lnk|url|exe)$/i, '')
    .replace(/\s*\((x64|x86|64[- ]bit|32[- ]bit)\)\s*/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function runPowerShell(scriptPath, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true }
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      ps.kill();
      reject(new Error('scan timed out'));
    }, timeoutMs);

    ps.stdout.setEncoding('utf8');
    ps.stderr.setEncoding('utf8');
    ps.stdout.on('data', (d) => (out += d));
    ps.stderr.on('data', (d) => (err += d));
    ps.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ps.on('close', () => {
      clearTimeout(timer);
      if (!out.trim() && err.trim()) return reject(new Error(err.trim().slice(0, 400)));
      resolve(out);
    });
  });
}

function createCatalog(dataDir, options) {
  const opts = options || {};
  const maxAgeMs = opts.maxAgeMs || 1000 * 60 * 60 * 12;
  const cacheFile = path.join(dataDir, 'catalog.json');
  const usageFile = path.join(dataDir, 'usage.json');
  const scanScript = path.join(dataDir, 'scan-apps.ps1');

  // Scanned entries and hand-added ones are kept apart and merged into
  // `apps` on every change, because ids are indexes into the merged list.
  let scanned = [];
  let customList = [];
  let apps = [];
  let scannedAt = 0;
  let usage = {};

  function rebuild() {
    apps = [...scanned, ...customList].sort((a, b) => a.name.localeCompare(b.name));
    apps.forEach((a, i) => (a.id = i));
  }

  try {
    usage = JSON.parse(fs.readFileSync(usageFile, 'utf8')) || {};
  } catch (_) {
    usage = {};
  }

  function loadCache() {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c && Array.isArray(c.apps) && c.apps.length) {
        scanned = c.apps;
        scannedAt = c.scannedAt || 0;
        rebuild();
        return true;
      }
    } catch (_) {
      /* no cache yet */
    }
    return false;
  }

  async function scan() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(scanScript, SCAN_PS1, 'utf8');

    const raw = await runPowerShell(scanScript);
    let parsed;
    try {
      parsed = JSON.parse(raw.trim() || '[]');
    } catch (e) {
      throw new Error('could not parse scanner output: ' + e.message);
    }
    if (!Array.isArray(parsed)) parsed = [parsed];

    const byKey = new Map();
    for (const row of parsed) {
      const name = String(row.n || '').trim();
      if (!name || JUNK_NAME.test(name)) continue;

      const target = String(row.t || '');
      if (target && JUNK_TARGET.test(target)) continue;
      if (row.k === 'lnk' && path.extname(row.p).toLowerCase() === '.lnk' && !target) continue;

      const key = normalizeName(name);
      if (!key) continue;

      const entry = {
        name,
        key,
        launchPath: String(row.p || ''),
        target,
        args: String(row.a || ''),
        workDir: String(row.w || ''),
        group: String(row.g || ''),
        kind: row.k === 'appx' ? 'appx' : 'lnk',
      };

      const existing = byKey.get(key);
      if (!existing) byKey.set(key, entry);
      // Prefer the shortcut: knowing the real target lets us skip the shell.
      else if (existing.kind === 'appx' && entry.kind === 'lnk') byKey.set(key, entry);
    }

    scanned = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
    scannedAt = Date.now();
    rebuild();

    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ apps: scanned, scannedAt }), 'utf8');
    } catch (_) {
      /* cache is best-effort */
    }
    return apps;
  }

  /** Replace the hand-added entries and re-merge. */
  function setCustom(list) {
    customList = (list || []).map((e) => ({
      name: e.name,
      key: normalizeName(e.name),
      launchPath: e.launchPath,
      target: e.target || '',
      args: e.args || '',
      workDir: e.workDir || '',
      group: '',
      kind: e.kind,
      custom: true,
      customId: e.id,
    }));
    rebuild();
    return apps;
  }

  async function ensure(force) {
    const stale = Date.now() - scannedAt > maxAgeMs;
    if (force || !scanned.length || stale) {
      try {
        await scan();
      } catch (e) {
        if (!scanned.length) throw e;
      }
    }
    return apps;
  }

  function recordUsage(key) {
    const u = usage[key] || { count: 0, last: 0 };
    u.count += 1;
    u.last = Date.now();
    usage[key] = u;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(usageFile, JSON.stringify(usage), 'utf8');
    } catch (_) {
      /* best-effort */
    }
  }

  /**
   * The shape the renderer wants — no filesystem paths leave the backend.
   *
   * Hidden entries are marked rather than removed: ids are indexes into this
   * same array, so dropping them would renumber everything, and the renderer
   * needs to be able to list them again to offer a restore.
   */
  function toClientList(opts) {
    const o = opts || {};
    const hide = o.hidden || new Set();
    const icon = o.icon || (() => null);
    return {
      scannedAt,
      apps: apps.map((a) => ({
        id: a.id,
        name: a.name,
        key: a.key,
        group: a.group,
        kind: a.kind,
        use: usage[a.key] || null,
        hidden: hide.has(a.key),
        custom: !!a.custom,
        icon: icon(a.key),
      })),
    };
  }

  return {
    scan,
    ensure,
    loadCache,
    setCustom,
    recordUsage,
    toClientList,
    get apps() {
      return apps;
    },
    get scannedAt() {
      return scannedAt;
    },
  };
}

module.exports = { createCatalog, normalizeName };
