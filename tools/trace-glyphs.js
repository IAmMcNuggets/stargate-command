#!/usr/bin/env node
'use strict';
/*
 * Convert a glyph contact sheet into exact vector paths.
 *
 *   node tools/trace-glyphs.js assets/glyphs.png
 *   node tools/trace-glyphs.js assets/glyphs.png --region 240,195,750,810
 *   node tools/trace-glyphs.js assets/glyphs.png --cols 6 --rows 7 --preview
 *
 * How it works:
 *   1. decode the PNG (tools/png.js, zlib only)
 *   2. threshold to a binary ink mask
 *   3. find the grid by projection profile — glyph bands are tall, the
 *      filename captions under them are short, so they separate cleanly
 *   4. trace every cell along real pixel edges, which yields outer contours
 *      and holes together (rendered even-odd, so rings stay hollow)
 *   5. simplify with Douglas-Peucker and normalize into a unit box
 *
 * Writes public/glyph-paths.js, and with --preview an SVG contact sheet of
 * the traced result so it can be checked against the original by eye.
 */

const fs = require('fs');
const path = require('path');
const { decodePNG } = require('./png');

/* ------------------------------------------------------------------ args */

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  if (hit) return hit.slice(name.length + 3);
  const idx = argv.indexOf('--' + name);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return dflt;
};
const has = (name) => argv.includes('--' + name);

if (!file) {
  console.error('usage: node tools/trace-glyphs.js <sheet.png> [--region x,y,w,h]');
  console.error('                                  [--cols 6] [--rows 7]');
  console.error('                                  [--threshold 128] [--invert] [--preview]');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const THRESHOLD = Number(flag('threshold', 128));
const INVERT = has('invert');
const WANT_COLS = Number(flag('cols', 0)) || 0;
const WANT_ROWS = Number(flag('rows', 0)) || 0;
const EPSILON = Number(flag('epsilon', 0.75));
// JPEG sources ring around hard edges, leaving specks that survive
// thresholding. Drop any loop enclosing less than this many pixels.
const MIN_AREA = Number(flag('minarea', 6));
const MIN_BAND = Number(flag('minband', 14)); // ignore caption bands shorter than this

const GLYPH_NAMES_OUT = [];
for (let i = 1; i <= 39; i++) GLYPH_NAMES_OUT.push('glyph' + String(i).padStart(4, '0'));
GLYPH_NAMES_OUT.push('P7J-989', 'abydos', 'antarctica');

/* ------------------------------------------------------------------ load */

const img = decodePNG(path.resolve(file));
console.log(`sheet: ${file}  ${img.width}x${img.height}`);

let region = { x: 0, y: 0, w: img.width, h: img.height };
const regionArg = flag('region', null);
if (regionArg) {
  const [x, y, w, h] = regionArg.split(',').map(Number);
  region = { x, y, w, h };
  console.log(`region: ${x},${y} ${w}x${h}`);
}

/*
 * Optional radial mask, in source-image coordinates. A contact sheet that
 * also draws the assembled ring has the ring sitting in an annulus around
 * the grid; a radius histogram shows a clean gap between the two, and
 * clearing everything outside it drops the ring without touching the grid.
 */
let circle = null;
const circleArg = flag('circle', null);
if (circleArg) {
  const [ccx, ccy, cr] = circleArg.split(',').map(Number);
  circle = { cx: ccx, cy: ccy, r: cr };
  console.log(`mask: keeping ink within ${cr}px of (${ccx},${ccy})`);
}

// Binary ink mask over the region.
const RW = region.w;
const RH = region.h;
const ink = new Uint8Array(RW * RH);
let masked = 0;
for (let y = 0; y < RH; y++) {
  for (let x = 0; x < RW; x++) {
    const sx = region.x + x;
    const sy = region.y + y;
    if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
    if (circle && Math.hypot(sx - circle.cx, sy - circle.cy) > circle.r) {
      masked++;
      continue;
    }
    const o = (sy * img.width + sx) * 4;
    const a = img.data[o + 3];
    const lum = 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2];
    let on = a > 32 && lum >= THRESHOLD;
    if (INVERT) on = a > 32 && lum < THRESHOLD;
    ink[y * RW + x] = on ? 1 : 0;
  }
}

/* ---------------------------------------------------------------- bands */

/** Contiguous runs of rows/columns that contain any ink. */
function bands(counts, minRun) {
  const out = [];
  let start = -1;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > 0 && start < 0) start = i;
    else if (counts[i] === 0 && start >= 0) {
      if (i - start >= minRun) out.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0 && counts.length - start >= minRun) out.push([start, counts.length - 1]);
  return out;
}

if (circle) console.log(`masked ${masked} px outside the circle`);

const rowCounts = new Int32Array(RH);
for (let y = 0; y < RH; y++) {
  let n = 0;
  for (let x = 0; x < RW; x++) n += ink[y * RW + x];
  rowCounts[y] = n;
}

let rowBands = bands(rowCounts, MIN_BAND);
console.log(`\nrow bands taller than ${MIN_BAND}px: ${rowBands.length}`);
rowBands.forEach((b, i) => console.log(`  row ${i}: y ${b[0]}..${b[1]}  (${b[1] - b[0] + 1}px)`));

if (WANT_ROWS && rowBands.length !== WANT_ROWS) {
  console.log(`\n! expected ${WANT_ROWS} rows, found ${rowBands.length}.`);
  console.log('  Adjust --region to isolate the grid, or --minband to change the cutoff.');
}

/* ---------------------------------------------------------------- trace */

/**
 * Walk pixel-edge boundaries. Each ink pixel contributes the edges of its
 * sides that face background; chaining those directed edges yields closed
 * loops — outer contours clockwise, holes counter-clockwise — so filling
 * even-odd keeps hollow shapes hollow.
 */
function traceLoops(mask, w, h) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
  const edges = new Map(); // "x,y" -> [[x2,y2], ...]
  const addEdge = (x1, y1, x2, y2) => {
    const k = x1 + ',' + y1;
    if (!edges.has(k)) edges.set(k, []);
    edges.get(k).push([x2, y2]);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!at(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }

  const loops = [];
  while (edges.size) {
    const startKey = edges.keys().next().value;
    let [cx, cy] = startKey.split(',').map(Number);
    const loop = [[cx, cy]];
    let dir = null;

    for (;;) {
      const key = cx + ',' + cy;
      const outs = edges.get(key);
      if (!outs || !outs.length) break;

      // At a diagonal pinch a corner has two exits; take the sharpest
      // right turn so the loop hugs this shape instead of jumping across.
      let pick = 0;
      if (outs.length > 1 && dir) {
        let best = -Infinity;
        outs.forEach((cand, i) => {
          const nd = [cand[0] - cx, cand[1] - cy];
          const cross = dir[0] * nd[1] - dir[1] * nd[0];
          const dot = dir[0] * nd[0] + dir[1] * nd[1];
          const score = Math.atan2(-cross, -dot);
          if (score > best) { best = score; pick = i; }
        });
      }

      const [nx, ny] = outs.splice(pick, 1)[0];
      if (!outs.length) edges.delete(key);
      dir = [nx - cx, ny - cy];
      cx = nx;
      cy = ny;
      if (cx === loop[0][0] && cy === loop[0][1]) break;
      loop.push([cx, cy]);
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

/** Shoelace area of a closed ring, signed. */
function ringArea(points) {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return a / 2;
}

/** Douglas-Peucker on a closed ring. */
function simplify(points, eps) {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let far = -1;
    let farD = eps;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i][0] - ax) * dy - (points[i][1] - ay) * dx) / len;
      if (d > farD) { farD = d; far = i; }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/* ----------------------------------------------------------- extraction */

const glyphs = [];
let cellIndex = 0;

/*
 * Column boundaries are derived once, from every glyph row stacked together,
 * rather than per row. Merging bands row by row is fragile: two glyphs that
 * happen to sit close (row 5 of the SG-1 sheet) collapse into one cell and
 * shift every index after them. Stacking the rows makes the five gaps between
 * the six columns the widest blank runs in the profile, which is unambiguous.
 */
const colCountsAll = new Int32Array(RW);
for (const [y0, y1] of rowBands) {
  for (let x = 0; x < RW; x++) {
    let n = 0;
    for (let y = y0; y <= y1; y++) n += ink[y * RW + x];
    colCountsAll[x] += n;
  }
}

let bounds;
if (WANT_COLS > 1) {
  const gaps = [];
  let run = -1;
  for (let x = 0; x < RW; x++) {
    if (colCountsAll[x] === 0 && run < 0) run = x;
    else if (colCountsAll[x] > 0 && run >= 0) {
      gaps.push({ x0: run, x1: x - 1, len: x - run });
      run = -1;
    }
  }
  if (run >= 0) gaps.push({ x0: run, x1: RW - 1, len: RW - run });

  const interior = gaps.filter((g) => g.x0 > 0 && g.x1 < RW - 1);
  const split = interior
    .sort((a, b) => b.len - a.len)
    .slice(0, WANT_COLS - 1)
    .sort((a, b) => a.x0 - b.x0)
    .map((g) => Math.round((g.x0 + g.x1) / 2));

  bounds = [0, ...split, RW];
  console.log(`\ncolumn splits at x: ${split.join(', ')}`);
  if (split.length !== WANT_COLS - 1) {
    console.log(`! only found ${split.length} gaps, expected ${WANT_COLS - 1}`);
  }
} else {
  bounds = [0, RW];
}

rowBands.forEach((rb, ri) => {
  const [y0, y1] = rb;
  const bandH = y1 - y0 + 1;

  // Slice this row at the global column boundaries, then tighten each cell
  // onto its actual ink.
  const cells = [];
  for (let ci = 0; ci < bounds.length - 1; ci++) {
    let lo = -1;
    let hi = -1;
    for (let x = bounds[ci]; x < bounds[ci + 1]; x++) {
      let n = 0;
      for (let y = y0; y <= y1; y++) n += ink[y * RW + x];
      if (n > 0) {
        if (lo < 0) lo = x;
        hi = x;
      }
    }
    if (lo >= 0) cells.push([lo, hi]);
  }

  console.log(`row ${ri}: ${cells.length} glyph columns (band height ${bandH}px)`);

  cells.forEach((cb) => {
    const [x0, x1] = cb;
    const w = x1 - x0 + 1;
    const h = bandH;
    const sub = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) sub[y * w + x] = ink[(y0 + y) * RW + (x0 + x)];
    }

    const loops = traceLoops(sub, w, h)
      .filter((l) => Math.abs(ringArea(l)) >= MIN_AREA)
      .map((l) => simplify(l, EPSILON));
    if (!loops.length) return;

    // Normalize into a unit box, preserving aspect.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of loops) {
      for (const [px, py] of l) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
    const bw = maxX - minX || 1;
    const bh = maxY - minY || 1;
    const s = 1 / Math.max(bw, bh);
    const cxm = (minX + maxX) / 2;
    const cym = (minY + maxY) / 2;

    const contours = loops.map((l) =>
      l.map(([px, py]) => [
        Math.round((px - cxm) * s * 1000) / 1000,
        Math.round((py - cym) * s * 1000) / 1000,
      ])
    );

    glyphs.push({
      name: GLYPH_NAMES_OUT[cellIndex] || 'cell' + cellIndex,
      index: cellIndex,
      aspect: Math.round((bw / bh) * 1000) / 1000,
      natural: Math.round(Math.max(bw, bh)),
      contours,
    });
    cellIndex++;
  });
});

console.log(`\ntraced ${glyphs.length} glyphs`);
const pts = glyphs.reduce((n, g) => n + g.contours.reduce((m, c) => m + c.length, 0), 0);
console.log(`total points after simplification: ${pts}`);
glyphs.slice(0, 6).forEach((g) =>
  console.log(`  ${g.name}: ${g.contours.length} contour(s), ${g.contours.reduce((n, c) => n + c.length, 0)} pts, aspect ${g.aspect}`)
);

/* -------------------------------------------------------------- outputs */

const outJs = path.join(ROOT, 'public', 'glyph-paths.js');
const body = glyphs
  .map(
    (g) =>
      `  { n: ${JSON.stringify(g.name)}, a: ${g.aspect}, s: ${g.natural}, c: [` +
      g.contours.map((c) => '[' + c.map((p) => `[${p[0]},${p[1]}]`).join(',') + ']').join(',') +
      '] }'
  )
  .join(',\n');

fs.writeFileSync(
  outJs,
  `'use strict';\n` +
    `/* Generated by tools/trace-glyphs.js — do not edit by hand.\n` +
    `   Traced from ${path.basename(file)}. Coordinates are normalized to a\n` +
    `   unit box centered on the origin; fill even-odd. */\n\n` +
    `const GLYPH_PATHS = [\n${body}\n];\n`,
  'utf8'
);
console.log(`\nwrote ${path.relative(ROOT, outJs)} (${(fs.statSync(outJs).size / 1024).toFixed(1)} KB)`);

if (has('preview')) {
  const cols = 6;
  const cell = 110;
  const rows = Math.ceil(glyphs.length / cols);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${rows * cell}" viewBox="0 0 ${cols * cell} ${rows * cell}"><rect width="100%" height="100%" fill="#000"/>`;
  glyphs.forEach((g, i) => {
    const cx = (i % cols) * cell + cell / 2;
    const cy = Math.floor(i / cols) * cell + cell / 2 - 6;
    const d = g.contours
      .map((c) => 'M' + c.map((p) => `${(p[0] * 74).toFixed(2)},${(p[1] * 74).toFixed(2)}`).join('L') + 'Z')
      .join('');
    svg += `<g transform="translate(${cx},${cy})"><path d="${d}" fill="#fff" fill-rule="evenodd"/></g>`;
    svg += `<text x="${cx}" y="${Math.floor(i / cols) * cell + cell - 6}" fill="#ffa53a" font-size="8" font-family="monospace" text-anchor="middle">${g.name}</text>`;
  });
  svg += '</svg>';
  const outSvg = path.join(ROOT, 'tools', 'glyph-preview.svg');
  fs.writeFileSync(outSvg, svg, 'utf8');
  console.log(`wrote ${path.relative(ROOT, outSvg)} — open it to check the trace`);
}
