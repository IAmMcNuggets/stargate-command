'use strict';
/*
 * Gate audio, in two layers.
 *
 * Recordings in public/sfx/ are used when they are there. Everything still
 * has a synthesized version behind it, built from oscillators and noise
 * buffers, so the launcher works with the sfx folder deleted - which matters,
 * because whether those files ship is a licensing question, not a technical
 * one.
 *
 * They play through HTMLAudioElement rather than being decoded into the Web
 * Audio graph: the desktop app loads its page over file://, where fetch is
 * blocked, and createMediaElementSource on a file:// element is not reliably
 * permitted either. An element plays, takes a volume, and stops, which is all
 * this needs.
 */

const SFX = {
  chevronLock: 'sfx/chevron-lock.mp3',
  chevronEncoded: 'sfx/chevron-encoded.mp3',
  dhdPress: 'sfx/dhd-press.mp3',
  ringSpin: 'sfx/ring-spin.mp3',
  wormholeOpen: 'sfx/wormhole-open.mp3',
  wormholeClose: 'sfx/wormhole-close.mp3',
  irisOpen: 'sfx/iris-open.mp3',
  irisClose: 'sfx/iris-close.mp3',
  dialFail: 'sfx/dial-fail.mp3',
};

class GateAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this._spin = null;
    this._hum = null;
    this._noise = null;

    this._samples = {};
    this._playing = [];
    this._spinEl = null;
    this._spinTimer = null;
    this._loadSamples();
  }

  /* ---------------- recordings ---------------- */

  /*
   * Probed once at startup. A file that is missing or unplayable leaves its
   * entry unready and the synthesized version answers instead.
   */
  _loadSamples() {
    for (const name of Object.keys(SFX)) {
      const entry = { src: SFX[name], ready: false };
      this._samples[name] = entry;
      try {
        const el = new Audio(entry.src);
        el.preload = 'auto';
        el.addEventListener('canplaythrough', () => { entry.ready = true; }, { once: true });
        el.addEventListener('error', () => { entry.ready = false; }, { once: true });
        entry.el = el;
      } catch (_) {
        /* no Audio here: synth only */
      }
    }
  }

  hasSample(name) {
    const e = this._samples[name];
    return !!(e && e.ready && this.enabled);
  }

  /**
   * Drop an element from the playing list.
   *
   * Every route out of _play has to come through here. Pausing a sound does
   * not fire `ended`, so a faded-out spin would otherwise sit in the list
   * forever, and the list would grow by one for every dial you ever ran.
   */
  _retire(el) {
    const i = this._playing.indexOf(el);
    if (i >= 0) this._playing.splice(i, 1);
  }

  /**
   * Fire a recording. Each shot gets its own element so a quick run of
   * chevron locks overlaps rather than cutting itself off.
   * @returns {HTMLAudioElement|null} the element, so callers can stop it
   */
  _play(name, volume) {
    if (!this.hasSample(name)) return null;
    try {
      const el = new Audio(this._samples[name].src);
      el.volume = Math.max(0, Math.min(1, volume === undefined ? 0.9 : volume));
      const done = () => this._retire(el);
      el.addEventListener('ended', done, { once: true });
      el.addEventListener('error', done, { once: true });
      this._playing.push(el);
      const p = el.play();
      if (p && p.catch) p.catch(done);
      return el;
    } catch (_) {
      return null;
    }
  }

  /** Ease a playing element down and stop it, so cuts are not abrupt. */
  _fadeOut(el, ms) {
    if (!el) return;
    const steps = 8;
    const step = Math.max(8, (ms || 140) / steps);
    const from = el.volume;
    let i = steps;
    const tick = setInterval(() => {
      i -= 1;
      if (i <= 0) {
        clearInterval(tick);
        try { el.pause(); el.currentTime = 0; } catch (_) { /* gone */ }
        this._retire(el);
        return;
      }
      try { el.volume = Math.max(0, from * (i / steps)); } catch (_) { clearInterval(tick); }
    }, step);
  }

  stopAllSamples() {
    for (const el of this._playing.slice()) {
      try { el.pause(); } catch (_) { /* gone */ }
    }
    this._playing.length = 0;
    this._spinEl = null;
    if (this._spinTimer) {
      clearTimeout(this._spinTimer);
      this._spinTimer = null;
    }
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
      this.stopAllSamples();
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

  chevronEncoded() {
    if (this._play('chevronEncoded', 0.85)) return;
  }

  /** The heavy mechanical clunk of a chevron locking. */
  chevronLock(final) {
    if (this._play('chevronLock', final ? 1 : 0.85)) return;
    this._synthChevronLock(final);
  }

  _synthChevronLock(final) {
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

  /**
   * The rumble while the inner ring turns.
   *
   * The recording runs far longer than most spins, which are about a third
   * of a second upwards, so it is faded out when the ring stops rather than
   * left playing over the chevron lock.
   */
  startSpin(duration) {
    if (this.hasSample('ringSpin')) {
      this.stopSpin();
      const el = this._play('ringSpin', 0.75);
      if (el) {
        this._spinEl = el;
        const ms = Math.max(60, (duration || 0.4) * 1000);
        this._spinTimer = setTimeout(() => this._fadeOut(el, 160), ms);
        return;
      }
    }
    this._synthStartSpin(duration);
  }

  _synthStartSpin(duration) {
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
    if (this._spinTimer) {
      clearTimeout(this._spinTimer);
      this._spinTimer = null;
    }
    if (this._spinEl) {
      this._fadeOut(this._spinEl, 120);
      this._spinEl = null;
    }
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
    if (this._play('wormholeOpen', 1)) return;
    this._synthKawoosh(duration);
  }

  _synthKawoosh(duration) {
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

  /**
   * The gate shutting down. There was no synthesized equivalent, so without
   * the recording this stays silent rather than borrowing a sound that means
   * something else.
   */
  wormholeClose() {
    this._play('wormholeClose', 0.9);
  }

  /**
   * A key going down on the DHD. Falls back to the blip these made before,
   * so the keyboard still answers a press without the recording.
   */
  dhdPress() {
    if (this._play('dhdPress', 0.85)) return;
    this.chevronLight();
  }

  /** The trinium blades. Falls back to the chevron clunk, as it used to. */
  iris(closed) {
    if (this._play(closed ? 'irisClose' : 'irisOpen', 0.9)) return;
    this._synthChevronLock(false);
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
    if (this._play('dialFail', 0.9)) return;
    this._synthError();
  }

  _synthError() {
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
