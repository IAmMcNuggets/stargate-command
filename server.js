#!/usr/bin/env node
'use strict';
/*
 * STARGATE COMMAND :: DIALING COMPUTER
 * Zero-dependency app launcher — cross-platform.
 *
 * This is the browser-mode server: it serves the gate over localhost and
 * opens it in the default browser. It shares the same platform-dispatched
 * catalog and launcher as the Electron desktop app, so the catalog is
 * identical either way.
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
const crypto = require('crypto');
const { spawn } = require('child_process');

const { createCatalog } = require('./lib/catalog');
const { launchApp } = require('./lib/launcher');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');

const IS_WIN32 = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// The per-platform "hand this to the desktop" command.
const OPEN_CMD = IS_WIN32 ? 'explorer.exe' : IS_MAC ? 'open' : 'xdg-open';

const TOKEN = crypto.randomBytes(24).toString('hex');
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

const catalog = createCatalog(DATA_DIR, { maxAgeMs: CATALOG_MAX_AGE_MS });

/* ------------------------------------------------------------------ *
 * Launching
 * ------------------------------------------------------------------ */

/*
 * Hand a URL or file to the desktop's default handler. On Windows that is
 * explorer.exe (the same path a double-click takes); on macOS, open; on
 * Linux, xdg-open.
 * Resolves null on success, an error string on failure — the contract
 * launchApp expects from its shellOpen callback.
 */
function shellOpen(target) {
  const cmd = OPEN_CMD;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
    } catch (e) {
      return resolve(e.message);
    }
    child.on('error', (e) => resolve(e.message));
    child.on('exit', (code) => resolve(code === 0 ? null : cmd + ' exited ' + code));
    child.unref();
  });
}

function openExternal(url) {
  // launchApp awaits openExternal and treats a rejection as a launch failure,
  // matching Electron's shell.openExternal semantics.
  const cmd = OPEN_CMD;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    } catch (e) {
      return reject(new Error(e.message));
    }
    child.on('error', (e) => reject(new Error(e.message)));
    child.on('exit', (code) => {
      if (code === 0) resolve(null);
      else reject(new Error(cmd + ' exited ' + code));
    });
    child.unref();
  });
}

function log(message, isError) {
  (isError ? console.error : console.log)('  ' + message);
}

/*
 * Window helper: the Windows server used user32 to minimise its own Edge
 * window. There is no portable equivalent from a plain Node process, and the
 * browser-mode UI launches with `minimize: false` anyway, so this is a no-op
 * that keeps the /api/minimize endpoint working on both platforms.
 */
function minimizeLauncherWindow() {
  /* no-op — the browser owns its own window */
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
      try {
        await catalog.ensure(false);
      } catch (e) {
        if (!catalog.apps.length) return sendJson(res, 500, { error: e.message });
      }
      return sendJson(res, 200, catalog.toClientList());
    }

    if (route === '/api/rescan' && req.method === 'POST') {
      await catalog.ensure(true);
      return sendJson(res, 200, catalog.toClientList());
    }

    if (route === '/api/launch' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const id = Number(body.id);
      const app = catalog.apps[id];
      if (!Number.isInteger(id) || !app) return sendJson(res, 400, { error: 'unknown address' });

      await launchApp(app, {
        log,
        shellOpen,
        openExternal,
      });
      catalog.recordUsage(app.key);
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

function openInBrowser(url) {
  if (IS_WIN32) {
    // Original behaviour: Edge in --app mode, falling back to `cmd start`.
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
    return;
  }
  const child = spawn(OPEN_CMD, [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    console.log('  (could not open a browser — visit ' + url + ' yourself)');
  });
  child.unref();
}

for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (sig !== 'exit') process.exit(0);
  });
}

(async function main() {
  const hadCache = catalog.loadCache();

  server.listen(PORT, '127.0.0.1', async () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/`;
    console.log('');
    console.log('  STARGATE COMMAND :: dialing computer online');
    console.log('  ' + url);
    console.log('  catalog: ' + (hadCache ? catalog.apps.length + ' cached addresses' : 'scanning...'));
    console.log('  (close this window to shut the gate down)');
    console.log('');
    if (!NO_BROWSER) openInBrowser(url);
  });

  if (!hadCache || FORCE_RESCAN) {
    try {
      await catalog.ensure(true);
      console.log('  catalog: ' + catalog.apps.length + ' addresses indexed');
    } catch (e) {
      console.error('  scan failed: ' + e.message);
    }
  }
})();
