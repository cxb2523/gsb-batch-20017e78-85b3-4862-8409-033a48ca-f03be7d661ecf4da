// The engine and electrical state the sound worklet needs, read from the
// flight model and the systems module instead of being guessed from rpm alone.
//
// `firing` is the truth from the flight model (ignition, fuel, cut-out, crash),
// `magnetos` is how many ignition circuits are still live (0, 1 or 2), `volts`
// is the battery/bus voltage the starter has to work with, and `seized` is the
// oil-starvation seizure the systems module models. No DOM, no three.js, so
// test/audio.mjs can drive it headless.
export function engineSoundState(fm, systems) {
  const o = fm.out;
  const magsLive = systems && systems.magsLive != null ? systems.magsLive : 2;
  return {
    rpm: o.rpm,
    load: fm.ctl.throttle,
    firing: o.firing ? 1 : 0,
    magnetos: magsLive / 2,                 // 0 off, 0.5 one magneto, 1 both
    volts: systems && systems.volts != null ? systems.volts : 0,
    powered: systems && systems.powered ? 1 : 0,
    seized: systems && systems.seized ? 1 : 0,
  };
}
