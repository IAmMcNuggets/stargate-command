'use strict';
/*
 * The 39 Milky Way glyphs.
 *
 * Glyph 0 is the Point of Origin (Giza). Glyphs 1-38 are the constellation
 * glyphs, drawn procedurally: a sweeping "cartouche" arc, a handful of stars
 * along it, and a connecting figure — the same visual grammar the real props
 * use. Generation is seeded per index, so glyph 17 is always glyph 17.
 */

const GLYPH_COUNT = 39;

const GLYPH_NAMES = [
  'POINT OF ORIGIN',
  'CRATER',
  'VIRGO',
  'BOOTES',
  'CENTAURUS',
  'LIBRA',
  'SERPENS CAPUT',
  'NORMA',
  'SCORPIUS',
  'CORONA AUSTRALIS',
  'SCUTUM',
  'SAGITTARIUS',
  'AQUILA',
  'MICROSCOPIUM',
  'CAPRICORNUS',
  'PISCIS AUSTRINUS',
  'EQUULEUS',
  'AQUARIUS',
  'PEGASUS',
  'SCULPTOR',
  'PISCES',
  'ANDROMEDA',
  'TRIANGULUM',
  'ARIES',
  'PERSEUS',
  'CETUS',
  'TAURUS',
  'AURIGA',
  'ERIDANUS',
  'ORION',
  'CANIS MINOR',
  'MONOCEROS',
  'GEMINI',
  'HYDRA',
  'LYNX',
  'CANCER',
  'SEXTANS',
  'LEO MINOR',
  'LEO',
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quadAt(p0, c, p1, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

// Build a glyph description in a box spanning roughly -0.5..0.5 on both axes.
function buildGlyph(index) {
  if (index === 0) {
    // Point of Origin: pyramid beneath a sun disc.
    return {
      arcs: [],
      lines: [
        [
          { x: -0.34, y: 0.3 },
          { x: 0, y: -0.16 },
          { x: 0.34, y: 0.3 },
          { x: -0.34, y: 0.3 },
        ],
        [
          { x: -0.17, y: 0.3 },
          { x: 0, y: 0.06 },
          { x: 0.17, y: 0.3 },
        ],
        [
          { x: -0.42, y: 0.4 },
          { x: 0.42, y: 0.4 },
        ],
      ],
      dots: [{ x: 0, y: -0.34, r: 0.1, filled: false }],
      pips: [{ x: 0, y: -0.34, r: 0.038, filled: true }],
    };
  }

  const rnd = mulberry32(Math.imul(index + 7, 2654435761));
  const flip = rnd() < 0.5 ? 1 : -1;

  // Primary sweep — the long curve every glyph is hung from.
  const p0 = { x: -0.42 + rnd() * 0.1, y: (-0.1 + rnd() * 0.45) * flip };
  const p1 = { x: 0.42 - rnd() * 0.1, y: (-0.1 + rnd() * 0.45) * -flip };
  const ctrl = { x: (rnd() - 0.5) * 0.5, y: (-0.55 + rnd() * 0.35) * flip };

  const arcs = [{ p0, ctrl, p1 }];

  // Some glyphs get a second, shorter counter-arc.
  if (rnd() < 0.55) {
    const s = 0.55 + rnd() * 0.3;
    arcs.push({
      p0: { x: p0.x * s + 0.08, y: -p0.y * s },
      ctrl: { x: -ctrl.x * 0.7, y: -ctrl.y * 0.55 },
      p1: { x: p1.x * s - 0.08, y: -p1.y * s },
    });
  }

  // Stars sit along the primary sweep, jittered off it.
  const starCount = 3 + Math.floor(rnd() * 3);
  const dots = [];
  for (let i = 0; i < starCount; i++) {
    const t = (i + 0.5 + (rnd() - 0.5) * 0.5) / starCount;
    const pt = quadAt(p0, ctrl, p1, Math.min(0.96, Math.max(0.04, t)));
    dots.push({
      x: pt.x + (rnd() - 0.5) * 0.16,
      y: pt.y + (rnd() - 0.5) * 0.3,
      r: 0.028 + rnd() * 0.022,
      filled: rnd() < 0.6,
    });
  }

  // Connecting figure between the stars.
  const lines = [];
  const order = dots.map((d, i) => i);
  if (rnd() < 0.5) order.reverse();
  const spine = order.map((i) => ({ x: dots[i].x, y: dots[i].y }));
  if (spine.length >= 2) lines.push(spine);

  // A branch or a closing edge to break the zig-zag monotony.
  if (dots.length >= 3 && rnd() < 0.7) {
    const a = dots[Math.floor(rnd() * dots.length)];
    const b = dots[Math.floor(rnd() * dots.length)];
    if (a !== b) {
      lines.push([
        { x: a.x, y: a.y },
        { x: b.x, y: b.y },
      ]);
    }
  }

  // A tail dropping off the sweep, seen on many of the props.
  if (rnd() < 0.45) {
    const pt = quadAt(p0, ctrl, p1, 0.2 + rnd() * 0.6);
    lines.push([
      { x: pt.x, y: pt.y },
      { x: pt.x + (rnd() - 0.5) * 0.2, y: pt.y + (0.16 + rnd() * 0.2) * flip },
    ]);
  }

  return { arcs, lines, dots, pips: [] };
}

const GLYPH_CACHE = [];
function getGlyph(index) {
  const i = ((index % GLYPH_COUNT) + GLYPH_COUNT) % GLYPH_COUNT;
  if (!GLYPH_CACHE[i]) GLYPH_CACHE[i] = buildGlyph(i);
  return GLYPH_CACHE[i];
}

/** Traced artwork, if tools/trace-glyphs.js has been run. Filled even-odd. */
function drawTracedGlyph(ctx, g, size, opts) {
  const o = opts || {};
  const color = o.color || '#ffa53a';
  ctx.save();
  ctx.scale(size, size);
  ctx.fillStyle = color;
  if (o.glow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = o.glow / size;
  }
  ctx.beginPath();
  for (const contour of g.c) {
    if (!contour.length) continue;
    ctx.moveTo(contour[0][0], contour[0][1]);
    for (let i = 1; i < contour.length; i++) ctx.lineTo(contour[i][0], contour[i][1]);
    ctx.closePath();
  }
  ctx.fill('evenodd');
  ctx.restore();
}

/** True once the real glyph artwork has been traced in. */
function hasTracedGlyphs() {
  return typeof GLYPH_PATHS !== 'undefined' && GLYPH_PATHS && GLYPH_PATHS.length >= GLYPH_COUNT;
}

/**
 * Draw a glyph centred on the current origin.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} index    0-38
 * @param {number} size     bounding box edge in px
 * @param {object} opts     { color, lineWidth, glow }
 */
function drawGlyph(ctx, index, size, opts) {
  if (hasTracedGlyphs()) {
    const traced = GLYPH_PATHS[((index % GLYPH_COUNT) + GLYPH_COUNT) % GLYPH_COUNT];
    if (traced && traced.c && traced.c.length) return drawTracedGlyph(ctx, traced, size, opts);
  }

  const g = getGlyph(index);
  const o = opts || {};
  const color = o.color || '#ffa53a';
  const lw = o.lineWidth || Math.max(1, size * 0.045);

  ctx.save();
  ctx.scale(size, size);
  ctx.lineWidth = lw / size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  if (o.glow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = o.glow / size;
  }

  for (const a of g.arcs) {
    ctx.beginPath();
    ctx.moveTo(a.p0.x, a.p0.y);
    ctx.quadraticCurveTo(a.ctrl.x, a.ctrl.y, a.p1.x, a.p1.y);
    ctx.stroke();
  }

  for (const poly of g.lines) {
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.stroke();
  }

  for (const d of g.dots) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    if (d.filled) ctx.fill();
    else ctx.stroke();
  }

  for (const p of g.pips || []) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Deterministic gate address for a destination.
 * Six constellation glyphs plus the Point of Origin, exactly like a real dial.
 */
function addressFor(seedString) {
  let h = 2166136261 >>> 0;
  const s = String(seedString);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const rnd = mulberry32(h);
  const pool = [];
  for (let i = 1; i < GLYPH_COUNT; i++) pool.push(i);
  const address = [];
  for (let i = 0; i < 6; i++) {
    const pick = Math.floor(rnd() * pool.length);
    address.push(pool.splice(pick, 1)[0]);
  }
  address.push(0); // point of origin always closes the sequence
  return address;
}
