'use strict';
/*
 * Program discovery — platform dispatch.
 *
 * All three platforms implement the same interface (createCatalog,
 * normalizeName), so the rest of the app never has to branch. Windows walks
 * the Start Menu and Desktop for shortcuts via PowerShell; Linux scans
 * .desktop files under the XDG application directories; macOS walks the
 * application folders for .app bundles.
 */
const IMPLEMENTATIONS = {
  win32: './catalog-win',
  darwin: './catalog-mac',
  linux: './catalog-linux',
};

// The BSDs run the same freedesktop desktop environments, so they get the
// Linux scanner rather than nothing at all.
module.exports = require(IMPLEMENTATIONS[process.platform] || './catalog-linux');
