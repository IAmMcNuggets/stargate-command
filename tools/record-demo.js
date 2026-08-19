#!/usr/bin/env node
'use strict';
/*
 * Record a demo clip of the gate dialing.
 *
 *   "dist\win-unpacked\Stargate Command.exe" --remote-debugging-port=9222
 *   node tools/record-demo.js [scene] [out.mp4]     scenes: dial, iris
 *
 * Frames come from Chromium's own screencast over the DevTools protocol
 * rather than from a screen recorder. Windows' Game Bar captures the window
 * but not the GPU-accelerated canvas, so every frame of the gate comes out
 * identical — the UI records, the animation does not. Pulling frames from the
 * renderer sidesteps that entirely and is deterministic.
 *
 * No audio: the screencast is video only. Reddit and most feeds autoplay
 * muted anyway, so the clip is built to read without sound.
 *
 * Needs ffmpeg on PATH.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.SGC_DEBUG_PORT || 9222);
const SCENE = process.argv[2] || 'dial';
const OUT = path.resolve(process.argv[3] || `stargate-${SCENE}.mp4`);
const WORK = path.join(os.tmpdir(), 'sgc-demo-frames');

// Shared preamble: put the console into a known idle state so a take never
// starts mid-wormhole or at the wrong speed.
const PRELUDE = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const s = document.getElementById('search');
  const type = async (word) => {
    s.focus();
    for (const ch of word) {
      s.value += ch;
      s.dispatchEvent(new Event('input', { bubbles: true }));
      // Uneven, so it reads as someone typing rather than a paste.
      await sleep(95 + Math.random() * 65);
    }
  };
  state.speed = 'NORMAL';
  applySpeedLabel();
  s.value = '';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  gate.reset();
`;

// Each scene is one take. A beat at either end so the clip does not cut hard.
const SCENES = {
  // The main clip: type a program, dial it, watch it open.
  dial: `(async () => {
    ${PRELUDE}
    if (state.irisClosed) toggleIris();
    await sleep(1400);
    await type('calculator');
    await sleep(900);
    await dialSelected(false);
    await sleep(2600);
    return 'done';
  })()`,

  // The iris: same dial, but nothing comes through and nothing launches.
  iris: `(async () => {
    ${PRELUDE}
    if (state.irisClosed) toggleIris();
    await sleep(1200);
    toggleIris();
    await sleep(1800);
    await type('notepad');
    await sleep(900);
    // A blocked transit is the point of this take, so a rejection here is the
    // expected outcome, not a failed recording.
    try { await dialSelected(false); } catch (e) {}
    await sleep(3200);
    return 'done';
  })()`,
};

async function main() {
  if (!SCENES[SCENE]) {
    throw new Error(`unknown scene "${SCENE}" — try one of: ${Object.keys(SCENES).join(', ')}`);
  }

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target — is the app running with --remote-debugging-port?');

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  const frames = []; // { file, t }
  let done = false;

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.method === 'Page.screencastFrame') {
      const { data, sessionId, metadata } = msg.params;
      if (!done) {
        const file = path.join(WORK, String(frames.length).padStart(5, '0') + '.jpg');
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        frames.push({ file, t: metadata.timestamp });
      }
      ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId } }));
      return;
    }

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

  await send('Page.enable');
  await send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 });
  console.log(`recording scene "${SCENE}"…`);

  await send('Runtime.evaluate', { expression: SCENES[SCENE], awaitPromise: true, returnByValue: true });

  done = true;
  await send('Page.stopScreencast');
  ws.close();

  if (frames.length < 2) throw new Error('captured ' + frames.length + ' frames — nothing to encode');

  // Real per-frame durations, so the clip runs at the speed it was performed.
  const first = frames[0].t;
  const last = frames[frames.length - 1].t;
  const span = last - first;
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].t : last + 1 / 30;
    lines.push(`file '${frames[i].file.replace(/\\/g, '/')}'`);
    lines.push(`duration ${Math.max(0.01, next - frames[i].t).toFixed(4)}`);
  }
  lines.push(`file '${frames[frames.length - 1].file.replace(/\\/g, '/')}'`);
  const listFile = path.join(WORK, 'frames.txt');
  fs.writeFileSync(listFile, lines.join('\n'));

  console.log(`captured ${frames.length} frames over ${span.toFixed(1)}s (${(frames.length / span).toFixed(1)} fps)`);
  console.log('encoding…');

  fs.rmSync(OUT, { force: true });
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-fps_mode', 'vfr',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
      // yuv420p and even dimensions, or half the world cannot play it.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      OUT,
    ],
    { stdio: 'inherit' }
  );

  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
  console.log(`wrote ${OUT}  ${mb} MB`);
  fs.rmSync(WORK, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
