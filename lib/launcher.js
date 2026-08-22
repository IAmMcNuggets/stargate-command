'use strict';
/*
 * Program launching — platform dispatch.
 *
 * All three platforms expose launchApp(app, opts) with the same callback
 * contract ({ log, shellOpen, openExternal, activateAppx }), so callers are
 * identical whichever one is loaded.
 */
const IMPLEMENTATIONS = {
  win32: './launcher-win',
  darwin: './launcher-mac',
  linux: './launcher-linux',
};

module.exports = require(IMPLEMENTATIONS[process.platform] || './launcher-linux');
