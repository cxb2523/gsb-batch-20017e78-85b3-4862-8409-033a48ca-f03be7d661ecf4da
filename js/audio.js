// Thin wrapper around the synthesis worklet. Nothing is sampled or downloaded.
//
// Audio is a luxury, never a dependency: if the browser has no AudioWorklet or
// the module fails to load, start() warns once and the simulator carries on
// silently. Every call below is a no-op until the graph is actually running.
export class Sound {
  constructor() { this.ctx = null; this.node = null; this.muted = false; this.ready = false; }

  async start() {
    if (this.ready) { this._resume(); return; }
    try {
      const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
      if (!AC) throw new Error('Web Audio is not available');
      if (!this.ctx) this.ctx = new AC({ latencyHint: 'interactive' });
      if (!this.ctx.audioWorklet || typeof AudioWorkletNode !== 'function') throw new Error('AudioWorklet is not available');
      await this.ctx.audioWorklet.addModule('js/engine-worklet.js');
      this.node = new AudioWorkletNode(this.ctx, 'flight-sound', { numberOfInputs: 0, outputChannelCount: [2] });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;
      this.node.connect(this.gain).connect(this.ctx.destination);
      this.ready = true;
      this._resume();
    } catch (err) {
      this.ready = false;
      console.warn('audio unavailable', err);
    }
  }

  _resume() { try { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); } catch (_) { /* audio is optional */ } }

  setLevel(v) {
    if (!this.ready) return;
    try { this.gain.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.15); } catch (_) { /* audio is optional */ }
  }

  update(params) { if (this.ready) { try { this.node.port.postMessage(params); } catch (_) { /* audio is optional */ } } }

  touch(strength) { if (this.ready) { try { this.node.port.postMessage({ touch: strength }); } catch (_) { /* audio is optional */ } } }

  // Forget everything the worklet has smoothed or accumulated. Called when the
  // aircraft is swapped, re-placed or the menu is entered, so the next flight
  // never starts with the last one's revs or ignition state.
  reset() { if (this.ready) { try { this.node.port.postMessage({ reset: true }); } catch (_) { /* audio is optional */ } } }

  stop() { if (this.ready) { try { this.node.disconnect(); this.gain.disconnect(); } catch (_) {} } this.ready = false; this.node = null; this.gain = null; }
}
