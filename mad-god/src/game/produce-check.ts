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

// v0.15 住满即升：升级由"入住满员"驱动（第二人入住 L1 → 下一帧升 L2），
// 不再等新生儿出生数达到门槛（旧 born>=2 会让升级顿好几秒）。

function testProductionAndUpgrade(): void {
  const sim = new Sim(new World(42));
  const hut = sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level === 1)!;
  const walker = sim.units.find((u) => u.team === BLUE && u.kind === "walker")!;
  sim.occupy(walker, hut);
  assert(hut.dwell === 1, "hut has 1 occupant");

  const w2 = sim.addUnit(BLUE, "walker", hut.x - 1, hut.z + 1);
  assert(sim.occupy(w2, hut), "second walker occupies hut");
  assert(hut.wantLevel === 2, "住满 L1 当帧置位升级");
  sim.tick(0.05);
  assert(hut.level === 2, "住满 L1 下一帧升至 L2（无顿挫）");
  assert(hut.hp === houseHp(2), "hut hp upgraded to L2 house hp");
  assert(houseMaxPop(hut.level) === 5, "L2 容量扩到 5");

  console.log("testProductionAndUpgrade ok");
}

// v0.15 回归：感化可把人口顶到任意高（bug 现场：子民 31/20，七座茅屋全体停摆），
// 出生不得再受任何全局上限拦截——生产只看"屋里有没有人"。

function testProductionNotBlockedByPop(): void {
  const sim = new Sim(new World(42));
  const hut = sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level === 1)!;
  for (let i = 0; i < 25; i++) sim.addUnit(BLUE, "walker", hut.x + 2, hut.z + 2);
  assert(sim.countPop(BLUE) >= 25, "人口远超旧全局上限（20）");

  const w = sim.addUnit(BLUE, "walker", hut.x + 1, hut.z + 1);
  assert(sim.occupy(w, hut), "村民入住");
  const born0 = hut.born;
  for (let i = 0; i < 600 && hut.born < born0 + 1; i++) sim.tick(0.05);
  assert(hut.born === born0 + 1, "高人口下生产照常（不再被上限拦死）");

  console.log("testProductionNotBlockedByPop ok");
}

// v0.11c 生产与居住解耦：满员照常生产、新生儿走出屋子成为自由村民。

function testNewbornWalksOut(): void {
  const sim = new Sim(new World(42));
  const hut = sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level === 1)!;
  const walker = sim.units.find((u) => u.team === BLUE && u.kind === "walker")!;
  sim.occupy(walker, hut);
  const dwell0 = hut.dwell;
  assert(dwell0 === 1, "入住后 dwell=1");

  for (let i = 0; i < 600 && hut.born < 1; i++) sim.tick(0.05);
  assert(hut.born === 1, "成功产出第一个新生村民");
  assert(hut.dwell === dwell0, "新生儿不占住：dwell 不变（生产与居住解耦）");
  const baby = sim.units
    .filter((u) => u.team === BLUE && u.kind === "walker" && u.homeId === 0 && u.id > walker.id)
    .sort((a, b) => b.id - a.id)[0];
  assert(!!baby, "新生儿已在屋外（homeId=0 的自由村民）");

  console.log("testNewbornWalksOut ok");
}

function testFullHouseKeepsProducing(): void {
  const sim = new Sim(new World(42));
  const hut = sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level === 1)!;
  const w1 = sim.addUnit(BLUE, "walker", hut.x + 1, hut.z + 1);
  const w2 = sim.addUnit(BLUE, "walker", hut.x - 1, hut.z + 1);
  assert(sim.occupy(w1, hut) && sim.occupy(w2, hut), "两名村民入住 L1");
  assert(hut.dwell === 2, "L1 满员 dwell=2");

  const born0 = hut.born;
  const pop0 = sim.countPop(BLUE);
  for (let i = 0; i < 600 && hut.born < born0 + 1; i++) sim.tick(0.05);
  assert(hut.born === born0 + 1, "满员房屋继续生产（关键：不再锁死）");
  assert(hut.dwell === 2, "居住数不变（新生儿出屋）");
  assert(sim.countPop(BLUE) === pop0 + 1, "人口 +1");

  console.log("testFullHouseKeepsProducing ok");
}

function testL1KeepsProducingWhileNotFull(): void {
  const sim = new Sim(new World(42));
  const hut = sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level === 1)!;
  const w1 = sim.addUnit(BLUE, "walker", hut.x + 1, hut.z + 1);
  assert(sim.occupy(w1, hut), "1 名村民入住（dwell=1）");

  const dwell0 = hut.dwell;
  for (let i = 0; i < 600 && hut.born < 2; i++) sim.tick(0.05);
  assert(hut.born >= 2, "未满员持续产出多个新生村民");
  assert(hut.dwell === dwell0, "dwell 保持 1（生产与居住解耦）");

  console.log("testL1KeepsProducingWhileNotFull ok");
}

// v0.11 生产系统：速率随 dwell 连续加速、L3 上限 10、住户死亡/房屋被毁的名额释放。

function testProductionRateScalesWithDwell(): void {
  const sim = new Sim(new World(42));
  // 多放一座茅屋（历史手法；v0.15 起无全局上限，仅为场景丰富）
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

  hut.dwell = 5; // L2 满员：v0.11c 起满员不锁生产，仍按最高速率（dwell 只影响速度）
  hut.prod = 0;
  sim.productionSystem.produce(sim, 1.0);
  const fullRate = base * (1 + HOUSE_DWELL_BONUS * 4);
  assert(Math.abs(hut.prod - fullRate) < 1e-6, `满员仍生产（${hut.prod.toFixed(4)} ≈ ${fullRate.toFixed(4)}）`);
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
  testNewbornWalksOut();
  testFullHouseKeepsProducing();
  testL1KeepsProducingWhileNotFull();
  testProductionNotBlockedByPop();
  console.log("produce-check ok (v0.11 + v0.11a 占地 + v0.11c 生产解耦 + v0.15 无上限/住满即升)");
}

main();
