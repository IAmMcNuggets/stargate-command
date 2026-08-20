'use strict';
/*
 * Starting programs on Linux, in order of preference:
 *
 *   1. gio launch  a .desktop file, exactly as the desktop's own menu does.
 *                  This handles DBus activation, Flatpak/Snap wrappers,
 *                  Terminal=true, %-field codes and working directories the
 *                  way the freedesktop spec says, and it reports success via
 *                  its exit code.
 *   2. direct      when gio is unavailable, a .desktop entry whose Exec is a
 *                  plain command is parsed and spawned ourselves — a real pid
 *                  and a real error, matching the Windows "direct" path.
 *   3. open        documents and folders hand-added by the user go through
 *                  shell.openPath, the same as double-clicking in the file
 *                  manager.
 *
 * Everything except the last resort can tell success from failure, so a dial
 * that launches nothing says so instead of claiming transit completed.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// How long to wait for a spawn to report ENOENT etc. before calling it good.
const SPAWN_GRACE_MS = 350;

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

/*
 * Strip the freedesktop Exec field codes. For a bare launch there is no file
 * or URL to substitute, so %f %F %u %U and friends all expand to nothing; the
 * deprecated %i/%c are cosmetic. A literal %% is restored to %.
 */
function stripFieldCodes(exec) {
  return String(exec || '')
    .replace(/%%/g, '\u0000')
    .replace(/%[a-zA-Z]/g, '')
    .replace(/\u0000/g, '%');
}

/** Parse an Exec line into { cmd, args }, or null if it isn't a plain command. */
function parseExec(exec) {
  const tokens = tokenizeArgs(stripFieldCodes(exec));
  if (!tokens.length) return null;
  return { cmd: tokens[0], args: tokens.slice(1) };
}

/** True when an Exec line needs a shell (pipes, redirection, command subst). */
function needsShell(exec) {
  return /[;|&<>]|\$\(|`/.test(exec);
}

/** Launch a .desktop file via gio. Resolves { ok, err } on gio's exit. */
function gioLaunch(desktopPath, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('gio', ['launch', desktopPath], {
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
    const timer = setTimeout(() => done(true, ''), timeoutMs); // still up = success

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => done(false, e.message));
    child.on('exit', (code, sig) => {
      if (code === 0) done(true, '');
      else if (sig) done(false, 'gio launch killed by ' + sig);
      else done(false, err.trim().slice(0, 400) || 'gio launch exited ' + code);
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

/** Read the Exec= line out of a .desktop file (for hand-browsed entries). */
function readDesktopExec(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const m = /^Exec\s*=\s*(.+)$/m.exec(text);
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
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

  /* --------------------------------------------------------- desktop --- */
  if (app.kind === 'desktop') {
    const df = app.desktopPath || app.launchPath;
    if (!df || !fs.existsSync(df)) {
      throw new Error(app.custom ? 'target no longer exists' : 'launcher entry no longer exists — rescan required');
    }

    const viaGio = await gioLaunch(df);
    if (viaGio.ok) {
      say('launch  ' + app.name + '  [desktop]');
      return { how: 'desktop' };
    }

    // gio is missing or refused — fall back to parsing the Exec ourselves.
    const exec = app.exec || readDesktopExec(df);
    if (app.terminal) {
      throw new Error(viaGio.err || 'gio launch failed');
    }
    if (needsShell(exec)) {
      throw new Error(viaGio.err || 'gio launch failed (command needs a shell)');
    }
    const parsed = parseExec(exec);
    if (!parsed) throw new Error(viaGio.err || 'gio launch failed (unparsable Exec)');

    const cwd = app.workDir && fs.existsSync(app.workDir) ? app.workDir : path.dirname(df);
    const res = await spawnDetached(parsed.cmd, parsed.args, { cwd });
    say('launch  ' + app.name + '  [direct, pid ' + res.pid + ']');
    return res;
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
  parseExec,
  stripFieldCodes,
  needsShell,
  gioLaunch,
};
