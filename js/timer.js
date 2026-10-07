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

// Epoch-based stopwatch: elapsed is always derived from (now - startEpochMs),
// so it stays correct even if the screen locks, the tab is backgrounded, or
// setInterval gets throttled — there is nothing to "catch up" on resume.
export class Stopwatch {
  constructor(onTick) {
    this.onTick = onTick;
    this.startEpochMs = null;
    this.intervalId = null;
  }
  start(startEpochMs) {
    this.startEpochMs = startEpochMs;
    this._tick();
    this.intervalId = setInterval(() => this._tick(), 1000);
  }
  _tick() {
    if (!this.startEpochMs) return;
    this.onTick((Date.now() - this.startEpochMs) / 1000);
  }
  forceTick() { this._tick(); }
  getElapsed() {
    if (!this.startEpochMs) return 0;
    return (Date.now() - this.startEpochMs) / 1000;
  }
  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    const total = this.getElapsed();
    this.startEpochMs = null;
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

// Voice announcement via Web Speech API (plays through connected headphones too).
// Must first be triggered from a user gesture (tap) on iOS, otherwise it's silently blocked.
export function speak(text, lang = 'he-IL') {
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 1;
    u.volume = 1;
    window.speechSynthesis.speak(u);
  } catch (e) { /* speech not available */ }
}

// Call once on a user gesture (e.g. the "start workout" tap) to unlock speech on iOS.
export function primeSpeech() {
  try {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch (e) { /* noop */ }
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
  forceTick() { this._tick(); }
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
