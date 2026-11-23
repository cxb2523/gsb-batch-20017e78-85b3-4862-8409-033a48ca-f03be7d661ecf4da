// Drives the synthesis worklet directly, with no audio hardware, and checks
// that the sound follows the aircraft's real engine and electrical state:
// combustion only while the ignition is live, a sparser and quieter pulse
// train on one magneto, nothing but airframe noise when the engine is cut or
// seized, a starter that only turns on a live battery, and a reset that leaves
// no trace of the previous aircraft.
//
//   node test/audio.mjs
import { FlightSound } from '../js/engine-worklet.js';
import { engineSoundState } from '../js/audio-state.js';
import { Sound } from '../js/audio.js';
import { FlightModel, stillAir } from '../js/fdm.js';
import { Systems } from '../js/systems.js';

const SR = 48000, N = 128, BLOCK = N / SR;
const rows = [];
const row = (name, got, want, unit = '', tol = 0) => rows.push({ name, got, want, unit, ok: Number.isFinite(got) && Math.abs(got - want) <= tol });
const check = (name, pass, note = '') => rows.push({ name, got: pass ? 1 : 0, want: 1, unit: note, ok: !!pass });

const L = new Float32Array(N), R = new Float32Array(N);

// Run the processor for `seconds`, returning RMS, the largest sample-to-sample
// step, and how many combustion events fired.
function run(proc, seconds, after = () => {}) {
  const blocks = Math.max(1, Math.round(seconds / BLOCK));
  const sparks0 = proc.sparks;
  let sq = 0, n = 0, maxStep = 0, prev = 0;
  for (let b = 0; b < blocks; b++) {
    L.fill(0); R.fill(0);
    proc.process(null, [[L, R]]);
    for (let i = 0; i < N; i++) { const v = L[i]; sq += v * v; n++; if (i || b) maxStep = Math.max(maxStep, Math.abs(v - prev)); prev = v; }
    after();
  }
  return { rms: Math.sqrt(sq / n), maxStep, sparks: proc.sparks - sparks0 };
}
const post = (proc, d) => proc.port.onmessage({ data: d });
const quiet = { speed: 0, interior: 1, turb: 0, roll: 0, stall: 0, flap: 0, rain: 0, scrape: 0, doppler: 1, distance: 1, load: 1 };

// A settled engine at cruise rpm with both magnetos, used as the reference.
function engine(over = {}) {
  const proc = new FlightSound();
  post(proc, { ...quiet, rpm: 2400, firing: 1, magnetos: 1, powered: 1, volts: 28, seized: 0, starter: 0, ...over });
  run(proc, 0.5);                       // let the per-block smoothing settle
  return proc;
}

// ------------------------------------------------------------------ combustion
{
  const both = run(engine(), 1);
  row('Sparks per second, both magnetos at 2400 rpm', both.sparks, 80, '', 10);

  const one = run(engine({ magnetos: 0.5 }), 1);
  row('Sparks per second, one magneto', one.sparks, 40, '', 10);
  check('One magneto: sparser pulses and a quieter exhaust', one.rms < both.rms * 0.95 && one.sparks < both.sparks, `${both.rms.toFixed(3)} -> ${one.rms.toFixed(3)} rms, ${both.sparks} -> ${one.sparks} sparks`);

  const off = run(engine({ magnetos: 0, firing: 0 }), 1);
  row('Sparks per second, magnetos off', off.sparks, 0, '', 0);
  check('Engine cut: no combustion, only the windmilling propeller', off.rms > 0.002 && off.rms < both.rms * 0.8, `${off.rms.toFixed(3)} rms`);

  // A seized engine has combustion cut even if a stale firing flag arrives.
  const seized = run(engine({ seized: 1 }), 1);
  row('Sparks per second, seized engine', seized.sparks, 0, '', 0);
  check('Seized: no combustion pulses', seized.rms < both.rms * 0.8);
}

// ------------------------------------------------------------------ wind and tyres survive an engine-out
{
  const rolling = new FlightSound();
  post(rolling, { ...quiet, speed: 55, roll: 22, rpm: 1200, firing: 0, magnetos: 0, powered: 0, volts: 0 });
  run(rolling, 0.5);
  const moving = run(rolling, 1);
  check('Engine out on the runway: air and tyres remain', moving.rms > 0.01, `${moving.rms.toFixed(3)} rms`);
  check('...but distinctly quieter than the engine running', moving.rms < 0.05, `${moving.rms.toFixed(3)} rms`);
}

// ------------------------------------------------------------------ starter
{
  const p0 = new FlightSound();
  post(p0, { ...quiet, rpm: 0, firing: 0, magnetos: 0, powered: 0, volts: 0, starter: 1 });
  run(p0, 0.4);
  const dead = run(p0, 1);

  const p1 = new FlightSound();
  post(p1, { ...quiet, rpm: 0, firing: 0, magnetos: 0, powered: 1, volts: 28, starter: 1 });
  run(p1, 0.4);
  const live = run(p1, 1);

  const flat = new FlightSound();
  post(flat, { ...quiet, rpm: 0, firing: 0, magnetos: 0, powered: 1, volts: 12, starter: 1 });
  run(flat, 0.4);
  const weak = run(flat, 1);

  check('Starter is silent with no battery', dead.rms < 0.002, `${dead.rms.toFixed(4)} rms`);
  check('Starter turns on a live battery', live.rms > 0.02, `${live.rms.toFixed(3)} rms`);
  check('A flat battery cranks weakly', weak.rms < live.rms * 0.6);
}

// ------------------------------------------------------------------ smooth transitions, no clicks
{
  const proc = engine();
  run(proc, 0.3);
  post(proc, { firing: 0, magnetos: 0, rpm: 2400 });
  const trans = run(proc, 0.4);
  check('Shutting down does not click', trans.maxStep < 0.15, `largest step ${trans.maxStep.toFixed(4)}`);

  // A step in rpm as the aircraft is swapped must also fade, not pop.
  const p2 = engine({ rpm: 700 });
  run(p2, 0.3);
  post(p2, { rpm: 2700 });
  const spool = run(p2, 0.4);
  check('A step change in rpm does not click', spool.maxStep < 0.15, `largest step ${spool.maxStep.toFixed(4)}`);
}

// ------------------------------------------------------------------ reset clears the last aircraft
{
  const proc = engine({ rpm: 2600, speed: 40 });
  run(proc, 0.3);
  post(proc, { reset: true });
  run(proc, 0.1);                      // fade out and hard clear happen here
  const out = run(proc, 0.3);          // ...and this window must be the cold state
  check('Reset returns the worklet to a silent cold state', proc.p.rpm === 0 && out.rms < 0.002, `rpm ${proc.p.rpm}, ${out.rms.toFixed(4)} rms`);

  // and a fresh aircraft, posted after the reset, takes over cleanly
  post(proc, { ...quiet, rpm: 900, firing: 1, magnetos: 1, powered: 1, volts: 28 });
  const fresh = run(proc, 0.6);
  check('After reset the next aircraft sounds from its own state', fresh.sparks > 0 && proc.s.rpm > 300, `rpm ${proc.s.rpm.toFixed(0)}, ${fresh.sparks} sparks`);
}

// ------------------------------------------------------------------ state mapping from fm + systems
{
  const fm = { out: { rpm: 2200, firing: true }, ctl: { throttle: 0.7 } };
  const sys = { volts: 27.4, powered: true, seized: false, magsLive: 1 };
  const st = engineSoundState(fm, sys);
  check('Mapping: one magneto reads as half', Math.abs(st.magnetos - 0.5) < 1e-9, st.magnetos);
  check('Mapping: firing and throttle pass through', st.firing === 1 && Math.abs(st.load - 0.7) < 1e-9);
  check('Mapping: volts and power come from the systems module', st.volts === 27.4 && st.powered === 1 && st.seized === 0);
  sys.magsLive = 0; sys.seized = true; fm.out.firing = false;
  const off = engineSoundState(fm, sys);
  check('Mapping: magnetos off and a seizure are visible to the sound', off.magnetos === 0 && off.seized === 1 && off.firing === 0);
  // a missing systems module (or a glider) never throws
  const bare = engineSoundState({ out: { rpm: 0, firing: false }, ctl: { throttle: 0 } }, null);
  check('Mapping tolerates a missing systems module', bare.magnetos === 1 && bare.volts === 0);
}

// ------------------------------------------------------------------ the wrapper never throws
{
  let ready = false;
  const warn = console.warn;
  console.warn = () => {};              // start() warns once when there is no audio; expected here
  try {
    delete globalThis.window;
    globalThis.window = {};              // no AudioContext at all
    const s = new Sound();
    await s.start();
    s.update({ rpm: 100 }); s.touch(0.5); s.setLevel(0.5); s.reset(); s.stop();
    ready = !s.ready;
  } catch (e) { ready = false; } finally { console.warn = warn; }
  check('No Web Audio available: start() and every call are harmless', ready);

  let wired = null;
  try {
    const posted = [];
    class FakeNode { constructor() { this.port = { postMessage: (m) => posted.push(m) }; } connect(n) { return n; } disconnect() {} }
    class FakeGain { constructor() { this.gain = { value: 0, setTargetAtTime() {} }; } connect(n) { return n; } disconnect() {} }
    class FakeCtx {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
      createGain() { return new FakeGain(); }
      resume() { return Promise.resolve(); }
    }
    globalThis.window = { AudioContext: FakeCtx };
    globalThis.AudioWorkletNode = FakeNode;
    const s = new Sound();
    await s.start();
    s.update({ rpm: 2400, firing: 1 });
    s.reset();
    wired = s.ready && posted.some((m) => m.rpm === 2400) && posted.some((m) => m.reset === true);
  } catch (e) { wired = false; }
  check('With audio available, update and reset reach the processor', wired);
}

// ------------------------------------------------------------------ real flight model + systems
{
  // Ground run-up, then a magneto check, then a shutdown: the sound state has to
  // follow the aircraft through all three, from the modules that own the truth.
  const DT = 1 / 240, clear = { oat: 15, lwc: 0, precip: 0, humidity: 0.5, lat: 46, variation: 0 };
  const fm = new FlightModel(stillAir); fm.reset({});
  const sys = new Systems(fm);
  const runSim = (sec) => { for (let i = 0; i < sec / DT; i++) { fm.step(DT); sys.update(DT, clear); } };
  for (let k = 0; k < 30; k++) { runSim(1); fm.ctl.throttle += 0.004 * (1800 - fm.out.rpm) / 100; }
  const both = engineSoundState(fm, sys);
  check('Run-up: both magnetos, engine firing, battery live', both.magnetos === 1 && both.firing === 1 && both.powered === 1, `rpm ${both.rpm.toFixed(0)}`);

  // feed it into the synth and hear the difference at the same rpm
  const pBoth = new FlightSound(); post(pBoth, { ...quiet, ...both }); run(pBoth, 0.3);
  const sBoth = run(pBoth, 0.8);

  sys.sw.magnetos = 1; runSim(6);
  const one = engineSoundState(fm, sys);
  check('Magneto check: systems reports one live circuit', one.magnetos === 0.5 && one.firing === 1);
  const pOne = new FlightSound(); post(pOne, { ...quiet, ...one }); run(pOne, 0.3);
  const sOne = run(pOne, 0.8);
  check('Magneto check: the sound pulses less and drops in level', sOne.sparks < sBoth.sparks * 0.75 && sOne.rms < sBoth.rms * 0.95, `${sBoth.sparks} -> ${sOne.sparks} sparks`);

  sys.sw.magnetos = 0; fm.ctl.mags = false; runSim(3);
  const off = engineSoundState(fm, sys);
  check('Magnetos off: not firing, no live circuit, no sparks reach the synth', off.firing === 0 && off.magnetos === 0, `rpm ${off.rpm.toFixed(0)}`);
  const pOff = new FlightSound(); post(pOff, { ...quiet, ...off }); run(pOff, 0.3);
  const sOff = run(pOff, 0.8);
  check('Magnetos off: combustion gone and the aircraft falls quiet', sOff.sparks === 0 && sOff.rms < sBoth.rms * 0.2, `${sOff.rms.toFixed(3)} rms at ${off.rpm.toFixed(0)} rpm on the ground`);
}

const pad = (s, n) => String(s).padEnd(n);
let bad = 0;
for (const r of rows) { if (!r.ok) bad++; const shown = typeof r.want === 'number' && r.unit !== '' && r.want !== 1 ? pad(Number.isFinite(r.got) ? r.got.toFixed(3) : r.got, 10) + pad(r.want, 6) : ''; console.log(`${r.ok ? '  ok  ' : ' MISS '}${pad(r.name, 78)}${shown}${r.unit}`); }
console.log(`\n${rows.length - bad}/${rows.length}\n`);
if (bad) process.exitCode = 1;
