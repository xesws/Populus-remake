// v0.39 水规则测试（feature=water）：不能游泳 —— 不可涉水、落水持续掉血至死。
//
// 背景（用户实测口径）："敌人会直接从水里面穿过来，然后进到我的基地里。这绝对是个 bug：
// ① 敌人不应该这么走；② 游戏设定里所有人都是不能游泳的，进入水里应该扣血直接死亡，
// 但现在水面对人造成不了伤害。"
//
// 两个真实根因（都在移动/危害层）：
//   ① PathSystem.canStandOn 的鬼影分支（u.ghostT > 0）对**任何格**都放行——卡住的单位会直接涉水
//      走向对岸；watchStuck/unstick 还会把目标改写成“直线冲到目的地”，于是敌人从水里穿过来了。
//   ② resolveCollisions 每帧把踩进非可走格的单位 nearestLand 弹回岸边，而 HazardSystem 的溺水
//      伤害（4/s）只来得及跑一帧（≈0.07 血）——观感就是“水面对人造成不了伤害”。
// 本文件锁定修复后的两条硬不变量：**干地步进**（鬼影也不得穿水）+ **落水必沉**（含宽限期与豁免）。
// 纯 node 可跑（npx tsx src/game/water-check.ts）。

import { Sim } from "./sim";
import { astar } from "./path";
import { BLUE, dist2, RED, Unit, WATER } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function play(sim: Sim, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.05) {
    sim.tick(0.05);
    sim.winner = null;
  }
}

/** 找一片深水（周围 8 格采样都是水下，避免选到海岸线）。 */
function deepWater(sim: Sim): { x: number; z: number } {
  for (let z = 2; z < 70; z += 0.5) {
    for (let x = 2; x < 70; x += 0.5) {
      let ok = true;
      for (let dz = -1; dz <= 1 && ok; dz += 1) {
        for (let dx = -1; dx <= 1 && ok; dx += 1) {
          if (sim.world.heightAt(x + dx, z + dz) > WATER - 0.05) ok = false;
        }
      }
      if (ok) return { x, z };
    }
  }
  throw new Error("找不到深水点");
}

/** 找一个分岛种子（两出生点不同岛且互不可达）。 */
function splitSeed(): number {
  for (let s = 1; s <= 40; s++) {
    const w = new World(s);
    const a = w.startPad(BLUE);
    const b = w.startPad(RED);
    if (w.islandAt(a.x, a.z) === w.islandAt(b.x, b.z)) continue;
    const path = astar(w, a.x, a.z, b.x, b.z, 20736, 0);
    const end = path[path.length - 1];
    if (!end || Math.hypot(end.x - b.x, end.z - b.z) > 0.01) return s;
  }
  throw new Error("1..40 内没有分岛种子");
}

// ── T1：鬼影不得穿水——被指派到对岸的单位永远不能涉水 ────────────────────
function testNoWaterCrossing(): void {
  const seed = splitSeed();
  const sim = new Sim(new World(seed));
  const foePad = sim.world.startPad(RED);
  const myPad = sim.world.startPad(BLUE);
  const w = sim.world;
  // 派一名武士去对岸（玩家点了个不可达的点：这正是旧实现“直线冲过去”的触发条件）
  const runner: Unit = sim.addUnit(BLUE, "warrior", myPad.x, myPad.z + 1);
  sim.sendMove(runner, foePad.x, foePad.z);
  const homeIsle = w.islandAt(runner.x, runner.z);
  let everWet = false;
  let maxDist = 0;
  for (let t = 0; t < 60; t += 0.05) {
    sim.tick(0.05);
    sim.winner = null;
    if (!w.cellLand(runner.x, runner.z)) everWet = true;
    maxDist = Math.max(maxDist, Math.hypot(runner.x - myPad.x, runner.z - myPad.z));
  }
  assert(runner.hp > 0, `涉水失败的单位应存活（不会被溺水机制误杀）——hp=${runner.hp.toFixed(1)}`);
  assert(!everWet, "鬼影/直冲兜底不得让地面单位踏入水里（旧实现：卡住 2s 后 ghostT 穿水，敌人从水里穿过来）");
  assert(w.islandAt(runner.x, runner.z) === homeIsle, "跨海指令不得把单位送到对岸（应留在本岛）");
  console.log(`testNoWaterCrossing ok（seed=${seed}，60s 最远离家 ${maxDist.toFixed(1)} 格，全程干地）`);
}

// ── T2：落水必沉——宽限期后持续掉血直到死亡 ──────────────────────────────
function testDrownKills(): void {
  const sim = new Sim(new World(42));
  const spot = deepWater(sim);
  const victim: Unit = sim.addUnit(RED, "warrior", spot.x, spot.z);
  const hp0 = victim.hp;
  // 宽限期内不扣血：短背被挤下水岸不应该致命
  for (let t = 0; t < 0.4; t += 0.05) sim.tick(0.05);
  assert(victim.hp === hp0, `落水 0.4s（宽限期内）不应扣血（实际 ${hp0} → ${victim.hp}）`);
  // 超过宽限 → 持续掉血 → 沉底
  let sawDamage = false;
  for (let t = 0; t < 20; t += 0.05) {
    sim.tick(0.05);
    sim.winner = null;
    if (victim.hp < hp0) sawDamage = true;
  }
  assert(sawDamage, "超过溺亡宽限期后应持续扣血（水面必须有伤害）");
  assert(!sim.units.some((u) => u.id === victim.id), "溺亡单位应被清场移除");
  console.log("testDrownKills ok");
}

// ── T3：豁免——船、船员、大龙不溺水 ──────────────────────────────────────
function testWaterExemptions(): void {
  const sim = new Sim(new World(42));
  const spot = deepWater(sim);
  const boat = sim.addUnit(BLUE, "boat", spot.x, spot.z);
  const crew = sim.addUnit(BLUE, "firewarrior", spot.x, spot.z);
  crew.homeId = boat.id;
  crew.hp = crew.maxHp;
  const dragon = sim.addUnit(BLUE, "dragon", spot.x + 2, spot.z + 2);
  dragon.hp = dragon.maxHp;
  play(sim, 6);
  assert(boat.hp > 0, `船浮在水上不溺水（hp ${boat.hp}）`);
  assert(crew.hp > 0, `船员挂在船上不溺水（hp ${crew.hp}）`);
  assert(dragon.hp > 0, `大龙在半空飞，不受水面影响（hp ${dragon.hp}）`);
  console.log("testWaterExemptions ok");
}

// ── T4：玩家雕水淹敌（lower 到水面以下 = 合法战术）──────────────────────
function testSculptDrown(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  // 找一块离家不远的陆地，放一名敌兵
  let spot: { x: number; z: number } | null = null;
  for (let r = 4; r <= 12 && !spot; r += 0.5) {
    for (let a = 0; a < 32 && !spot; a++) {
      const ang = (a / 32) * Math.PI * 2;
      const x = pad.x + Math.cos(ang) * r;
      const z = pad.z + Math.sin(ang) * r;
      if (sim.world.walkableAt(x, z)) spot = { x, z };
    }
  }
  assert(!!spot, "找得到一块陆地放敌人");
  const foe: Unit = sim.addUnit(RED, "warrior", spot!.x, spot!.z);
  const hp0 = foe.hp;
  // 把该格雕到水面以下（模拟玩家用 lower 把敌人沉进海里）
  const ix = Math.round(spot!.x / 0.25);
  const iz = Math.round(spot!.z / 0.25);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) sim.world.setSample(ix + dx, iz + dz, 0.04);
  }
  play(sim, 8);
  assert(foe.hp < hp0, `被雕沉的敌人应开始溺水扣血（${hp0} → ${foe.hp.toFixed(1)}）`);
  console.log("testSculptDrown ok");
}

// ── T5：上岸即停血（溺水计时清零，不是永久标记）──────────────────────────
function testDrownTimerResets(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  // 找一块临水的陆地：格心是干的、且 1 格内有水
  let coast: { x: number; z: number } | null = null;
  for (let r = 4; r <= 20 && !coast; r += 0.5) {
    for (let a = 0; a < 32 && !coast; a++) {
      const ang = (a / 32) * Math.PI * 2;
      const x = pad.x + Math.cos(ang) * r;
      const z = pad.z + Math.sin(ang) * r;
      if (!sim.world.cellLand(x, z)) continue;
      if (sim.world.heightAt(x + 1, z) <= WATER || sim.world.heightAt(x - 1, z) <= WATER) coast = { x, z };
    }
  }
  assert(!!coast, "找得到一块临水陆地");
  const u: Unit = sim.addUnit(BLUE, "warrior", coast!.x, coast!.z);
  const hp0 = u.hp;
  // 落水 0.4s（宽限期内）后自己走上岸 → 不应有任何伤害
  const spot = deepWater(sim);
  u.x = spot.x;
  u.z = spot.z;
  for (let t = 0; t < 0.4; t += 0.05) sim.tick(0.05);
  u.x = coast!.x;
  u.z = coast!.z;
  play(sim, 3);
  assert(u.hp === hp0, `短暂落水后上岸不应累计伤害（hp ${hp0} → ${u.hp}）`);
  console.log("testDrownTimerResets ok");
}

// ── T6：海岸线不得误杀（站可走岸边被挤不可致死）─────────────────────────
// boat-check 登船上用例实测踩到过：第七名水手站在可走岸点上，被挤挪半格就进了“格内某角在水下”的
// 格，若把它当落水就会当场淹死（玩家搁一个村民在岸边等他上船、结果人自己淹死了）。
function testShorelineNudgeSafe(): void {
  const sim = new Sim(new World(2050));
  let spot: { x: number; z: number } | null = null;
  for (let z = 2; z < 70 && !spot; z += 0.25) {
    for (let x = 2; x < 70 && !spot; x += 0.25) {
      // “湿角格”：不是整格陆地（某个角在水下），但格心仍在水面以上
      if (!sim.world.cellLand(x, z) && sim.world.heightAt(x, z) > WATER) spot = { x, z };
    }
  }
  assert(!!spot, "找得到一块海岸线湿角格");
  const u: Unit = sim.addUnit(BLUE, "warrior", spot!.x, spot!.z);
  const hp0 = u.hp;
  play(sim, 5);
  assert(u.hp === hp0, `站在“格心干、某角湿”的岸边不应扣血（${hp0} → ${u.hp}）——海岸线误杀回归锁`);
  console.log("testShorelineNudgeSafe ok");
}

testNoWaterCrossing();
testDrownKills();
testWaterExemptions();
testSculptDrown();
testDrownTimerResets();
testShorelineNudgeSafe();
console.log("water-check ok (v0.39 水规则：鬼影不得穿水 / 落水宽限后必沉 / 船与龙豁免 / 雕水淹敌 / 上岸停血 / 海岸不误杀)");
