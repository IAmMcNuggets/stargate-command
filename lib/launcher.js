'use strict';
/*
 * Program launching — platform dispatch.
 *
 * Both platforms expose launchApp(app, opts) with the same callback contract
 * ({ log, shellOpen, openExternal, activateAppx }), so callers are identical
 * either way.
 */
module.exports =
  process.platform === 'win32' ? require('./launcher-win') : require('./launcher-linux');
