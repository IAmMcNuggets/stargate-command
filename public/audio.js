'use strict';
/*
 * Synthesized gate audio. No sample files — everything is built from
 * oscillators and noise buffers so the launcher stays a single folder.
 */

class GateAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this._spin = null;
    this._hum = null;
    this._noise = null;
  }

  /** Must be called from a user gesture the first time. */
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this.stopSpin();
      this.stopHum();
    }
    if (this.master) this.master.gain.value = on ? 0.55 : 0;
  }

  _noiseBuffer() {
    if (this._noise) return this._noise;
    const ctx = this.ctx;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noise = buf;
    return buf;
  }

  _ok() {
    return this.enabled && this.ensure();
  }

  /* ---------------- one-shots ---------------- */

  blip(freq) {
    if (!this._ok()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(freq || 1180, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.045, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.06);
  }

  /** The heavy mechanical clunk of a chevron locking. */
  chevronLock(final) {
    if (!this._ok()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // Body thump.
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(final ? 120 : 96, t);
    o.frequency.exponentialRampToValueAtTime(final ? 32 : 42, t + 0.34);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(final ? 0.75 : 0.5, t + 0.012);
    og.gain.exponentialRampToValueAtTime(0.0001, t + (final ? 0.7 : 0.42));
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.8);

    // Impact transient.
    const n = ctx.createBufferSource();
    n.buffer = this._noiseBuffer();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1400, t);
    bp.frequency.exponentialRampToValueAtTime(240, t + 0.2);
    bp.Q.value = 1.1;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.28, t + 0.008);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    n.connect(bp).connect(ng).connect(this.master);
    n.start(t);
    n.stop(t + 0.35);

    // Metallic ring-off.
    [612, 947, 1483].forEach((f, i) => {
      const m = ctx.createOscillator();
      const mg = ctx.createGain();
      m.type = 'triangle';
      m.frequency.setValueAtTime(f * (final ? 1.15 : 1), t);
      mg.gain.setValueAtTime(0.0001, t);
      mg.gain.exponentialRampToValueAtTime(0.05 / (i + 1), t + 0.01);
      mg.gain.exponentialRampToValueAtTime(0.0001, t + 0.5 - i * 0.1);
      m.connect(mg).connect(this.master);
      m.start(t);
      m.stop(t + 0.6);
    });
  }

  /**
   * A numbered chevron latching. Lighter and brighter than the grab — the
   * grab is the ring stopping dead, this is just the lamp coming up.
   */
  chevronLight() {
    if (!this._ok()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(430, t);
    o.frequency.exponentialRampToValueAtTime(196, t + 0.16);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.3);

    const n = ctx.createBufferSource();
    n.buffer = this._noiseBuffer();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2600, t);
    bp.Q.value = 2.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.09, t + 0.006);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    n.connect(bp).connect(ng).connect(this.master);
    n.start(t);
    n.stop(t + 0.16);
  }

  /** The rumble while the inner ring turns. */
  startSpin(duration) {
    if (!this._ok()) return;
    this.stopSpin();
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const n = ctx.createBufferSource();
    n.buffer = this._noiseBuffer();
    n.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(300, t);
    lp.Q.value = 3;

    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(46, t);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + Math.min(0.14, duration * 0.3));
    g.gain.setValueAtTime(0.16, t + Math.max(0.02, duration - 0.1));
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.06);

    n.connect(lp).connect(g).connect(this.master);
    o.connect(g);
    n.start(t);
    o.start(t);
    this._spin = { n, o, g, stopAt: t + duration + 0.12 };
    n.stop(t + duration + 0.14);
    o.stop(t + duration + 0.14);
  }

  stopSpin() {
    if (!this._spin) return;
    try {
      this._spin.n.stop();
      this._spin.o.stop();
    } catch (_) {
      /* already stopped */
    }
    this._spin = null;
  }

  /** Unstable vortex eruption. */
  kawoosh(duration) {
    if (!this._ok()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const d = (duration || 900) / 1000;

    const n = ctx.createBufferSource();
    n.buffer = this._noiseBuffer();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(220, t);
    lp.frequency.exponentialRampToValueAtTime(7200, t + d * 0.4);
    lp.frequency.exponentialRampToValueAtTime(320, t + d);
    lp.Q.value = 1.4;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.62, t + d * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d * 1.05);

    n.connect(lp).connect(g).connect(this.master);
    n.start(t);
    n.stop(t + d * 1.1);

    // Sub-bass whump under the roar.
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(28, t + d);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.5, t + d * 0.3);
    og.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + d + 0.1);
  }

  /** The idle shimmer of an open wormhole. */
  startHum() {
    if (!this._ok()) return;
    this.stopHum();
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.4);

    const oscs = [58, 58.7, 174].map((f, i) => {
      const o = ctx.createOscillator();
      o.type = i === 2 ? 'triangle' : 'sine';
      o.frequency.value = f;
      o.connect(g);
      o.start(t);
      return o;
    });

    const n = ctx.createBufferSource();
    n.buffer = this._noiseBuffer();
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.value = 0.02;
    n.connect(bp).connect(ng).connect(g);
    n.start(t);

    g.connect(this.master);
    this._hum = { g, oscs, n };
  }

  stopHum() {
    if (!this._hum) return;
    const { g, oscs, n } = this._hum;
    const t = this.ctx.currentTime;
    try {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      oscs.forEach((o) => o.stop(t + 0.35));
      n.stop(t + 0.35);
    } catch (_) {
      /* already stopped */
    }
    this._hum = null;
  }

  /** Failed dial. */
  error() {
    if (!this._ok()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    [0, 0.16].forEach((off) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(220, t + off);
      o.frequency.exponentialRampToValueAtTime(70, t + off + 0.22);
      g.gain.setValueAtTime(0.0001, t + off);
      g.gain.exponentialRampToValueAtTime(0.25, t + off + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.24);
      o.connect(g).connect(this.master);
      o.start(t + off);
      o.stop(t + off + 0.3);
    });
  }
}
