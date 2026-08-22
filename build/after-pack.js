'use strict';
/*
 * Trim runtime files Electron ships that this app provably never uses.
 *
 * dxcompiler.dll / dxil.dll are the DirectX shader compiler, loaded only when
 * Chromium initializes WebGPU. The gate is drawn entirely with 2D canvas, so
 * that path is never taken — verified by running a packaged build with both
 * removed: the ring renders, a full seven-chevron dial completes, the event
 * horizon paints, and a program launches. Together they are ~26 MB.
 *
 * Deliberately NOT removed, despite being tempting:
 *   vk_swiftshader.dll  the software renderer Chromium falls back to when GPU
 *                       drivers misbehave. Dropping it risks a black window on
 *                       someone else's machine, which is precisely the failure
 *                       you cannot debug remotely.
 *   ffmpeg.dll          media decoding. Our audio is synthesised with
 *                       oscillators, but stripping it is known to destabilise
 *                       some Electron builds for a couple of megabytes.
 *   LICENSES.chromium.html
 *                       large, but it is the copyright notice Chromium's
 *                       license requires be distributed. It also compresses to
 *                       almost nothing in the installer.
 *
 * Nothing is trimmed on macOS or Linux. The DirectX compiler is a Windows
 * artefact and simply is not there, and inside a .app bundle deleting files
 * after the fact would invalidate the code signature for the sake of a few
 * megabytes — so the loop below finds nothing and says nothing.
 *
 * To keep everything Electron ships, remove "afterPack" from package.json.
 */

const fs = require('fs');
const path = require('path');

const DROP = ['dxcompiler.dll', 'dxil.dll'];

exports.default = async function afterPack(context) {
  const dir = context.appOutDir;
  let freed = 0;

  for (const name of DROP) {
    const p = path.join(dir, name);
    try {
      const { size } = fs.statSync(p);
      fs.unlinkSync(p);
      freed += size;
      console.log(`  trimmed ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (_) {
      /* not present in this Electron version — nothing to do */
    }
  }

  if (freed) console.log(`  trimmed ${(freed / 1024 / 1024).toFixed(1)} MB of unused runtime`);
};
