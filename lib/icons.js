'use strict';
/*
 * Program icons — platform dispatch.
 *
 * Both platforms expose createIconStore(dataDir, log). Windows extracts .ico
 * via PowerShell + System.Drawing; Linux resolves Icon= names against the
 * freedesktop icon themes.
 */
module.exports =
  process.platform === 'win32' ? require('./icons-win') : require('./icons-linux');
