// v0.18 地震（quake）技能检查：
// a) cast 后裂缝覆盖半径 ≥ 7（≥ 新版火山半径 6.5~7）
// b) 裂缝沿线冒出岩浆、约 5~10 秒后干涸（lava→0 且 scorch>0 焦土仍在）
// c) 站在裂缝岩浆上的单位持续掉血并死亡（宽容上限 12 秒）
// d) 被裂缝穿过的房屋 hp 下降或归零
// 另附：岩浆上的树被烧毁。
//
// 说明：world.flowLava（岩浆向低处搬移）v0.18 集成时评估后**不启用**——其搬移是"累加汇聚"语义，
// 多处岩浆会灌进同一批低格把寿命堆到几十秒，冷却 -1/s 追不上，与"5~10 秒干涸"的产品要求冲突。
// 焦土改由 seedLava 直接写入 scorch（播浆必留焦土），不再依赖 flowLava。
import { Sim } from "./sim";
import { BLUE, Tree, WATER } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function tickFlow(sim: Sim, dt: number): void {
  sim.tick(dt); // v0.18 不启用 flowLava（见文件头说明），冷却走 sim.tick 内的 world.tickFx
}

function anyLava(sim: Sim): boolean {
  for (let i = 0; i < sim.world.lava.length; i++) {
    if (sim.world.lava[i]! > 0) return true;
  }
  return false;
}

// a) cast 后裂缝覆盖半径 ≥ 7：采样每条裂缝最远点距离，另校验条数/长度/数组同步。
function testQuakeCrackCoverage(): void {
  const sim = new Sim(new World(42));
  sim.lockWin = true;
  const x = 26;
  const z = 26;
  const r = sim.quakeSpell.cast(sim, BLUE, x, z);
  assert(r.ok, "quake cast ok");
  const q = sim.quake!;
  assert(q.angs.length >= 5 && q.angs.length <= 6, `裂缝条数 ${q.angs.length} ∈ [5,6]`);
  assert(q.lens.length === q.angs.length && q.opened.length === q.angs.length, "angs/lens/opened 数组长度同步");
  let maxD = 0;
  for (let k = 0; k < q.angs.length; k++) {
    const len = q.lens[k]!;
    assert(len >= 8 && len <= 10, `裂缝 ${k} 长度 ${len.toFixed(2)} ∈ [8,10]`);
    for (let s = 0; s <= len; s += 0.1) {
      const p = sim.crackPoint(q, k, s);
      maxD = Math.max(maxD, Math.hypot(p.x - x, p.z - z));
    }
  }
  assert(maxD >= 7, `裂缝最远覆盖 ${maxD.toFixed(2)} ≥ 7（≥ 新版火山半径）`);
  console.log("testQuakeCrackCoverage ok");
}

// b) 裂缝沿线岩浆冒出 + 约 10 秒后干涸：lava→0 且 scorch>0（焦土残留）。
function testQuakeLavaEruptsAndDries(): void {
  const sim = new Sim(new World(42));
  sim.lockWin = true;
  const x = 26;
  const z = 26;
  assert(sim.quakeSpell.cast(sim, BLUE, x, z).ok, "quake cast ok");
  const q = sim.quake!;

  // 2.5s：裂缝完全展开（dur=2.0），沿线岩浆应已涌出且仍在燃烧。
  for (let i = 0; i < 50; i++) tickFlow(sim, 0.05);
  let lavaPts = 0;
  for (let k = 0; k < q.angs.length; k++) {
    for (let s = 0; s <= q.opened[k]!; s += 0.5) {
      const p = sim.crackPoint(q, k, s);
      if (sim.world.lava[sim.world.sampleAt(p.x, p.z)]! > 0) lavaPts++;
    }
  }
  assert(lavaPts >= q.angs.length, `裂缝沿线存在岩浆（${lavaPts} 个采样点）`);

  // 继续 tick 至岩浆全干：理论最晚 ≈ 2.0s 展开结束 + 根部余量 10s = 12s，容差 14s。
  const dryStart = sim.time;
  let dryT = -1;
  for (let i = 0; i < 400; i++) {
    tickFlow(sim, 0.05);
    if (anyLava(sim)) continue;
    dryT = sim.time;
    break;
  }
  assert(dryT >= 0, "岩浆在 20s 内干涸");
  const elapsed = dryT - dryStart;
  assert(elapsed >= 4 && elapsed <= 14, `岩浆约 ${elapsed.toFixed(1)}s 后干涸（期望 5~10s，宽容 4~14s）`);
  assert(!anyLava(sim), "干涸后 lava 全 0");
  let scorchPts = 0;
  for (let k = 0; k < q.angs.length; k++) {
    for (let s = 0; s <= q.lens[k]!; s += 0.5) {
      const p = sim.crackPoint(q, k, s);
      if (sim.world.scorch[sim.world.sampleAt(p.x, p.z)]! > 0) scorchPts++;
    }
  }
  assert(scorchPts >= q.angs.length, `干涸后沿线焦土仍在（${scorchPts} 个采样点 scorch>0）`);
  console.log("testQuakeLavaEruptsAndDries ok");
}

// c) 站在裂缝岩浆上的单位持续掉血并死亡（宽容上限 12 秒，实际 10/s 灼烧很快致死）。
function testQuakeLavaBurnsUnit(): void {
  const sim = new Sim(new World(42));
  sim.lockWin = true;
  const x = 26;
  const z = 26;
  assert(sim.quakeSpell.cast(sim, BLUE, x, z).ok, "quake cast ok");
  const q0 = { x, z, angs: sim.quake!.angs.slice() }; // quake 结束后对象会被清空，先存副本

  // 6.5s：裂缝展开完毕、岩浆已涌出且 quake 生命周期结束（t > dur+4=6s，坠缝判定已失效，
  // 单位不会被 slideIntoCracks 吸入，纯验证岩浆灼烧链路）。
  for (let i = 0; i < 130; i++) tickFlow(sim, 0.05);
  assert(sim.quake === null, "quake 生命周期结束");

  // 找一处裂缝岩浆点：从尖端往回找（尖端岩浆种得最晚、余量最足），
  // 要求 lava 余量 >1s——10/s 灼烧足以在余量耗尽前烧死满血 walker（6 血 / 0.6s）。
  let px = -1;
  let pz = -1;
  outer: for (let k = 0; k < q0.angs.length; k++) {
    for (let s = 8; s >= 0; s -= 0.5) {
      const p = sim.crackPoint(q0, k, s);
      const i = sim.world.sampleAt(p.x, p.z);
      if (sim.world.lava[i]! > 1.0 && sim.world.heightAt(p.x, p.z) > WATER) {
        px = p.x;
        pz = p.z;
        break outer;
      }
    }
  }
  assert(px >= 0, "找到裂缝岩浆点");

  const u = sim.addUnit(BLUE, "walker", px, pz); // 蓝方无任务 walker 站桩（v0.10 待机逻辑）
  const hp0 = u.hp;
  assert(hp0 > 0, "测试单位满血入场");
  const placedAt = sim.time;
  let dropped = false;
  let died = false;
  for (let i = 0; i < 240; i++) {
    tickFlow(sim, 0.05);
    if (u.hp < hp0) dropped = true;
    if (!sim.units.includes(u)) {
      died = true;
      break;
    }
  }
  assert(dropped, "单位在裂缝岩浆上持续掉血");
  assert(died, "单位被岩浆灼烧至死");
  const killT = sim.time - placedAt;
  assert(killT <= 12, `死亡用时 ${killT.toFixed(1)}s ≤ 12s 宽容上限`);
  console.log("testQuakeLavaBurnsUnit ok");
}

// d) 被裂缝穿过的房屋 hp 下降或归零（collapseCutHouses 直拆 / burnBuildings 岩浆灼烧）。
function testQuakeCrackHitsHouse(): void {
  const sim = new Sim(new World(42));
  sim.lockWin = true;
  const x = 26;
  const z = 26;
  assert(sim.quakeSpell.cast(sim, BLUE, x, z).ok, "quake cast ok");
  const q0 = { x, z, angs: sim.quake!.angs.slice() };

  // 2.5s 裂缝完全展开后，沿第一条裂缝找一处陆地点放 L1 茅屋。
  for (let i = 0; i < 50; i++) tickFlow(sim, 0.05);
  let px = -1;
  let pz = -1;
  outer: for (let k = 0; k < q0.angs.length; k++) {
    for (let s = 2; s <= 8; s += 0.5) {
      const p = sim.crackPoint(q0, k, s);
      if (sim.world.land(p.x, p.z)) {
        px = p.x;
        pz = p.z;
        break outer;
      }
    }
  }
  assert(px >= 0, "找到裂缝上的陆地点");
  const house = sim.placeComplete(BLUE, px, pz, 0, "hut", 1);
  const hp0 = house.hp;
  let fell = false;
  for (let i = 0; i < 100; i++) {
    tickFlow(sim, 0.05);
    if (!sim.buildings.includes(house)) {
      fell = true; // 被直拆后 cull 移除
      break;
    }
    if (house.hp < hp0) {
      fell = true; // 被岩浆灼烧掉血
      break;
    }
  }
  assert(fell, "被裂缝穿过的房屋 hp 下降或归零");
  console.log("testQuakeCrackHitsHouse ok");
}

// 附：岩浆上的树被烧毁（alive=false，走既有 regen 复活节奏）。
function testQuakeLavaBurnsTree(): void {
  const sim = new Sim(new World(42));
  sim.lockWin = true;
  const x = 26;
  const z = 26;
  assert(sim.quakeSpell.cast(sim, BLUE, x, z).ok, "quake cast ok");
  const q0 = { x, z, angs: sim.quake!.angs.slice() };

  // 2.5s 裂缝展开完毕、岩浆已涌出，quake 仍在活跃期（t<6s）→ burnTrees 生效窗口。
  for (let i = 0; i < 50; i++) tickFlow(sim, 0.05);
  let px = -1;
  let pz = -1;
  outer: for (let k = 0; k < q0.angs.length; k++) {
    for (let s = 1; s <= 8; s += 0.5) {
      const p = sim.crackPoint(q0, k, s);
      const i = sim.world.sampleAt(p.x, p.z);
      if (sim.world.lava[i]! > 0 && sim.world.land(p.x, p.z)) {
        px = p.x;
        pz = p.z;
        break outer;
      }
    }
  }
  assert(px >= 0, "找到裂缝岩浆点");
  const tree = new Tree(9999, px, pz, sim.world.heightAt(px, pz), true, 0);
  sim.trees.push(tree);
  tickFlow(sim, 0.05);
  assert(!tree.alive, "岩浆上的树被烧毁");
  console.log("testQuakeLavaBurnsTree ok");
}

function main(): void {
  testQuakeCrackCoverage();
  testQuakeLavaEruptsAndDries();
  testQuakeLavaBurnsUnit();
  testQuakeCrackHitsHouse();
  testQuakeLavaBurnsTree();
  console.log("quake-check ok (v0.18 地震：覆盖半径/冒浆干涸/灼烧单位/拆房/烧树)");
}

main();
