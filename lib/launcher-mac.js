'use strict';
/*
 * Starting programs on macOS, in order of preference:
 *
 *   1. open -a     hand the bundle to Launch Services, exactly as a Finder
 *                  double-click does. It resolves the executable inside the
 *                  bundle, applies the right working directory and activates
 *                  the app if it is already running, and it reports failure
 *                  through its exit code.
 *   2. open -b     when the bundle is no longer where the catalog last saw it,
 *                  Launch Services is asked by bundle identifier instead, so
 *                  an app that was merely moved or updated still starts.
 *   3. direct      a plain executable added by hand is spawned ourselves, for
 *                  a real pid and a real error, matching the other platforms.
 *   4. open        documents and folders go through shell.openPath, the same
 *                  as double-clicking in the Finder.
 *
 * Every path except the last can tell success from failure, so a dial that
 * launches nothing says so instead of claiming transit completed.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { macRemoteUrl } = require('./remote');

// How long to wait for a spawn to report ENOENT etc. before calling it good.
const SPAWN_GRACE_MS = 350;

// Launch Services can sit on a cold bundle for a while; well past that and
// something is wrong rather than slow.
const OPEN_TIMEOUT_MS = 15000;

/** Split a command line into arguments, respecting double quotes. */
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

/**
 * Run /usr/bin/open and resolve { ok, err } on its exit.
 *
 * The absolute path is deliberate: this is the one place we hand a target to
 * something else to interpret, so it should not depend on what PATH happens
 * to contain.
 */
function runOpen(args, timeoutMs = OPEN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('/usr/bin/open', args, {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      return resolve({ ok: false, err: e.message });
    }

    let err = '';
    let settled = false;
    const done = (ok, msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, err: msg });
    };
    // open exits as soon as Launch Services accepts the request, so reaching
    // the timeout means it never answered at all.
    const timer = setTimeout(() => done(false, 'open did not return'), timeoutMs);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => done(false, e.message));
    child.on('exit', (code, sig) => {
      if (code === 0) done(true, '');
      else if (sig) done(false, 'open killed by ' + sig);
      else done(false, err.trim().slice(0, 400) || 'open exited ' + code);
    });
  });
}

/** Spawn a command detached and report a real pid (or a real error). */
function spawnDetached(cmd, args, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        cwd: o.cwd,
        env: o.env,
      });
    } catch (e) {
      return reject(new Error(e.message));
    }
    let settled = false;
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(new Error(e.message));
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ how: 'direct', pid: child.pid });
    }, SPAWN_GRACE_MS);
  });
}

/**
 * @param {object} app  catalog entry
 * @param {object} [opts] { log, shellOpen, openExternal }
 * @returns {Promise<{how:string, pid?:number}>} rejects when the program did
 *          not start, so the caller can report it.
 */
async function launchApp(app, opts) {
  const o = opts || {};
  const say = o.log || (() => {});

  /* ------------------------------------------------------------- url --- */
  if (app.kind === 'url') {
    if (!o.openExternal) throw new Error('cannot open links here');
    await o.openExternal(app.launchPath);
    say('launch  ' + app.name + '  [url]');
    return { how: 'url' };
  }

  /* ------------------------------------------------------------- app --- */
  if (app.kind === 'app') {
    const bundle = app.appPath || app.launchPath;
    const extra = tokenizeArgs(app.args || '');

    if (bundle && fs.existsSync(bundle)) {
      const args = ['-a', bundle];
      if (extra.length) args.push('--args', ...extra);
      const res = await runOpen(args);
      if (res.ok) {
        say('launch  ' + app.name + '  [bundle]');
        return { how: 'bundle' };
      }
      // Fall through to the identifier, which survives a moved bundle.
      if (!app.bundleId) throw new Error(res.err || 'open failed');
      const byId = await runOpen(
        extra.length ? ['-b', app.bundleId, '--args', ...extra] : ['-b', app.bundleId]
      );
      if (byId.ok) {
        say('launch  ' + app.name + '  [bundle id]');
        return { how: 'bundle-id' };
      }
      throw new Error(res.err || byId.err || 'open failed');
    }

    if (!app.bundleId) {
      throw new Error(
        app.custom ? 'target no longer exists' : 'application bundle no longer exists — rescan required'
      );
    }
    const byId = await runOpen(
      extra.length ? ['-b', app.bundleId, '--args', ...extra] : ['-b', app.bundleId]
    );
    if (byId.ok) {
      say('launch  ' + app.name + '  [bundle id]');
      return { how: 'bundle-id' };
    }
    throw new Error(byId.err || 'application bundle no longer exists — rescan required');
  }

  /* --------------------------------------------------------- remote --- */
  // The host was validated before it was stored, so nothing here can be read
  // as a client flag or smuggled into the URL.
  if (app.kind === 'remote') {
    const res = await runOpen([macRemoteUrl(app.launchPath)]);
    if (res.ok) {
      say('launch  ' + app.name + '  [rdp]');
      return { how: 'rdp' };
    }
    throw new Error(
      'no remote desktop client installed — install Windows App (formerly Microsoft Remote Desktop) from the App Store'
    );
  }

  /* -------------------------------------------------------- command --- */
  if (app.kind === 'command') {
    const target = app.target || app.launchPath;
    if (!target || !fs.existsSync(target)) throw new Error('target no longer exists');
    const cwd = app.workDir && fs.existsSync(app.workDir) ? app.workDir : path.dirname(target);
    const res = await spawnDetached(target, tokenizeArgs(app.args || ''), { cwd });
    say('launch  ' + app.name + '  [direct, pid ' + res.pid + ']');
    return res;
  }

  /* ----------------------------------------------------------- file --- */
  if (app.kind === 'file') {
    if (!app.launchPath || !fs.existsSync(app.launchPath)) throw new Error('target no longer exists');
    if (!o.shellOpen) throw new Error('cannot open files here');
    const err = await o.shellOpen(app.launchPath);
    if (err) throw new Error(err);
    say('launch  ' + app.name + '  [open]');
    return { how: 'open' };
  }

  throw new Error('unknown destination kind: ' + app.kind);
}

module.exports = {
  launchApp,
  tokenizeArgs,
  runOpen,
  spawnDetached,
};
