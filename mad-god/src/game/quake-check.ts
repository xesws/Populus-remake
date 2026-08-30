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
import { BLUE, inMap, Tree, WATER, WORLD } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function tickFlow(sim: Sim, dt: number): void {
  sim.tick(dt); // v0.18 不启用 flowLava（见文件头说明），冷却走 sim.tick 内的 world.tickFx
}

/**
 * v0.24 沿裂缝取一个「图内 + 可走 + 脚下有岩浆」的点（取不到返回 null）。
 * 三个条件缺一不可：地震在近岸施放时裂缝会甩到图外（实测 x=74.05 > WORLD=72），
 * 而 sinkTrench/seedLava 把越界下标夹到边框，于是"图外的裂缝点"竟在边框格上读到 lava>0；
 * addUnit 又把单位夹回图内（那儿没浆），表现就是"单位站在岩浆上不掉血"。
 */
function lavaCrackPoint(
  sim: Sim,
  q: { x: number; z: number; angs: number[]; lens: number[] },
): { x: number; z: number } | null {
  for (let k = 0; k < q.angs.length; k++) {
    const len = q.lens[k] ?? 8;
    // 从尖端往回扫：尖端那段种得最晚、余量最足（tickFx 冷却 1.4/s 会先吃掉根部）。
    for (let s = len; s >= 0; s -= 0.5) {
      const p = sim.crackPoint(q, k, s);
      if (!inMap(p.x, p.z) || !sim.world.walkableAt(p.x, p.z)) continue;
      const i = sim.world.sampleAt(p.x, p.z);
      if (sim.world.lava[i] > 0.25 && sim.world.heightAt(p.x, p.z) > WATER) return p;
    }
  }
  return null;
}

/** 同上，但不要求有浆（给"裂缝穿过房屋"用例找一处能在图内落地的陆点）。 */
function landCrackPoint(
  sim: Sim,
  q: { x: number; z: number; angs: number[]; lens: number[] },
): { x: number; z: number } | null {
  for (let k = 0; k < q.angs.length; k++) {
    const len = q.lens[k] ?? 8;
    for (let s = 1; s <= len; s += 0.5) {
      const p = sim.crackPoint(q, k, s);
      if (inMap(p.x, p.z) && sim.world.walkableAt(p.x, p.z)) return p;
    }
  }
  return null;
}

/**
 * v0.24 地图模板化后固定坐标 (26,26) 不再保证是陆地。从蓝方出生点螺旋找一块净空可走地，
 * 并 flattenPad 整出 22×22 平地（sculpt-check 同款手法）——模板海岸随机，
 * 不整平的话裂缝 8~10 格经常伸出海，"裂缝上的陆地/岩浆点"类断言随机失败。
 * 距图边留 13 格：保证 22×22 平台完整落在图内（否则平台被裁半、裂缝照样甩出界）。
 */
function landSpot(sim: Sim): { x: number; z: number } {
  const s = sim.world.startPad(BLUE);
  const lo = 13;
  const hi = WORLD - 13;
  for (let r = 6; r < 26; r += 1.5) {
    for (let a = 0; a < 10; a++) {
      const x = s.x + Math.cos((a / 10) * Math.PI * 2) * r;
      const z = s.z + Math.sin((a / 10) * Math.PI * 2) * r;
      if (x < lo || x > hi || z < lo || z > hi) continue;
      if (!sim.world.walkableAt(x, z)) continue;
      if (sim.units.some((o) => (o.x - x) ** 2 + (o.z - z) ** 2 <= 16)) continue;
      sim.world.flattenPad(x, z, 22, 22, 0, Math.max(sim.world.heightAt(x, z), 0.8));
      return { x, z };
    }
  }
  return { x: s.x, z: s.z };
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
  const spot = landSpot(sim);
  const x = spot.x;
  const z = spot.z;
  sim.fillCharges(BLUE); // v0.26d 开局 0 颗，测试前填满
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
  const spot = landSpot(sim);
  const x = spot.x;
  const z = spot.z;
  sim.fillCharges(BLUE); // v0.26d 开局 0 颗，测试前填满
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
  const spot = landSpot(sim);
  const x = spot.x;
  const z = spot.z;
  sim.fillCharges(BLUE); // v0.26d 开局 0 颗，测试前填满
  assert(sim.quakeSpell.cast(sim, BLUE, x, z).ok, "quake cast ok");
  // quake 结束后对象会被清空，先存副本（含 lens：尖端采样需要各缝长度）。
  const q0 = { x, z, angs: sim.quake!.angs.slice(), lens: sim.quake!.lens.slice() };

  // 6.05s：quake 生命周期刚结束（t>dur+4=6.0，坠缝判定失效）就立刻测——
  // 再等下去 tickFx 的 1.4/s 冷却会把裂缝浆耗干（v0.24 曾在 6.5s 全干）。
  for (let i = 0; i < 121; i++) tickFlow(sim, 0.05);
  assert(sim.quake === null, "quake 生命周期结束");

  // 找一处裂缝岩浆点（v0.24：交给 lavaCrackPoint——图内 + 可走 + 脚下有浆三条一起判；
  // 旧循环只判 lava>0.25 && h>WATER，会在被夹到边框的越界格上误判命中）。
  const pt = lavaCrackPoint(sim, q0);
  assert(pt !== null, "找到图内可走的裂缝岩浆点");
  const px = pt!.x;
  const pz = pt!.z;

  const u = sim.addUnit(BLUE, "walker", px, pz); // 蓝方无任务 walker 站桩（v0.10 待机逻辑）
  u.hp = 2; // 打残：余量本就紧张，残血让灼烧链路在浆干前完成验证
  const hp0 = u.hp;
  assert(hp0 > 0, "测试单位带残血入场（未被瞬死）");
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
  const spot = landSpot(sim);
  const x = spot.x;
  const z = spot.z;
  sim.fillCharges(BLUE); // v0.26d 开局 0 颗，测试前填满
  assert(sim.quakeSpell.cast(sim, BLUE, x, z).ok, "quake cast ok");
  const q0 = { x, z, angs: sim.quake!.angs.slice(), lens: sim.quake!.lens.slice() };

  // 2.5s 裂缝完全展开后，沿裂缝找一处能落屋的陆地点（v0.24：改走 landCrackPoint——
  // 除陆地外还要求在图内且可走，旧判据 world.land() 不查越界，会在被夹到边框的
  // 越界格上误判命中，房子就"落在了图外"）。
  for (let i = 0; i < 50; i++) tickFlow(sim, 0.05);
  const spot2 = landCrackPoint(sim, q0);
  assert(spot2 !== null, "找到裂缝上图内可走的陆地点");
  const px = spot2!.x;
  const pz = spot2!.z;
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
  const spot = landSpot(sim);
  const x = spot.x;
  const z = spot.z;
  sim.fillCharges(BLUE); // v0.26d 开局 0 颗，测试前填满
  assert(sim.quakeSpell.cast(sim, BLUE, x, z).ok, "quake cast ok");
  const q0 = { x, z, angs: sim.quake!.angs.slice(), lens: sim.quake!.lens.slice() };

  // 2.5s 裂缝展开完毕、岩浆已涌出，quake 仍在活跃期（t<6s）→ burnTrees 生效窗口。
  for (let i = 0; i < 50; i++) tickFlow(sim, 0.05);
  let px = -1;
  let pz = -1;
  outer: for (let k = 0; k < q0.angs.length; k++) {
    const len = q0.lens[k] ?? 8;
    for (let s = 1; s <= len; s += 0.5) {
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
