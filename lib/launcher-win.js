'use strict';
/*
 * Starting programs, in order of preference:
 *
 *   1. direct    a shortcut whose target resolves to an executable — we spawn
 *                it ourselves using the target, arguments and working
 *                directory captured during the scan. Real pid, real error.
 *   2. activate  a Store app — IApplicationActivationManager by AUMID, which
 *                returns an HRESULT and the real process id.
 *   3. shell     .url files and shortcuts to documents, via the host's
 *                shell.openPath, which reports failure.
 *   4. explorer  last-resort fallback. Fire-and-forget: reports nothing,
 *                always exits 1, and occasionally drops the request.
 *
 * Everything except the fallback can tell success from failure, so a dial that
 * launches nothing now says so instead of claiming transit completed.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIRECT_EXEC = /\.(exe|com|bat|cmd)$/i;

// How long to wait for a spawn to report ENOENT etc. before calling it good.
const SPAWN_GRACE_MS = 350;

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

/**
 * @param {object} app  catalog entry
 * @param {object} [opts] { log, shellOpen, activateAppx }
 * @returns {Promise<{how:string, pid?:number}>} rejects when the program did
 *          not start, so the caller can report it.
 */
async function launchApp(app, opts) {
  const o = opts || {};
  const say = o.log || (() => {});

  /* ------------------------------------------------------------- url --- */
  // Hand-added web destinations: a URL is neither a file nor an AUMID, so it
  // needs openExternal rather than openPath.
  if (app.kind === 'url') {
    if (!o.openExternal) throw new Error('cannot open links here');
    await o.openExternal(app.launchPath);
    say('launch  ' + app.name + '  [url]');
    return { how: 'url' };
  }

  /* ---------------------------------------------------------- remote --- */
  // Remote Desktop. The host was validated in the main process before it was
  // ever stored, so what arrives here is a hostname or IP and nothing that
  // mstsc could mistake for one of its own switches.
  if (app.kind === 'remote') {
    const child = spawn('mstsc.exe', ['/v:' + app.launchPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    return await new Promise((resolve, reject) => {
      let settled = false;
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        say(`launch FAILED  ${app.name} (rdp): ${e.message}`, true);
        reject(new Error(e.message));
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        child.unref();
        say(`launch  ${app.name}  [rdp, pid ${child.pid}]`);
        resolve({ how: 'rdp', pid: child.pid });
      }, SPAWN_GRACE_MS);
    });
  }

  if ((app.kind === 'lnk' || app.kind === 'file') && !fs.existsSync(app.launchPath)) {
    throw new Error(
      app.custom ? 'target no longer exists' : 'shortcut no longer exists — rescan required'
    );
  }

  /* ---------------------------------------------------------- direct ---- */
  if (app.kind === 'lnk' && app.target && DIRECT_EXEC.test(app.target) && fs.existsSync(app.target)) {
    const cwd =
      app.workDir && fs.existsSync(app.workDir) ? app.workDir : path.dirname(app.target);
    const child = spawn(app.target, tokenizeArgs(app.args || ''), {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd,
    });

    const direct = await new Promise((resolve, reject) => {
      let settled = false;
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        // A program whose manifest asks for administrator cannot be started
        // by CreateProcess at all: Windows refuses with EACCES rather than
        // prompting, so spawn never gets the chance. ShellExecute is the call
        // that raises the UAC prompt, and the shell branch below uses it, so
        // this hands over instead of reporting a failure the user cannot act
        // on. Anything that genuinely will not start still fails there.
        if (e.code === 'EACCES' || e.code === 'EPERM') {
          say(`${app.name} needs elevation; handing it to the shell`);
          return resolve(null);
        }
        say(`launch FAILED  ${app.name} (direct): ${e.message}`, true);
        reject(new Error(e.message));
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        child.unref();
        say(`launch  ${app.name}  [direct, pid ${child.pid}]`);
        resolve({ how: 'direct', pid: child.pid });
      }, SPAWN_GRACE_MS);
    });
    if (direct) return direct;
  }

  /* -------------------------------------------------------- Store app --- */
  if (app.kind === 'appx' && o.activateAppx) {
    try {
      const { pid } = await o.activateAppx(app.launchPath);
      say(`launch  ${app.name}  [activate, pid ${pid}]`);
      return { how: 'activate', pid };
    } catch (e) {
      // Only fall through to the shell if the helper itself is unavailable.
      // A refusal from Windows is a real failure and must surface.
      if (!/unavailable|stopped/i.test(e.message)) {
        say(`launch FAILED  ${app.name} (activate): ${e.message}`, true);
        throw new Error(e.message);
      }
      say(`activator unavailable for ${app.name}, falling back to explorer`, true);
    }
  }

  const spec = app.kind === 'appx' ? 'shell:AppsFolder\\' + app.launchPath : app.launchPath;

  /* ------------------------------------------------------------ shell --- */
  // Documents and folders are opened by the shell, same as double-clicking.
  if (o.shellOpen && app.kind !== 'appx') {
    try {
      const err = await o.shellOpen(spec);
      if (!err) {
        say(`launch  ${app.name}  [shell]`);
        return { how: 'shell' };
      }
      say(`shell open failed for ${app.name}: ${err} — falling back to explorer`, true);
    } catch (e) {
      say(`shell open threw for ${app.name}: ${e.message} — falling back to explorer`, true);
    }
  }

  /* --------------------------------------------------------- explorer --- */
  return await new Promise((resolve, reject) => {
    const child = spawn('explorer.exe', [spec], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      say(`launch FAILED  ${app.name} (explorer): ${e.message}`, true);
      reject(new Error(e.message));
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      say(`launch  ${app.name}  [explorer, pid ${child.pid}]`);
      resolve({ how: 'explorer', pid: child.pid });
    }, SPAWN_GRACE_MS);
  });
}

module.exports = { launchApp, tokenizeArgs };
