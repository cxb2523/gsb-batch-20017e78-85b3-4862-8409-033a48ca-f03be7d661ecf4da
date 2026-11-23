// 保卫萝卜 V2 · 规则与数据测试
// 运行：node --test tests/
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAP_GRID, COLS, ROWS, TILE, PATH_LENGTH, PATH_POINTS, WAVES, WAVE_COUNT,
  TOWERS, ENEMIES, ECONOMY, CARROT_HP, MAX_LEVEL, isBuildableTile, hpScaleFor,
} from "../js/data.js";
import { applyDamage, applySlow, applyBurn, tickDebuffs, pickTarget, statsAt, pointAt, investedOf } from "../js/rules.js";
import { createGame, placeTower, upgradeTower, sellTower, startWave, update, togglePause, PHASE, snapshot } from "../js/game.js";

const mkEnemy = (over = {}) => ({
  id: 1, hp: 100, maxHp: 100, shield: 0, armor: 0, radius: 18, speed: 50,
  lane: 0, progress: 0, x: 0, y: 0, slowFactor: 1, slowTimer: 0,
  burnDps: 0, burnTimer: 0, burnAcc: 0, dead: false, ...over,
});

// ---------------- 地图数据（PRD 缺口 1） ----------------
test("地图网格尺寸正确", () => {
  assert.equal(MAP_GRID.length, ROWS);
  for (const row of MAP_GRID) assert.equal(row.length, COLS);
});

test("可建造格 96 / 路径格 27 / 装饰格 37", () => {
  const flat = MAP_GRID.join("");
  assert.equal([...flat].filter((c) => c === ".").length, 96);
  assert.equal([...flat].filter((c) => c === "#").length, 27);
  assert.equal([...flat].filter((c) => c === "o").length, 37);
});

test("路径总长 1656px", () => {
  assert.equal(Math.round(PATH_LENGTH), 1656);
});

test("路径折线端点落在边界外，怪物从左侧进场", () => {
  assert.equal(PATH_POINTS[0][0], -1);
  assert.ok(PATH_POINTS[PATH_POINTS.length - 1][0] > COLS - 1);
});

test("路径格不可建造，装饰格不可建造", () => {
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const ch = MAP_GRID[r][c];
      assert.equal(isBuildableTile(c, r), ch === ".");
    }
  }
});

// ---------------- 波次数据（PRD 缺口 2） ----------------
test("15 波，每波至少一个编队，字段完整", () => {
  assert.equal(WAVES.length, WAVE_COUNT);
  for (const wave of WAVES) {
    assert.ok(wave.length > 0);
    for (const g of wave) {
      assert.ok(ENEMIES[g.type], `未知怪物类型 ${g.type}`);
      assert.ok(g.count > 0);
      assert.ok(g.gap >= 0 && g.delay >= 0);
    }
  }
});

test("第 5/10/15 波包含首领", () => {
  for (const w of [5, 10, 15]) {
    assert.ok(WAVES[w - 1].some((g) => g.type === "boss"), `第 ${w} 波没有首领`);
  }
});

test("生命倍率符合 1 + 0.22×(波次-1)", () => {
  assert.equal(hpScaleFor(1), 1);
  assert.equal(Math.round(hpScaleFor(5) * 100) / 100, 1.88);
  assert.equal(Math.round(hpScaleFor(15) * 100) / 100, 4.08);
});

// ---------------- 战斗规则（PRD 缺口 3） ----------------
test("护甲是减法且保底 1 点伤害", () => {
  const e = mkEnemy({ hp: 100, armor: 4 });
  applyDamage(e, 9);
  assert.equal(e.hp, 95);
  applyDamage(e, 2);           // 2 - 4 < 1 → 保底 1
  assert.equal(e.hp, 94);
});

test("护盾先于生命被扣除", () => {
  const e = mkEnemy({ hp: 70, shield: 70 });
  applyDamage(e, 30);
  assert.equal(e.shield, 40);
  assert.equal(e.hp, 70);
  applyDamage(e, 50);
  assert.equal(e.shield, 0);
  assert.equal(e.hp, 60);      // 溢出 10 点打到血
});

test("灼烧无视护甲", () => {
  const e = mkEnemy({ hp: 100, armor: 4 });
  applyBurn(e, 9, 1);
  tickDebuffs(e, 0.25);
  // 9 dps × 0.25s = 2.25，不被护甲削到 1
  assert.ok(Math.abs(e.hp - 97.75) < 1e-6, `实际 hp=${e.hp}`);
});

test("减速取最强、刷新时长、不叠加", () => {
  const e = mkEnemy();
  applySlow(e, 0.45, 2);
  assert.equal(e.slowFactor, 0.55);
  applySlow(e, 0.2, 1);        // 更弱的减速不该覆盖
  assert.equal(e.slowFactor, 0.55);
  assert.equal(e.slowTimer, 2);
  applySlow(e, 0.6, 3);        // 更强的减速覆盖
  assert.equal(e.slowFactor, 0.4);
});

test("减速到期后速度恢复", () => {
  const e = mkEnemy();
  applySlow(e, 0.45, 0.5);
  tickDebuffs(e, 0.6);
  assert.equal(e.slowFactor, 1);
});

test("索敌选沿路径走得最远的敌人", () => {
  const tower = { x: 200, y: 200, level: 1, def: TOWERS.cannon };
  const near = mkEnemy({ id: 1, x: 210, y: 200, progress: 100 });
  const far = mkEnemy({ id: 2, x: 260, y: 200, progress: 900 });
  assert.equal(pickTarget(tower, [near, far]).id, 2);
});

test("射程外不索敌", () => {
  const tower = { x: 0, y: 0, level: 1, def: TOWERS.cannon };
  assert.equal(pickTarget(tower, [mkEnemy({ x: 900, y: 900, progress: 10 })]), null);
});

test("升级后面板按 1.65 / +18 / ×0.88 变化", () => {
  const t1 = { level: 1, def: TOWERS.cannon };
  const t2 = { level: 2, def: TOWERS.cannon };
  const s1 = statsAt(t1), s2 = statsAt(t2);
  assert.ok(Math.abs(s2.damage - s1.damage * 1.65) < 1e-9);
  assert.equal(s2.range, s1.range + 18);
  assert.ok(Math.abs(s2.interval - s1.interval * 0.88) < 1e-9);
});

// ---------------- 面板缓存的生命周期（建造 / 升级 / 拆除 / 重开） ----------------
// 回归：缓存曾只按「塔对象 + level」命中。只要等级一样，另一座塔、或换了 def 的
// 同一座塔就会拿到别人的旧面板，UI 显示、索敌与开火节奏跟着一起错。

test("同等级、不同实例的塔面板互不串值", () => {
  const s = createGame(1);
  s.coins = 9999;
  const a = placeTower(s, 5, 0, "cannon").tower;
  const b = placeTower(s, 6, 0, "ice").tower;
  assert.equal(a.level, b.level, "两座塔都是 1 级——旧的缓存键只比 level 就会撞车");

  const sa = statsAt(a);
  const sb = statsAt(b);
  assert.equal(sa.damage, TOWERS.cannon.damage);
  assert.equal(sa.range, TOWERS.cannon.range);
  assert.equal(sb.damage, TOWERS.ice.damage);
  assert.equal(sb.range, TOWERS.ice.range);
  assert.notEqual(sa.damage, sb.damage);
  assert.ok(Math.abs(sa.interval - TOWERS.cannon.interval) < 1e-12);
  assert.ok(Math.abs(sb.interval - TOWERS.ice.interval) < 1e-12);

  // 反序再读一次：任何一方都不得被对方后写入的缓存覆盖
  assert.deepEqual(statsAt(b), sb);
  assert.deepEqual(statsAt(a), sa);
});

test("同等级、同类型、不同实例：升级其中一座不影响另一座", () => {
  const s = createGame(1);
  s.coins = 9999;
  const a = placeTower(s, 5, 0, "cannon").tower;
  const b = placeTower(s, 6, 0, "cannon").tower;
  const bBefore = statsAt(b);

  assert.ok(upgradeTower(s, a.id).ok);   // 只升 a
  assert.equal(a.level, 2);
  assert.equal(b.level, 1);

  assert.equal(statsAt(b).damage, bBefore.damage, "b 仍应是 1 级面板");
  assert.equal(statsAt(b).range, TOWERS.cannon.range);
  assert.equal(statsAt(a).range, TOWERS.cannon.range + 18, "a 应是 2 级面板");
  assert.notDeepEqual(statsAt(a), statsAt(b));
});

test("同一塔对象换 def 前面板立即更新（不能只比 level）", () => {
  const t = { level: 2, def: { ...TOWERS.cannon } };
  const before = statsAt(t);
  assert.ok(Math.abs(before.damage - TOWERS.cannon.damage * 1.65) < 1e-9);

  t.def = { ...TOWERS.magic }; // 等级不变，面板来源变了
  const after = statsAt(t);
  assert.ok(Math.abs(after.damage - TOWERS.magic.damage * 1.65) < 1e-9);
  assert.equal(after.range, TOWERS.magic.range + 18);
  assert.notEqual(after.damage, before.damage);
});

test("升级后立刻读到当前等级面板", () => {
  const s = createGame(1);
  s.coins = 9999;
  const t = placeTower(s, 5, 0, "cannon").tower;
  const l1 = statsAt(t);
  assert.ok(upgradeTower(s, t.id).ok);
  const l2 = statsAt(t);
  assert.ok(Math.abs(l2.damage - l1.damage * 1.65) < 1e-9);
  assert.equal(l2.range, l1.range + 18);
});

test("拆除会作废该塔的面板缓存", () => {
  const s = createGame(1);
  s.coins = 9999;
  const t = placeTower(s, 5, 0, "cannon").tower;
  const before = statsAt(t);
  assert.ok(sellTower(s, t.id).ok);

  // 拆除后即使这个对象仍被别处引用，也不允许吐出缓存里的旧面板
  t.def = { ...TOWERS.magic };
  const after = statsAt(t);
  assert.equal(after.damage, TOWERS.magic.damage);
  assert.notEqual(after.damage, before.damage);
});

test("重开后新塔面板正确，且不会命中上一局的缓存", () => {
  const s1 = createGame(1);
  s1.coins = 9999;
  const old = placeTower(s1, 5, 0, "cannon").tower;
  assert.ok(upgradeTower(s1, old.id).ok);
  assert.ok(upgradeTower(s1, old.id).ok);
  assert.equal(old.level, 3);
  const oldPanel = statsAt(old);
  assert.equal(oldPanel.range, TOWERS.cannon.range + 36);

  // 重开新对局：新塔同样是 1 级，绝不能复用上一局的面板
  const s2 = createGame(1);
  s2.coins = 9999;
  const fresh = placeTower(s2, 5, 0, "cannon").tower;
  assert.equal(fresh.level, 1);
  const freshPanel = statsAt(fresh);
  assert.equal(freshPanel.damage, TOWERS.cannon.damage);
  assert.equal(freshPanel.range, TOWERS.cannon.range);
  assert.equal(freshPanel.income, 0);
  assert.notDeepEqual(freshPanel, oldPanel);

  // 重开后的升级路径同样正确
  assert.ok(upgradeTower(s2, fresh.id).ok);
  assert.equal(statsAt(fresh).range, TOWERS.cannon.range + 18);
});

test("路径进度单调推进，速度被减速影响", () => {
  const a = pointAt(0);
  const b = pointAt(500);
  assert.ok(b.x !== a.x || b.y !== a.y);
});

// ---------------- 经济（PRD 缺口 4） ----------------
test("加农炮升级价 130 / 169", () => {
  assert.equal(ECONOMY.upgradeCost(TOWERS.cannon.cost, 1), 130);
  assert.equal(ECONOMY.upgradeCost(TOWERS.cannon.cost, 2), 169);
});

test("拆除返还累计投入的 60%", () => {
  const s = createGame(1);
  const r = placeTower(s, 5, 0, "cannon");
  assert.ok(r.ok);
  s.coins = 1000;
  upgradeTower(s, r.tower.id);
  const invested = investedOf(s.towers[0]);
  assert.equal(invested, 100 + 130);
  const before = s.coins;
  const sold = sellTower(s, r.tower.id);
  assert.ok(sold.ok);
  assert.equal(sold.refund, Math.floor(230 * 0.6));
  assert.equal(s.coins, before + sold.refund);
});

test("初始金币 320，起始生命 20", () => {
  const s = createGame(1);
  assert.equal(s.coins, 320);
  assert.equal(s.hp, CARROT_HP);
});

// ---------------- 状态机（PRD 缺口 5） ----------------
test("路径格、装饰格、已占用格都不能建造", () => {
  const s = createGame(1);
  s.coins = 9999;
  assert.equal(placeTower(s, 0, 2, "cannon").ok, false);   // 路径
  assert.equal(placeTower(s, 1, 0, "cannon").ok, false);   // 装饰
  const r = placeTower(s, 5, 0, "cannon");
  assert.ok(r.ok);
  assert.equal(placeTower(s, 5, 0, "cannon").ok, false);   // 已占用
});

test("金币不足时建造失败并给出差额", () => {
  const s = createGame(1);
  s.coins = 50;
  const r = placeTower(s, 5, 0, "cannon");
  assert.equal(r.ok, false);
  assert.match(r.reason, /差 50/);
});

test("暂停时不能建造、不能升级", () => {
  const s = createGame(1);
  s.coins = 9999;
  const r = placeTower(s, 5, 0, "cannon");
  assert.ok(r.ok);
  togglePause(s);
  assert.equal(placeTower(s, 5, 1, "cannon").ok, false);
  assert.equal(upgradeTower(s, r.tower.id).ok, false);
});

test("暂停会冻结世界", () => {
  const s = createGame(1);
  startWave(s);
  update(s, 1.0);
  const t0 = s.time;
  togglePause(s);
  update(s, 1.0);
  assert.equal(s.time, t0);
});

test("布防倒计时结束后自动开波", () => {
  const s = createGame(1);
  assert.equal(s.phase, PHASE.BUILD);
  for (let i = 0; i < 13 * 60; i += 1) update(s, 1 / 60);
  assert.equal(s.wave, 1);
});

test("清完一波回到布防状态并给奖励", () => {
  const s = createGame(1);
  startWave(s);
  s.enemies = [];
  s.pending = [];
  const before = s.coins;
  update(s, 1 / 60);
  assert.equal(s.phase, PHASE.BUILD);
  assert.equal(s.coins, before + ECONOMY.waveBonus(1));
  assert.equal(Math.ceil(s.buildTimer), 12);
});

test("同时漏怪按类型累加扣血，生命不为负", () => {
  const s = createGame(1);
  startWave(s);
  s.pending = [];
  s.hp = 3;
  s.enemies = [
    mkEnemy({ id: 10, progress: 1655.9, leak: 5 }),
    mkEnemy({ id: 11, progress: 1655.9, leak: 5 }),
  ];
  update(s, 1 / 60);
  assert.equal(s.hp, 0);
  assert.equal(s.phase, PHASE.LOST);
});

test("失败后所有游戏操作被锁定，只剩重开", () => {
  const s = createGame(1);
  s.coins = 9999;
  s.hp = 1;
  startWave(s);
  s.pending = [];
  s.enemies = [mkEnemy({ id: 10, progress: 1655.9, leak: 5 })];
  update(s, 1 / 60);
  assert.equal(s.phase, PHASE.LOST);
  const snap = snapshot(s);
  assert.equal(snap.phase, PHASE.LOST);
  assert.equal(placeTower(s, 1, 0, "cannon").ok, false);
  assert.equal(startWave(s).ok, false);
  assert.equal(togglePause(s).ok, false);
});

test("最后一波清完判定胜利", () => {
  const s = createGame(1);
  s.wave = WAVE_COUNT;
  s.phase = PHASE.WAVE;
  s.pending = [];
  s.enemies = [];
  update(s, 1 / 60);
  assert.equal(s.phase, PHASE.WON);
});

test("同一随机种子结果一致", () => {
  const run = () => {
    const s = createGame(42);
    s.coins = 9999;
    placeTower(s, 1, 0, "cannon");
    placeTower(s, 1, 1, "ice");
    startWave(s);
    for (let i = 0; i < 60 * 40; i += 1) update(s, 1 / 60);
    return snapshot(s);
  };
  assert.deepEqual(run(), run());
});

test("倍速不改变逻辑结果：同一游戏时刻状态完全一致", () => {
  const play = (speed) => {
    const s = createGame(7);
    s.speed = speed;
    s.coins = 9999;
    placeTower(s, 5, 0, "cannon");
    startWave(s);
    // 倍速 = 每个真实帧多跑几步，所以到达同一个游戏时刻所需的帧数不同
    const frames = speed === 1 ? 60 * 60 : (60 * 60) / speed;
    for (let i = 0; i < frames; i += 1) update(s, 1 / 60);
    return { hp: s.hp, wave: s.wave, kills: s.stats.kills, time: Math.round(s.time * 1000) / 1000 };
  };
  assert.deepEqual(play(1), play(3));
});
