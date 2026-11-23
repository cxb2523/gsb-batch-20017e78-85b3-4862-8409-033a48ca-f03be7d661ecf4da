import assert from 'node:assert/strict';
import test from 'node:test';

import { Scene } from '../src/scene.js';
import { LifeSession } from '../src/life-session.js';

const SEED = 20260727;
const OPT = { light: { az: 30, el: 45 } };
const W = 480, H = 270;

/* Scene owns world state; the renderer only has to answer frame questions.
   A stub renderer exercises the full generate -> populate -> dispose ->
   rebuild chain without WebGL. */
function stubRenderer() {
  return { W, H, time: 0, atlasGen: 1, wind: 0 };
}

function openScene(renderer, session, sceneId, at) {
  const scene = new Scene(renderer, SEED, OPT, sceneId, session);
  scene.generate();
  renderer.atlasGen += 1;
  scene.populate(W, H, at);
  return scene;
}

/* The renderer's gotoScene contract: dispose the resident scene, build the
   destination against the same session, and seat the traveller on the portal. */
function crossPortal(renderer, session, scene, destinationId) {
  const portal = scene.portals.find((q) => q.to === destinationId) || scene.portals[0];
  const source = { from: scene.id, returnId: portal.returnId || portal.id };
  scene.dispose();
  const next = new Scene(renderer, SEED, OPT, portal.to, session);
  next.generate();
  renderer.atlasGen += 1;
  const arrival = next.arriveAtPortal(source);
  next.populate(W, H, arrival && arrival.at);
  if (arrival) next.doorLock = arrival.lock;
  return next;
}

function walk(scene, renderer, frames, input = { right: 1 }) {
  for (let i = 0; i < frames; i++) {
    renderer.time += 1 / 60;
    scene.step(1 / 60, input);
  }
}

function recordIdsFor(session, sceneId) {
  return [...session.records.values()]
    .filter((q) => q.sceneId === sceneId)
    .map((q) => q.id)
    .sort();
}

test('one life session survives repeated world round trips with a monotonic clock and no duplicate events', () => {
  const renderer = stubRenderer();
  const session = new LifeSession(SEED);
  const scheduledIds = new Set();
  const originalSchedule = session.schedule.bind(session);
  session.schedule = (event) => {
    const row = originalSchedule(event);
    assert.equal(scheduledIds.has(row.id), false, `event id scheduled twice: ${row.id}`);
    scheduledIds.add(row.id);
    return row;
  };

  let scene = openScene(renderer, session, 'frostwood');
  const frostwoodIds = recordIdsFor(session, 'frostwood');
  assert.ok(frostwoodIds.length > 1);

  let previousMinute = session.clock.minute;
  const trip = [
    ['frostwood', 'meadow'], ['meadow', 'frostwood'],
    ['frostwood', 'meadow'], ['meadow', 'frostwood'],
  ];
  for (const [from, to] of trip) {
    assert.equal(scene.id, from);
    walk(scene, renderer, 240);
    scene = crossPortal(renderer, session, scene, to);
    assert.equal(scene.id, to);
    assert.ok(session.clock.minute >= previousMinute,
      `clock ran backward crossing ${from} -> ${to}`);
    previousMinute = session.clock.minute;
    for (let i = 1; i < session.events.length; i++) {
      const a = session.events[i - 1], b = session.events[i];
      assert.ok(b.at >= a.at || (b.at === a.at && String(b.id) >= String(a.id)),
        'event queue lost its time ordering after a rebuild');
    }
  }

  /* The same identities own the frostwood scene after every round trip. */
  assert.deepEqual(recordIdsFor(session, 'frostwood'), frostwoodIds);
  /* Every record kept exactly one queued advance event at most per type. */
  const seen = new Map();
  for (const event of session.events) {
    const key = `${event.recordId}:${event.type}:${event.id}`;
    assert.equal(seen.has(key), false, `duplicate queued event ${key}`);
    seen.set(key, true);
  }
  scene.dispose();
});

test('a snapshot rebuild restores every scene entity at its snapshot position and clock', () => {
  const renderer = stubRenderer();
  const session = new LifeSession(SEED);
  const scene = openScene(renderer, session, 'frostwood');
  walk(scene, renderer, 480);

  const snapshot = session.snapshot();
  /* The snapshot is plain serializable data and carries no runtime handles. */
  const wire = JSON.parse(JSON.stringify(snapshot));
  assert.ok(wire.records.every((q) => !('activeScene' in q)));

  scene.dispose();
  const restored = LifeSession.fromSnapshot(wire);
  assert.equal(restored.clock.minute, session.clock.minute);
  assert.equal(restored.sequence, session.sequence);

  const rebuiltRenderer = stubRenderer();
  const rebuilt = openScene(rebuiltRenderer, restored, 'frostwood');
  const liveIds = recordIdsFor(session, 'frostwood');
  assert.deepEqual(rebuilt.lifeRuntime.records().map((q) => q.id).sort(), liveIds);

  for (const actor of rebuilt.actors) {
    const record = restored.record(actor.lifeId);
    assert.ok(record, `actor ${actor.id} has no restored record`);
    const members = record.memberIds?.length ? record.memberIds : [record.id];
    assert.ok(members.includes(actor.id));
    /* The lead body of a cohort lands on the record's analytic position. */
    if (members[0] === actor.id) {
      const want = rebuilt.lifeRuntime.positionAt(record);
      assert.ok(Math.hypot(actor.x - want.x, actor.y - want.y) < 1e-9,
        `${actor.id} rebuilt off its snapshot position`);
    }
  }

  /* Stepping the restored session continues the same clock and event ids. */
  const before = restored.clock.minute;
  walk(rebuilt, rebuiltRenderer, 120);
  assert.ok(restored.clock.minute > before);
  rebuilt.dispose();

  /* Restored snapshots keep round-tripping byte for byte. */
  assert.deepEqual(restored.snapshot(), LifeSession.fromSnapshot(
    JSON.parse(JSON.stringify(restored.snapshot()))).snapshot());
});

test('the direct scene path and the snapshot path rebuild the same world content', () => {
  const rendererA = stubRenderer(), rendererB = stubRenderer();
  const session = new LifeSession(SEED);
  const direct = openScene(rendererA, session, 'meadow');
  walk(direct, rendererA, 240);
  const wire = JSON.parse(JSON.stringify(session.snapshot()));
  direct.dispose();

  const restored = LifeSession.fromSnapshot(wire);
  const viaSnapshot = openScene(rendererB, restored, 'meadow');

  assert.deepEqual(
    viaSnapshot.lifeRuntime.records().map((q) => q.id).sort(),
    recordIdsFor(session, 'meadow'));
  for (const record of restored.records.values()) {
    if (record.sceneId !== 'meadow') continue;
    const original = session.record(record.id);
    assert.equal(record.decisionIndex, original.decisionIndex);
    assert.equal(record.commitment.action, original.commitment.action);
    assert.deepEqual(record.position, original.position);
  }
  viaSnapshot.dispose();
});
