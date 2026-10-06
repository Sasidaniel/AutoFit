// timer.js — workout stopwatch + rest countdown with sound/vibration
export function formatHMS(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export class Stopwatch {
  constructor(onTick) {
    this.onTick = onTick;
    this.startedAt = null;
    this.accumulated = 0; // seconds already elapsed before current run
    this.intervalId = null;
  }
  start(resumeFromSeconds = 0) {
    this.accumulated = resumeFromSeconds;
    this.startedAt = Date.now();
    this._tick();
    this.intervalId = setInterval(() => this._tick(), 1000);
  }
  _tick() {
    const elapsed = this.accumulated + (Date.now() - this.startedAt) / 1000;
    this.onTick(elapsed);
  }
  getElapsed() {
    if (!this.startedAt) return this.accumulated;
    return this.accumulated + (Date.now() - this.startedAt) / 1000;
  }
  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    const total = this.getElapsed();
    this.startedAt = null;
    this.accumulated = total;
    return total;
  }
}

let audioCtx = null;
export function playBeep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtx;
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.value = 0.2;
      o.connect(g).connect(ctx.destination);
      const t = ctx.currentTime + i * 0.25;
      o.start(t);
      o.stop(t + 0.15);
    }
  } catch (e) { /* audio not available */ }
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
}

export class RestTimer {
  constructor({ onTick, onDone }) {
    this.onTick = onTick;
    this.onDone = onDone;
    this.endAt = null;
    this.intervalId = null;
  }
  start(seconds) {
    this.stop();
    this.endAt = Date.now() + seconds * 1000;
    this._tick();
    this.intervalId = setInterval(() => this._tick(), 250);
  }
  addSeconds(seconds) {
    if (!this.endAt) return;
    this.endAt += seconds * 1000;
    this._tick();
  }
  _tick() {
    const remaining = (this.endAt - Date.now()) / 1000;
    if (remaining <= 0) {
      this.onTick(0);
      this.stop();
      this.onDone();
      return;
    }
    this.onTick(remaining);
  }
  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.endAt = null;
  }
  isRunning() {
    return this.intervalId !== null;
  }
}
