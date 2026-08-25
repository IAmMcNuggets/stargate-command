'use strict';
/*
 * Canvas renderer for the gate itself: 39-glyph inner ring, 9 chevrons on the
 * outer body, kawoosh, and the event horizon.
 */

const TAU = Math.PI * 2;

/*
 * Where each chevron sits, in degrees clockwise from top dead center, indexed
 * by chevron number 1-9.
 *
 * They are NOT evenly numbered around the ring. The seven address chevrons are
 * arranged symmetrically — 1,2,3 down the right side, 4,5,6 back up the left,
 * and 7 at top — while the two extra chevrons, 8 and 9, fill the bottom. So
 * lighting them 1..7 in order sweeps down one side and up the other.
 */
const CHEVRON_DEG = [40, 80, 120, 240, 280, 320, 0, 160, 200];

/*
 * Band radii as a fraction of R, taken off the gate's construction drawing.
 * Outward from the middle:
 *
 *   0      .. 0.740   event horizon / aperture
 *   0.740  .. 0.885   glyph cells        <- the inner track, this rotates
 *   0.885  .. 0.958   scalloped band     <- static body
 *   0.958  .. 1.000   outer rim          <- static body, chevrons mount here
 *
 * The real ring is thinner than it looks in memory: the aperture is nearly
 * three quarters of the outside radius.
 */
const R_APERTURE = 0.74;
// How far the top V drops as it takes a symbol, as a fraction of the gate
// radius. Sized so the point of the V finishes halfway down a constellation:
// it rests at 0.855 and the symbol track runs R_RING_IN to R_RING_OUT, so
// half way is 0.8125 and the travel is the difference.
//
// The prop only moves about 0.013. This is well past that on purpose, since
// at the size the gate renders here the true figure is a few pixels and does
// not register.
const TOP_DROP = 0.0425;

// How far the lit element rides outward while the V drops inward, as a
// fraction of the gate radius. The two travel in opposite directions at the
// same time, which is what makes the chevron look like it is coming apart as
// it takes the symbol rather than merely stretching.
//
// It has to stay captive in its channel: the block slides, it does not come
// off. Rest to full travel the block clears the V by TOP_DROP + TOP_RISE, and
// the channel runs from the block down to the point of the V, so that sum has
// to stay under the channel depth or the block leaves the part it slides in.
const TOP_RISE = 0.02;

const R_RING_IN = 0.74;
const R_RING_OUT = 0.885;
const R_DECO_OUT = 0.958;
const DECO_COUNT = GLYPH_COUNT * 5;

/*
 * The gate is drawn the way the SGC diagnostics screen draws it: a schematic,
 * not a photograph. Glowing blue structural rings, symbol cells picked out in
 * green, flat gray chevron brackets, and a near-black aperture.
 */
const PALETTE = {
  ringGlow: '#29b6f6',
  ringLine: '#1e88e5',
  ringDeep: '#0d3f66',
  cellFill: 'rgba(6, 22, 36, 0.85)',
  cellEdge: 'rgba(41, 182, 246, 0.45)',
  glyphIdle: 'rgba(0, 214, 110, 0.78)',
  glyphLit: '#7dffb2',
  chevronBody: '#8a97a3',
  chevronDark: '#39454f',
  chevronEdge: 'rgba(190, 208, 222, 0.75)',
  chevronLit: '#ff7a29',
  chevronLitHot: '#ffd08a',
  horizon: '#3fb9ff',
  horizonPale: '#d8f4ff',
};

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/*
 * Ring rotation. A cubic ease looks springy — the real ring is a heavy lump of
 * naquadah on a motor: it winds up, holds a constant speed for most of the
 * turn, then brakes. Piecewise accel / cruise / brake gives that weight.
 */
function easeRing(t) {
  const a = 0.26;
  const d = 0.3;
  const c = 1 - a - d;
  const total = a / 2 + c + d / 2;
  if (t < a) return t * t / (2 * a) / total;
  if (t < a + c) return (a / 2 + (t - a)) / total;
  const td = t - a - c;
  return (a / 2 + c + td - (td * td) / (2 * d)) / total;
}
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
function easeOutBack(t) {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

class Gate {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.ringAngle = 0;
    this.spinning = false;
    this.spinBlur = 0;

    // chevron display number (1-9) -> { lit, glyph, flash }
    this.chevrons = new Map();
    this.activeGlyph = null; // glyph currently at top dead center
    this.glyphFlash = 0;

    // The top chevron grabs every symbol, separately from the numbered
    // chevrons that latch and stay lit. topDrop is the V dropping inward to
    // take the symbol; topGrab is the light, driven off the same phases so
    // the two stay welded together.
    this.topGrab = 0;
    this.topDrop = 0;

    // Trinium iris: 0 fully open, 1 fully closed. Sits in front of the
    // event horizon, exactly as it does on the real gate.
    this.iris = 0;

    // The symbol currently being dialled, shown large in the aperture.
    this.centerGlyph = null;
    this.centerAlpha = 0;

    // The destination boxes down the right, and the symbol in flight between
    // the gate center and its box. Seven boxes for an ordinary address, nine
    // when a remote destination lights the two spare chevrons as well.
    this.slotCount = 7;
    this.slots = new Array(this.slotCount).fill(null);
    this.flight = null; // { glyph, slot, t }

    this.horizon = 0; // 0 closed .. 1 fully open
    this.kawooshT = -1; // -1 idle, else 0..1
    this.shake = 0;
    this.failure = 0;

    this.aborted = false;
    this.t0 = performance.now();

    this._resize();
    window.addEventListener('resize', () => this._resize());

    // Catches the initial layout settle, not just later window resizes.
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(canvas);
    }
    // Fonts landing can reflow the panels around the canvas.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => this._resize()).catch(() => {});
    }
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  /* ---------------- geometry ---------------- */

  /**
   * @param {boolean} [force]  recompute even when the canvas is the same size.
   *        Needed when something other than the window changed the layout, such
   *        as switching between a seven and nine box column.
   */
  _resize(force) {
    // Re-read on every resize: dragging to a monitor with different scaling
    // changes this, and a stale value scales the whole drawing wrongly.
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(120, rect.width);
    const h = Math.max(120, rect.height);
    if (!force && this.w === w && this.h === h && this.canvas.width === Math.round(w * this.dpr)) {
      return;
    }
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.w = w;
    this.h = h;
    // A gutter on the right holds the destination boxes. Below a certain
    // width there is no room, so the boxes are dropped rather than squeezed.
    const gutter = Math.min(w * 0.17, h * 0.2);
    this.showSlots = w - gutter > h * 0.92 && gutter > 34;
    const usableW = this.showSlots ? w - gutter : w;

    // 0.735 of the height is what seven boxes at the old fixed size came to.
    // Dividing it keeps the column the same length whether there are seven or
    // nine, shrinking the boxes instead of running off the bottom.
    this.slotSize = Math.min(gutter * 0.72, (h * 0.735) / this.slotCount);
    this.slotGap = this.slotSize * 0.28;

    // The ring sits in the middle of the canvas. It used to be centred on
    // the space left of the boxes instead, which put it off to the left and
    // meant everything wanting to line up with it - the banner, the DHD -
    // had to be nudged the same way.
    this.cx = w / 2;
    this.cy = h / 2;

    // The boxes did not move with it, so the ring has to stop short of them.
    // In most window shapes the height is the tighter limit and this changes
    // nothing; it only bites on a wide, short window.
    const margin = Math.min(w, h) * 0.055;
    const boxLeft = this.showSlots ? usableW + gutter / 2 - this.slotSize / 2 : w;
    this.R = Math.max(
      40,
      Math.min(h / 2 - margin, boxLeft - this.cx - margin * 0.5, this.cx - margin)
    );

    this.slotDX = usableW + gutter / 2 - this.cx;
    this._chevCache = null;

    // Zero now that the ring is centred, but still published: callers should
    // keep asking rather than assuming, in case this moves again.
    this.centerOffset = this.cx - w / 2;
    if (this.onLayout) this.onLayout(this);
  }

  /* ---------------- public animation API ---------------- */

  /**
   * How many destination boxes to show — the length of the address about to be
   * dialled. Re-runs layout, because the boxes shrink to keep the column the
   * same length.
   */
  setSlotCount(n) {
    const count = Math.max(1, Math.min(9, n || 7));
    if (count === this.slotCount) return;
    this.slotCount = count;
    this.slots = new Array(count).fill(null);
    // Forced: the canvas is usually the same size as it was a moment ago, and
    // an unforced resize would return before recomputing the box size, leaving
    // nine boxes drawn at the size worked out for seven.
    this._resize(true);
  }

  reset() {
    this.chevrons.clear();
    this.activeGlyph = null;
    this.centerGlyph = null;
    this.centerAlpha = 0;
    this.slots = new Array(this.slotCount).fill(null);
    this.flight = null;
    this.topGrab = 0;
    this.topDrop = 0;
    this.horizon = 0;
    this.kawooshT = -1;
    this.spinning = false;
    this.spinBlur = 0;
    this.shake = 0;
    this.failure = 0;
    this.aborted = false;
  }

  abort() {
    this.aborted = true;
  }

  /*
   * Animation driver.
   *
   * requestAnimationFrame stops entirely while the window is hidden, which
   * would strand a dial mid-sequence — and the program at the far end would
   * never launch. A timer backstop force-completes the step if rAF has gone
   * quiet, so the sequence always finishes even if the user alt-tabs away
   * the moment they hit Enter. Visually it jumps; functionally it still dials.
   */
  _tween(duration, onUpdate, easing) {
    const ease = easing || ((t) => t);
    return new Promise((resolve) => {
      if (duration <= 0) {
        onUpdate(1);
        return resolve();
      }
      const start = performance.now();
      let done = false;
      let backstop = null;

      const finish = () => {
        if (done) return;
        done = true;
        if (backstop) clearTimeout(backstop);
        onUpdate(1, 1);
        resolve();
      };

      const step = (now) => {
        if (done) return;
        if (this.aborted) return finish();
        const raw = clamp((now - start) / duration, 0, 1);
        onUpdate(ease(raw), raw);
        if (raw >= 1) return finish();
        requestAnimationFrame(step);
      };

      backstop = setTimeout(finish, duration + 300);
      requestAnimationFrame(step);
    });
  }

  /**
   * Rotate the inner ring until `glyph` sits at top dead center, under the
   * chevron that does the grabbing. Every symbol comes to the top; the
   * numbered chevrons light in sequence around the ring, and the seventh —
   * which is the top one — stays locked with the Point of Origin beneath it.
   *
   * `minTurns` forces extra full revolutions — on screen the ring always
   * travels a long way, never a token nudge to the neighboring symbol.
   *
   * `timing` is either a fixed millisecond count, or `{ degPerSec, minMs }`.
   * Prefer the latter: the ring is a heavy motor-driven lump, so it should
   * turn at a constant rate and take *longer to go further*. A fixed duration
   * makes a short hop crawl and a full revolution look flung.
   *
   * `onBegin` receives the computed duration, so the spin-up sound can be
   * given the same length as the movement.
   */
  async spinTo(glyph, direction, timing, minTurns, onBegin) {
    const slot = (glyph * TAU) / GLYPH_COUNT;
    const target = -slot; // ringAngle 0 puts glyph 0 at top

    // Normalize so we always travel `direction` and cover a decent arc.
    const from = this.ringAngle;
    let delta = target - from;
    delta = ((delta % TAU) + TAU) % TAU; // 0..TAU, clockwise
    if (direction < 0) delta -= TAU; // counter-clockwise

    const turns = minTurns || 0;
    if (turns > 0) delta += (direction < 0 ? -TAU : TAU) * turns;
    else if (Math.abs(delta) < TAU * 0.22) delta += direction < 0 ? -TAU : TAU;

    // Constant angular velocity: time follows from how far it actually has
    // to turn.
    let duration;
    if (typeof timing === 'number') {
      duration = timing;
    } else {
      const degrees = (Math.abs(delta) * 180) / Math.PI;
      duration = Math.max(timing.minMs || 0, (degrees / timing.degPerSec) * 1000);
    }
    if (onBegin) onBegin(duration);

    this.spinning = true;
    await this._tween(
      duration,
      (t) => {
        this.ringAngle = from + delta * t;
        // Smear tracks velocity, so it peaks during the cruise, not the ends.
        this.spinBlur = Math.min(1, Math.sin(clamp(t, 0, 1) * Math.PI) * 1.6);
      },
      easeRing
    );
    this.ringAngle = ((target % TAU) + TAU) % TAU;
    this.spinning = false;
    this.spinBlur = 0;
    this.activeGlyph = glyph;
  }

  /**
   * The top chevron clamping down on the symbol that just arrived. Runs
   * alongside the numbered chevron latching rather than before it, so the
   * grab reads without lengthening the dial.
   */
  /**
   * The V dropping inward as it takes the symbol.
   *
   * The wing across the top does not move; only the V below it does. Tracked
   * off the prop by correlating the slat pattern frame to frame, which works
   * whether the slats are lit or dark: it drops inward over about a fifth
   * of a second, sits there for half a second, then returns. See TOP_DROP for
   * the distance, which is pushed past the measured one on purpose.
   *
   * It travels one way only. The prop does carry on a few pixels past its
   * resting place on the way back, but reproducing that read as a bounce
   * rather than as weight, so the return stops at rest.
   *
   * Positive is inward, toward the middle of the gate.
   */
  async _dropTop(duration) {
    await this._tween(duration * 0.28, (t) => (this.topDrop = t), easeOutCubic);
    this.topDrop = 1;
    await this._tween(duration * 0.32, () => {});
    await this._tween(duration * 0.4, (t) => (this.topDrop = 1 - t), easeInOutCubic);
    this.topDrop = 0;
  }


  async flashTop(duration) {
    this.shake = Math.min(1, this.shake + 0.45);
    this.glyphFlash = 1;
    // Phase-matched to _dropTop rather than run on its own clock. It used to
    // peak at 0.35 and be fading again while the V was still down, which is
    // what made the light look like it belonged to something else.
    const moving = this._dropTop(duration);
    await this._tween(duration * 0.28, (t) => (this.topGrab = t), easeOutCubic);
    this.topGrab = 1;
    await this._tween(duration * 0.47, () => {});
    await this._tween(duration * 0.25, (t) => (this.topGrab = 1 - t), easeOutCubic);
    this.topGrab = 0;
    await moving;
  }

  /** Slam a chevron closed. */
  async lockChevron(chevronNumber, glyph, duration) {
    // Seven is the top one and locks itself rather than being grabbed, so
    // without this it would be the only symbol that engages without the
    // housing moving.
    const lifting = chevronNumber === 7 ? this._dropTop(duration) : null;
    const entry = { lit: 0, glyph, flash: 1 };
    this.chevrons.set(chevronNumber, entry);
    this.glyphFlash = 1;
    this.shake = Math.min(1, this.shake + 0.55);
    await this._tween(
      duration,
      (t) => {
        entry.lit = t;
        entry.flash = 1 - t * 0.65;
      },
      easeOutBack
    );
    entry.lit = 1;
    entry.flash = 0.35;
    if (lifting) await lifting;
  }

  /** Drive the iris blades open or shut. */
  async setIris(closed, duration) {
    const from = this.iris;
    const to = closed ? 1 : 0;
    if (from === to) return;
    await this._tween(
      duration,
      (t) => {
        this.iris = from + (to - from) * t;
      },
      easeInOutCubic
    );
    this.iris = to;
  }

  /** Show a symbol large in the middle of the gate, one at a time. */
  async showCenterGlyph(glyph, duration) {
    this.centerGlyph = glyph;
    const from = this.centerAlpha;
    await this._tween(duration, (t) => {
      this.centerAlpha = from + (1 - from) * t;
    }, easeOutCubic);
    this.centerAlpha = 1;
  }

  /**
   * Shrink the big symbol down and send it to its destination box. Not
   * awaited by the dial loop — it flies while the ring starts its next turn,
   * so it costs no time.
   */
  async stowCenterGlyph(slot, duration) {
    const glyph = this.centerGlyph;
    if (glyph === null) return;
    this.flight = { glyph, slot, t: 0 };
    this.centerGlyph = null;
    this.centerAlpha = 0;
    await this._tween(duration, (t) => {
      if (this.flight) this.flight.t = t;
    }, easeInOutCubic);
    this.slots[slot] = glyph;
    this.flight = null;
  }

  async hideCenterGlyph(duration) {
    const from = this.centerAlpha;
    if (from <= 0) return;
    await this._tween(duration, (t) => {
      this.centerAlpha = from * (1 - t);
    }, easeOutCubic);
    this.centerAlpha = 0;
    this.centerGlyph = null;
  }

  /** The kawoosh, then the settled event horizon. */
  async openWormhole(duration) {
    this.shake = 1;
    this.kawooshT = 0;
    await this._tween(duration, (t) => {
      this.kawooshT = t;
      this.horizon = clamp((t - 0.3) / 0.45, 0, 1);
    });
    this.kawooshT = -1;
    this.horizon = 1;
  }

  async closeWormhole(duration) {
    const from = this.horizon;
    await this._tween(
      duration,
      (t) => {
        this.horizon = from * (1 - t);
      },
      easeOutCubic
    );
    this.horizon = 0;
    this.chevrons.clear();
    this.activeGlyph = null;
  }

  async failSequence(duration) {
    this.failure = 1;
    this.shake = 1;
    await this._tween(duration, (t) => {
      this.failure = 1 - t;
    });
    this.failure = 0;
    this.chevrons.clear();
  }

  /* ---------------- render ---------------- */

  _loop(now) {
    const dt = Math.min(50, now - (this._last || now));
    this._last = now;
    this.shake *= Math.pow(0.86, dt / 16.67);
    this.glyphFlash *= Math.pow(0.9, dt / 16.67);
    this._draw(now);
    requestAnimationFrame(this._loop);
  }

  _draw(now) {
    const ctx = this.ctx;
    const { cx, cy, R } = this;
    const time = (now - this.t0) / 1000;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    const sx = (Math.random() - 0.5) * this.shake * 4;
    const sy = (Math.random() - 0.5) * this.shake * 4;
    ctx.translate(cx + sx, cy + sy);

    this._drawAperture(ctx, R, time);
    this._drawBody(ctx, R);
    this._drawGlyphRing(ctx, R, time);
    this._drawChevrons(ctx, R, time);
    if (this.kawooshT >= 0) this._drawKawoosh(ctx, R, this.kawooshT, time);
    this._drawSlots(ctx, R);
    this._drawFlight(ctx, R);

    ctx.restore();
  }

  _drawAperture(ctx, R, time) {
    const aR = R * R_APERTURE;

    // The dark interior, always present behind everything else.
    const back = ctx.createRadialGradient(0, 0, 0, 0, 0, aR);
    back.addColorStop(0, '#04060a');
    back.addColorStop(1, '#010203');
    ctx.fillStyle = back;
    ctx.beginPath();
    ctx.arc(0, 0, aR, 0, TAU);
    ctx.fill();

    // Idle sweep arcs across the dark aperture, as on the diagnostics screen.
    if (this.horizon < 0.35) {
      const fade = 1 - this.horizon / 0.35;
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const r = aR * (0.42 + i * 0.19);
        const speed = 0.09 + i * 0.045;
        const start = time * speed * (i % 2 ? -1 : 1);
        ctx.strokeStyle = `rgba(79, 195, 247, ${(0.16 - i * 0.035) * fade})`;
        ctx.lineWidth = Math.max(1, R * 0.0035);
        ctx.beginPath();
        ctx.arc(0, 0, r, start, start + 1.1 + i * 0.35);
        ctx.stroke();
      }
      // A couple of radial ticks hanging off the arcs.
      ctx.strokeStyle = `rgba(79, 195, 247, ${0.13 * fade})`;
      const tick = time * 0.09;
      ctx.beginPath();
      ctx.moveTo(Math.cos(tick) * aR * 0.42, Math.sin(tick) * aR * 0.42);
      ctx.lineTo(Math.cos(tick) * aR * 0.61, Math.sin(tick) * aR * 0.61);
      ctx.stroke();
      ctx.restore();

      // Soft glowing diagnostic dot in the center.
      const blink = (Math.sin(time * Math.PI * 2) + 1) * 0.5;
      const radius = R * 0.036;

      ctx.save();

      const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
      gradient.addColorStop(0, `rgba(79, 195, 247, ${0.25 + blink * 0.65})`);
      gradient.addColorStop(0.35, `rgba(79, 195, 247, ${0.15 + blink * 0.4})`);
      gradient.addColorStop(1, 'rgba(79, 195, 247, 0)');

      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    if (this.horizon <= 0.001) {
      this._drawIris(ctx, R, time);
      this._drawCenterGlyph(ctx, R);
      return;
    }
    const hz = this.horizon;

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, aR, 0, TAU);
    ctx.clip();

    // Deep pool. Darker at the rim, luminous toward the center.
    const pool = ctx.createRadialGradient(0, 0, aR * 0.04, 0, 0, aR);
    pool.addColorStop(0, `rgba(150, 216, 255, ${0.92 * hz})`);
    pool.addColorStop(0.3, `rgba(46, 150, 226, ${0.9 * hz})`);
    pool.addColorStop(0.72, `rgba(16, 78, 158, ${0.92 * hz})`);
    pool.addColorStop(1, `rgba(5, 26, 66, ${0.96 * hz})`);
    ctx.fillStyle = pool;
    ctx.fillRect(-aR, -aR, aR * 2, aR * 2);

    ctx.globalCompositeOperation = 'lighter';

    // Drifting caustics — the bulk of the shimmer.
    for (let i = 0; i < 7; i++) {
      const ang = time * (0.19 + i * 0.075) + (i * TAU) / 7;
      const rr = aR * (0.26 + 0.24 * Math.sin(time * 0.55 + i * 1.7));
      const px = Math.cos(ang) * rr;
      const py = Math.sin(ang) * rr;
      const size = aR * (0.42 + 0.16 * Math.sin(time * 0.9 + i));
      const g = ctx.createRadialGradient(px, py, 0, px, py, size);
      g.addColorStop(0, `rgba(198, 238, 255, ${0.1 * hz})`);
      g.addColorStop(0.55, `rgba(96, 190, 250, ${0.045 * hz})`);
      g.addColorStop(1, 'rgba(96, 190, 250, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(-aR, -aR, aR * 2, aR * 2);
    }

    // Surface ripples travelling inward, wobbled so they never read as
    // perfect circles.
    for (let i = 0; i < 4; i++) {
      const phase = (time * 0.22 + i / 4) % 1;
      const r = aR * (1.0 - phase * 0.94);
      const a = Math.sin(phase * Math.PI) * 0.09 * hz;
      if (a <= 0.002) continue;
      ctx.strokeStyle = `rgba(206, 240, 255, ${a})`;
      ctx.lineWidth = R * (0.004 + phase * 0.016);
      ctx.beginPath();
      const steps = 48;
      for (let s = 0; s <= steps; s++) {
        const th = (s / steps) * TAU;
        const wob =
          1 +
          0.035 * Math.sin(th * 3 + time * 1.3 + i) +
          0.022 * Math.sin(th * 6 - time * 0.9 + i * 2);
        const x = Math.cos(th) * r * wob;
        const y = Math.sin(th) * r * wob;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }

    // Crisp bright rim where the horizon meets the ring.
    const rim = ctx.createRadialGradient(0, 0, aR * 0.9, 0, 0, aR);
    rim.addColorStop(0, 'rgba(150, 220, 255, 0)');
    rim.addColorStop(0.82, `rgba(150, 220, 255, ${0.16 * hz})`);
    rim.addColorStop(1, `rgba(226, 248, 255, ${0.5 * hz})`);
    ctx.fillStyle = rim;
    ctx.fillRect(-aR, -aR, aR * 2, aR * 2);

    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();

    this._drawIris(ctx, R, time);
    this._drawCenterGlyph(ctx, R);

    // Glow spilling out onto the ring face.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const spill = ctx.createRadialGradient(0, 0, aR * 0.8, 0, 0, aR * 1.35);
    spill.addColorStop(0, `rgba(63, 185, 255, ${0.35 * hz})`);
    spill.addColorStop(1, 'rgba(63, 185, 255, 0)');
    ctx.fillStyle = spill;
    ctx.beginPath();
    ctx.arc(0, 0, aR * 1.35, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  _drawBody(ctx, R) {
    const dIn = R * R_RING_OUT;
    const dOut = R * R_DECO_OUT;

    // Body band between the symbol track and the rim.
    const g = ctx.createRadialGradient(0, 0, dIn, 0, 0, R);
    g.addColorStop(0, 'rgba(10, 38, 62, 0.9)');
    g.addColorStop(0.6, 'rgba(7, 28, 48, 0.9)');
    g.addColorStop(1, 'rgba(5, 18, 32, 0.9)');
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.arc(0, 0, dIn, 0, TAU, true);
    ctx.fillStyle = g;
    ctx.fill();

    // Fine radial tick texture where the prop has its scalloped band.
    ctx.save();
    ctx.lineWidth = Math.max(0.5, R * 0.002);
    ctx.strokeStyle = 'rgba(41, 182, 246, 0.22)';
    for (let i = 0; i < DECO_COUNT; i++) {
      const phi = (i / DECO_COUNT) * TAU;
      ctx.save();
      ctx.rotate(phi);
      ctx.beginPath();
      ctx.moveTo(0, -(dIn + (dOut - dIn) * 0.18));
      ctx.lineTo(0, -(dOut - (dOut - dIn) * 0.18));
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // The glowing structural circles that define the schematic.
    this._glowRing(ctx, R, R * 0.006, PALETTE.ringGlow, 0.95);
    this._glowRing(ctx, dOut, R * 0.0035, PALETTE.ringLine, 0.5);
    this._glowRing(ctx, dIn, R * 0.005, PALETTE.ringGlow, 0.8);

    if (this.failure > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(255, 40, 30, ${0.5 * this.failure})`;
      ctx.lineWidth = R * 0.02;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.93, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** The symbol being dialled, drawn large across the aperture. */
  _drawCenterGlyph(ctx, R) {
    if (this.centerAlpha <= 0.002 || this.centerGlyph === null) return;
    const a = this.centerAlpha;
    const size = R * R_APERTURE * 1.15;

    ctx.save();
    ctx.globalAlpha = a * (1 - this.horizon * 0.85);
    drawGlyph(ctx, this.centerGlyph, size, {
      color: 'rgba(125, 255, 178, 0.9)',
      lineWidth: Math.max(2, size * 0.02),
      glow: R * 0.06,
    });
    ctx.restore();
  }

  /*
   * The iris: 22 interlocking trinium plates working as a multi-bladed leaf
   * shutter, per canon.
   *
   * The spiral is not decoration — it falls out of the mechanism. Each blade's
   * leading edge is a circular ARC whose center is offset from the gate center,
   * sitting at distance (r + Rb) along the blade's own angle. The aperture is
   * the envelope of those arcs, which is why a real iris closes to a curved
   * polygon that twists rather than a plain shrinking circle. The blades also
   * sweep round as they close, which deepens the twist.
   */
  _drawIris(ctx, R, time) {
    const t = clamp(this.iris, 0, 1);
    if (t <= 0.002) return;
    const aR = R * R_APERTURE;

    const N = 22;
    const Rb = aR * 1.15;      // curvature of each plate's leading edge
    const hub = aR * 0.055;    // the plates meet on a hub, not on a point
    const r = hub + (aR - hub) * (1 - t);
    const rot = 0.5 * t;
    const d = r + Rb;          // center of every plate's edge arc
    const Rr = aR * 1.06;      // where a plate meets the housing

    /*
     * Both spans are DERIVED, not chosen. The plate is the region inside the
     * housing and outside its edge arc, so the two arcs have to meet at the
     * same points:
     *
     *   s   half-angle of the edge arc, from the triangle O-C-P where the
     *       edge circle crosses the housing  (law of cosines)
     *   phi bearing of that crossing from the gate center
     *
     * Hard-coding these was the bug behind the overlap artifacts: the edge arc
     * ended at 1.09 rad while the rim arc it joined spanned 0.43 rad, so
     * closePath drew a chord straight across the aperture.
     */
    const cosS = clamp((d * d + Rb * Rb - Rr * Rr) / (2 * d * Rb), -1, 1);
    const s = Math.acos(cosS);
    const phi = Math.atan2(Rb * Math.sin(s), d - Rb * Math.cos(s));

    const center = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + rot;
      center.push({ a, x: Math.cos(a) * d, y: Math.sin(a) * d });
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, aR, 0, TAU);
    ctx.clip();

    /*
     * Each plate is drawn as its ACTUAL VISIBLE SHAPE: the region outside its
     * own edge arc and inside the NEXT plate's, which is precisely the part a
     * real blade leaves showing before it tucks underneath its neighbor.
     *
     * This matters for more than looks. Drawing full overlapping lunes needs
     * every blade painted under the next one, all the way round — a cyclic
     * overlap, which a painter's algorithm cannot express. One seam always
     * ends up inverted, and with lunes spanning +/-61 degrees that seam was a
     * huge wedge. These shapes tile the annulus instead of overlapping, so
     * there is no ordering to get wrong and no seam at the wrap.
     */
    const norm = (x) => ((x % TAU) + TAU) % TAU;
    const arcThrough = (cx0, cy0, rr, from, to, via) => {
      // Sweep from -> to the way round that passes through `via`.
      const ccw = norm(via - from) > norm(to - from);
      ctx.arc(cx0, cy0, rr, from, to, ccw);
    };

    for (let i = 0; i < N; i++) {
      const c1 = center[i];
      const c2 = center[(i + 1) % N];

      const ux = c2.x - c1.x;
      const uy = c2.y - c1.y;
      const L = Math.hypot(ux, uy);
      if (L < 1e-6 || L > 2 * Rb) continue;

      const dx = ux / L;
      const dy = uy / L;
      const hHalf = Math.sqrt(Math.max(0, Rb * Rb - (L / 2) * (L / 2)));
      const mx = (c1.x + c2.x) / 2;
      const my = (c1.y + c2.y) / 2;

      // The two circles cross here: one crossing sits at the aperture edge,
      // the other well outside the housing and gets clipped.
      const px = mx - dy * hHalf;
      const py = my + dx * hHalf;
      const qx = mx + dy * hHalf;
      const qy = my - dx * hHalf;

      const via = Math.atan2(dy, dx);
      const angle = (cx0, cy0, x, y) => Math.atan2(y - cy0, x - cx0);

      ctx.beginPath();
      ctx.moveTo(px, py);
      arcThrough(c1.x, c1.y, Rb, angle(c1.x, c1.y, px, py), angle(c1.x, c1.y, qx, qy), via);
      arcThrough(c2.x, c2.y, Rb, angle(c2.x, c2.y, qx, qy), angle(c2.x, c2.y, px, py), via);
      ctx.closePath();

      const litness = 0.5 + 0.5 * Math.cos(c1.a - 2.3);
      const base = 48 + litness * 44 + (i % 2) * 5;
      ctx.fillStyle = `rgb(${Math.round(base)}, ${Math.round(base * 1.1)}, ${Math.round(base * 1.24)})`;
      ctx.fill();

      // Lit lip along this plate's own leading edge.
      ctx.beginPath();
      arcThrough(c1.x, c1.y, Rb, angle(c1.x, c1.y, px, py), angle(c1.x, c1.y, qx, qy), via);
      ctx.strokeStyle = `rgba(216, 236, 252, ${0.28 + litness * 0.4})`;
      ctx.lineWidth = Math.max(1, R * 0.0032);
      ctx.stroke();
    }

    if (t > 0.55) {
      const k = (t - 0.55) / 0.45;
      ctx.beginPath();
      ctx.arc(0, 0, hub * k, 0, TAU);
      ctx.fillStyle = 'rgb(78, 88, 100)';
      ctx.fill();
      ctx.strokeStyle = `rgba(206, 228, 246, ${0.55 * k})`;
      ctx.lineWidth = Math.max(1, R * 0.003);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = t;
    ctx.strokeStyle = 'rgba(150, 190, 220, 0.5)';
    ctx.lineWidth = Math.max(1, R * 0.006);
    ctx.beginPath();
    ctx.arc(0, 0, aR * 0.995, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  /** Geometry of destination box `i`, in gate-center coordinates. */
  _slotRect(i) {
    const s = this.slotSize;
    const pitch = s + this.slotGap;
    const total = pitch * this.slotCount - this.slotGap;
    return { x: this.slotDX, y: -total / 2 + i * pitch + s / 2, s };
  }

  /** The destination boxes, filling in as the address is dialled. */
  _drawSlots(ctx, R) {
    if (!this.showSlots) return;
    for (let i = 0; i < this.slotCount; i++) {
      const { x, y, s } = this._slotRect(i);
      const filled = this.slots[i] !== null;

      ctx.save();
      ctx.translate(x, y);
      ctx.beginPath();
      ctx.rect(-s / 2, -s / 2, s, s);
      ctx.fillStyle = 'rgba(4, 20, 34, 0.72)';
      ctx.fill();
      ctx.strokeStyle = filled ? 'rgba(0, 230, 118, 0.75)' : 'rgba(41, 182, 246, 0.32)';
      ctx.lineWidth = Math.max(1, R * 0.0032);
      ctx.stroke();

      if (filled) {
        drawGlyph(ctx, this.slots[i], s * 0.66, {
          color: PALETTE.glyphLit,
          lineWidth: Math.max(1, s * 0.05),
          glow: s * 0.14,
        });
      }
      ctx.restore();
    }
  }

  /** The symbol mid-flight from the gate center to its box. */
  _drawFlight(ctx, R) {
    if (!this.flight) return;
    const { glyph, slot, t } = this.flight;
    const big = R * R_APERTURE * 1.15;

    if (!this.showSlots) {
      // Nowhere to land — just fade it out where it stands.
      ctx.save();
      ctx.globalAlpha = 1 - t;
      drawGlyph(ctx, glyph, big, { color: PALETTE.glyphLit, lineWidth: Math.max(2, big * 0.02), glow: R * 0.05 });
      ctx.restore();
      return;
    }

    const { x, y, s } = this._slotRect(slot);
    const px = x * t;
    const py = y * t;
    const size = big + (s * 0.66 - big) * t;

    ctx.save();
    ctx.translate(px, py);
    drawGlyph(ctx, glyph, size, {
      color: PALETTE.glyphLit,
      lineWidth: Math.max(1, size * 0.035),
      glow: R * 0.05 * (1 - t) + s * 0.14 * t,
    });
    ctx.restore();
  }

  /** A circle with a bloom around it, the signature look of this display. */
  _glowRing(ctx, radius, width, color, alpha) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = Math.max(2, width * 3.5);
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(1, width);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  _drawGlyphRing(ctx, R, time) {
    const rOuter = R * R_RING_OUT;
    const rInner = R * R_RING_IN;
    const rMid = (rOuter + rInner) / 2;

    ctx.beginPath();
    ctx.arc(0, 0, rOuter, 0, TAU);
    ctx.arc(0, 0, rInner, 0, TAU, true);
    ctx.fillStyle = PALETTE.cellFill;
    ctx.fill();

    // Traced artwork is filled rather than stroked, so it reads smaller at the
    // same box size — give it a little more of the cell.
    const glyphSize = (rOuter - rInner) * (hasTracedGlyphs() ? 0.70 : 0.62);
    const step = TAU / GLYPH_COUNT;

    for (let i = 0; i < GLYPH_COUNT; i++) {
      // Bearing from top dead center, clockwise — the same convention the
      // chevrons use. ctx.rotate(t) then translate(0, -r) lands a point at
      // bearing t, so this must NOT carry an extra -PI/2: that offset put
      // every symbol 90 degrees anticlockwise of its chevron.
      const theta = this.ringAngle + i * step;

      // Cell divider: one radial rule per boundary, so each glyph sits in its
      // own box on the track.
      ctx.save();
      ctx.rotate(theta + step / 2);
      ctx.strokeStyle = PALETTE.cellEdge;
      ctx.lineWidth = Math.max(1, R * 0.0028);
      ctx.beginPath();
      ctx.moveTo(0, -rInner);
      ctx.lineTo(0, -rOuter);
      ctx.stroke();
      ctx.restore();

      const isActive = this.activeGlyph === i && !this.spinning;
      const locked = [...this.chevrons.values()].some((c) => c.glyph === i);

      // Falloff around top dead center, where symbols are brought to lock.
      const d = Math.abs(((theta + Math.PI) % TAU) - Math.PI);
      const proximity = clamp(1 - d / (step * 3), 0, 1);

      let color = PALETTE.glyphIdle;
      let glow = 0;
      if (isActive) {
        const pulse = 0.75 + 0.25 * Math.sin(time * 9);
        color = `rgba(190, 255, 214, ${0.9 + 0.1 * pulse})`;
        glow = R * 0.05 * (0.6 + this.glyphFlash);
      } else if (locked) {
        color = 'rgba(125, 255, 178, 0.95)';
        glow = R * 0.022;
      } else if (proximity > 0) {
        color = `rgba(0, 230, 130, ${0.72 + proximity * 0.24})`;
      }
      if (this.spinning) glow = 0;

      ctx.save();
      ctx.rotate(theta);
      ctx.translate(0, -rMid);
      drawGlyph(ctx, i, glyphSize, {
        color,
        lineWidth: Math.max(1, glyphSize * 0.05),
        glow,
      });
      ctx.restore();
    }

    // Motion smear while the ring is turning.
    if (this.spinBlur > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(255, 190, 110, ${0.05 * this.spinBlur})`;
      ctx.lineWidth = rOuter - rInner;
      ctx.beginPath();
      ctx.arc(0, 0, rMid, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * The chevron silhouette: an arrowhead aimed at the event horizon, mounted
   * on the outer body. Built once per resize and reused for all nine.
   * Drawn at top dead center; callers rotate into position.
   */
  _chevronPath(R, big) {
    const key = big ? 'big' : 'small';
    if (this._chevCache && this._chevCache.R === R && this._chevCache[key]) {
      return this._chevCache[key];
    }
    if (!this._chevCache || this._chevCache.R !== R) this._chevCache = { R };

    // The housing flares outward at the top and tapers to a point on the
    // rim, rather than being a rectangular bracket.
    //
    // All nine are the same size. The top one used to be built oversized,
    // which reads fine on a narrow bracket but not on this silhouette: at
    // 1.22 its half-width came to 0.26R, better than half the gate across,
    // and it stopped looking like the same part as the other eight.
    const rTop = big ? 1.0 : 0.99;
    const rShoulder = 0.855;
    const rTip = 0.855;

    const halfTop = 0.215;
    const halfOuter = 0.075;
    const halfShoulder = 0.015;

    // Two pieces, because on the top chevron they move independently: the
    // wing across the top is bolted to the ring and never moves, and the V
    // below it drops to take the symbol. Splitting them here means the draw
    // does not have to know the geometry.
    // The seam sits deep enough that the V is still covered at full travel:
    // the wing has to overlap the V by more than TOP_DROP or the two come
    // apart at the bottom of the drop.
    const rSplit = rTop - (TOP_DROP + 0.0025);
    const rOuterTop = rTop - 0.025;
    // Half-width of the original single outline at any radius on the taper,
    // so splitting it in two does not change the silhouette.
    const taperAt = (r) =>
      halfShoulder + ((r - rShoulder) / (rOuterTop - rShoulder)) * (halfOuter - halfShoulder);
    const halfSplit = taperAt(rSplit);

    const wing = new Path2D();
    wing.moveTo(-R * halfTop, -R * rTop);
    // Curved top edge.
    wing.quadraticCurveTo(0, -R * (rTop + 0.038), R * halfTop, -R * rTop);
    wing.lineTo(R * halfOuter, -R * rOuterTop);
    wing.lineTo(R * halfSplit, -R * rSplit);
    wing.lineTo(-R * halfSplit, -R * rSplit);
    wing.lineTo(-R * halfOuter, -R * rOuterTop);
    wing.closePath();

    // The V runs up behind the wing rather than stopping at it, so that as it
    // drops it slides out from underneath instead of opening a hole. The tail
    // stops just under the curved top edge, which is at its lowest directly
    // above the tail, so nothing pokes out at rest.
    const veeTop = rTop + 0.01;
    const vee = new Path2D();
    vee.moveTo(-R * halfOuter, -R * veeTop);
    vee.lineTo(R * halfOuter, -R * veeTop);
    vee.lineTo(R * halfSplit, -R * rSplit);
    // Shoulder, then the tip on the rim.
    vee.lineTo(R * halfShoulder, -R * rShoulder);
    vee.lineTo(0, -R * rTip);
    vee.lineTo(-R * halfShoulder, -R * rShoulder);
    vee.lineTo(-R * halfSplit, -R * rSplit);
    vee.closePath();

    // The illuminated element, seated inside the housing. Its top has to sit
    // at a smaller radius than the frame or the light protrudes past the
    // metal that is supposed to surround it.
    //
    // It is seated deep enough to leave the top chevron room to travel: the
    // element rides out as it engages, and if it starts flush it clears the
    // housing immediately and reads as the part detaching rather than
    // sliding. At full extension it should sit barely proud of the metal.
    const lTop = rTop - 0.03;
    const lTip = rTip + 0.036;
    const lHalfTop = 0.052;
    const lHalfTip = 0.01;

    // The channel the element slides in. Cut into the V, so it travels with
    // the V and the element moves against it. At rest the element fills the
    // mouth of it; as it rides out the rest of the channel is uncovered.
    const chTop = lTop + 0.004;
    const chTip = rTip + 0.005;
    const chHalfTop = lHalfTop + 0.007;
    const chHalfTip = lHalfTip + 0.007;

    const channel = new Path2D();
    channel.moveTo(-R * chHalfTop, -R * chTop);
    channel.lineTo(R * chHalfTop, -R * chTop);
    channel.lineTo(R * chHalfTip, -R * chTip);
    channel.lineTo(-R * chHalfTip, -R * chTip);
    channel.closePath();

    const light = new Path2D();
    light.moveTo(-R * lHalfTop, -R * lTop);
    light.lineTo(R * lHalfTop, -R * lTop);
    light.lineTo(R * lHalfTip, -R * lTip);
    light.lineTo(-R * lHalfTip, -R * lTip);
    light.closePath();

    // Slats down the inside of each arm. On the prop these light with the
    // element and account for as much of the engaged look as the element
    // itself does. They sit in the metal between the element and the outer
    // edge, so both boundaries taper and each bar has to follow them.
    const outerAt = taperAt;
    const innerAt = (r) => lHalfTip + ((r - lTip) / (lTop - lTip)) * (lHalfTop - lHalfTip);

    const slats = new Path2D();
    const SLATS = 5;
    const rFrom = 0.9;
    const rSpan = 0.058;
    const pitch = rSpan / SLATS;
    const inset = 0.005;
    for (let k = 0; k < SLATS; k++) {
      const r0 = rFrom + k * pitch;
      const r1 = r0 + pitch * 0.6;
      const a0 = innerAt(r0) + inset;
      const b0 = outerAt(r0) - inset;
      const a1 = innerAt(r1) + inset;
      const b1 = outerAt(r1) - inset;
      if (b0 <= a0 || b1 <= a1) continue;
      for (let side = -1; side <= 1; side += 2) {
        slats.moveTo(side * R * a0, -R * r0);
        slats.lineTo(side * R * b0, -R * r0);
        slats.lineTo(side * R * b1, -R * r1);
        slats.lineTo(side * R * a1, -R * r1);
        slats.closePath();
      }
    }

    this._chevCache[key] = { wing, vee, channel, light, slats, rTop, rTip };
    return this._chevCache[key];
  }
  _drawChevrons(ctx, R, time) {
    const edge = Math.max(1, R * 0.0045);

    for (let i = 0; i < CHEVRON_DEG.length; i++) {
      const number = i + 1;
      const theta = (CHEVRON_DEG[i] * Math.PI) / 180;
      const { wing, vee, channel, light, slats } = this._chevronPath(R, number === 7);
      const entry = this.chevrons.get(number);
      let lit = entry ? clamp(entry.lit, 0, 1) : 0;
      // Chevron 7 is at top dead center and doubles as the grabber.
      if (number === 7) lit = Math.max(lit, this.topGrab);

      ctx.save();
      ctx.rotate(theta);

      // Flat gray bracket, as the diagnostics screen renders it.
      const mg = ctx.createLinearGradient(0, -R * 1.03, 0, -R * 0.855);
      mg.addColorStop(0, PALETTE.chevronBody);
      mg.addColorStop(0.55, '#5d6b77');
      mg.addColorStop(1, PALETTE.chevronDark);

      // Only the V travels, and only on the top chevron. Moving the whole
      // bracket reads as the part coming loose from the ring.
      ctx.save();
      if (number === 7 && this.topDrop > 0.001) {
        ctx.translate(0, R * TOP_DROP * this.topDrop);
      }

      ctx.fillStyle = mg;
      ctx.fill(vee);
      ctx.strokeStyle = PALETTE.chevronEdge;
      ctx.lineWidth = edge;
      ctx.stroke(vee);

      // The channel, sunk into the V.
      ctx.fillStyle = 'rgba(4, 12, 20, 0.95)';
      ctx.fill(channel);
      ctx.strokeStyle = 'rgba(120, 140, 158, 0.35)';
      ctx.lineWidth = edge;
      ctx.stroke(channel);

      // Arm slats, carried by the V.
      ctx.fillStyle = 'rgba(10, 20, 30, 0.85)';
      ctx.fill(slats);
      if (lit > 0.001) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.shadowColor = PALETTE.chevronLit;
        ctx.shadowBlur = R * 0.02;
        ctx.fillStyle = PALETTE.chevronLitHot;
        ctx.globalAlpha = lit * 0.85;
        ctx.fill(slats);
        ctx.restore();
      }

      ctx.restore(); // the V travel

      // The wing across the top is bolted to the ring. It goes on over the V
      // so the V slides out from under it rather than opening a gap.
      ctx.fillStyle = mg;
      ctx.fill(wing);
      ctx.strokeStyle = PALETTE.chevronEdge;
      ctx.lineWidth = edge;
      ctx.stroke(wing);

      // Illuminated element. It rides outward as the V drops inward, so the
      // two pull apart and the chevron reads as coming open rather than as
      // stretching. Driven off topDrop rather than a tween of its own: that is
      // what keeps it locked to the movement instead of running on its own
      // clock. Drawn after the wing so it passes in front of the metal.
      ctx.save();
      if (number === 7 && this.topDrop > 0.001) {
        ctx.translate(0, -R * TOP_RISE * this.topDrop);
      }

      ctx.fillStyle = 'rgba(8, 24, 38, 0.9)';
      ctx.fill(light);

      if (lit > 0.001) {
        const flash = entry && entry.flash ? entry.flash : this.glyphFlash * 0.7;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.shadowColor = PALETTE.chevronLit;
        ctx.shadowBlur = R * (0.045 + flash * 0.1);
        const wg = ctx.createLinearGradient(0, -R * 1.03, 0, -R * 0.855);
        wg.addColorStop(0, PALETTE.chevronLit);
        wg.addColorStop(0.55, PALETTE.chevronLitHot);
        wg.addColorStop(1, PALETTE.chevronLit);
        ctx.fillStyle = wg;
        ctx.globalAlpha = lit;
        ctx.fill(light);
        ctx.fill(light); // second pass to bloom the core
        ctx.restore();
      }

      ctx.strokeStyle = lit > 0.001 ? 'rgba(255, 214, 160, 0.9)' : 'rgba(150, 172, 190, 0.5)';
      ctx.lineWidth = edge;
      ctx.stroke(light);
      ctx.restore(); // the element riding out

      ctx.restore();

      // Chevron index, sitting outside the body in screen space.
      const lx = Math.sin(theta) * R * 1.09;
      const ly = -Math.cos(theta) * R * 1.09;
      ctx.fillStyle = lit > 0.5 ? 'rgba(255, 180, 110, 0.95)' : 'rgba(90, 150, 190, 0.55)';
      ctx.font = `${Math.max(8, R * 0.042)}px "Cascadia Mono", Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(number), lx, ly);
    }
  }

  _drawKawoosh(ctx, R, t, time) {
    const aR = R * R_APERTURE;
    // Burst out past the ring, then snap back to the gate plane.
    const out = t < 0.42 ? easeOutCubic(t / 0.42) : 1 - easeInOutCubic((t - 0.42) / 0.58);
    const radius = aR * (0.08 + out * 1.42);
    const alpha = t < 0.42 ? 1 : clamp(1 - (t - 0.42) / 0.5, 0, 1);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Turbulent leading edge.
    ctx.beginPath();
    const lobes = 22;
    for (let i = 0; i <= lobes; i++) {
      const a = (i / lobes) * TAU;
      const wobble =
        1 +
        0.16 * out * Math.sin(a * 5 + time * 14) +
        0.1 * out * Math.sin(a * 9 - time * 9) +
        0.06 * Math.sin(a * 17 + time * 21);
      const r = radius * wobble;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    const g = ctx.createRadialGradient(0, 0, radius * 0.1, 0, 0, radius);
    g.addColorStop(0, `rgba(255, 255, 255, ${0.95 * alpha})`);
    g.addColorStop(0.4, `rgba(190, 236, 255, ${0.8 * alpha})`);
    g.addColorStop(0.78, `rgba(63, 185, 255, ${0.6 * alpha})`);
    g.addColorStop(1, `rgba(20, 110, 210, 0)`);
    ctx.fillStyle = g;
    ctx.fill();

    // Bright core flash on the way out.
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, aR * (0.5 + out));
    core.addColorStop(0, `rgba(255, 255, 255, ${0.6 * alpha * (1 - out * 0.5)})`);
    core.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, aR * (0.5 + out), 0, TAU);
    ctx.fill();

    ctx.restore();
  }
}
