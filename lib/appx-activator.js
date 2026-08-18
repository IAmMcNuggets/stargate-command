'use strict';
/*
 * Store-app launching, done properly.
 *
 * explorer.exe is fire-and-forget: it reports nothing, always exits 1, and
 * when the shell is busy it will accept a request and silently drop it —
 * roughly one launch in ten. IApplicationActivationManager is the documented
 * API for activating a packaged app by AUMID, and it returns both an HRESULT
 * and the real process id, so success and failure are actually knowable.
 *
 * Reaching it needs COM interop, which from PowerShell means Add-Type and a
 * ~0.5s compile. So one PowerShell is kept alive for the life of the app: it
 * pays that cost once at startup, in the background, then answers activation
 * requests over stdin in a few milliseconds.
 *
 * Note the cast to the interface happens inside C#, not PowerShell —
 * PowerShell cannot cast the runtime-callable wrapper to a ComImport
 * interface ("Cannot convert System.__ComObject"), whereas the C# cast does a
 * proper QueryInterface.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HELPER_PS1 = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {
    [PreserveSig]
    int ActivateApplication(
        [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments,
        int options,
        out uint processId);
}

public static class SgcAppx {
    public static uint Activate(string aumid, out int hr) {
        Type t = Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C"));
        IApplicationActivationManager mgr = (IApplicationActivationManager)Activator.CreateInstance(t);
        uint pid = 0;
        hr = mgr.ActivateApplication(aumid, null, 0, out pid);
        return pid;
    }
}
"@

[Console]::Out.WriteLine('READY')

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq 'exit') { break }
    if ($line -eq '') { continue }
    try {
        $hr = 0
        $p = [SgcAppx]::Activate($line, [ref]$hr)
        if ($hr -eq 0 -and $p -ne 0) {
            [Console]::Out.WriteLine("OK $p")
        } else {
            [Console]::Out.WriteLine("ERR activation failed (0x$('{0:X8}' -f $hr))")
        }
    } catch {
        $m = $_.Exception.Message -replace '\\r?\\n', ' '
        [Console]::Out.WriteLine("ERR $m")
    }
}
`;

function createAppxActivator(dataDir, log) {
  const say = log || (() => {});
  const scriptPath = path.join(dataDir, 'appx-activator.ps1');

  let proc = null;
  let ready = false;
  const queue = []; // FIFO of { resolve, reject, timer }

  function settleNext(handler) {
    const job = queue.shift();
    if (job) {
      clearTimeout(job.timer);
      handler(job);
    }
  }

  function start() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(scriptPath, HELPER_PS1, 'utf8');
      proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
      );
    } catch (e) {
      say('appx activator failed to start: ' + e.message, true);
      proc = null;
      return;
    }

    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;

        if (line === 'READY') {
          ready = true;
          say('appx activator ready');
        } else if (line.startsWith('OK ')) {
          const pid = Number(line.slice(3));
          settleNext((job) => job.resolve({ pid }));
        } else if (line.startsWith('ERR ')) {
          const msg = line.slice(4);
          settleNext((job) => job.reject(new Error(msg)));
        }
      }
    });

    proc.on('error', (e) => {
      say('appx activator error: ' + e.message, true);
      proc = null;
      ready = false;
    });
    proc.on('exit', () => {
      proc = null;
      ready = false;
      // Anything still waiting will never be answered.
      while (queue.length) settleNext((job) => job.reject(new Error('activator stopped')));
    });
    proc.unref();
  }

  /** @returns {Promise<{pid:number}>} rejects if the app did not start. */
  function activate(aumid, timeoutMs) {
    if (!proc || !ready || !proc.stdin.writable) {
      return Promise.reject(new Error('activator unavailable'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = queue.findIndex((j) => j.timer === timer);
        if (i >= 0) queue.splice(i, 1);
        reject(new Error('activation timed out'));
      }, timeoutMs || 12000);

      queue.push({ resolve, reject, timer });
      try {
        proc.stdin.write(aumid + '\n');
      } catch (e) {
        clearTimeout(timer);
        queue.pop();
        reject(e);
      }
    });
  }

  function stop() {
    if (!proc) return;
    try {
      proc.stdin.write('exit\n');
      proc.stdin.end();
    } catch (_) {
      /* already gone */
    }
    proc = null;
    ready = false;
  }

  start();

  return {
    activate,
    stop,
    get ready() {
      return ready;
    },
  };
}

module.exports = { createAppxActivator };
