#!/usr/bin/env node
'use strict';
/*
 * Grab a PNG of the running desktop app over the DevTools protocol.
 *
 *   node tools/screenshot.js out.png
 *
 * Start the app with --remote-debugging-port=9222 first. Same transport as
 * tools/drive-desktop.js; this just captures rather than evaluates.
 */
const fs = require('fs');
const PORT = Number(process.env.SGC_DEBUG_PORT || 9222);
const OUT = process.argv[2] || 'screenshot.png';

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target — is the app running with --remote-debugging-port?');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('cannot connect'))); });
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(data, 'base64'));
  ws.close();
  console.log(`wrote ${OUT}  ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
})().catch((e) => { console.error(e.message); process.exit(1); });
