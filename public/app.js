'use strict';
/* STARGATE COMMAND :: dialing computer — console logic */

// Carried on <body> rather than an inline <script>, so the page can run
// under a strict script-src 'self' policy. Only used in browser mode.
const TOKEN = document.body.dataset.gateToken || '';

const el = (id) => document.getElementById(id);
const $search = el('search');
const $results = el('results');
const $resultMeta = el('result-meta');
const $chevrons = el('chevron-list');
const $addressStrip = el('address-strip');
const $log = el('log');
const $banner = el('stage-banner');
const $roDest = el('ro-dest');
const $statGate = el('stat-gate');
const $statCount = el('stat-count');
const $statClock = el('stat-clock');
const $btnSpeed = el('btn-speed');
const $btnAudio = el('btn-audio');

const NUMBER_WORD = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];

/*
 * Dial timings.
 *
 * Each symbol on screen is: ring winds up and turns a long way → the symbol
 * arrives under the chevron that will lock it → that chevron latches → beat →
 * next symbol. Seven symbols, finishing with the Point of Origin at top.
 *
 * `spin` is an angular rate, not a duration — the ring turns at degPerSec and
 * a long sweep therefore takes longer than a short hop, which is what makes
 * it read as a motor rather than an animation. `minMs` floors the very
 * shortest moves so they still register.
 *
 * SHOW is paced off the series: a full revolution plus travel per symbol,
 * ~32s for a seven chevron dial. NORMAL keeps the same rhythm at roughly a
 * third of that. INSTANT skips to the wormhole for when you just want the
 * program open.
 */
const SPEEDS = {
  INSTANT: { spin: 0, turns: 0, light: 18, gap: 0, kawoosh: 260, hold: 550 },
  NORMAL: {
    spin: { degPerSec: 320, minMs: 320 },
    turns: 0,
    light: 220,
    gap: 100,
    kawoosh: 900,
    hold: 1100,
  },
  SHOW: {
    spin: { degPerSec: 160, minMs: 900 },
    turns: 1,
    light: 550,
    gap: 450,
    kawoosh: 1500,
    hold: 1800,
  },
};
const SPEED_ORDER = ['INSTANT', 'NORMAL', 'SHOW'];

const state = {
  apps: [],
  view: [],
  sel: 0,
  dialing: false,
  address: null,
  speed: SPEEDS[localStorage.getItem('sgc.speed')] ? localStorage.getItem('sgc.speed') : 'NORMAL',
  audio: localStorage.getItem('sgc.audio') !== 'off',
  irisClosed: localStorage.getItem('sgc.iris') === 'closed',
  manage: false,
  hotkey: null,
  capturingHotkey: false,
};

const gate = new Gate(el('gate'));
const sfx = new GateAudio();
sfx.setEnabled(state.audio);

/* ================================================================== *
 * transport
 * ================================================================== */

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { 'X-Gate-Token': TOKEN, 'Content-Type': 'application/json', ...(options || {}).headers },
  });
  if (!res.ok) {
    let msg = res.status + '';
    try {
      msg = (await res.json()).error || msg;
    } catch (_) {
      /* non-JSON error */
    }
    throw new Error(msg);
  }
  return res.json();
}

/*
 * The gate runs two ways: as a desktop app, where the preload bridge talks
 * straight to the main process, and as `node server.js` in a browser, where
 * it talks over localhost. Everything above this line is identical either
 * way — only the transport differs.
 */
const HOST = window.gateHost || null;

const backend = {
  isDesktop: !!HOST,
  getCatalog: () => (HOST ? HOST.getCatalog() : api('/api/catalog')),
  rescan: () => (HOST ? HOST.rescan() : api('/api/rescan', { method: 'POST' })),
  launch: (id) =>
    HOST
      ? HOST.launch(id)
      : api('/api/launch', { method: 'POST', body: JSON.stringify({ id, minimize: false }) }),
  minimize: () => (HOST ? HOST.minimize() : api('/api/minimize', { method: 'POST' })),
  quit: () => (HOST ? HOST.close() : api('/api/quit', { method: 'POST' })),

  // Desktop-only extras; browser mode simply doesn't offer them.
  hide: (id) => (HOST ? HOST.hide(id) : Promise.reject(new Error('desktop only'))),
  unhide: (id) => (HOST ? HOST.unhide(id) : Promise.reject(new Error('desktop only'))),
  getSettings: () => (HOST ? HOST.getSettings() : Promise.resolve({ hotkey: null })),
  setHotkey: (a) => (HOST ? HOST.setHotkey(a) : Promise.reject(new Error('desktop only'))),
  addCustom: (e) => (HOST ? HOST.addCustom(e) : Promise.reject(new Error('desktop only'))),
  removeCustom: (id) => (HOST ? HOST.removeCustom(id) : Promise.reject(new Error('desktop only'))),
  pickTarget: () => (HOST ? HOST.pickTarget() : Promise.resolve(null)),
};

/*
 * Electron wraps anything thrown inside ipcMain.handle as
 * "Error invoking remote method 'x': Error: <real message>". That plumbing
 * detail has no business on the console, so strip it back to the message.
 */
function cleanError(err) {
  let raw = (err && err.message) || String(err);
  const marker = "Error invoking remote method";
  if (raw.indexOf(marker) === 0) {
    const i = raw.indexOf("': ");
    if (i >= 0) raw = raw.slice(i + 3);
    if (raw.indexOf("Error: ") === 0) raw = raw.slice(7);
  }
  return raw.trim();
}

/* ================================================================== *
 * logging
 * ================================================================== */

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(text, cls) {
  const row = document.createElement('div');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = stamp() + '  ';
  const b = document.createElement('span');
  if (cls) b.className = cls;
  b.textContent = text;
  row.append(t, b);
  $log.prepend(row);
  while ($log.childElementCount > 60) $log.lastElementChild.remove();
}

function banner(text, cls) {
  $banner.textContent = text;
  $banner.className = 'stage-banner show' + (cls ? ' ' + cls : '');
}
function clearBanner() {
  $banner.className = 'stage-banner';
}

function setGateStatus(text, cls) {
  $statGate.textContent = text;
  $statGate.className = cls || '';
}

/* ================================================================== *
 * chevron + address panels
 * ================================================================== */

function buildChevronList() {
  $chevrons.replaceChildren();
  for (let i = 1; i <= 9; i++) {
    const li = document.createElement('li');
    li.dataset.n = String(i);
    const mark = document.createElement('span');
    mark.className = 'mark';
    const label = document.createElement('span');
    label.textContent = 'CHEVRON ' + i;
    const st = document.createElement('span');
    st.className = 'state';
    st.textContent = i <= activeChevrons() ? 'STANDBY' : 'INACTIVE';
    li.append(mark, label, st);
    $chevrons.append(li);
  }
}

function setChevron(n, status, cls) {
  const li = $chevrons.querySelector(`li[data-n="${n}"]`);
  if (!li) return;
  li.className = cls || '';
  li.classList.add('active');
  li.querySelector('.state').textContent = status;
  setTimeout(() => li.classList.remove('active'), 500);
}

/**
 * How many chevrons the current destination needs. Seven for anything local,
 * nine for a remote machine — the two spare chevrons at the bottom of the ring
 * stay INACTIVE until something actually uses them.
 */
function activeChevrons() {
  return state.address ? state.address.length : 7;
}

function resetChevronList() {
  const active = activeChevrons();
  $chevrons.querySelectorAll('li').forEach((li) => {
    li.className = '';
    const n = Number(li.dataset.n);
    li.querySelector('.state').textContent = n <= active ? 'STANDBY' : 'INACTIVE';
  });
}

/**
 * Render an address as a row of glyph cells.
 *
 * Shared by the LAST DIALED ADDRESS panel and the manual-dial tray, so it takes
 * its container, and sizes its grid to however many symbols the address has
 * rather than assuming seven.
 */
function renderAddressStrip(address, opts) {
  const o = opts || {};
  const host = o.container || $addressStrip;
  const slots = o.slots || (address && address.length) || 7;
  host.replaceChildren();
  host.style.gridTemplateColumns = 'repeat(' + slots + ', 1fr)';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  (address || new Array(slots).fill(null)).forEach((g, i) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.i = String(i);
    if (g !== null && g !== undefined) {
      const c = document.createElement('canvas');
      const size = 34;
      c.width = size * dpr;
      c.height = size * dpr;
      const cx = c.getContext('2d');
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx.translate(size / 2, size / 2);
      drawGlyph(cx, g, size * 0.78, { color: '#00e676', lineWidth: 1.15 });
      cell.append(c);
      cell.title = GLYPH_NAMES[g];
    }
    host.append(cell);
  });
}

function lightAddressCell(i) {
  const cell = $addressStrip.querySelector(`.cell[data-i="${i}"]`);
  if (cell) cell.classList.add('on');
}

/* ================================================================== *
 * search
 * ================================================================== */

function fuzzyIndices(hay, needle) {
  const idx = [];
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] === needle[j]) {
      idx.push(i);
      j++;
    }
  }
  return j === needle.length ? idx : null;
}

function usageBoost(app) {
  if (!app.use) return 0;
  const days = (Date.now() - app.use.last) / 86400000;
  const recency = Math.max(0, 45 - days * 6);
  return Math.min(60, app.use.count * 7) + recency;
}

function wordStarts(name, q) {
  return new RegExp('\\b' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(name);
}

function scoreApp(app, q) {
  if (!q) return usageBoost(app);
  const name = app.name.toLowerCase();
  let s;

  if (app.key === q) s = 1000;
  else if (name.startsWith(q)) s = 900;
  else if (app.key.startsWith(q)) s = 880;
  else if (wordStarts(name, q)) s = 780;
  else {
    const p = name.indexOf(q);
    if (p >= 0) s = 620 - Math.min(p, 40) * 2;
    else {
      const idx = fuzzyIndices(name, q);
      if (!idx) return null;
      let gaps = 0;
      for (let i = 1; i < idx.length; i++) gaps += idx[i] - idx[i - 1] - 1;
      s = 380 - gaps * 6 - Math.min(idx[0], 30) * 2;
    }
  }
  return s - Math.min(24, name.length * 0.2) + usageBoost(app);
}

function highlightInto(node, name, q) {
  if (!q) {
    node.textContent = name;
    return;
  }
  const lower = name.toLowerCase();
  let hits = null;
  const p = lower.indexOf(q);
  if (p >= 0) {
    hits = [];
    for (let i = 0; i < q.length; i++) hits.push(p + i);
  } else {
    hits = fuzzyIndices(lower, q);
  }
  if (!hits) {
    node.textContent = name;
    return;
  }
  const set = new Set(hits);
  let buf = '';
  let inMark = false;
  const flush = () => {
    if (!buf) return;
    if (inMark) {
      const m = document.createElement('mark');
      m.textContent = buf;
      node.append(m);
    } else {
      node.append(document.createTextNode(buf));
    }
    buf = '';
  };
  for (let i = 0; i < name.length; i++) {
    const on = set.has(i);
    if (on !== inMark) {
      flush();
      inMark = on;
    }
    buf += name[i];
  }
  flush();
}

function runSearch() {
  const q = $search.value.trim().toLowerCase();
  const scored = [];
  for (const app of state.apps) {
    // Hidden entries stay out of the way except while managing the list.
    if (app.hidden && !state.manage) continue;
    const s = scoreApp(app, q);
    if (s === null) continue;
    scored.push({ app, s });
  }
  scored.sort((a, b) => b.s - a.s || a.app.name.localeCompare(b.app.name));
  state.view = scored.slice(0, 250).map((x) => x.app);
  state.sel = 0;
  renderResults(q);
  updateSelection();
}

function renderResults(q) {
  $results.replaceChildren();
  $results.classList.toggle('manage', state.manage);
  if (!state.view.length) {
    const d = document.createElement('div');
    d.className = 'results-empty';
    d.textContent = state.apps.length
      ? 'NO MATCHING ADDRESS IN THE REGISTRY.'
      : 'REGISTRY EMPTY — PRESS RESCAN.';
    $results.append(d);
    $resultMeta.textContent = '0 MATCHES';
    return;
  }
  const frag = document.createDocumentFragment();
  state.view.forEach((app, i) => {
    const li = document.createElement('li');
    li.dataset.i = String(i);
    li.setAttribute('role', 'option');

    const nm = document.createElement('span');
    nm.className = 'nm';
    highlightInto(nm, app.name, q);

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = app.use && app.use.count ? '×' + app.use.count : app.kind === 'appx' ? 'PKG' : '';

    if (app.hidden) li.classList.add('is-hidden');
    if (app.custom) li.classList.add('is-custom');

    // Real program icon where we have one; otherwise a small gate sigil, so
    // rows stay aligned instead of jumping when icons arrive.
    const ico = document.createElement('span');
    ico.className = 'row-icon';
    if (app.icon) {
      const img = document.createElement('img');
      img.src = app.icon;
      img.alt = '';
      ico.append(img);
    } else {
      ico.classList.add('fallback');
    }

    if (state.manage) {
      // The tick IS the hidden state: ticking hides, unticking restores.
      // Immediate and reversible, so it needs no confirmation step.
      const box = document.createElement('span');
      box.className = 'tickbox' + (app.hidden ? ' on' : '');
      box.textContent = app.hidden ? '✕' : '';
      li.append(box, ico, nm, tag);

      // A hand-added entry can be removed outright; hiding one would leave it
      // sitting in settings forever with no way back to it.
      if (app.custom) {
        const del = document.createElement('button');
        del.className = 'row-del';
        del.textContent = 'DELETE';
        del.title = 'Remove this custom destination';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          removeCustomEntry(app);
        });
        li.append(del);
      }
      li.addEventListener('click', () => toggleHidden(app));
    } else {
      li.append(ico, nm, tag);
      li.addEventListener('click', () => {
        state.sel = i;
        updateSelection();
        dialSelected(false);
      });
    }
    frag.append(li);
  });
  $results.append(frag);
  $resultMeta.textContent = state.manage
    ? 'MANAGING · TICK TO HIDE, UNTICK TO RESTORE · ' +
      state.apps.filter((x) => x.hidden).length +
      ' HIDDEN'
    : state.view.length + ' MATCH' + (state.view.length === 1 ? '' : 'ES') + ' · ' + state.apps.length + ' INDEXED';
}

async function toggleHidden(app) {
  if (!backend.isDesktop) return;
  try {
    const wasHidden = app.hidden;
    const data = wasHidden ? await backend.unhide(app.id) : await backend.hide(app.id);
    state.apps = data.apps;
    log((wasHidden ? 'RESTORED ' : 'HIDDEN ') + app.name.toUpperCase(), wasHidden ? 'ok' : 'lock');
    applyHiddenLabel();
    const keepScroll = $results.scrollTop;
    runSearch();
    $results.scrollTop = keepScroll; // ticking shouldn't jump the list around
  } catch (e) {
    log('REGISTRY ERROR — ' + e.message, 'err');
  }
}

/* ================================================================== *
 * custom destinations
 * ================================================================== */

function openAddForm() {
  if (!backend.isDesktop) return;
  el('add-name').value = '';
  el('add-target').value = '';
  el('add-args').value = '';
  el('add-err').textContent = '';
  el('add-overlay').hidden = false;
  el('add-name').focus();
}

function closeAddForm() {
  el('add-overlay').hidden = true;
  $search.focus();
}

function addFormOpen() {
  return !el('add-overlay').hidden;
}

async function browseForTarget() {
  try {
    const p = await backend.pickTarget();
    if (!p) return;
    el('add-target').value = p;
    // Offer the file's own name if nothing has been typed yet.
    if (!el('add-name').value.trim()) {
      const base = p.split(/[\\/]/).pop() || '';
      el('add-name').value = base.replace(/\.[^.]+$/, '');
    }
    el('add-name').focus();
  } catch (e) {
    el('add-err').textContent = cleanError(e);
  }
}

async function submitAddForm() {
  const entry = {
    name: el('add-name').value.trim(),
    target: el('add-target').value.trim(),
    args: el('add-args').value.trim(),
  };
  if (!entry.name) return (el('add-err').textContent = 'A DESIGNATION IS REQUIRED');
  if (!entry.target) return (el('add-err').textContent = 'A TARGET IS REQUIRED');

  try {
    const data = await backend.addCustom(entry);
    state.apps = data.apps;
    applyHiddenLabel();
    closeAddForm();
    $search.value = entry.name;
    runSearch();
    log('DESTINATION ADDED — ' + entry.name.toUpperCase(), 'ok');
  } catch (e) {
    el('add-err').textContent = cleanError(e).toUpperCase();
  }
}

async function removeCustomEntry(app) {
  try {
    const data = await backend.removeCustom(app.id);
    state.apps = data.apps;
    applyHiddenLabel();
    runSearch();
    log('DESTINATION REMOVED — ' + app.name.toUpperCase(), 'lock');
  } catch (e) {
    log('REGISTRY ERROR — ' + cleanError(e), 'err');
  }
}

function applyHiddenLabel() {
  const n = state.apps.filter((a) => a.hidden).length;
  const btn = el('btn-manage');
  if (!btn) return;
  btn.textContent = state.manage ? 'DONE' : n ? 'MANAGE · ' + n : 'MANAGE';
  btn.classList.toggle('on', state.manage);
  btn.style.display = backend.isDesktop ? '' : 'none';
  const add = el('btn-add');
  if (add) add.style.display = backend.isDesktop ? '' : 'none';
  document.body.classList.toggle('managing', state.manage);
}

function toggleManage() {
  if (!backend.isDesktop) return;
  state.manage = !state.manage;
  applyHiddenLabel();
  runSearch();
  log(state.manage ? 'REGISTRY MANAGEMENT — TICK ENTRIES TO HIDE' : 'REGISTRY MANAGEMENT CLOSED');
  $search.focus();
}

function updateSelection() {
  const items = $results.querySelectorAll('li');
  items.forEach((li, i) => li.classList.toggle('sel', i === state.sel));
  const cur = items[state.sel];
  if (cur) cur.scrollIntoView({ block: 'nearest' });

  const app = state.view[state.sel];
  const $caption = el('addr-caption');
  if (app) {
    state.address = addressForApp(app);
    gate.setSlotCount(state.address.length);
    renderAddressStrip(state.address);
    $roDest.textContent = app.name.toUpperCase();
    if ($caption) $caption.textContent = state.address.map((g) => GLYPH_NAMES[g]).join(' · ');
  } else {
    state.address = null;
    gate.setSlotCount(7);
    renderAddressStrip(null);
    $roDest.textContent = '— NO TARGET LOCKED —';
    if ($caption) $caption.textContent = 'NO TARGET LOCKED';
  }
}

/* ================================================================== *
 * the dial
 * ================================================================== */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/*
 * An established wormhole stays up for a while rather than snapping shut the
 * instant the program launches. The console is released as soon as transit
 * completes, so you can keep working — dialing again, or Esc, shuts it early.
 */
const WORMHOLE_SECONDS = 60;
let wormholeTimer = null;
let wormholeTick = null;

function clearWormholeTimers() {
  if (wormholeTimer) clearTimeout(wormholeTimer);
  if (wormholeTick) clearInterval(wormholeTick);
  wormholeTimer = null;
  wormholeTick = null;
}

function wormholeOpen() {
  return gate.horizon > 0.01;
}

function beginWormholeHold() {
  clearWormholeTimers();
  let left = WORMHOLE_SECONDS;
  setGateStatus('OPEN ' + left + 'S', 'open');
  wormholeTick = setInterval(() => {
    left -= 1;
    if (left > 0) setGateStatus('OPEN ' + left + 'S', 'open');
  }, 1000);
  wormholeTimer = setTimeout(() => shutWormhole(false), WORMHOLE_SECONDS * 1000);
}

async function shutWormhole(manual) {
  clearWormholeTimers();
  if (!wormholeOpen()) return;
  sfx.stopHum();
  await gate.closeWormhole(520);
  log('WORMHOLE DISENGAGED' + (manual ? ' — MANUAL SHUTDOWN' : ' — 38 MINUTE LIMIT'), 'ok');
  gate.reset();
  resetChevronList();
  renderAddressStrip(state.address);
  setGateStatus('IDLE', '');
  clearBanner();
}

/**
 * The address for a destination: a user-set override when there is one,
 * otherwise derived from the name so it stays the same forever.
 *
 * Remote machines get eight constellations and a nine-chevron dial; everything
 * local gets six and seven chevrons.
 */
function addressForApp(app) {
  if (Array.isArray(app.address) && app.address.length) return app.address;
  return addressFor(app.key + '|' + app.name, app.kind === 'remote' ? 8 : 6);
}

async function dialSelected(forceFull) {
  if (state.dialing || state.manage) return;
  const app = state.view[state.sel];
  if (!app) {
    sfx.error();
    log('NO DESTINATION SELECTED', 'err');
    return;
  }
  return dialAddress(app, state.address || addressForApp(app), forceFull);
}

/**
 * Dial `address` and launch `app` at the kawoosh.
 *
 * The chevron count comes from the address rather than a constant: seven for a
 * local destination, nine for a remote one. Every symbol but the last is a
 * constellation, and the last is always the point of origin.
 */
async function dialAddress(app, address, forceFull) {
  if (state.dialing || state.manage) return;
  const speed = SPEEDS[forceFull ? 'SHOW' : state.speed] || SPEEDS.NORMAL;

  clearWormholeTimers();
  state.dialing = true;
  document.body.classList.add('dialing');
  gate.setSlotCount(address.length);
  gate.reset();
  resetChevronList();
  renderAddressStrip(address);
  setGateStatus('DIALING', 'hot');

  log('DIALING SEQUENCE INITIATED → ' + app.name.toUpperCase(), 'hi');
  banner('ENCODING DESTINATION…');

  try {
    for (let i = 0; i < address.length; i++) {
      if (!state.dialing) break; // aborted
      const glyph = address[i];
      const chevron = i + 1;
      const final = i === address.length - 1;

      if (speed.spin) banner('INNER TRACK — ' + GLYPH_NAMES[glyph]);

      // Every symbol is brought to top dead center. The spin sound is started
      // from inside, once the real duration is known.
      await gate.spinTo(
        glyph,
        i % 2 === 0 ? 1 : -1,
        speed.spin,
        speed.turns,
        (ms) => ms > 0 && sfx.startSpin(ms / 1000)
      );
      if (!state.dialing) break;

      // The top chevron grabs the symbol while the numbered chevron latches;
      // running them together keeps the grab visible without adding a beat.
      sfx.chevronLock(final);
      const grabbing = final ? Promise.resolve() : gate.flashTop(speed.light);
      await gate.lockChevron(chevron, glyph, speed.light);
      await grabbing;
      sfx.chevronLight();
      await gate.showCenterGlyph(glyph, Math.max(120, speed.light));

      if (final) {
        setChevron(chevron, 'LOCKED', 'locked');
        banner('CHEVRON ' + NUMBER_WORD[chevron] + ' — LOCKED', 'lock');
        log('CHEVRON ' + NUMBER_WORD[chevron] + ' LOCKED · ' + GLYPH_NAMES[glyph], 'lock');
      } else {
        setChevron(chevron, 'ENCODED', 'encoded');
        banner('CHEVRON ' + NUMBER_WORD[chevron] + ' — ENCODED', 'lock');
        log('CHEVRON ' + NUMBER_WORD[chevron] + ' ENCODED · ' + GLYPH_NAMES[glyph]);
      }
      lightAddressCell(i);
      if (speed.gap) await sleep(speed.gap);
      // Shrink it into its destination box. Deliberately not awaited: it
      // flies while the ring is already turning for the next symbol.
      gate.stowCenterGlyph(i, speed.spin ? 420 : 120);
    }

    if (!state.dialing) return; // aborted mid-sequence

    // Wormhole. Fire the launch at the moment of the kawoosh so the program
    // is already coming up while the event horizon settles.
    setGateStatus('OPEN', 'open');
    banner('WORMHOLE ESTABLISHED', 'open');
    log('UNSTABLE VORTEX — EVENT HORIZON FORMING', 'ok');
    sfx.kawoosh(speed.kawoosh);
    gate.hideCenterGlyph(200);

    // The iris sits in front of the event horizon. Dialing still completes;
    // nothing is allowed through.
    const blocked = state.irisClosed;
    // Capture the failure rather than letting it reject unhandled — the
    // promise is created here but not awaited until the kawoosh finishes.
    let launchError = null;
    const launching = blocked
      ? Promise.resolve(null)
      : Promise.resolve(backend.launch(app.id)).catch((e) => {
          launchError = e;
          return null;
        });

    await gate.openWormhole(speed.kawoosh);
    sfx.startHum();

    await launching;

    if (blocked) {
      log('IRIS CLOSED — TRANSIT BLOCKED', 'err');
      banner('IRIS CLOSED · TRANSIT BLOCKED', 'err');
      sfx.error();
    } else if (launchError) {
      // The program did not start. Collapse the gate rather than sitting
      // there claiming an established wormhole for a minute.
      log('WORMHOLE COULD NOT BE ESTABLISHED — ' + cleanError(launchError), 'err');
      banner('WORMHOLE COULD NOT BE ESTABLISHED', 'err');
      setGateStatus('FAILED', 'hot');
      sfx.error();
      sfx.stopHum();
      await gate.failSequence(700);
      await gate.closeWormhole(420);
      state.dialing = false;
      document.body.classList.remove('dialing');
      gate.reset();
      resetChevronList();
      renderAddressStrip(state.address);
      setGateStatus('IDLE', '');
      await sleep(1400);
      clearBanner();
      $search.focus();
      return;
    } else {
      log('TRANSIT COMPLETE → ' + app.name.toUpperCase(), 'ok');
      banner('TRANSIT COMPLETE · ' + app.name.toUpperCase(), 'open');

      // Reflect the new usage count without a full rescan.
      app.use = app.use || { count: 0, last: 0 };
      app.use.count += 1;
      app.use.last = Date.now();
    }

    // Release the console straight away and leave the gate open.
    await sleep(speed.hold);
    state.dialing = false;
    document.body.classList.remove('dialing');
    $search.focus();
    beginWormholeHold();
    return;
  } catch (err) {
    sfx.stopSpin();
    sfx.stopHum();
    log('DIALING FAILURE — ' + cleanError(err), 'err');
    banner('DIALING FAILURE', 'err');
    sfx.error();
    await gate.failSequence(700);
    await sleep(500);
  } finally {
    // Only reached on failure or abort; the success path returns above with
    // the wormhole still open.
    if (state.dialing) {
      state.dialing = false;
      document.body.classList.remove('dialing');
      gate.reset();
      resetChevronList();
      renderAddressStrip(state.address);
      setGateStatus('IDLE', '');
      clearBanner();
      $search.focus();
    }
  }
}

function abortDial() {
  clearWormholeTimers();
  if (!state.dialing) return false;
  state.dialing = false;
  gate.abort();
  sfx.stopSpin();
  sfx.stopHum();
  sfx.error();
  log('DIALING SEQUENCE ABORTED', 'err');
  banner('SEQUENCE ABORTED', 'err');
  setTimeout(() => {
    gate.reset();
    resetChevronList();
    document.body.classList.remove('dialing');
    setGateStatus('IDLE', '');
    clearBanner();
  }, 650);
  return true;
}

/* ================================================================== *
 * catalog
 * ================================================================== */

async function loadCatalog(rescan) {
  $resultMeta.textContent = rescan ? 'RESCANNING GATE NETWORK…' : 'LOADING REGISTRY…';
  log(rescan ? 'RESCANNING LOCAL GATE NETWORK…' : 'LOADING DESTINATION REGISTRY…');
  try {
    const data = rescan ? await backend.rescan() : await backend.getCatalog();
    state.apps = data.apps;
    applyHiddenLabel();
    $statCount.textContent = String(data.apps.filter((a) => !a.hidden).length).padStart(4, '0');
    log(data.apps.length + ' ADDRESSES INDEXED', 'hi');
    runSearch();
  } catch (e) {
    log('REGISTRY ERROR — ' + cleanError(e), 'err');
    $resultMeta.textContent = 'REGISTRY ERROR';
  }
}

/* ================================================================== *
 * chrome
 * ================================================================== */

function applySpeedLabel() {
  $btnSpeed.textContent = 'SPEED: ' + state.speed;
}
function cycleSpeed() {
  const i = SPEED_ORDER.indexOf(state.speed);
  state.speed = SPEED_ORDER[(i + 1) % SPEED_ORDER.length];
  localStorage.setItem('sgc.speed', state.speed);
  applySpeedLabel();
  log('DIAL RATE SET TO ' + state.speed);
}

/* ================================================================== *
 * global hotkey
 * ================================================================== */

// Electron accelerators use these names; a KeyboardEvent gives us something
// close but not identical, so map the awkward ones explicitly.
const KEY_ALIAS = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Enter: 'Return',
};

function eventToAccelerator(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (!mods.length) return null; // a bare key would swallow it system-wide

  let key = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null; // modifier alone
  if (KEY_ALIAS[key]) key = KEY_ALIAS[key];
  else if (key.length === 1) key = key.toUpperCase();
  else if (!/^Fd{1,2}$/.test(key)) key = key.charAt(0).toUpperCase() + key.slice(1);

  return mods.concat(key).join('+');
}

function applyHotkeyLabel() {
  const btn = el('btn-hotkey');
  if (!btn) return;
  btn.style.display = backend.isDesktop ? '' : 'none';
  if (state.capturingHotkey) {
    btn.textContent = 'PRESS KEYS…';
    btn.classList.add('capturing');
  } else {
    btn.textContent = 'HOTKEY: ' + (state.hotkey ? state.hotkey.toUpperCase() : 'NONE');
    btn.classList.remove('capturing');
  }
}

function beginHotkeyCapture() {
  if (!backend.isDesktop) return;
  state.capturingHotkey = true;
  applyHotkeyLabel();
  log('AWAITING KEY COMBINATION — ESC TO CANCEL');
}

async function finishHotkeyCapture(accelerator) {
  state.capturingHotkey = false;
  if (accelerator) {
    try {
      const res = await backend.setHotkey(accelerator);
      if (res && res.ok) {
        state.hotkey = res.hotkey;
        log('SUMMON HOTKEY SET — ' + String(res.hotkey).toUpperCase(), 'ok');
      } else {
        log('HOTKEY REJECTED — ' + ((res && res.error) || 'unavailable'), 'err');
      }
    } catch (e) {
      log('HOTKEY ERROR — ' + e.message, 'err');
    }
  } else {
    log('HOTKEY UNCHANGED');
  }
  applyHotkeyLabel();
}

function applyIrisLabel() {
    const closed = state.irisClosed;
    el('btn-iris').textContent = 'IRIS: ' + (closed ? 'CLOSED' : 'OPEN');
    el('btn-iris').classList.toggle('engaged', closed);
    el('ro-iris').textContent = closed ? 'CLOSED' : 'OPEN';
    const bar = document.querySelector('.bar i');
    if (bar) bar.style.setProperty('--f', closed ? '100%' : '0%');
}

function toggleIris() {
  state.irisClosed = !state.irisClosed;
  localStorage.setItem('sgc.iris', state.irisClosed ? 'closed' : 'open');
  applyIrisLabel();
  gate.setIris(state.irisClosed, 620);
  sfx.chevronLock(false);
  log(state.irisClosed ? 'IRIS CLOSED — GATE SEALED' : 'IRIS OPEN', state.irisClosed ? 'lock' : 'ok');
}

function applyAudioLabel() {
  $btnAudio.textContent = 'AUDIO: ' + (state.audio ? 'ON' : 'OFF');
}
function toggleAudio() {
  state.audio = !state.audio;
  localStorage.setItem('sgc.audio', state.audio ? 'on' : 'off');
  sfx.setEnabled(state.audio);
  applyAudioLabel();
  if (state.audio) sfx.blip(900);
}

/*
 * Keep the banner on the gate's axis rather than the stage's. The gate is
 * offset left to make room for the destination boxes, so a banner centered on
 * the panel reads as slightly misaligned with the thing it describes.
 */
function syncGateAxis() {
  document.documentElement.style.setProperty('--gate-offset', (gate.centerOffset || 0) + 'px');
}
gate.onLayout = syncGateAxis;

function initBars() {
  document.querySelectorAll('.bar i').forEach((i) => {
    i.style.setProperty('--f', Math.round(parseFloat(i.dataset.fill || '0') * 100) + '%');
  });
}

/*
 * The reference display is dense with telemetry that isn't really telling you
 * anything — code strips, subset tables, drifting hex. It's what makes it read
 * as an instrument rather than a web page, so it's reproduced here, clearly
 * marked decorative and kept out of the accessibility tree.
 */
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRTUVXZ';
function code(len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += Math.random() < 0.55
      ? CODE_ALPHA[(Math.random() * CODE_ALPHA.length) | 0]
      : String((Math.random() * 10) | 0);
  }
  return s;
}
function num(int, dec) {
  const a = String((Math.random() * Math.pow(10, int)) | 0).padStart(int, '0');
  return dec ? a + '.' + String((Math.random() * Math.pow(10, dec)) | 0).padStart(dec, '0') : a;
}

function initDecor() {
  const strip = el('code-strip');
  if (strip) {
    strip.replaceChildren();
    for (let i = 0; i < 17; i++) {
      const s = document.createElement('span');
      s.textContent = code(3);
      strip.append(s);
    }
  }

  const grid = el('dt-grid');
  if (grid) {
    grid.replaceChildren();
    for (let c = 0; c < 8; c++) {
      const col = document.createElement('div');
      col.className = 'dt-col';
      const h = document.createElement('h3');
      h.textContent = 'SUBSET ' + code(2);
      col.append(h);
      for (let r = 0; r < 5; r++) {
        const d = document.createElement('div');
        d.textContent = num(3, 2);
        col.append(d);
      }
      grid.append(col);
    }
  }

  el('tab-code').textContent = 'MCK.' + num(9);
  el('macro-code').textContent = '00.' + num(7) + code(1) + num(3);
}

/** Nudge a few values so the instrument looks alive, without churning it. */
function driftDecor() {
  const cells = document.querySelectorAll('.dt-col div');
  for (let i = 0; i < 3 && cells.length; i++) {
    cells[(Math.random() * cells.length) | 0].textContent = num(3, 2);
  }
  const codes = document.querySelectorAll('.code-strip span');
  if (codes.length) codes[(Math.random() * codes.length) | 0].textContent = code(3);

  el('rd-init').textContent = '00.' + num(4);
  el('rd-freq').textContent = (60 + Math.random() * 9).toFixed(2) + ' KHZ';
  el('rd-phase').textContent = (0.4 + Math.random() * 0.3).toFixed(4);
}

function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $statClock.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ================================================================== *
 * input
 * ================================================================== */

$search.addEventListener('input', () => {
  if (state.dialing) return;
  sfx.blip(1250);
  runSearch();
});

document.addEventListener('keydown', (e) => {
  // First real keypress unlocks the audio context.
  sfx.ensure();

  // The add form owns the keyboard while it is open; Esc closes it and
  // Enter is handled by the form's own submit.
  if (addFormOpen()) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAddForm();
    }
    return;
  }

  // While capturing, every key belongs to the hotkey picker.
  if (state.capturingHotkey) {
    e.preventDefault();
    if (e.key === 'Escape') return finishHotkeyCapture(null);
    const acc = eventToAccelerator(e);
    if (acc) finishHotkeyCapture(acc);
    return;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    if (abortDial()) return;
    if (wormholeOpen()) {
      shutWormhole(true);
      return;
    }
    if ($search.value) {
      $search.value = '';
      runSearch();
      return;
    }
    Promise.resolve(backend.minimize()).catch(() => {});
    return;
  }

  if (e.key === 'F5') {
    e.preventDefault();
    if (!state.dialing) loadCatalog(true);
    return;
  }

  if (state.dialing) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (state.view.length) {
      state.sel = (state.sel + 1) % state.view.length;
      updateSelection();
      sfx.blip(720);
    }
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (state.view.length) {
      state.sel = (state.sel - 1 + state.view.length) % state.view.length;
      updateSelection();
      sfx.blip(720);
    }
    return;
  }
  if (e.key === 'PageDown' || e.key === 'PageUp') {
    e.preventDefault();
    if (state.view.length) {
      const d = e.key === 'PageDown' ? 8 : -8;
      state.sel = Math.min(state.view.length - 1, Math.max(0, state.sel + d));
      updateSelection();
    }
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    dialSelected(e.shiftKey);
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    cycleSpeed();
    return;
  }
  if ((e.key === 'm' || e.key === 'M') && (e.ctrlKey || e.altKey || document.activeElement !== $search)) {
    e.preventDefault();
    toggleAudio();
    return;
  }
  if ((e.key === 'i' || e.key === 'I') && (e.ctrlKey || e.altKey || document.activeElement !== $search)) {
    e.preventDefault();
    toggleIris();
    return;
  }

  // Anything else printable belongs in the search box.
  if (document.activeElement !== $search && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
    $search.focus();
  }
});

el('btn-hotkey').addEventListener('click', beginHotkeyCapture);
el('btn-manage').addEventListener('click', toggleManage);
el('btn-add').addEventListener('click', openAddForm);
el('add-cancel').addEventListener('click', closeAddForm);
el('add-browse').addEventListener('click', browseForTarget);
el('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitAddForm();
});
el('add-overlay').addEventListener('mousedown', (e) => {
  if (e.target === el('add-overlay')) closeAddForm();
});
el('btn-iris').addEventListener('click', toggleIris);
el('btn-speed').addEventListener('click', cycleSpeed);
el('btn-audio').addEventListener('click', toggleAudio);
el('btn-rescan').addEventListener('click', () => !state.dialing && loadCatalog(true));
el('btn-quit').addEventListener('click', () => {
  log('DIALING COMPUTER OFFLINE', 'err');
  Promise.resolve(backend.quit()).catch(() => {});
  if (!backend.isDesktop) setTimeout(() => window.close(), 250);
});
document.addEventListener('click', () => sfx.ensure());
window.addEventListener('blur', () => sfx.stopHum());

if (backend.isDesktop) {
  document.body.classList.add('desktop');
  el('win-min').addEventListener('click', () => HOST.minimize());
  el('win-max').addEventListener('click', () => HOST.toggleMaximize());
  el('win-close').addEventListener('click', () => HOST.close());
}

/* ================================================================== *
 * boot
 * ================================================================== */

buildChevronList();
renderAddressStrip(null);
initBars();
initDecor();
syncGateAxis();
applySpeedLabel();
applyAudioLabel();
applyIrisLabel();
applyHotkeyLabel();

if (backend.isDesktop) {
  HOST.getSettings()
    .then((s) => {
      state.hotkey = s.hotkey;
      applyHotkeyLabel();
      if (s.requestedHotkey && !s.hotkey) {
        log('HOTKEY ' + String(s.requestedHotkey).toUpperCase() + ' UNAVAILABLE', 'err');
      }
    })
    .catch(() => {});
  if (HOST.onSummon) {
    HOST.onSummon(() => {
      $search.focus();
      $search.select();
    });
  }
  if (HOST.onCatalogUpdated) {
    HOST.onCatalogUpdated((data) => {
      // Icons finished extracting in the background. Keep the selection and
      // scroll position — this can land while you are already typing.
      const keepSel = state.view[state.sel] ? state.view[state.sel].key : null;
      const keepScroll = $results.scrollTop;
      state.apps = data.apps;
      applyHiddenLabel();
      runSearch();
      if (keepSel) {
        const i = state.view.findIndex((x) => x.key === keepSel);
        if (i >= 0) {
          state.sel = i;
          updateSelection();
        }
      }
      $results.scrollTop = keepScroll;
      log('PROGRAM ICONS LOADED');
    });
  }
}
gate.setIris(state.irisClosed, 0);
tickClock();
setInterval(tickClock, 1000);
setInterval(driftDecor, 1400);
setGateStatus('IDLE', '');

log('SGC DIALING COMPUTER ONLINE');
log('GATE DIAGNOSTIC — ALL SYSTEMS NOMINAL');

loadCatalog(false).then(() => $search.focus());
