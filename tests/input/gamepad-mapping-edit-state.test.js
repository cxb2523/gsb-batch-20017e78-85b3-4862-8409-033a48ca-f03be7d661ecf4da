/**
 * Mapping edits (setProfileMappingEntry / removeProfileMappingEntry /
 * resetProfileMapping) are the single state-change entry point: every chain
 * that interprets physical inputs — capture detection, gameplay
 * suppression/resume (the pressed-set latches) and disconnect/reconnect —
 * must read the same freshly compiled mapping afterwards. No stale raw index,
 * no stale hat-grid decision, no phantom edge from the edit itself.
 *
 * The harness keeps a single live synthetic pad: both _processGamepad() and
 * navigator.getGamepads() (used by the edit reconciliation) see identical
 * hardware state, exactly like a real browser.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let __mockControllerProfile = null;
vi.mock('../../src/input/controller_definitions/index.js', () => ({
  findControllerProfileByGamepadId: () => __mockControllerProfile,
}));

import { GamepadRuntime } from '../../src/input/gamepad-runtime.js';
import { ActionRegistry } from '../../src/core/action-registry.js';
import { BindingStore } from '../../src/core/binding-store.js';

const PAD_ID = '054c-0ce6-DualSense Wireless Controller';

const BASE_PROFILE = {
  vendorId: '054c',
  sourceButtons: 20,
  sourceAxes: 12,
  productId: '0ce6',
  family: 'dualsense',
  mapping: {
    GP_B0: { kind: 'button', index: 1 },
    GP_B1: { kind: 'button', index: 2 },
    GP_A0N: { kind: 'axis', index: 0, direction: 'negative' },
    GP_A0P: { kind: 'axis', index: 0, direction: 'positive' },
  },
};

const HAT_PROFILE = {
  vendorId: '054c',
  sourceButtons: 20,
  sourceAxes: 12,
  productId: '0ce6',
  family: 'dualsense',
  mapping: {
    GP_B12: { kind: 'hat', index: 9, value: -1.0, tolerance: 0.2 },
    GP_B13: { kind: 'hat', index: 9, value: 0.142857, tolerance: 0.2 },
    GP_B14: { kind: 'hat', index: 9, value: 0.714286, tolerance: 0.2 },
    GP_B15: { kind: 'hat', index: 9, value: -0.428571, tolerance: 0.2 },
  },
};

function makePad(pressed = {}, axes = {}) {
  return {
    id: PAD_ID,
    index: 0,
    connected: true,
    buttons: Array.from({ length: 20 }, (_, i) => ({
      pressed: pressed[i] ?? false,
      value: pressed[i] ? 1 : 0,
    })),
    axes: Array.from({ length: 12 }, (_, i) => axes[i] ?? 0),
    vibrationActuator: null,
  };
}

function setup(profile = BASE_PROFILE) {
  __mockControllerProfile = profile;
  const registry = new ActionRegistry();
  const store = new BindingStore(registry);
  registry.register({ id: 'jump', label: 'Jump', slots: 1, gamepadSlots: 1 });
  registry.register({ id: 'fire', label: 'Fire', slots: 1, gamepadSlots: 1 });
  registry.register({ id: 'moveX', label: 'Move X', slots: 1, gamepadSlots: 1, analog: true });
  store.init({});
  for (const action of registry.getAll()) store.initAction(action);
  store.set('jump', 0, 'GP_B0', 'gamepad');
  store.set('fire', 0, 'GP_B1', 'gamepad');
  store.set('moveX', 0, 'GP_A0N', 'gamepad');

  const runtime = new GamepadRuntime(store, registry, { analogThreshold: 0.5, deadband: 0.12 });
  let live = makePad();
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => [live],
  });
  const poll = (pressed, axes) => {
    live = makePad(pressed, axes);
    runtime._processGamepad(live);
    return live;
  };
  return {
    runtime,
    poll,
    getLive: () => live,
  };
}

beforeEach(() => {
  __mockControllerProfile = BASE_PROFILE;
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => [],
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 1. Capture chain
// ════════════════════════════════════════════════════════════════════════════

describe('GamepadRuntime — mapping edits vs capture detection', () => {
  it('a capture starting after an edit detects the new physical source, not the old one', () => {
    const { runtime, poll } = setup();
    poll(); // baseline
    expect(runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 5 })).toBe(true);

    const captured = [];
    runtime.startCapture((code) => captured.push(code));
    poll({ 1: true }); // old source under the base mapping: GP_B0 no longer lives here
    expect(captured).toEqual([]);
    poll();
    poll({ 5: true }); // new source
    expect(captured).toEqual(['GP_B0']);
  });

  it('an edit made while a capture is pending makes the very next result reflect the new mapping', () => {
    const { runtime, poll } = setup();
    poll();
    runtime.startCapture(() => {});
    // Edit happens during the pending capture; raw 5 is already physically held.
    poll({ 5: true });
    expect(runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 5 })).toBe(true);
    // Still held, no new physical press: the edit must not phantom-capture it.
    poll({ 5: true });
    runtime.cancelCapture(); // no callback fired during the above polls

    const captured = [];
    runtime.startCapture((code) => captured.push(code));
    poll({ 5: true }); // still the same held press: baseline was rebuilt by the edit
    expect(captured).toEqual([]);
    poll();            // release
    poll({ 5: true }); // genuine new press under the new mapping
    expect(captured).toEqual(['GP_B0']);
  });

  it('editing does not fire an already-held action: input held before the edit stays silent until re-pressed', () => {
    const { runtime, poll } = setup();
    const events = [];
    runtime.onAction('jump', (e) => events.push(`${e.type}:${e.code}`));
    poll();
    poll({ 5: true }); // raw 5 held, unmapped under the base mapping
    expect(events).toEqual([]);

    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 5 });
    poll({ 5: true }); // still physically held: no pressed/held may appear
    expect(events).toEqual([]);
    poll();            // release: silent too
    poll({ 5: true }); // real press after release
    expect(events).toEqual(['pressed:GP_B0']);
  });

  it('an edited axis direction is captured via its new raw axis', () => {
    const { runtime, poll } = setup();
    poll();
    runtime.setProfileMappingEntry(0, 'GP_A0N', { kind: 'axis', index: 2, direction: 'negative' });
    const captured = [];
    runtime.startCapture((code) => captured.push(code));
    poll({}, { 0: -0.9 }); // old raw axis: nothing
    expect(captured).toEqual([]);
    poll({}, { 2: -0.9 }); // new raw axis
    expect(captured).toEqual(['GP_A0N']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Suppression / resume chain
// ════════════════════════════════════════════════════════════════════════════

describe('GamepadRuntime — mapping edits vs gameplay suppression / resume', () => {
  it('an edited direction held while suppressed cannot get stuck or retrigger on resume', () => {
    const { runtime, poll } = setup();
    const events = [];
    runtime.onAction('jump', (e) => events.push(`${e.type}:${e.code}`));

    poll();
    poll({ 1: true });                 // pressed via base mapping (raw 1)
    expect(events).toEqual(['pressed:GP_B0']);
    runtime.setGameplaySuppressed(true);
    expect(events).toEqual(['pressed:GP_B0', 'released:GP_B0']);

    // Edit while the modal is open; the user keeps holding the old raw button.
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 5 });
    runtime.setGameplaySuppressed(false);
    events.length = 0;

    poll({ 1: true }); // still physically held on the old source: silent
    expect(events).toEqual([]);
    poll();            // release: silent
    poll({ 1: true }); // old source never fires the edited code again
    expect(events).toEqual([]);
    poll();
    poll({ 5: true }); // new source: a clean press, no held-without-pressed
    expect(events).toEqual(['pressed:GP_B0']);
    poll({ 5: true });
    expect(events).toEqual(['pressed:GP_B0', 'held:GP_B0']);
  });

  it('the new physical source, already held before resume, stays silent until released and re-pressed', () => {
    const { runtime, poll } = setup();
    const events = [];
    runtime.onAction('jump', (e) => events.push(`${e.type}:${e.code}`));
    runtime.setGameplaySuppressed(true);
    poll();
    poll({ 5: true }); // user holds raw 5 while the modal is open
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 5 });
    runtime.setGameplaySuppressed(false);

    events.length = 0;
    poll({ 5: true }); // held throughout: must not emit pressed or held
    expect(events).toEqual([]);
    poll();
    poll({ 5: true }); // release then a genuine press
    expect(events).toEqual(['pressed:GP_B0']);
  });

  it('a live (unsuppressed) edit closes the old press once and never phantom-presses the new one', () => {
    const { runtime, poll } = setup();
    const events = [];
    runtime.onAction('jump', (e) => events.push(`${e.type}:${e.code}`));
    poll();
    poll({ 1: true }); // jump held under the base mapping
    expect(events).toEqual(['pressed:GP_B0']);

    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 5 });
    // The edit itself emits the single closing release; polling the still-held
    // old source adds nothing.
    expect(events).toEqual(['pressed:GP_B0', 'released:GP_B0']);
    poll({ 1: true });
    expect(events).toEqual(['pressed:GP_B0', 'released:GP_B0']);
    poll();
    poll({ 5: true }); // new source works normally after a real release
    expect(events).toEqual(['pressed:GP_B0', 'released:GP_B0', 'pressed:GP_B0']);
  });

  it('an axis edit while suppressed sends one final analog 0 and resumes against the new raw axis', () => {
    const { runtime, poll } = setup();
    const analog = [];
    const digital = [];
    runtime.onAction('moveX', (e) => {
      if (e.type === 'analog') analog.push(e.value);
      else digital.push(e.type);
    });
    poll({}, { 0: -0.9 }); // moveX held on raw axis 0
    analog.length = 0;
    runtime.setGameplaySuppressed(true);
    expect(digital).toContain('released');
    expect(analog).toEqual([0]); // exactly one final zero

    runtime.setProfileMappingEntry(0, 'GP_A0N', { kind: 'axis', index: 2, direction: 'negative' });
    runtime.setGameplaySuppressed(false);
    analog.length = 0;
    digital.length = 0;
    poll({}, { 0: -0.9 }); // old raw axis no longer drives the action
    expect(digital).toEqual([]);
    poll({}, { 2: -0.9 }); // new raw axis: fresh press, value flows again
    expect(digital).toEqual(['pressed']);
    expect(analog.at(-1)).toBeCloseTo(-0.9);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Disconnect / reconnect chain
// ════════════════════════════════════════════════════════════════════════════

describe('GamepadRuntime — mapping edits vs disconnect / reconnect', () => {
  it('disconnect releases every action held before the edit with one released and final analog 0', () => {
    const { runtime, poll, getLive } = setup();
    const events = [];
    runtime.onAnyAction((e) => events.push(`${e.actionId}:${e.type}:${e.value}`));
    poll();
    poll({ 1: true }, { 0: -0.9 }); // jump + moveX held before any edit
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 5 });
    events.length = 0;

    runtime._handleDisconnect({ gamepad: getLive() });
    // jump was already closed by the edit; the disconnect must not double-release it.
    expect(events.filter((e) => e === 'jump:released:0')).toHaveLength(0);
    // moveX (untouched by the edit) still gets its single release and analog zero here.
    expect(events).toContain('moveX:released:0');
    expect(events).toContain('moveX:analog:0');
    expect(events.filter((e) => e === 'moveX:analog:0')).toHaveLength(1);
  });

  it('reconnect while an edited input is still held does not replay pressed, and re-press works after release', () => {
    const { runtime, poll } = setup();
    const events = [];
    runtime.onAction('jump', (e) => events.push(`${e.type}:${e.code}`));
    poll();
    poll({ 5: true });
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 5 });
    poll({ 5: true }); // held, silent after the edit
    expect(events).toEqual([]);

    const held = makePad({ 5: true });
    runtime._handleDisconnect({ gamepad: held });
    runtime._handleConnect({ gamepad: held });
    runtime._processGamepad(held); // still physically held at reconnect: no duplicate pressed
    expect(events).toEqual([]);
    runtime._processGamepad(makePad());            // release: silent
    runtime._processGamepad(makePad({ 5: true })); // genuine new press
    expect(events).toEqual(['pressed:GP_B0']);
  });

  it('the edited mapping (not a stale index or snapshot) is the one applied after reconnect', () => {
    const { runtime, poll } = setup();
    const events = [];
    runtime.onAction('jump', (e) => events.push(e.type));
    poll();
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 5 });
    runtime._handleDisconnect({ gamepad: makePad() });
    runtime._handleConnect({ gamepad: makePad() });

    expect(runtime.getResolvedProfile(0).source).toBe('memory-edit');
    runtime._processGamepad(makePad({ 1: true })); // old index: nothing
    expect(events).toEqual([]);
    runtime._processGamepad(makePad());
    runtime._processGamepad(makePad({ 5: true })); // edited index
    expect(events).toEqual(['pressed']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. removeProfileMappingEntry / resetProfileMapping use the same reconciliation
// ════════════════════════════════════════════════════════════════════════════

describe('GamepadRuntime — remove/reset edits re-sync all chains to the base mapping', () => {
  it('removeProfileMappingEntry restores base behaviour for capture and suppression together', () => {
    const { runtime, poll } = setup();
    const events = [];
    runtime.onAction('jump', (e) => events.push(`${e.type}:${e.code}`));
    poll();
    // Edit while raw 5 is physically held: the reconciliation latches GP_B0.
    poll({ 5: true });
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 5 });
    expect(events).toEqual([]); // an edit never phantom-presses a held action
    // Removing the edit while the same input stays held: it has no base entry,
    // so it must remain silent until released and pressed on the base source.
    expect(runtime.removeProfileMappingEntry(0, 'GP_B0')).toBe(true);
    expect(runtime.getResolvedProfile(0).source).toBe('exact');
    poll({ 5: true });
    expect(events).toEqual([]);
    poll();
    poll({ 1: true }); // base source drives the action again
    expect(events).toEqual(['pressed:GP_B0']);

    // Capture reads the restored mapping too.
    const captured = [];
    runtime.startCapture((code) => captured.push(code));
    poll();
    poll({ 1: true });
    expect(captured).toEqual(['GP_B0']);
  });

  it('resetProfileMapping returns capture and suppression to the base mapping', () => {
    const { runtime, poll } = setup();
    const events = [];
    runtime.onAction('jump', (e) => events.push(e.type));
    poll();
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 5 });
    runtime.setProfileMappingEntry(0, 'GP_B1', { kind: 'button', index: 6 });
    expect(runtime.getResolvedProfile(0).source).toBe('memory-edit');

    // A genuine press under the edited mapping, then a reset while still held:
    // the reset reconciliation closes that press exactly once (no stuck
    // action), and never phantom-presses anything.
    poll();
    poll({ 5: true });
    expect(events).toEqual(['pressed']);
    expect(runtime.resetProfileMapping(0)).toBe(true);
    expect(runtime.getResolvedProfile(0).source).toBe('exact');
    expect(events).toEqual(['pressed', 'released']);
    events.length = 0;

    // After the held input is released, the base mapping is fully restored for
    // both dispatch and suppression.
    poll();
    runtime.setGameplaySuppressed(true);
    runtime.setGameplaySuppressed(false);
    poll({ 5: true }); // edited index is dead under the base mapping
    expect(events).toEqual([]);
    poll();
    poll({ 1: true }); // base index for GP_B0 works again
    expect(events).toEqual(['pressed']);

    // And capture is back on the base mapping.
    const captured = [];
    runtime.startCapture((code) => captured.push(code));
    poll();
    poll({ 2: true }); // base GP_B1 source
    expect(captured).toEqual(['GP_B1']);
  });

  it('reset while an edited input is held releases it once and keeps it silent until re-pressed', () => {
    const { runtime, poll } = setup();
    const events = [];
    runtime.onAction('jump', (e) => events.push(`${e.type}:${e.code}`));
    poll();
    poll({ 5: true }); // raw 5 held before the edit, unmapped under the base mapping
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 5 });
    // Raw 5 stays physically held through the reset; the reconciliation latches it.
    expect(events).toEqual([]);
    runtime.resetProfileMapping(0);
    // Raw 5 has no base mapping: the still-held input stays silent.
    poll({ 5: true });
    expect(events).toEqual([]);
    poll();
    poll({ 1: true }); // base source after a clean release
    expect(events).toEqual(['pressed:GP_B0']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Hat-grid decisions are recompiled, never carried over from the old mapping
// ════════════════════════════════════════════════════════════════════════════

describe('GamepadRuntime — hat grid decisions follow the edited mapping', () => {
  it('removing one of the four grid hat entries drops grid decoding for the rest', () => {
    const { runtime, poll } = setup(HAT_PROFILE);
    poll();
    // Sanity: the shipped four-entry layout decodes on the 2/7 grid.
    const before = runtime._compileControllerMapping(runtime.getProfileDefinition(0));
    expect(before.buttons[12].grid).toBe(true);

    expect(runtime.setProfileMappingEntry(0, 'GP_B12', { kind: 'button', index: 2 })).toBe(true);
    const after = runtime._compileControllerMapping(runtime.getProfileDefinition(0));
    expect(after.buttons[12].kind).toBe('button');
    // Only three hat entries remain: no stale grid flag on the survivors.
    expect(after.buttons[13].grid).toBe(false);
    expect(after.buttons[14].grid).toBe(false);
    expect(after.buttons[15].grid).toBe(false);

    // A diagonal raw value must no longer light a cardinal direction (grid rule gone).
    const step = 2 / 7;
    runtime._processGamepad(makePad({}, { 9: -1 + step })); // up-right diagonal
    expect(runtime.isPressed('GP_B12')).toBe(false);
    expect(runtime.isPressed('GP_B15')).toBe(false);
    // The remaining entry still works on its own tolerance when exactly on its value.
    runtime._processGamepad(makePad({}, { 9: 0.142857 }));
    expect(runtime.isPressed('GP_B13')).toBe(true);
  });

  it('an edited hat direction is captured through the new mapping with no old grid cache', () => {
    const { runtime, poll } = setup(HAT_PROFILE);
    poll();
    runtime.setProfileMappingEntry(0, 'GP_B12', { kind: 'hat', index: 9, value: 0, tolerance: 0.1 });
    const captured = [];
    runtime.startCapture((code) => captured.push(code));
    runtime._processGamepad(makePad({}, { 9: 1.285714 })); // neutral baseline
    runtime._processGamepad(makePad({}, { 9: 0 }));        // new value
    expect(captured).toEqual(['GP_B12']);
  });
});
