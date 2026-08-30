import { Sim } from "./sim";
import {
  BLUE,
  houseBaseRate,
  houseHp,
  houseMaxPop,
  HOUSE_DWELL_BONUS,
  inMap,
  padSize,
  Tree,
  Unit,
  woodNeedFor,
  POP_CAP,
} from "./types";
import { World, padsOverlap } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/**
 * v0.24 地图模板化后，找一个「确实能落下 L0 房基」的落脚点。
 * 旧用例写死 walker.x + 3.0：52 格平缓图上那一点几乎必然可建，换成 72 格模板图后
 * 经常是海水/陡坡/树，canFound 直接拒（foundSite 返回 null）。这里螺旋外扩试探，
 * 返回第一个真正落成站的坐标——测的是"建房+运木+入住"链路，不是"正东 3 格必须能盖房"。
 */
function hutSiteNear(sim: Sim, u: Unit) {
  for (let r = 2.0; r <= 6.0; r += 0.5) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const x = Math.round((u.x + Math.cos(ang) * r) * 2) / 2;
      const z = Math.round((u.z + Math.sin(ang) * r) * 2) / 2;
      sim.tryPrepFound(x, z, 0);
      const site = sim.foundSite(BLUE, x, z, 0, "hut");
      if (site) return site;
    }
  }
  return null;
}

/**
 * v0.24 找一个「地形真正养得住一座 L1 屋」的落点（绕开出生点近圈，向外扩 5~16 格）。
 * 判据与游戏的存活规则同源（production-system.refreshHouses → world.houseLevelAt →
 * padReady：land≥0.80、variance<0.22、maxSlope<0.70、mean>WATER），
 * 这样测的才是"升级占地恒定"这件事本身，而不是被一处不合格地基的自塌打断。
 */
function readyHutSpot(sim: Sim, ox: number, oz: number, yaw: number) {
  const pad = padSize(1);
  for (let r = 5; r <= 16; r += 1) {
    for (let a = 0; a < 24; a++) {
      const ang = (a / 24) * Math.PI * 2;
      const x = ox + Math.cos(ang) * r;
      const z = oz + Math.sin(ang) * r;
      if (!inMap(x, z)) continue;
      if (sim.world.padReady(x, z, pad.w, pad.d, yaw)) return { x, z };
    }
  }
  return null;
}

function testWoodChoppingAndDelivery(): void {
  const sim = new Sim(new World(42));
  const walker = sim.units.find((u) => u.team === BLUE && u.kind === "walker");
  assert(!!walker, "need a blue walker");

  // Prep pad and place an L0 hut site near walker（v0.24：就近试探可建点，不再写死正东 3 格）
  const site = hutSiteNear(sim, walker!);
  assert(site !== null, "L0 hut site founded（附近存在可落房基的陆地）");
  assert(site!.level === 0, "site is level 0");
  assert(site!.need === 2, "L0 hut needs 2 wood");
  assert(sim.needsWood(site!), "site needs wood");

  // Create a tree right next to walker for chopping（v0.24：树也要摆在真正可走的格子上，
  // 旧实现写死 walker.x + 0.6，模板图上可能落在水里/别的地基里，砍树链路就测不到底）
  let tx = walker!.x + 0.6;
  let tz = walker!.z;
  if (!sim.world.walkableAt(tx, tz)) {
    outer: for (let r = 0.6; r <= 2.5; r += 0.2) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const x = walker!.x + Math.cos(ang) * r;
        const z = walker!.z + Math.sin(ang) * r;
        if (sim.world.walkableAt(x, z)) {
          tx = x;
          tz = z;
          break outer;
        }
      }
    }
  }
  const tree = new Tree(9999, tx, tz, sim.world.heightAt(tx, tz), true, 0);
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

  // Deliver second wood: v0.28i 渐进式建造——交付只堆满木料，完工由起升 tick 达标（≈1.6s）。
  sim.deliverWood(site!);
  assert(site!.wood === site!.need && site!.built >= 0, "木料堆满地基，起升开始");
  for (let i = 0; i < 200 && site!.level === 0; i++) sim.tick(0.05);
  assert(site!.wood === 0, "wood reset upon completion");
  assert(site!.level === 1, "hut upgraded from L0 to L1（存木起升达标）");
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
    sim.tryPrepFound(x, z, s.yaw, "warriorHut"); // v0.28c 预备/落基同口径（训练营 2.6）
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
  // v0.28i 渐进式完工（4 木存量 ≈ 1.35/s → ~3s）。
  for (let i = 0; i < 200 && camp!.level === 0; i++) sim.tick(0.05);
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

/**
 * v0.28h 分队人口上限：满员时出生**暂停但进度保留**（绝不重蹈 v0.15 前的假死），
 * 人口一降下一帧立即恢复出生。
 */
function testPopCapPausesAndResumes(): void {
  const sim = new Sim(new World(42));
  const cap0 = POP_CAP[BLUE];
  const bw = sim.units.find((u) => u.team === BLUE && u.kind === "walker")!;
  POP_CAP[BLUE] = sim.countPop(BLUE); // 当前人口即满员
  try {
    const hut = sim.placeComplete(BLUE, bw.x + 2, bw.z, 0, "hut", 1);
    hut.dwell = 1;
    hut.prod = 1.0; // 进度已满，就差出生
    const born0 = hut.born;

    for (let i = 0; i < 20; i++) sim.tick(0.05); // 1 秒：满员不得出生
    assert(hut.born === born0, "cap: 满员时不出声");
    assert(hut.prod >= 1.0, `cap: 进度保留不丢弃（prod=${hut.prod.toFixed(2)}）`);

    // 人口降 1（阵亡一名村民）→ cull 后下一帧立即补生。
    const victim = sim.units.find((u) => u.team === BLUE && u.kind === "walker" && u.homeId === 0 && u !== bw)!;
    victim.hp = 0;
    for (let i = 0; i < 10; i++) sim.tick(0.05);
    assert(hut.born === born0 + 1, "cap: 减员后立即恢复出生（不假死）");
    assert(hut.prod < 1.0, "cap: 出生后进度正常清零重充");
  } finally {
    POP_CAP[BLUE] = cap0; // 还原全局上限，别污染后续用例
  }
  console.log("testPopCapPausesAndResumes ok");
}

/**
 * v0.28i 渐进式建造：存木越多 built 增速越快（wood=2 比 wood=1 快 ~1.67 倍）。
 */
function testGradualConstruction(): void {
  const sim = new Sim(new World(42));
  const bw = sim.units.find((u) => u.team === BLUE && u.kind === "walker")!;
  const a1 = hutSiteNear(sim, bw!); // 螺旋找真实可落地基（写死坐标常踩水/坡）
  const a2 = hutSiteNear(sim, bw!);
  assert(!!a1 && !!a2, "两座工地落地");
  sim.deliverWood(a1!); // 工地1：1 根
  sim.deliverWood(a2!);
  sim.deliverWood(a2!); // 工地2：2 根
  const r1 = a1!.built;
  const r2 = a2!.built;
  sim.tick(0.5); // 0.5 秒增量（工地2 未到 need，量纯增量）
  const d1 = a1!.built - r1;
  const d2 = a2!.built - r2;
  assert(d1 > 0 && d2 > d1, `存木 2 根比 1 根建得快（Δ1=${d1.toFixed(3)} Δ2=${d2.toFixed(3)}）`);
  // a1 只有 1 根木：进度必须封顶在 1（v0.28i-2 存木封顶），补上第 2 根才允许建成。
  assert(a1!.built <= a1!.wood + 1e-9, `进度不得超出存木（built=${a1!.built.toFixed(2)} ≤ wood=${a1!.wood}）`);
  sim.deliverWood(a1!);
  for (let i = 0; i < 300 && (a1!.level === 0 || a2!.level === 0); i++) sim.tick(0.05);
  assert(a1!.level === 1 && a2!.level === 1, "两工地最终都建成（各补满木料）");
  console.log("testGradualConstruction ok");
}

/** v0.28i 建工到站接活：指派建工走到工地边后 10 秒内应已开始砍树/搬运（旧实现卡 30s）。 */
function testBuilderStartsQuickly(): void {
  const sim = new Sim(new World(42));
  const bw = sim.units.find((u) => u.team === BLUE && u.kind === "walker")!;
  const site = hutSiteNear(sim, bw!);
  assert(!!site, "工地落地");
  bw.selected = true;
  sim.assignBuilders(BLUE, site!);
  let started = false;
  for (let i = 0; i < 200; i++) {
    sim.tick(0.05);
    if (bw.job === "chop" || bw.job === "haul" || bw.carry === 1) {
      started = true;
      break;
    }
  }
  assert(started, `建工到站 10s 内已开工（job=${bw.job}，旧实现发呆 30s）`);
  console.log("testBuilderStartsQuickly ok");
}

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
  // v0.24：邻屋选址改走"地形真合格"的判据。placeComplete 不校验地形（正式链路是
  // foundSite→canFound 才校验），而 refreshHouses 每帧按 houseLevelAt/padReady 判毁——
  // 旧用例写死 s.x+8,s.z+8，在模板化地图上常踩到坡地浅滩，升级链路还没测就被自己塌房打断。
  const spot = readyHutSpot(sim, s.x, s.z, s.yaw);
  assert(spot !== null, "出生点附近存在地形合格的屋址");
  const c = sim.placeComplete(BLUE, spot!.x, spot!.z, s.yaw, "hut", 1);
  assert(!!c, "邻屋放置成功");
  assert(a.padW === 1.3 && c!.padW === 1.3, "两屋初始 pad 均为 1.3（v0.28c 茅屋缩半）");

  // 走真实升级路径一路升到 L3
  sim.productionSystem.upgradeBuilding(sim, a, 2);
  sim.productionSystem.upgradeBuilding(sim, a, 3);
  sim.productionSystem.upgradeBuilding(sim, c!, 2);
  sim.productionSystem.upgradeBuilding(sim, c!, 3);

  assert(a.level === 3 && c!.level === 3, "两屋均升至 L3");
  assert(a.padW === 1.3 && a.padD === 1.3, "L3 后 pad 仍为 1.3（面积不变，只许长高）");
  assert(c!.padW === 1.3 && c!.padD === 1.3, "邻屋 L3 后 pad 仍为 1.3");

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
testPopCapPausesAndResumes();
testGradualConstruction();
testBuilderStartsQuickly();
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
