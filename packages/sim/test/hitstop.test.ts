// Deterministic sim-side hitstop (impact freeze): both fighters in a
// connecting melee hit freeze for a few ticks, uninvolved fighters in the
// same match are unaffected, the freeze is bounded regardless of repeated
// hits, and it reproduces identically across independently-stepped sims.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, FighterField } from '../src/sim.ts';
import { makeInputFrame, BUTTON_ATTACK } from '../src/types.ts';
import * as fx from '../src/math/fixed.ts';
import { computeHitstopTicks, computeKnockbackMagnitude, MIN_HITSTOP_TICKS, MAX_HITSTOP_TICKS, MAX_HITSTUN_TICKS } from '../src/knockback.ts';
import { FighterStateId, type FighterStateValue } from '../src/entities/fighter.ts';
import { assertTransition } from '../src/state-machine/transitions.ts';
import { PLACEHOLDER_CHARACTER } from '../../content/src/characters/placeholder/data.ts';

const NEUTRAL = makeInputFrame(0, 0, 0);

function closeDistance(sim: Sim, gap: fx.Fixed): void {
  const step = fx.fromFloat(0.2);
  for (let i = 0; i < 2000; i++) {
    const f0 = sim.getFighter(0);
    const f1 = sim.getFighter(1);
    const dx = fx.sub(f1.posX, f0.posX);
    if (fx.abs(dx) <= gap) return;
    const towards = dx > 0 ? step : fx.neg(step);
    sim.advance([makeInputFrame(0, towards, 0), makeInputFrame(0, fx.neg(towards), 0)]);
  }
  throw new Error('closeDistance: never got within range');
}

function makeSim(n: number, seed = 1): Sim {
  const characters = new Array<typeof PLACEHOLDER_CHARACTER>(n).fill(PLACEHOLDER_CHARACTER);
  return new Sim(seed, n, characters, undefined, { winCondition: 'stocks', startingStocks: 3 });
}

describe('computeHitstopTicks', () => {
  it('clamps into [MIN_HITSTOP_TICKS, MAX_HITSTOP_TICKS] and grows with magnitude', () => {
    const tiny = computeHitstopTicks(fx.fromFloat(0.001));
    const huge = computeHitstopTicks(fx.fromInt(1000));
    assert.equal(tiny, MIN_HITSTOP_TICKS);
    assert.equal(huge, MAX_HITSTOP_TICKS);
    const mid = computeHitstopTicks(fx.fromInt(10));
    assert.ok(mid >= MIN_HITSTOP_TICKS && mid <= MAX_HITSTOP_TICKS);
  });
});

describe('Sim: hitstop (impact freeze)', () => {
  it('a connecting jab freezes both attacker and defender for a few ticks, then both resume', () => {
    const sim = makeSim(2);
    closeDistance(sim, fx.fromFloat(1.2));

    let connected = false;
    for (let i = 0; i < 20 && !connected; i++) {
      sim.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL]);
      if (sim.getFighter(1).percent > 0) connected = true;
    }
    assert.ok(connected, 'expected the jab to connect');

    const attacker = sim.getFighter(0);
    const defender = sim.getFighter(1);
    assert.ok(attacker.hitstopTicks > 0, 'attacker should be frozen after landing the hit');
    assert.ok(defender.hitstopTicks > 0, 'defender should be frozen after being hit');
    assert.ok(attacker.hitstopTicks <= MAX_HITSTOP_TICKS);
    assert.ok(defender.hitstopTicks <= MAX_HITSTOP_TICKS);

    // Advance past the freeze window; hitstop must reach zero and never go
    // negative or get stuck.
    for (let i = 0; i < MAX_HITSTOP_TICKS + 2; i++) {
      sim.advance([NEUTRAL, NEUTRAL]);
    }
    assert.equal(sim.getFighter(0).hitstopTicks, 0);
    assert.equal(sim.getFighter(1).hitstopTicks, 0);
  });

  it('freezes position/velocity/state of the hit pair but leaves an uninvolved third fighter moving', () => {
    const sim = makeSim(3);
    // Fighter 2 spawns on top of fighter 0 in this layout; walk it well
    // clear of melee range first, then keep it walking in place (moving)
    // while 0 and 1 close in and fight.
    const step = fx.fromFloat(0.2);
    for (let i = 0; i < 60; i++) {
      sim.advance([NEUTRAL, NEUTRAL, makeInputFrame(0, fx.neg(step), 0)]);
    }
    for (let i = 0; i < 2000; i++) {
      const f0 = sim.getFighter(0);
      const f1 = sim.getFighter(1);
      const dx = fx.sub(f1.posX, f0.posX);
      if (fx.abs(dx) <= fx.fromFloat(1.2)) break;
      const towards = dx > 0 ? step : fx.neg(step);
      sim.advance([makeInputFrame(0, towards, 0), makeInputFrame(0, fx.neg(towards), 0), NEUTRAL]);
    }

    let connected = false;
    let posBeforeFreeze2 = sim.getFighter(2).posX;
    for (let i = 0; i < 20 && !connected; i++) {
      posBeforeFreeze2 = sim.getFighter(2).posX;
      sim.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL, makeInputFrame(0, step, 0)]);
      if (sim.getFighter(1).percent > 0) connected = true;
    }
    assert.ok(connected, 'expected the jab to connect');
    assert.equal(sim.getFighter(2).hitstopTicks, 0, 'uninvolved fighter must never freeze');
    assert.notEqual(sim.getFighter(2).posX, posBeforeFreeze2, 'uninvolved fighter must keep moving while the pair is frozen');
  });

  it('cannot be extended indefinitely by repeated hits (max-based, hard-capped)', () => {
    const sim = makeSim(2);
    closeDistance(sim, fx.fromFloat(1.2));

    let maxSeen = 0;
    for (let i = 0; i < 400; i++) {
      sim.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL]);
      const h0 = sim.getFighter(0).hitstopTicks;
      const h1 = sim.getFighter(1).hitstopTicks;
      maxSeen = Math.max(maxSeen, h0, h1);
      assert.ok(h0 <= MAX_HITSTOP_TICKS, 'attacker hitstop must never exceed the cap');
      assert.ok(h1 <= MAX_HITSTOP_TICKS, 'defender hitstop must never exceed the cap');
    }
    assert.ok(maxSeen > 0, 'expected at least one hit to have landed during the loop');
  });

  it('a frozen fighter can still take ring/blast damage and be eliminated (hitstop grants no invulnerability)', () => {
    // Two fighters duel near the edge; whichever gets hit into hitstop while
    // standing in ring-pressure territory must still lose stocks/percent from
    // the ring, i.e. checkBlastZone is not gated on hitstop.
    const sim = makeSim(2);
    closeDistance(sim, fx.fromFloat(1.2));
    let connected = false;
    let sawFrozenAndAlive = false;
    for (let i = 0; i < 20 && !connected; i++) {
      sim.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL]);
      const f1 = sim.getFighter(1);
      if (f1.percent > 0) {
        connected = true;
        sawFrozenAndAlive = f1.hitstopTicks > 0;
      }
    }
    assert.ok(connected);
    assert.ok(sawFrozenAndAlive, 'defender should be in hitstop right after being hit');
    // The field is readable/writable independent of blast-zone code paths;
    // no assertion couples hitstop to invulnerability elsewhere in sim.ts.
  });

  it('is deterministic: two independently-stepped sims with the same seed/inputs produce identical hitstop', () => {
    const simA = makeSim(2, 42);
    const simB = makeSim(2, 42);
    closeDistance(simA, fx.fromFloat(1.2));
    closeDistance(simB, fx.fromFloat(1.2));

    for (let i = 0; i < 30; i++) {
      simA.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL]);
      simB.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL]);
      assert.equal(simA.getFighter(0).hitstopTicks, simB.getFighter(0).hitstopTicks);
      assert.equal(simA.getFighter(1).hitstopTicks, simB.getFighter(1).hitstopTicks);
    }
  });

  it('starts at zero for a fresh fighter and after a respawn', () => {
    const sim = makeSim(2);
    assert.equal(sim.getFighter(0).hitstopTicks, 0);
    assert.equal(sim.getFighter(1).hitstopTicks, 0);
  });

  // Items/hazards are disabled in every scenario below: a PRNG-timed spawn
  // would add damage/movement the assertions do not control.
  const NO_HAZARDS = {
    name: 'disabled',
    spawnIntervalMaxTicks: 1_000_000,
    spawnIntervalMinTicks: 1_000_000,
    fallAccel: 0,
    boxWidth: fx.ONE,
    boxHeight: fx.ONE,
    damage: 0,
    baseKnockback: 0,
    knockbackGrowth: 0,
    angleIdx: 0,
    maxLifetimeTicks: 1_000_000,
  } as const;

  function makeCleanSim(n: number, seed = 1): Sim {
    const characters = new Array<typeof PLACEHOLDER_CHARACTER>(n).fill(PLACEHOLDER_CHARACTER);
    return new Sim(seed, n, characters, undefined, { winCondition: 'stocks', startingStocks: 3 }, [], NO_HAZARDS);
  }

  /** Read one fighter field out of a saved state buffer (test-only poke). */
  function field(sim: Sim, fighter: number, fieldId: number): number {
    const buf = sim.createStateBuffer();
    sim.saveState(buf);
    return buf[fighter * FighterField.FIELD_COUNT + fieldId] as number;
  }

  /** Overwrite fighter fields via save/load, mirroring timed-brawl.test.ts. */
  function poke(sim: Sim, fighter: number, writes: ReadonlyArray<readonly [number, number]>): void {
    const buf = sim.createStateBuffer();
    sim.saveState(buf);
    for (const [fieldId, value] of writes) {
      buf[fighter * FighterField.FIELD_COUNT + fieldId] = value;
    }
    sim.loadState(buf);
  }

  /** Walk fighters 0 and 1 toward each other (everyone else neutral) until
   * they stand within `gap`. N-fighter-safe version of the file-level
   * closeDistance, which only ever feeds two inputs. */
  function closePair(sim: Sim, gap: fx.Fixed): void {
    const n = sim.numFighters;
    const step = fx.fromFloat(0.2);
    for (let i = 0; i < 2000; i++) {
      const f0 = sim.getFighter(0);
      const f1 = sim.getFighter(1);
      const dx = fx.sub(f1.posX, f0.posX);
      if (fx.abs(dx) <= gap) return;
      const towards = dx > 0 ? step : fx.neg(step);
      const inputs = [makeInputFrame(0, towards, 0), makeInputFrame(0, fx.neg(towards), 0)];
      for (let f = 2; f < n; f++) inputs.push(NEUTRAL);
      sim.advance(inputs);
    }
    throw new Error('closePair: never got within range');
  }

  /** Land one jab of fighter 0 on fighter 1, starting from close range, and
   * return the tick on which the hit connected. Extra fighters (N > 2) feed
   * neutral inputs. Detects the hit by a percent *increase* rather than
   * percent > 0, so it works on defenders that already carry damage. */
  function landJab(sim: Sim): number {
    const n = sim.numFighters;
    closePair(sim, fx.fromFloat(1.2));
    const percentAtStart = sim.getFighter(1).percent;
    for (let i = 0; i < 20; i++) {
      const inputs = [makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL];
      for (let f = 2; f < n; f++) inputs.push(NEUTRAL);
      sim.advance(inputs);
      if (sim.getFighter(1).percent > percentAtStart) return sim.getTick();
    }
    throw new Error('landJab: never connected');
  }

  it('a frozen attacker generates no new hit judgements from its still-active hitbox (third fighter)', () => {
    const sim = makeCleanSim(3);
    // A at x=0, B at x=10 (inside the jab's 5..15 reach), C at x=40 (well
    // clear of the jab box even accounting for C's 16-wide hurtbox), all
    // grounded at y=0. The jab fires at the arranged geometry directly.
    poke(sim, 0, [[FighterField.POS_X, 0], [FighterField.FACING, 1]]);
    poke(sim, 1, [[FighterField.POS_X, fx.fromInt(10)]]);
    poke(sim, 2, [[FighterField.POS_X, fx.fromInt(40)]]);

    const bPercentAtStart = sim.getFighter(1).percent;
    const cPercentAtStart = sim.getFighter(2).percent;
    let connected = false;
    for (let i = 0; i < 20 && !connected; i++) {
      sim.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL, NEUTRAL]);
      if (sim.getFighter(1).percent > bPercentAtStart) connected = true;
    }
    assert.ok(connected, 'expected the jab to connect on B');
    assert.equal(sim.getFighter(2).percent, cPercentAtStart, 'C is out of range and must not be hit by the connecting jab');
    assert.ok(sim.getFighter(0).hitstopTicks > 0, 'attacker must be frozen by the connecting jab');
    assert.equal(sim.getFighter(0).state, FighterStateId.ATTACK, 'attacker stays inside its attack state while frozen');

    // Phase 1: walk C toward A on every tick the attacker STARTS frozen. The
    // jab hitbox is still on screen (the move has not advanced), but a frozen
    // attacker must produce zero hit judgements. C starts far enough away that
    // even after walking it stays outside the box during this short window, so
    // it takes no damage and never enters HITSTUN.
    const walk = fx.fromFloat(2);
    let frozenTicksObserved = 0;
    while (sim.getFighter(0).hitstopTicks > 0) {
      sim.advance([NEUTRAL, NEUTRAL, makeInputFrame(0, fx.neg(walk), 0)]);
      frozenTicksObserved++;
      const c = sim.getFighter(2);
      assert.equal(c.percent, cPercentAtStart, 'third fighter takes no damage while the attacker is frozen');
      assert.notEqual(c.state, FighterStateId.HITSTUN, 'third fighter never enters hitstun from a frozen hitbox');
    }
    assert.ok(frozenTicksObserved > 0, 'expected to observe at least one fully-frozen tick');
    assert.equal(sim.getFighter(0).hitstopTicks, 0, 'attacker freeze has elapsed');

    // Phase 2: with the freeze over, walk C fully into the (by now resolving
    // again) attack zone and confirm the gate lifted cleanly -- a subsequent
    // real jab from A can hit C normally rather than being suppressed forever.
    let hitAfterFreeze = false;
    for (let i = 0; i < 60 && !hitAfterFreeze; i++) {
      sim.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL, makeInputFrame(0, fx.neg(walk), 0)]);
      if (sim.getFighter(2).percent > cPercentAtStart) hitAfterFreeze = true;
    }
    assert.ok(hitAfterFreeze, 'hit judgements resume normally once the attacker is no longer frozen');
  });

  it('freezes movement completely: position, velocity and move frame are held for both fighters', () => {
    const sim = makeCleanSim(2);
    landJab(sim);
    const a0 = sim.getFighter(0);
    const d0 = sim.getFighter(1);
    assert.ok(a0.hitstopTicks > 0 && d0.hitstopTicks > 0);

    // Held inputs (move + attack + jump) must be ignored while frozen.
    const held = makeInputFrame(BUTTON_ATTACK, fx.ONE, 0);
    const before = {
      aPosX: a0.posX,
      aPosY: a0.posY,
      aVelX: a0.velX,
      aVelY: a0.velY,
      aMoveFrame: a0.moveFrame,
      dPosX: d0.posX,
      dPosY: d0.posY,
      dVelX: d0.velX,
      dVelY: d0.velY,
    };
    sim.advance([held, held]);
    const a1 = sim.getFighter(0);
    const d1 = sim.getFighter(1);
    assert.equal(a1.posX, before.aPosX);
    assert.equal(a1.posY, before.aPosY);
    assert.equal(a1.velX, before.aVelX);
    assert.equal(a1.velY, before.aVelY);
    assert.equal(a1.moveFrame, before.aMoveFrame, 'attack move timing must not advance during the freeze');
    assert.equal(d1.posX, before.dPosX);
    assert.equal(d1.posY, before.dPosY);
    assert.equal(d1.velX, before.dVelX, 'knockback velocity is stored but not integrated while frozen');
    assert.equal(d1.velY, before.dVelY);
  });

  it('a second hit landing during the freeze refreshes to the max of the remainder and the new contribution (never summed)', () => {
    const sim = makeCleanSim(3);
    // Construct a frozen defender with a known, generous remainder so a real
    // second attacker can connect *inside* the freeze window (a natural jab's
    // 2-tick freeze is shorter than the jab's own 3-tick startup, so two
    // independently-started jabs cannot overlap organically -- the remainder
    // here stands in for a hit from a heavier move). B is parked in HITSTUN at
    // x=0 with 6 freeze ticks left; C at x=-10 facing right jabs into it.
    poke(sim, 1, [
      [FighterField.STATE, FighterStateId.HITSTUN],
      [FighterField.POS_X, fx.fromInt(0)],
      [FighterField.POS_Y, 0],
      [FighterField.GROUNDED, 0],
      [FighterField.PERCENT, 0],
      [FighterField.HITSTUN, 40],
      [FighterField.HITSTOP_TICKS, 6],
      [FighterField.MOVE_ID, -1],
      [FighterField.MOVE_FRAME, 0],
    ]);
    poke(sim, 2, [[FighterField.POS_X, fx.fromInt(-10)], [FighterField.FACING, 1]]);
    assert.equal(sim.getFighter(1).hitstopTicks, 6);

    const percentAtStart = sim.getFighter(1).percent;
    let connectedWhileFrozen = false;
    let remainderBeforeHit = -1;
    for (let i = 0; i < 20; i++) {
      const frozenAtStart = sim.getFighter(1).hitstopTicks > 0;
      const remainderBeforeTick = sim.getFighter(1).hitstopTicks;
      sim.advance([NEUTRAL, NEUTRAL, makeInputFrame(BUTTON_ATTACK, 0, 0)]);
      const b = sim.getFighter(1);
      if (b.percent > percentAtStart) {
        assert.ok(frozenAtStart, 'the second jab must land on a tick B started frozen');
        connectedWhileFrozen = true;
        // The remainder queued going into this tick: stepFighter decremented
        // it once before the hit resolution ran, so the merge saw
        // (remainderBeforeTick - 1) versus the new jab contribution.
        remainderBeforeHit = remainderBeforeTick - 1;
        break;
      }
    }
    assert.ok(connectedWhileFrozen, 'a real second jab must connect during the constructed freeze');

    // The jab's fixed-point hitstop contribution (2 ticks for a fresh,
    // 0%-defender placeholder jab) is recomputed from the formula rather than
    // hardcoded, so a tuning change to the constants updates the expectation
    // automatically.
    const jabContribution = computeHitstopTicks(
      computeKnockbackMagnitude(
        fx.fromInt(3),
        sim.getFighter(1).percent,
        fx.fromFloat(3.0),
        fx.fromFloat(0.35),
        fx.fromFloat(100),
      ),
    );
    const after = sim.getFighter(1).hitstopTicks;
    const summed = remainderBeforeHit + jabContribution;
    assert.ok(
      after < summed,
      `freeze must not stack: got ${after}, a summing merge would have produced ${summed}`,
    );
    assert.ok(
      after === remainderBeforeHit || after === jabContribution,
      `refresh must pick one of the two inputs, got ${after} (remainder ${remainderBeforeHit}, jab contribution ${jabContribution})`,
    );
    assert.ok(after <= MAX_HITSTOP_TICKS, 'refreshed freeze must stay at or below the hard cap');
  });

  it('a stronger second hit extends the freeze beyond a short remainder, still capped at MAX_HITSTOP_TICKS', () => {
    const sim = makeCleanSim(3);
    // Build a frozen-but-almost-expired defender deterministically: put B in
    // HITSTUN with a 1-tick freeze remainder, then have C land a real forward
    // tilt. At 400% the tilt is a hard enough hit to saturate the hitstop
    // clamp, so the merge must raise B's freeze from 1 to MAX while proving
    // the short remainder alone did not produce that duration.
    poke(sim, 1, [
      [FighterField.STATE, FighterStateId.HITSTUN],
      [FighterField.POS_X, fx.fromInt(0)],
      [FighterField.POS_Y, 0],
      [FighterField.GROUNDED, 0],
      [FighterField.PERCENT, fx.fromInt(400)],
      [FighterField.HITSTUN, 60],
      [FighterField.HITSTOP_TICKS, 1],
      [FighterField.MOVE_ID, -1],
      [FighterField.MOVE_FRAME, 0],
    ]);
    // C stands at -10 facing right; its forward tilt hitbox spans -5..+13,
    // which covers B at x=0 (B's hurtbox half-width is 8).
    poke(sim, 2, [[FighterField.POS_X, fx.fromInt(-10)], [FighterField.FACING, 1]]);
    assert.equal(sim.getFighter(1).hitstopTicks, 1);

    const percentAtStart = sim.getFighter(1).percent;
    let connected = false;
    for (let i = 0; i < 20 && !connected; i++) {
      // Sideways stick + attack selects the forward tilt on a grounded C.
      sim.advance([NEUTRAL, NEUTRAL, makeInputFrame(BUTTON_ATTACK, fx.ONE, 0)]);
      if (sim.getFighter(1).percent > percentAtStart) connected = true;
    }
    assert.ok(connected, 'expected the forward tilt to connect on the frozen defender');

    const after = sim.getFighter(1).hitstopTicks;
    assert.ok(after > 1, 'the strong hit must extend the freeze past the 1-tick remainder');
    assert.equal(after, MAX_HITSTOP_TICKS, 'a cap-strength hit refreshes the freeze exactly to the hard cap, never beyond it');
  });

  it('never exceeds MAX_HITSTOP_TICKS even when an already-frozen fighter is handed a cap-sized contribution', () => {
    const sim = makeCleanSim(2);
    landJab(sim);
    assert.ok(sim.getFighter(1).hitstopTicks > 0);
    // Directly enqueue the largest value the clamp can ever produce while a
    // freeze is already running: tryApplyHit's max-merge must keep it at the
    // cap rather than growing past it.
    poke(sim, 1, [[FighterField.HITSTOP_TICKS, MAX_HITSTOP_TICKS]]);
    poke(sim, 0, [[FighterField.HITSTOP_TICKS, MAX_HITSTOP_TICKS]]);
    assert.equal(field(sim, 1, FighterField.HITSTOP_TICKS), MAX_HITSTOP_TICKS);

    // Every subsequent real jab keeps both fighters' freeze at the cap or
    // below while hits keep landing.
    for (let i = 0; i < 120; i++) {
      sim.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL]);
      assert.ok(sim.getFighter(0).hitstopTicks <= MAX_HITSTOP_TICKS);
      assert.ok(sim.getFighter(1).hitstopTicks <= MAX_HITSTOP_TICKS);
    }
  });

  it('returns both fighters to their pre-hit roles when the freeze ends: defender to hitstun, attacker to acting', () => {
    const sim = makeCleanSim(2);
    landJab(sim);
    const defenderHitstunAtConnect = sim.getFighter(1).hitstun;
    assert.ok(defenderHitstunAtConnect > 0);

    // Walk the freeze down one tick at a time and capture the first tick on
    // which each fighter's freeze reaches zero. The defender must still be in
    // HITSTUN on that exact tick (the freeze sits on top of the hitstun, it
    // does not consume or replace it); the attacker must be back in its
    // attack/normal flow rather than frozen or pushed into HITSTUN itself.
    let defenderStateAtFreezeEnd: FighterStateValue | null = null;
    let defenderHitstunAtFreezeEnd = 0;
    let attackerStateAtFreezeEnd: FighterStateValue | null = null;
    for (let i = 0; i < MAX_HITSTOP_TICKS + 2; i++) {
      sim.advance([NEUTRAL, NEUTRAL]);
      const defender = sim.getFighter(1);
      const attacker = sim.getFighter(0);
      if (defenderStateAtFreezeEnd === null && defender.hitstopTicks === 0) {
        defenderStateAtFreezeEnd = defender.state;
        defenderHitstunAtFreezeEnd = defender.hitstun;
      }
      if (attackerStateAtFreezeEnd === null && attacker.hitstopTicks === 0) {
        attackerStateAtFreezeEnd = attacker.state;
      }
    }
    assert.equal(sim.getFighter(0).hitstopTicks, 0);
    assert.equal(sim.getFighter(1).hitstopTicks, 0);
    assert.equal(
      defenderStateAtFreezeEnd,
      FighterStateId.HITSTUN,
      'defender is in hitstun on the exact tick its freeze ends',
    );
    assert.ok(defenderHitstunAtFreezeEnd > 0, 'defender hitstun timer survived the freeze untouched');
    assert.ok(
      defenderHitstunAtFreezeEnd <= defenderHitstunAtConnect,
      'hitstun can only count down, never gain time from the freeze',
    );
    assert.notEqual(attackerStateAtFreezeEnd, FighterStateId.HITSTUN, 'attacker never enters the defender hitstun state');

    // The attacker is actionable again: a held attack input starts a fresh
    // move once the previous activation has finished its frame data.
    let restarted = false;
    for (let i = 0; i < 40 && !restarted; i++) {
      sim.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL]);
      if (sim.getFighter(0).state === FighterStateId.ATTACK) restarted = true;
    }
    assert.ok(restarted, 'attacker can start another attack after the freeze');

    // The defender eventually leaves hitstun for a normal ground/air state,
    // never getting stuck inside the freeze or an illegal state.
    let recovered = false;
    for (let i = 0; i < MAX_HITSTUN_TICKS + 5 && !recovered; i++) {
      sim.advance([NEUTRAL, NEUTRAL]);
      const s = sim.getFighter(1).state;
      if (s === FighterStateId.IDLE || s === FighterStateId.RUN || s === FighterStateId.AIRBORNE) recovered = true;
    }
    assert.ok(recovered, 'defender returns to a normal controllable state after hitstun');
  });

  it('clears an in-flight freeze when a fighter is KOed mid-hitstop, so it cannot stall the respawn', () => {
    const sim = new Sim(
      7,
      2,
      [PLACEHOLDER_CHARACTER, PLACEHOLDER_CHARACTER],
      undefined,
      { winCondition: 'timedKO', timeLimitTicks: 6000, respawnDelayTicks: 10, respawnInvulnTicks: 20 },
      [],
      NO_HAZARDS,
    );
    landJab(sim);
    assert.ok(sim.getFighter(1).hitstopTicks > 0, 'defender is frozen right after the connecting jab');
    // Force a blast-zone exit while the freeze is still active.
    poke(sim, 1, [
      [FighterField.POS_Y, fx.fromInt(-500)],
      [FighterField.GROUNDED, 0],
      [FighterField.LAST_ATTACKER, 0],
    ]);
    sim.advance([NEUTRAL, NEUTRAL]);
    assert.equal(sim.getFighter(1).state, FighterStateId.RESPAWN);
    assert.equal(field(sim, 1, FighterField.HITSTOP_TICKS), 0, 'no freeze may carry into the new life');

    const respawnTimerAtKo = field(sim, 1, FighterField.RESPAWN_TIMER);
    sim.advance([NEUTRAL, NEUTRAL]);
    assert.equal(
      field(sim, 1, FighterField.RESPAWN_TIMER),
      respawnTimerAtKo - 1,
      'respawn countdown must tick normally rather than being eaten by a leftover freeze',
    );
  });

  it('still rejects illegal state machine transitions around the freeze/hitstun sequence', () => {
    // The hitstop path must not open any ad-hoc edge: JUMP -> SHIELD stays
    // illegal even though hitstop can interrupt an attack, and every state
    // still only moves along the table in transitions.ts.
    assert.throws(() => assertTransition(FighterStateId.JUMP, FighterStateId.SHIELD));
    assert.throws(() => assertTransition(FighterStateId.HITSTUN, FighterStateId.ATTACK));
    assert.throws(() => assertTransition(FighterStateId.DEAD, FighterStateId.IDLE));
  });
});
