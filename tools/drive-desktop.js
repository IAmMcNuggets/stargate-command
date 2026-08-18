#!/usr/bin/env node
'use strict';
/*
 * Evaluate an expression inside the running desktop app's renderer, for
 * verifying a packaged build without a human driving the window.
 *
 * Start the app with a debugging port first:
 *   "dist\win-unpacked\Stargate Command.exe" --remote-debugging-port=9222
 * then:
 *   node tools/drive-desktop.js "state.apps.length"
 *
 * Uses Node's built-in fetch and WebSocket (Node 22+), so nothing to install.
 */

const fs = require('fs');

const PORT = Number(process.env.SGC_DEBUG_PORT || 9222);
const args = process.argv.slice(2);

// Multi-line expressions are painful to quote through a shell, so they can
// live in a file instead:  node tools/drive-desktop.js --file check.js
const fileIdx = args.indexOf('--file');
const expression =
  fileIdx >= 0 && args[fileIdx + 1]
    ? fs.readFileSync(args[fileIdx + 1], 'utf8')
    : args.join(' ') || 'location.href';

async function main() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) {
    console.error('no page target — is the app running with --remote-debugging-port?');
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('could not connect to the renderer')));
  });

  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });

  if (result.exceptionDetails) {
    console.error('threw:', result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    ws.close();
    process.exit(1);
  }
  console.log(JSON.stringify(result.result.value, null, 2));
  ws.close();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
