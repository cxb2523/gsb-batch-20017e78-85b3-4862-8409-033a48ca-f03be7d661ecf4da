// js/quality.js: graphics quality, 'high' (sky, clouds, more particles) or 'low' (the plain look), and the frame-rate
// measurement that picks it.
//
// Setting (saved): 'auto' (default), 'high' or 'low'. Auto starts at high and, once a flight has run a few seconds,
// measures 5 s of frames: under 45 fps on average, or over 10 % of frames slower than 33 ms (visible stutter), and
// it drops to low and remembers that for this browser. It tries high first because the frame rate never goes above
// the screen's refresh rate: 60 fps on low says nothing about whether high would also make 60. Choosing Auto again
// clears the memory and tries high once more.
//
// Every change (a click on the Graphics button in the hangar or on the pause screen, and the Auto measurement
// dropping the level) goes through set(), which announces it on one notification chain (onChange). The game
// responds where the graphics are drawn instead of testing the setting at the button: main.js switches the sky
// (sky.js) on or off and refreshes the pause screen, effects.js builds each new explosion and missile trail for the
// level in force. A switch rebuilds and disposes nothing — the sky reuses its dome, clouds and sun, and the
// particle pools keep their fixed slots — so toggling back and forth adds no geometries or textures.

import { Save } from './save.js';

const WARMUP_MS = 3000;          // the first seconds of a flight load things and are slow on every device
const WINDOW_MS = 5000;          // how much flying one judgment looks at
const MIN_FPS = 45, MAX_SLOW = 0.1, SLOW_MS = 1000 / 30;
const SETTINGS = ['auto', 'high', 'low'];

export const Quality = {
  setting() { return ['high', 'low'].includes(Save.data.quality) ? Save.data.quality : 'auto'; },
  get level() { const s = this.setting(); return s === 'auto' ? (Save.data.qualityAuto === 'low' ? 'low' : 'high') : s; },
  get high() { return this.level === 'high'; },
  // the button names the setting; for Auto the level it picked is shown as well ("Auto (High)")
  settingLabel() { const s = this.setting(); return s === 'auto' ? 'Auto' : s === 'high' ? 'High' : 'Low'; },
  label() { const s = this.setting(); return s === 'auto' ? `Auto (${this.level === 'high' ? 'High' : 'Low'})` : s === 'high' ? 'High' : 'Low'; },

  listeners: [],
  // subscribe to level changes; returns a function that unsubscribes
  onChange(fn) { this.listeners.push(fn); return () => { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); }; },
  // (the listeners get the level in force and the setting it belongs to; a new array, so a listener may unsubscribe
  //  while the chain runs)
  emit() { const level = this.level, setting = this.setting(); for (const fn of this.listeners.slice()) fn(level, setting); },

  // change the setting and announce it when anything the game draws changes: the level (High <-> Low), or only the
  // name of the setting while the level stays the same (e.g. Auto(High) -> High; the sky does not change, but the
  // hangar and pause buttons must show the new name)
  set(next) {
    next = SETTINGS.includes(next) ? next : 'auto';
    const beforeLevel = this.level, beforeSetting = this.setting();
    Save.data.quality = next;
    if (next === 'auto') Save.data.qualityAuto = null;   // Auto again: measure afresh, starting from high
    Save.write();
    this.resetSampling();
    if (this.level !== beforeLevel || this.setting() !== beforeSetting) this.emit();
    return next;
  },
  // the button: Auto -> High -> Low -> Auto (back to Auto = test again from high)
  cycle() { return this.set({ auto: 'high', high: 'low', low: 'auto' }[this.setting()]); },

  // frame timing, fed by main.js with each frame's real duration while flying (not paused, tab visible)
  frames: [], warm: 0, last: null,
  resetSampling() { this.frames = []; this.warm = 0; },
  sample(ms) {
    // a second or more: a pause in the page (a hidden tab is not sampled at all, see main.js), not a frame to judge.
    // (It was 250 ms, which also threw away every frame of a really slow device, so Auto never lowered it.)
    if (!(ms > 0) || ms >= 1000) return;
    if (this.warm < WARMUP_MS) { this.warm += ms; return; }
    this.frames.push(ms);
    let total = 0;
    for (const f of this.frames) total += f;
    while (total > WINDOW_MS && this.frames.length > 1) total -= this.frames.shift();
    if (total < WINDOW_MS * 0.95) return;
    const slow = this.frames.filter(f => f > SLOW_MS).length / this.frames.length;
    this.last = { fps: Math.round(1000 * this.frames.length / total), slow: Math.round(slow * 100) };
    if (this.setting() === 'auto' && this.level === 'high' && (this.last.fps < MIN_FPS || slow > MAX_SLOW)) {
      // the Auto measurement drops this device to low and remembers it; same notification chain as the button, so
      // the sky and the effects follow at once (not only on the next take-off)
      Save.data.qualityAuto = 'low';
      Save.write();
      this.resetSampling();
      this.emit();
    }
  },
  // "58 fps · 2 % slow frames · Graphics: Auto (High)"
  readout() {
    const m = this.last ? `${this.last.fps} fps · ${this.last.slow} % slow frames` : 'measuring frame rate...';
    return `${m} · Graphics: ${this.label()}`;
  },
};
