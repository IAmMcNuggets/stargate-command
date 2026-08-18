#!/usr/bin/env node
'use strict';
/*
 * STARGATE COMMAND :: DIALING COMPUTER
 * Zero-dependency app launcher for Windows.
 *
 * Security model:
 *  - Binds to 127.0.0.1 on an ephemeral port.
 *  - Every API call requires a random per-session token in the X-Gate-Token
 *    header (custom headers can't be forged by cross-origin forms, and CORS
 *    preflight blocks cross-origin fetch).
 *  - /api/launch takes an *index into the server's own catalog*, never a path
 *    from the request. A malicious page cannot make this run arbitrary code.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const SCAN_SCRIPT = path.join(DATA_DIR, 'scan-apps.ps1');
const HELPER_SCRIPT = path.join(DATA_DIR, 'window-helper.ps1');

const TOKEN = crypto.randomBytes(24).toString('hex');
const WINDOW_TITLE = 'STARGATE COMMAND';
const CATALOG_MAX_AGE_MS = 1000 * 60 * 60 * 12; // rescan twice a day

const argv = process.argv.slice(2);
const NO_BROWSER = argv.includes('--no-browser');
const FORCE_RESCAN = argv.includes('--rescan');

// 0 = let the OS pick a free port (the default; nothing to collide with).
const portArg = argv.find((a) => a.startsWith('--port='));
const PORT = parseInt(
  (portArg && portArg.slice('--port='.length)) || process.env.SGC_PORT || '0',
  10
) || 0;

let catalog = { apps: [], scannedAt: 0 };
let usage = {};

/* ------------------------------------------------------------------ *
 * PowerShell scanner
 * ------------------------------------------------------------------ */

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

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.(lnk|url|exe)$/i, '')
    .replace(/\s*\((x64|x86|64[- ]bit|32[- ]bit)\)\s*/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function scanApps() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SCAN_SCRIPT, SCAN_PS1, 'utf8');

  const raw = await runPowerShell(SCAN_SCRIPT);
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
    if (!name) continue;
    if (JUNK_NAME.test(name)) continue;

    const target = String(row.t || '');
    if (target && JUNK_TARGET.test(target)) continue;

    // .lnk with no resolvable target and no arguments is usually a dead entry.
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
    if (!existing) {
      byKey.set(key, entry);
    } else if (existing.kind === 'appx' && entry.kind === 'lnk') {
      // Prefer the shortcut: we know its real target, which makes it launch faster.
      byKey.set(key, entry);
    }
  }

  const apps = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  apps.forEach((a, i) => (a.id = i));

  catalog = { apps, scannedAt: Date.now() };
  try {
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog), 'utf8');
  } catch (_) {
    /* cache is best-effort */
  }
  return catalog;
}

function loadCachedCatalog() {
  try {
    const c = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    if (c && Array.isArray(c.apps) && c.apps.length) {
      c.apps.forEach((a, i) => (a.id = i));
      catalog = c;
      return true;
    }
  } catch (_) {
    /* no cache yet */
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Usage stats (drives recency ranking)
 * ------------------------------------------------------------------ */

function loadUsage() {
  try {
    usage = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')) || {};
  } catch (_) {
    usage = {};
  }
}

function recordUsage(key) {
  const u = usage[key] || { count: 0, last: 0 };
  u.count += 1;
  u.last = Date.now();
  usage[key] = u;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage), 'utf8');
  } catch (_) {
    /* best-effort */
  }
}

/* ------------------------------------------------------------------ *
 * Launching
 * ------------------------------------------------------------------ */

/*
 * Launch through explorer.exe — the same path a double-click takes.
 *
 * Deliberately NOT PowerShell's Start-Process: when spawned detached and
 * hidden from Node, the shell activation it kicks off is torn down before it
 * completes, so Store apps silently never start (exit code 0, no window).
 * explorer.exe hands the request to the running shell, which owns the
 * activation, and works for .lnk, .url and AppsFolder AUMIDs alike.
 */
/** Split a shortcut's argument string, respecting double quotes. */
function tokenizeArgs(s) {
  const out = [];
  let cur = '';
  let inQuote = false;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      inQuote = !inQuote;
      started = true;
    } else if (!inQuote && /\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

const DIRECT_EXEC = /\.(exe|com|bat|cmd)$/i;

function launchApp(app) {
  if (app.kind === 'lnk' && !fs.existsSync(app.launchPath)) {
    throw new Error('shortcut no longer exists — rescan required');
  }

  let child;
  let how;

  if (app.kind === 'lnk' && app.target && DIRECT_EXEC.test(app.target) && fs.existsSync(app.target)) {
    /*
     * Preferred path. We resolved the shortcut's real target at scan time, so
     * run it directly instead of asking the shell to. Going through
     * explorer.exe is fire-and-forget — it reports nothing and, if the shell
     * is busy, will occasionally accept a request and simply drop it, which
     * looks like a successful dial that launches nothing. A direct spawn
     * gives a real pid and a real error event.
     */
    const cwd = app.workDir && fs.existsSync(app.workDir) ? app.workDir : path.dirname(app.target);
    child = spawn(app.target, tokenizeArgs(app.args || ''), {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd,
    });
    how = 'direct';
  } else {
    // Store apps (AUMIDs), .url files and shortcuts pointing at documents
    // genuinely need the shell to resolve them.
    const spec = app.kind === 'appx' ? 'shell:AppsFolder\\' + app.launchPath : app.launchPath;
    child = spawn('explorer.exe', [spec], { detached: true, stdio: 'ignore', windowsHide: true });
    how = 'shell';
  }

  child.on('error', (e) => {
    console.error(`  launch FAILED  ${app.name} (${how}): ${e.message}`);
  });
  console.log(`  launch  ${app.name}  [${how}, pid ${child.pid}]`);
  child.unref();
}

/*
 * Window helper.
 *
 * Minimizing needs user32!ShowWindow, which from PowerShell means Add-Type —
 * and Add-Type invokes the C# compiler, costing ~3s every call. So we keep one
 * PowerShell alive for the life of the server, pay that cost once at startup,
 * and then just write commands to its stdin.
 */
const HELPER_PS1 = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SgcWin {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

[Console]::Out.WriteLine('READY')
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq 'minimize') {
        Get-Process |
          Where-Object { $_.MainWindowTitle -like '*${WINDOW_TITLE}*' -and $_.MainWindowHandle -ne 0 } |
          ForEach-Object { [SgcWin]::ShowWindow($_.MainWindowHandle, 6) | Out-Null }
    }
    elseif ($line.Trim() -eq 'exit') { break }
}
`;

let helper = null;

function startWindowHelper() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HELPER_SCRIPT, HELPER_PS1, 'utf8');
    helper = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_SCRIPT],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    helper.on('error', () => (helper = null));
    helper.on('exit', () => (helper = null));
    helper.unref();
  } catch (_) {
    helper = null;
  }
}

function minimizeLauncherWindow() {
  if (!helper || !helper.stdin.writable) return;
  try {
    helper.stdin.write('minimize\n');
  } catch (_) {
    /* helper died; the launched app still takes focus on its own */
  }
}

function stopWindowHelper() {
  if (!helper) return;
  try {
    helper.stdin.write('exit\n');
    helper.stdin.end();
  } catch (_) {
    /* already gone */
  }
  helper = null;
}

/* ------------------------------------------------------------------ *
 * HTTP server
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function isLocalRequest(req) {
  const host = String(req.headers.host || '');
  const addr = req.socket.remoteAddress || '';
  const localAddr = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  return localAddr && /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host);
}

function authorized(req) {
  return isLocalRequest(req) && req.headers['x-gate-token'] === TOKEN;
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    let out = buf;
    if (ext === '.html') {
      out = Buffer.from(buf.toString('utf8').replace(/__GATE_TOKEN__/g, TOKEN), 'utf8');
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': out.length,
      'Cache-Control': 'no-store',
    });
    res.end(out);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;

  if (!route.startsWith('/api/')) {
    if (req.method !== 'GET') return res.writeHead(405).end();
    return serveStatic(req, res, route);
  }

  if (!authorized(req)) return sendJson(res, 403, { error: 'unauthorized' });

  try {
    if (route === '/api/catalog' && req.method === 'GET') {
      const stale = Date.now() - catalog.scannedAt > CATALOG_MAX_AGE_MS;
      if (!catalog.apps.length || stale) {
        try {
          await scanApps();
        } catch (e) {
          if (!catalog.apps.length) return sendJson(res, 500, { error: e.message });
        }
      }
      return sendJson(res, 200, {
        scannedAt: catalog.scannedAt,
        apps: catalog.apps.map((a) => ({
          id: a.id,
          name: a.name,
          key: a.key,
          group: a.group,
          kind: a.kind,
          use: usage[a.key] || null,
        })),
      });
    }

    if (route === '/api/rescan' && req.method === 'POST') {
      await scanApps();
      return sendJson(res, 200, {
        scannedAt: catalog.scannedAt,
        apps: catalog.apps.map((a) => ({
          id: a.id,
          name: a.name,
          key: a.key,
          group: a.group,
          kind: a.kind,
          use: usage[a.key] || null,
        })),
      });
    }

    if (route === '/api/launch' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const id = Number(body.id);
      const app = catalog.apps[id];
      if (!Number.isInteger(id) || !app) return sendJson(res, 400, { error: 'unknown address' });

      await launchApp(app, {
        log: (m, isErr) => (isErr ? console.error('  ' + m) : console.log('  ' + m)),
      });
      recordUsage(app.key);
      if (body.minimize !== false) setTimeout(minimizeLauncherWindow, 450);
      return sendJson(res, 200, { ok: true, name: app.name });
    }

    if (route === '/api/minimize' && req.method === 'POST') {
      minimizeLauncherWindow();
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/api/quit' && req.method === 'POST') {
      sendJson(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 150);
      return;
    }

    return sendJson(res, 404, { error: 'no such endpoint' });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function openInEdge(url) {
  const candidates = [
    path.join(
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'Microsoft\\Edge\\Application\\msedge.exe'
    ),
    path.join(
      process.env['ProgramFiles'] || 'C:\\Program Files',
      'Microsoft\\Edge\\Application\\msedge.exe'
    ),
  ];
  const exe = candidates.find((p) => fs.existsSync(p));
  const profileDir = path.join(DATA_DIR, 'browser-profile');

  if (exe) {
    const child = spawn(
      exe,
      [
        `--app=${url}`,
        `--user-data-dir=${profileDir}`,
        '--window-size=1360,860',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,msEdgeSplitScreen',
      ],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();
  } else {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
}

for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopWindowHelper();
    if (sig !== 'exit') process.exit(0);
  });
}

(async function main() {
  loadUsage();
  startWindowHelper();
  const hadCache = loadCachedCatalog();

  server.listen(PORT, '127.0.0.1', async () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/`;
    console.log('');
    console.log('  STARGATE COMMAND :: dialing computer online');
    console.log('  ' + url);
    console.log('  catalog: ' + (hadCache ? catalog.apps.length + ' cached addresses' : 'scanning...'));
    console.log('  (close this window to shut the gate down)');
    console.log('');
    if (!NO_BROWSER) openInEdge(url);
  });

  if (!hadCache || FORCE_RESCAN) {
    try {
      await scanApps();
      console.log('  catalog: ' + catalog.apps.length + ' addresses indexed');
    } catch (e) {
      console.error('  scan failed: ' + e.message);
    }
  }
})();
