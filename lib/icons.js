'use strict';
/*
 * Program icons — platform dispatch.
 *
 * All three platforms expose createIconStore(dataDir, log). Windows extracts
 * .ico via PowerShell + System.Drawing; Linux resolves Icon= names against the
 * freedesktop icon themes; macOS asks Launch Services for the bundle's icon.
 */
const IMPLEMENTATIONS = {
  win32: './icons-win',
  darwin: './icons-mac',
  linux: './icons-linux',
};

module.exports = require(IMPLEMENTATIONS[process.platform] || './icons-linux');
