'use strict';
/*
 * Program discovery — platform dispatch.
 *
 * Both platforms implement the same interface (createCatalog, normalizeName),
 * so the rest of the app never has to branch. Windows walks the Start Menu
 * and Desktop for shortcuts via PowerShell; Linux scans .desktop files under
 * the XDG application directories.
 */
module.exports =
  process.platform === 'win32' ? require('./catalog-win') : require('./catalog-linux');
