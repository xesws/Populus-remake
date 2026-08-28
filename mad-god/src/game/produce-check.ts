import { Sim } from "./sim";
import { BLUE, houseBaseRate, houseHp, houseMaxPop, HOUSE_DWELL_BONUS, Tree, Unit, woodNeedFor } from "./types";
import { World, padsOverlap } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function testWoodChoppingAndDelivery(): void {
  const sim = new Sim(new World(42));
  const walker = sim.units.find((u) => u.team === BLUE && u.kind === "walker");
  assert(!!walker, "need a blue walker");

  // Prep pad and place an L0 hut site near walker
  const siteX = walker!.x + 3.0;
  const siteZ = walker!.z;
  sim.tryPrepFound(siteX, siteZ, 0);
  const site = sim.foundSite(BLUE, siteX, siteZ, 0, "hut");
  assert(site !== null, "L0 hut site founded");
  assert(site!.level === 0, "site is level 0");
  assert(site!.need === 2, "L0 hut needs 2 wood");
  assert(sim.needsWood(site!), "site needs wood");

  // Create a tree right next to walker for chopping
  const tree = new Tree(9999, walker!.x + 0.6, walker!.z, sim.world.heightAt(walker!.x + 0.6, walker!.z), true, 0);
  sim.trees.push(tree);

  // Walker starts chopping
  walker!.order = "settle";
  walker!.job = "chop";
  walker!.targetId = tree.id;
  walker!.channel = 0;
  walker!.carry = 0;

  // Advance time until chop finishes (24 ticks * 0.05 = 1.2s)
  for (let i = 0; i < 24; i++) sim.tick(0.05);

  assert(!tree.alive, "tree must be chopped down");
  assert((walker!.carry as number) === 1, "walker is carrying wood");
  assert((walker!.job as string) === "haul", "walker job is haul");

  // Move walker near site edge and simulate delivery
  const edge = sim.padEdge(site!.x, site!.z, site!.padW, site!.padD, site!.yaw, walker!.x, walker!.z);
  walker!.x = edge.x;
  walker!.z = edge.z;
  walker!.targetId = site!.id;

  sim.tick(0.05);
  assert(site!.wood >= 1, "site received 1 wood");
  assert(walker!.carry === 0, "walker dropped wood after delivery");

  // Deliver second wood to finish L0 hut into L1 hut
  sim.deliverWood(site!);
  assert(site!.wood === 0, "wood reset upon completion");
  assert(site!.level === 1, "hut upgraded from L0 to L1");
  assert(site!.hp === houseHp(1), "hut hp upgraded to L1 hp");
  assert(site!.need === woodNeedFor("hut", 1), "hut need is 0 for L1");

  console.log("testWoodChoppingAndDelivery ok");
}

function testCampSiteDelivery(): void {
  const sim = new Sim(new World(42));
  const s = sim.world.startPad(BLUE);
  const toCx = 52 * 0.5 - s.x;
  const toCz = 52 * 0.5 - s.z;
  const len = Math.hypot(toCx, toCz) || 1;
  const fx = toCx / len;
  const fz = toCz / len;
  const px = -fz;
  const pz = fx;
  let campX = s.x + fx * 8;
  let campZ = s.z + fz * 8;
  for (const [a, b] of [
    [8.0, 0],
    [7.2, 2.6],
    [7.2, -2.6],
    [9.0, 1.8],
    [6.6, 0],
  ] as Array<[number, number]>) {
    const x = s.x + fx * a + px * b;
    const z = s.z + fz * a + pz * b;
    sim.tryPrepFound(x, z, s.yaw);
    if (sim.canFound(x, z, 1, s.yaw)) {
      campX = x;
      campZ = z;
      break;
    }
  }
  const camp = sim.foundSite(BLUE, campX, campZ, s.yaw, "warriorHut");
  assert(camp !== null, "warrior camp site founded");
  assert(camp!.level === 0, "camp starts at level 0");
  assert(camp!.need === 4, "warrior camp needs 4 wood");

  for (let i = 0; i < 3; i++) {
    sim.deliverWood(camp!);
    assert(camp!.wood === i + 1, `camp wood is ${i + 1}`);
    assert(camp!.level === 0, "still level 0 before 4th wood");
  }

  sim.deliverWood(camp!);
  assert(camp!.level === 1, "camp completes into level 1 warriorHut");
  assert(camp!.need === 0, "camp needs 0 wood once complete");

  console.log("testCampSiteDelivery ok");
}

function testHutOccupancy(): void {
  const sim = new Sim(new World(42));
  const hut = sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level === 1);
  assert(!!hut, "need starting L1 hut");
  assert(hut!.dwell === 0, "hut initially has 0 dwell");
  assert(houseMaxPop(1) === 2, "L1 house max pop is 2");

  const walker1 = sim.addUnit(BLUE, "walker", hut!.x + 1, hut!.z + 1);
  const walker2 = sim.addUnit(BLUE, "walker", hut!.x - 1, hut!.z + 1);
  const walker3 = sim.addUnit(BLUE, "walker", hut!.x, hut!.z + 2);

  const occ1 = sim.occupy(walker1, hut!);
  assert(occ1, "first walker occupies hut");
  assert(hut!.dwell === 1, "dwell is 1");
  assert(walker1.homeId === hut!.id, "walker1 homeId set to hut");

  const occ2 = sim.occupy(walker2, hut!);
  assert(occ2, "second walker occupies hut");
  assert(hut!.dwell === 2, "dwell is 2");
  assert(walker2.homeId === hut!.id, "walker2 homeId set to hut");

  const occ3 = sim.occupy(walker3, hut!);
  assert(!occ3, "third walker cannot occupy full L1 hut");
  assert(hut!.dwell === 2, "dwell remains 2");
  assert(walker3.homeId === 0, "walker3 homeId remains 0");

  console.log("testHutOccupancy ok");
}

function testProductionAndUpgrade(): void {
  const sim = new Sim(new World(42));
  // v0.11b 出生即占位：新生村民计入 popCap。
  // 起始蓝方 2 个 L1 hut = popCap 4，起始 4 个 walker + 1 个 shaman = pop=5 >= popCap，整屋无法生产。
  // 先把第二间 L1 升 L2（cap=5）留出 1 个空位给生产路径。
  const s = sim.world.startPad(BLUE);
  const huts = sim.buildings.filter((b) => b.team === BLUE && b.kind === "hut" && b.level === 1);
  assert(huts.length >= 2, "need at least 2 blue L1 huts");
  sim.productionSystem.upgradeBuilding(sim, huts[1]!, 2);
  // 同时给起始 shaman（无家可归）迁出——它持续驻留但不产人，占着 pop 不影响 hut 生产
  // （shaman 计数会爆 popCap 吗？不会，shaman 仍计入 pop，但 popCap 已扩到 5，pop=5+1=6 仍超，故也需降一个 walker 入住）
  const walker = sim.units.find((u) => u.team === BLUE && u.kind === "walker" && u.homeId === 0)!;
  sim.occupy(walker, huts[0]!);
  assert(huts[0]!.dwell === 1, "hut has 1 occupant");

  const hut = huts[0]!;
  const popBefore = sim.countPop(BLUE);
  // hut 1（cap 2，dwell=1）→ 可产；新生即占位 dwell=2 → 撞上限停；hut 2（L2 cap 5 dwell=0）继续生产
  for (let i = 0; i < 800 && hut.born < 1; i++) sim.tick(0.05);
  assert(hut.born >= 1, "at least 1 baby born from hut");
  assert(sim.countPop(BLUE) > popBefore, "population increased");

  for (let i = 0; i < 200 && hut.born < 2; i++) sim.tick(0.05);
  // v0.11b：出生即占位，hut 1 cap=2 → 不会产第 2 个
  assert(hut.born === 1, "L1 hut cap=2 + 出生即占位 = 仅产 1 个后停");
  assert(hut.dwell === 2, "dwell 触顶 2");
  assert(hut.hp === houseHp(1), "hut hp remains at L1");

  console.log("testProductionAndUpgrade ok");
}

// v0.11b 死锁修复：出生即占位 + 满员守卫有效

function testNewbornImmediatelyOccupies(): void {
  const sim = new Sim(new World(42));
  // v0.11b：让起始 L1 hut 有人住、且 popCap 还有空位（先升级一间 L1 → L2 让 cap=5，给生产留位置）。
  const s = sim.world.startPad(BLUE);
  const huts = sim.buildings.filter((b) => b.team === BLUE && b.kind === "hut" && b.level === 1);
  assert(huts.length >= 2, "need at least 2 blue L1 huts");
  sim.productionSystem.upgradeBuilding(sim, huts[1]!, 2);
  const hut = huts[0]!;

  const walker = sim.units.find((u) => u.team === BLUE && u.kind === "walker" && u.homeId === 0)!;
  sim.occupy(walker, hut);
  const dwell0 = hut.dwell;
  assert(dwell0 === 1, "起始入住后 dwell=1（仍未满员）");

  // 让屋子持续产 1 个村民
  for (let i = 0; i < 600 && hut.born < 1; i++) sim.tick(0.05);
  assert(hut.born === 1, "成功产出第一个新生村民");
  assert(hut.dwell === dwell0 + 1, "出生即占位：dwell 同步加 1（关键：避免锁死）");
  const baby = sim.units.find((u) => u.team === BLUE && u.kind === "walker" && u.homeId === hut.id);
  assert(!!baby, "新生村民 homeId 立刻等于 hut.id");

  console.log("testNewbornImmediatelyOccupies ok");
}

function testL1CapFullStop(): void {
  const sim = new Sim(new World(42));
  // v0.11b：起始 pop=5、popCap=4（L1×2），任何入住都会顶 popCap 而被全局 guard 卡。
  // 先升一间 L1 → L2 释放 cap=5，再放入 2 名村民让 hut 满员。
  const s = sim.world.startPad(BLUE);
  const huts = sim.buildings.filter((b) => b.team === BLUE && b.kind === "hut" && b.level === 1);
  assert(huts.length >= 2, "need at least 2 blue L1 huts");
  sim.productionSystem.upgradeBuilding(sim, huts[1]!, 2);
  const hut = huts[0]!;

  const w1 = sim.addUnit(BLUE, "walker", hut.x + 1, hut.z + 1);
  const w2 = sim.addUnit(BLUE, "walker", hut.x - 1, hut.z + 1);
  assert(sim.occupy(w1, hut) && sim.occupy(w2, hut), "两名村民入住 L1");
  assert(hut.dwell === 2, "L1 满员 dwell=2");

  const born0 = hut.born;
  for (let i = 0; i < 200; i++) sim.tick(0.05); // 10s
  assert(hut.born === born0, "满员后整屋停止生产（正向：守卫有效）");
  assert(hut.prod === 0, "prod 不再累加");

  console.log("testL1CapFullStop ok");
}

function testL1KeepsProducingWhileNotFull(): void {
  const sim = new Sim(new World(42));
  const s = sim.world.startPad(BLUE);
  const huts = sim.buildings.filter((b) => b.team === BLUE && b.kind === "hut" && b.level === 1);
  assert(huts.length >= 2, "need at least 2 blue L1 huts");
  sim.productionSystem.upgradeBuilding(sim, huts[1]!, 2);
  const hut = huts[0]!;

  const w1 = sim.addUnit(BLUE, "walker", hut.x + 1, hut.z + 1);
  assert(sim.occupy(w1, hut), "1 名村民入住 L1（dwell=1，仍可生产）");

  const born0 = hut.born;
  const dwell0 = hut.dwell;
  for (let i = 0; i < 600 && hut.born < born0 + 1; i++) sim.tick(0.05);
  assert(hut.born === born0 + 1, "L1 1人时持续产第 1 个新生");
  assert(hut.dwell === dwell0 + 1, "出生即占位：dwell 同步加 1（关键：保证下一次仍可生产）");

  for (let i = 0; i < 200 && hut.born < born0 + 2; i++) sim.tick(0.05);
  // v0.11b：dwell 已到上限 2，停止生产
  assert(hut.dwell === 2 && hut.born === born0 + 1, "dwell 触顶，停止生产（不是死锁，是满员停）");

  console.log("testL1KeepsProducingWhileNotFull ok");
}

// v0.11 生产系统：速率随 dwell 连续加速、L3 上限 10、住户死亡/房屋被毁的名额释放。

function testProductionRateScalesWithDwell(): void {
  const sim = new Sim(new World(42));
  // 多放一座茅屋保证 popCap 有余量（同 testProductionAndUpgrade 手法）
  const s = sim.world.startPad(BLUE);
  sim.placeComplete(BLUE, s.x + 8, s.z + 8, s.yaw, "hut", 1);

  const hut = sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level === 1)!;
  hut.level = 2; // L2 上限 5，可观察 dwell 1~4 的连续加速

  hut.dwell = 1;
  hut.prod = 0;
  sim.productionSystem.produce(sim, 1.0);
  const base = houseBaseRate(2);
  assert(Math.abs(hut.prod - base) < 1e-6, `dwell=1 时按基础速率生产（${hut.prod.toFixed(4)} ≈ ${base}）`);

  hut.dwell = 3;
  hut.prod = 0;
  sim.productionSystem.produce(sim, 1.0);
  const boosted = base * (1 + HOUSE_DWELL_BONUS * 2);
  assert(Math.abs(hut.prod - boosted) < 1e-6, `dwell=3 加速生产（${hut.prod.toFixed(4)} ≈ ${boosted.toFixed(4)}）`);

  hut.dwell = 5; // L2 满员
  hut.prod = 0;
  sim.productionSystem.produce(sim, 1.0);
  assert(hut.prod === 0, "满员房屋停止生产");
  hut.level = 1;

  console.log("testProductionRateScalesWithDwell ok");
}

function testL3CapTen(): void {
  assert(houseMaxPop(3) === 10, "L3 house max pop is 10");
  const sim = new Sim(new World(42));
  const hut = sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level === 1)!;
  hut.level = 3;
  const walkers: Unit[] = [];
  for (let i = 0; i < 11; i++) walkers.push(sim.addUnit(BLUE, "walker", hut.x + 1, hut.z + 1));
  for (let i = 0; i < 10; i++) {
    assert(sim.occupy(walkers[i]!, hut), `第 ${i + 1} 名村民入住 L3`);
  }
  assert(hut.dwell === 10, "dwell 达到 10");
  assert(!sim.occupy(walkers[10]!, hut), "第 11 名村民被拒（L3 上限 10）");
  hut.level = 1;

  console.log("testL3CapTen ok");
}

function testDwellReleasedOnDeath(): void {
  const sim = new Sim(new World(42));
  const hut = sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level === 1)!;
  const w1 = sim.addUnit(BLUE, "walker", hut.x + 1, hut.z + 1);
  const w2 = sim.addUnit(BLUE, "walker", hut.x - 1, hut.z + 1);
  assert(sim.occupy(w1, hut) && sim.occupy(w2, hut), "两名村民入住");
  assert(hut.dwell === 2, "dwell = 2");

  w2.hp = 0;
  sim.tick(0.05);
  assert(hut.dwell === 1, "住户死亡释放房屋名额（修复 dwell 泄漏）");
  assert(!sim.units.includes(w2), "死亡单位已被清理");

  console.log("testDwellReleasedOnDeath ok");
}

function testHouseDestroyedReleasesDwellers(): void {
  const sim = new Sim(new World(42));
  const hut = sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level === 1)!;
  const w = sim.addUnit(BLUE, "walker", hut.x + 1, hut.z + 1);
  assert(sim.occupy(w, hut), "村民入住");
  assert(w.homeId === hut.id, "homeId 已绑定");

  hut.hp = 0;
  sim.tick(0.05);
  assert(!sim.buildings.includes(hut), "房屋被摧毁移除");
  assert(w.hp > 0 && w.homeId === 0, "住户迁出且存活（修复 homeId 悬空）");
  assert(Math.hypot(w.x - hut.x, w.z - hut.z) < 8, "住户被安置在原房屋附近");
  assert(w.enterT === 0, "进门动画复位");

  console.log("testHouseDestroyedReleasesDwellers ok");
}

// v0.11a 修复：房屋升级占地恒定，只长高——不再把邻居挤掉。

function testUpgradeKeepsFootprint(): void {
  const sim = new Sim(new World(42));
  const a = sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level === 1)!;
  const s = sim.world.startPad(BLUE);
  const c = sim.placeComplete(BLUE, s.x + 8, s.z + 8, s.yaw, "hut", 1);
  assert(!!c, "邻屋放置成功");
  assert(a.padW === 2.6 && c!.padW === 2.6, "两屋初始 pad 均为 2.6");

  // 走真实升级路径一路升到 L3
  sim.productionSystem.upgradeBuilding(sim, a, 2);
  sim.productionSystem.upgradeBuilding(sim, a, 3);
  sim.productionSystem.upgradeBuilding(sim, c!, 2);
  sim.productionSystem.upgradeBuilding(sim, c!, 3);

  assert(a.level === 3 && c!.level === 3, "两屋均升至 L3");
  assert(a.padW === 2.6 && a.padD === 2.6, "L3 后 pad 仍为 2.6（面积不变，只许长高）");
  assert(c!.padW === 2.6 && c!.padD === 2.6, "邻屋 L3 后 pad 仍为 2.6");

  const padOf = (b: { x: number; z: number; padW: number; padD: number; yaw: number }) => ({
    x: b.x,
    z: b.z,
    w: b.padW,
    d: b.padD,
    yaw: b.yaw,
  });
  assert(!padsOverlap(padOf(a), padOf(c!)), "两座 L3 屋 pad 不重叠（不再挤掉邻居）");

  sim.tick(0.1);
  assert(a.hp > 0 && c!.hp > 0, "升级后房屋存活（地形判定按恒定 pad）");

  console.log("testUpgradeKeepsFootprint ok");
}

function main(): void {
  testWoodChoppingAndDelivery();
  testCampSiteDelivery();
  testHutOccupancy();
  testProductionAndUpgrade();
  testProductionRateScalesWithDwell();
  testL3CapTen();
  testDwellReleasedOnDeath();
  testHouseDestroyedReleasesDwellers();
  testUpgradeKeepsFootprint();
  testNewbornImmediatelyOccupies();
  testL1CapFullStop();
  testL1KeepsProducingWhileNotFull();
  console.log("produce-check ok (v0.11 + v0.11a 占地 + v0.11b 出生即占位)");
}

main();
