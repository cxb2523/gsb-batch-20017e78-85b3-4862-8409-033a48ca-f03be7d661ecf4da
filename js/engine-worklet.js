// Every sound is synthesised here, sample by sample, from the physics:
// four cylinders firing through exhaust resonances at the real crank speed,
// two blades passing at the same rate, air over the airframe scaled by dynamic
// pressure, tyres, the reed stall horn, flap motor, starter, rain.
//
// The engine is not a fixed roar. It fires only while the ignition is live and
// the engine is neither cut out nor seized; with one magneto down only every
// other cylinder event lights and the exhaust is quieter; the starter only
// turns when the battery can feed it, and a flat battery cranks weakly. The
// main loop posts the real state from the flight model and the systems module,
// once per frame. Parameters are smoothed per block so a switch flip or an
// aircraft swap never clicks or carries the last aircraft's revs.
//
// The class is exported so test/audio.mjs can drive it directly with a fake
// audio context: under node the base class and sampleRate are simply absent.

// AudioWorkletGlobalScope supplies AudioWorkletProcessor. Under node (tests)
// it does not, so fall back to a minimal base with the same message port.
const FALLBACK_BASE = class {
  constructor() { this.port = { onmessage: null, postMessage() {} }; }
};
const Base = typeof AudioWorkletProcessor === 'function' ? AudioWorkletProcessor : FALLBACK_BASE;

class SVF {
  constructor() { this.low = 0; this.band = 0; }
  clear() { this.low = 0; this.band = 0; }
  // returns band-pass; this.low holds the low-pass
  run(x, f, q) {
    this.low += f * this.band;
    const high = x - this.low - q * this.band;
    this.band += f * high;
    return this.band;
  }
}

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export class FlightSound extends Base {
  constructor() {
    super();
    // What the main loop tells us. The defaults are a silent, unpowered aircraft:
    // nothing sounds until the real state arrives or reset() clears it.
    this.defaults = {
      rpm: 0, load: 0, firing: 0, magnetos: 1, volts: 0, powered: 0, seized: 0, starter: 0,
      speed: 0, interior: 1, roll: 0, stall: 0, flap: 0, rain: 0, doppler: 1, turb: 0, distance: 1, scrape: 0,
    };
    // Per-parameter time constants (seconds), applied once per 128-sample block.
    // Ignition and electrics move fastest; the airframe sounds are lazier.
    this.tau = {
      rpm: 0.06, load: 0.12, firing: 0.04, magnetos: 0.12, volts: 0.2, powered: 0.03, seized: 0.05, starter: 0.03,
      speed: 0.15, interior: 0.15, roll: 0.1, stall: 0.1, flap: 0.1, rain: 0.2, doppler: 0.1, turb: 0.2, distance: 0.15, scrape: 0.05,
    };
    this.p = { ...this.defaults };
    this.s = { ...this.defaults };
    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.reset) { this.pendingReset = true; return; }
      if (d.touch) { this.chirp = Math.min(1, d.touch); this.thump = Math.min(1, d.touch * 1.2); return; }
      for (const k in d) if (k in this.p) { const v = +d[k]; this.p[k] = Number.isFinite(v) ? v : 0; }
    };
    this.cylAmp = [1.0, 0.84, 0.95, 0.78];
    this.r1 = new SVF(); this.r2 = new SVF(); this.r3 = new SVF(); this.mech = new SVF();
    this.windL = new SVF(); this.windR = new SVF(); this.rumble = new SVF(); this.gnd = new SVF(); this.chirpF = new SVF();
    this.filters = [this.r1, this.r2, this.r3, this.mech, this.windL, this.windR, this.rumble, this.gnd, this.chirpF];
    this.lpL = 0; this.lpR = 0; this.lp2L = 0; this.lp2R = 0;
    this.horn = 0; this.flapPh = 0; this.startPh = 0; this.thumpPh = 0;
    this.chirp = 0; this.thump = 0; this.rainLp = 0; this.slow = 0; this.bump = 0;
    this.hornEnv = 0; this.flapEnv = 0; this.sparks = 0;
    this.mute = 1; this.pendingReset = false;
    this.resetDynamics();
  }

  // Forget every piece of running state (oscillator phases, filters, pulse
  // train). Used when the aircraft is swapped or re-placed: no revs or
  // combustion from the last flight may leak into the next. The hard reset
  // itself is held until the output has faded to silence (see process), so it
  // never clicks.
  reset() {
    Object.assign(this.p, this.defaults);
    Object.assign(this.s, this.defaults);
    this.resetDynamics();
  }

  resetDynamics() {
    this.crank = 0; this.cyl = 0; this.exc = 0; this.half = 0; this.sparks = 0;
    this.startPh = 0; this.thumpPh = 0; this.horn = 0; this.flapPh = 0;
    this.chirp = 0; this.thump = 0; this.rainLp = 0; this.slow = 0; this.bump = 0;
    this.hornEnv = 0; this.flapEnv = 0;
    this.lpL = this.lpR = this.lp2L = this.lp2R = 0;
    for (const f of this.filters) f.clear();
  }

  process(_, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    const sr = typeof sampleRate === 'number' ? sampleRate : 48000;
    const p = this.p, s = this.s, n = L.length;
    // A reset fades the output out, clears the running state at digital silence,
    // and fades back in. Nothing of the previous aircraft survives the gap.
    if (this.pendingReset && this.mute < 0.002) { this.pendingReset = false; this.reset(); }
    const resetting = this.pendingReset;
    const rpm0 = s.rpm;
    // Smooth every parameter towards what the main loop last posted. A block is
    // about 2.7 ms, so the ignition state settles in tens of milliseconds and
    // the airframe sounds in a fraction of a second: no steps, no clicks.
    const blockSec = n / sr;
    for (const k in s) s[k] += (p[k] - s[k]) * (1 - Math.exp(-blockSec / (this.tau[k] || 0.1)));
    const TWO_PI = Math.PI * 2;
    const pulseDecay = Math.exp(-1 / (sr * 0.0035));
    const fz = (hz) => 2 * Math.sin(Math.PI * Math.min(hz, sr * 0.22) / sr);
    const f1 = fz(92 * s.doppler), f2 = fz(215 * s.doppler), f3 = fz(470 * s.doppler), fm = fz(1400);
    const V = s.speed;
    const fw = fz(260 + 13 * V), frum = fz(110), fg = fz(70), fc = fz(1150);
    const windGain = Math.min(1.3, (V / 62) * (V / 62)) * (0.20 + 0.16 * (1 - s.interior));
    const cut = 1 - Math.exp(-TWO_PI * (1500 + 6500 * (1 - s.interior)) / sr);
    const rpmN = Math.min(1.2, s.rpm / 2700);
    const propAmp = Math.pow(rpmN, 2.3) * (0.20 + 0.25 * (1 - s.interior));
    const beta = 0.3 + 1.9 * rpmN * rpmN;
    const engGain = (0.55 + 0.45 * s.load) * (0.5 + 0.5 * Math.min(1, s.rpm / 800));
    // Combustion only while the ignition is live and the engine is not seized.
    // magnetos: 1 = both circuits, 0.5 = one magneto left, 0 = off.
    const comb = clamp(s.firing, 0, 1) * (1 - clamp(s.seized, 0, 1));
    const mags = clamp(s.magnetos, 0, 1) * 2;              // live ignition circuits, 0..2
    const magGain = mags < 0.05 ? 0 : 0.45 + 0.55 * (mags / 2);
    const singleMag = mags < 1.5;
    const voltsN = clamp(s.volts / 28, 0, 1.2);
    // A starter solenoid needs a battery behind it: with no power, or below about
    // 10 V, nothing turns; a sagging battery cranks weakly.
    const starterOn = s.starter > 0.02 && s.powered > 0.5 && s.volts > 10 && comb < 0.5;
    const starterAmp = s.starter * clamp(s.powered, 0, 1) * (0.15 + 0.85 * voltsN);
    const dist = s.distance;
    for (let i = 0; i < n; i++) {
      const rpm = rpm0 + (s.rpm - rpm0) * (i / n);
      const w1 = Math.random() * 2 - 1, w2 = Math.random() * 2 - 1;
      // ---- engine: a spark at every cylinder event (twice per crank turn),
      // unless only one magneto is left, when every other event goes unfired.
      const before = Math.floor(this.crank * 2);
      this.crank += (rpm / 60 / sr) * s.doppler;
      if (Math.floor(this.crank * 2) !== before) {
        this.half ^= 1;
        if (comb > 0.001 && mags >= 1 && !(singleMag && this.half)) {
          this.cyl = (this.cyl + 1) & 3;
          this.exc += this.cylAmp[this.cyl] * comb * magGain * (0.35 + 0.65 * s.load) * (0.9 + 0.2 * Math.random());
          this.sparks++;
        }
      }
      if (this.crank > 1024) this.crank -= 1024;
      this.exc *= pulseDecay;
      const e = this.exc;
      const eng = (this.r1.run(e, f1, 0.35) * 0.95 + this.r2.run(e, f2, 0.28) * 0.55 + this.r3.run(e, f3, 0.4) * 0.28) * engGain;
      // the propeller keeps turning whether it is driven or windmilling: that
      // blade-pass tone is air, not combustion, so it survives an engine-out
      const bp = this.crank * 2 * TWO_PI;
      const prop = Math.sin(bp + beta * Math.sin(bp)) * propAmp * (1 + 0.08 * Math.sin(this.crank * Math.PI));
      // mechanical clatter is the engine turning under its own power, not a windmill
      const mech = this.mech.run(w1, fm, 0.9) * 0.035 * rpmN * comb;
      let core = eng * 0.42 + prop + mech;
      // ---- starter: cranks only on a live battery, weaker as the volts sag
      if (starterOn) {
        this.startPh += (150 + 170 * voltsN + rpm * 0.9) / sr;
        const ph = this.startPh % 1;
        core += ((ph * 2 - 1) * 0.05 + Math.sin(this.startPh * TWO_PI * 3.01) * 0.025) * starterAmp;
      }
      // ---- air
      this.slow += (w2 - this.slow) * 0.0008;
      const gust = 1 + s.turb * this.slow * 22;
      const aL = this.windL.run(w1, fw, 1.3) * windGain * gust;
      const aR = this.windR.run(w2, fw, 1.3) * windGain * gust;
      this.rumble.run(w1 + w2, frum, 1.2);
      const low = this.rumble.low * 0.012 * Math.min(1.5, (V / 55) * (V / 55));
      // ---- wheels on the ground
      this.gnd.run(w2, fg, 0.9);
      if (s.roll > 0.5 && Math.random() < s.roll * 0.00012) this.bump = 0.6 + Math.random() * 0.5;
      this.bump *= 0.9993;
      let ground = this.gnd.low * 0.05 * Math.min(1, s.roll / 28) * (1 + this.bump * 3) + s.scrape * this.chirpF.band * 0.2;
      // ---- touchdown
      const ch = this.chirpF.run(w1, fc, 0.5);
      if (this.chirp > 0.001) { ground += ch * this.chirp * 0.5; this.chirp *= 0.99965; }
      if (this.thump > 0.001) { this.thumpPh += 58 / sr; ground += Math.sin(this.thumpPh * TWO_PI) * this.thump * 0.6; this.thump *= 0.9996; } else this.thumpPh = 0;
      // ---- stall warning: a reed that rises in pitch as the wing nears the stall
      this.hornEnv += ((s.stall > 0.05 ? 1 : 0) - this.hornEnv) * 0.002;
      let horn = 0;
      if (this.hornEnv > 0.002) {
        this.horn += (560 + 240 * s.stall) / sr;
        const h = Math.sin(this.horn * TWO_PI);
        horn = Math.tanh(h * 4 + Math.sin(this.horn * TWO_PI * 2) * 1.5) * 0.07 * this.hornEnv;
      }
      // ---- flap motor
      this.flapEnv += ((s.flap > 0.5 ? 1 : 0) - this.flapEnv) * 0.001;
      let flap = 0;
      if (this.flapEnv > 0.002) { this.flapPh += 173 / sr; flap = (((this.flapPh * 2) % 1) - 0.5 + Math.sin(this.flapPh * TWO_PI) * 0.6) * 0.022 * this.flapEnv; }
      // ---- rain on the airframe
      this.rainLp += (w1 - this.rainLp) * 0.35;
      const rain = (w1 - this.rainLp) * s.rain * 0.10;
      // cabin: the airframe swallows the highs
      const xl = (core + aL + low + ground) * dist, xr = (core + aR + low + ground) * dist;
      this.lpL += (xl - this.lpL) * cut; this.lp2L += (this.lpL - this.lp2L) * cut;
      this.lpR += (xr - this.lpR) * cut; this.lp2R += (this.lpR - this.lp2R) * cut;
      L[i] = Math.tanh((this.lp2L + horn + flap + rain) * 1.5) * 0.6;
      R[i] = Math.tanh((this.lp2R + horn + flap + rain) * 1.5) * 0.6;
      // a soft gate for the reset: 12 ms either side, far below a click
      const target = resetting ? 0 : 1;
      this.mute += (target - this.mute) * Math.min(1, 1 / (sr * 0.012));
      L[i] *= this.mute; R[i] *= this.mute;
    }
    return true;
  }
}

if (typeof registerProcessor === 'function') registerProcessor('flight-sound', FlightSound);
