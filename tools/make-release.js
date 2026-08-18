#!/usr/bin/env node
'use strict';
/*
 * Assemble the shareable bundle: installer + instructions, zipped.
 *
 *   npm run dist        (build the installer first)
 *   node tools/make-release.js
 *
 * Exists because staging this by hand lost the INSTALL.txt once — the release
 * folder was recreated and only the .exe copied back in. Everything the bundle
 * needs is generated here, including the SHA-256, so the checksum quoted to
 * people always matches the file actually shipped.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const SETUP = `StargateCommand-Setup-${VERSION}.exe`;
const distExe = path.join(ROOT, 'dist', SETUP);
const releaseDir = path.join(ROOT, 'release');
const zipPath = path.join(ROOT, `StargateCommand-${VERSION}.zip`);

if (!fs.existsSync(distExe)) {
  console.error(`No installer at dist/${SETUP} — run "npm run dist" first.`);
  process.exit(1);
}

const bytes = fs.readFileSync(distExe);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();

fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });
fs.copyFileSync(distExe, path.join(releaseDir, SETUP));

const NL = '\r\n'; // opens cleanly in Notepad
const install = [
  'STARGATE COMMAND - Dialing Computer',
  '===================================',
  '',
  'An app launcher for Windows. Type a program name, press Enter, and the',
  'Stargate dials it - the ring spins, seven chevrons lock, the kawoosh fires,',
  'and your program opens.',
  '',
  `Version ${VERSION}`,
  `SHA-256  ${sha256}`,
  '',
  '',
  'INSTALLING',
  '----------',
  `1. Run ${SETUP}`,
  '',
  '2. Windows will show a blue "Windows protected your PC" box.',
  '   Click "More info", then "Run anyway".',
  '',
  '   This is expected. The app is not code-signed - a signing certificate',
  '   costs a few hundred pounds a year, and this is a hobby project.',
  '   SmartScreen shows that warning for any unsigned installer.',
  '',
  '   If you would rather not trust a stranger\'s binary, the full source is',
  '   on GitHub and builds with "npm install && npm run dist".',
  '',
  '3. Choose where to install it. Start Menu and desktop shortcuts are',
  '   created for you.',
  '',
  'Requires Windows 10 or 11, 64-bit. Nothing else to install.',
  '',
  '',
  'WHAT IT DOES ON YOUR MACHINE',
  '----------------------------',
  'It reads your Start Menu and Desktop shortcuts to build the program list,',
  'and pulls each program\'s icon. That is all it looks at.',
  '',
  'It makes no network connections whatsoever - no telemetry, no update check,',
  'no phoning home. You can verify that with a firewall.',
  '',
  'Everything it stores lives in one folder:',
  '  %APPDATA%\\Stargate Command',
  '',
  '',
  'FIRST RUN',
  '---------',
  'It scans your Start Menu and Desktop for installed programs - a few',
  'seconds. Program icons are pulled in afterwards in the background, so the',
  'list may be text-only for the first ten seconds or so. That happens once.',
  '',
  '',
  'USING IT',
  '--------',
  '  Type              filter the list',
  '  Up / Down         move the selection',
  '  Enter             dial it (about 10 seconds)',
  '  Shift + Enter     dial at full screen-accurate speed (about 28 seconds)',
  '  Tab               cycle dial speed: INSTANT / NORMAL / SHOW',
  '  Esc               abort a dial, clear the search, or hide the window',
  '  Ctrl + Alt + G    summon the window from anywhere (rebindable)',
  '  I                 open or close the iris',
  '  M                 audio on/off',
  '  F5                rescan for newly installed programs',
  '',
  'INSTANT speed is there for when you just want the program open.',
  '',
  '',
  'THINGS WORTH KNOWING',
  '--------------------',
  'The iris. Press I to close it. With the iris shut the gate still dials',
  'normally, but nothing comes through and the program will NOT launch. If',
  'things stop launching, check the IRIS button in the bottom right.',
  '',
  'Tidying the list. Press MANAGE by the registry heading, then tick anything',
  'you never launch - the "About ...", "... Help" and setup-wizard entries.',
  'Untick to bring one back. Press DONE when finished.',
  '',
  'Adding your own. Press + ADD for anything not in the Start Menu: a program,',
  'a document, a folder, or a web link.',
  '',
  'The hotkey. Click HOTKEY in the footer, then press the combination you want.',
  'It needs at least one modifier key.',
  '',
  '',
  'UNINSTALLING',
  '------------',
  'Settings > Apps > Installed apps > Stargate Command > Uninstall.',
  'Then delete %APPDATA%\\Stargate Command to remove its settings.',
  '',
  '',
  'The 39 symbols are the real Milky Way glyphs, traced from reference art,',
  'and every program has a fixed seven-symbol address - so the same program',
  'always dials the same way.',
  '',
].join(NL);

fs.writeFileSync(path.join(releaseDir, 'INSTALL.txt'), install, 'utf8');

fs.rmSync(zipPath, { force: true });
execFileSync('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `Compress-Archive -Path '${releaseDir}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal`,
]);

const zipMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`installer  ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
console.log(`sha-256    ${sha256}`);
console.log(`bundle     ${path.basename(zipPath)}  ${zipMb} MB`);
console.log('contents   ' + fs.readdirSync(releaseDir).join(', '));
