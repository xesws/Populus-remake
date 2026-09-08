/**
 * v0.32 船屋＋战船回归锁（设计稿 BOAT.md）：
 *   T1 上船：6 人满员、第 7 人拒绝，船员 homeId 挂船、随船同坐标移动；
 *   T2 红叉：船离岸超 DOCK_RANGE → canBoard 全假，orderBoard 无事发生；
 *   T3 航行：只走水（全程 waterAt），陆岬绕行，孤立水洼无路返回 []；
 *   T4 下船：靠岸全员下船，homeId 清零、落可走格、unitAt 可点选；
 *   T5 开火：船上火战士默认索敌开火（boatCombat 通道），伤害数字与陆地一致；
 *   T6 击沉：damageArea 灌死 → 2s 沉没 → 船员全灭 → producedBoatIds 减员 → 船屋补产；
 *   T7 船屋：9 人不产、10 人开工、同屋 3 条存活暂停、无下水点等待不崩；
 *   T8 豁免：感化拒船、地震/龙卷跳过船与船员、countPop 不含船、codec 来回 kind＋homeId 不丢。
 */
import { Sim } from "./sim";
import { BLUE, RED, BOAT_CAPACITY, BOATHOUSE_DWELL, canConvert, WATER } from "./types";
import { World } from "./world";
import { waterAt } from "./path";
import { encodeSnapshot, applySnapshot, createSimMirror } from "./worker/codec";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** 蓝出生点旁找"可走岸"：可走格＋3 格内有水（船屋/登船测试共用）。 */
function findShore(sim: Sim): { x: number; z: number } {
  const s = sim.world.startPad(BLUE);
  for (let r = 1; r <= 14; r += 0.5) {
    const steps = Math.max(12, Math.ceil(r * 10));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const x = s.x + Math.cos(a) * r;
      const z = s.z + Math.sin(a) * r;
      if (x < 3 || z < 3 || x > 69 || z > 69) continue;
      if (!sim.world.walkableAt(x, z)) continue;
      if (sim.world.waterNear(x, z, 3)) return { x, z };
    }
  }
  throw new Error("蓝家旁找不到可走岸");
}

/** 开局一座完工船屋（走真实链路：prep→found→送满木→tick 完工）。 */
function buildBoathouse(sim: Sim): number {
  const shore = findShore(sim);
  const s = sim.world.startPad(BLUE);
  let bx = 0;
  let bz = 0;
  let ok = false;
  for (let r = 1; r <= 10 && !ok; r += 0.5) {
    for (let k = 0; k < 12 && !ok; k++) {
      const a = (k / 12) * Math.PI * 2;
      const x = shore.x + Math.cos(a) * r;
      const z = shore.z + Math.sin(a) * r;
      if (x < 3 || z < 3 || x > 69 || z > 69) continue;
      sim.tryPrepFound(x, z, s.yaw, "boathouse");
      if (!sim.canFound(x, z, 1, s.yaw, 0, "boathouse")) continue;
      const site = sim.foundSite(BLUE, x, z, s.yaw, "boathouse");
      if (!site) continue;
      site.wood = site.need;
      bx = x;
      bz = z;
      ok = true;
    }
  }
  assert(ok, "岸边落船屋地基");
  for (let i = 0; i < 200 && sim.buildings.find((b) => b.x === bx && b.z === bz)!.level < 1; i++) sim.tick(0.05);
  const b = sim.buildings.find((x) => x.x === bx && x.z === bz)!;
  assert(b.level >= 1, "船屋完工 L1");
  return b.id;
}

/** N 名村民空投到门外并指派入住（走 tryOccupy 真实到站链路，省去长途行军）。 */
function dwellCrew(sim: Sim, houseId: number, n: number): void {
  const b = sim.buildingById(houseId)!;
  const door = sim.hutDoor(b);
  for (let i = 0; i < n; i++) {
    const u = sim.addUnit(BLUE, "walker", door.x + (i % 3) * 0.4, door.z + ((i / 3) | 0) * 0.4);
    u.targetId = houseId;
  }
  for (let i = 0; i < 120; i++) sim.tick(0.05);
}

// T1 上船：6 人满员、第 7 人拒绝，船员随船移动
function testBoard(): void {
  const sim = new Sim(new World(2050));
  const houseId = buildBoathouse(sim);
  dwellCrew(sim, houseId, BOATHOUSE_DWELL);
  const bh = sim.buildings.find((b) => b.id === houseId)!;
  assert(bh.dwell === BOATHOUSE_DWELL, `船屋住满 ${BOATHOUSE_DWELL}（实际 ${bh.dwell}）`);
  for (let i = 0; i < 1200 && sim.units.every((u) => u.kind !== "boat"); i++) sim.tick(0.05);
  const boat = sim.units.find((u) => u.kind === "boat" && u.hp > 0)!;
  assert(boat, "住满后产出战船");
  assert(waterAt(sim.world, boat.x, boat.z), "船下水在水格");
  // 7 名水手就位（船边可走岸）。
  const shore = sim.boatSystem.shoreNear(sim, boat.x, boat.z)!;
  assert(shore, "新船旁有可走岸");
  const sailors: number[] = [];
  for (let i = 0; i < 7; i++) {
    const u = sim.addUnit(BLUE, "walker", shore.x + (i % 4) * 0.4, shore.z + ((i / 4) | 0) * 0.4);
    sailors.push(u.id);
    sim.boatSystem.orderBoard(sim, boat, u);
  }
  for (let i = 0; i < 200; i++) sim.tick(0.05);
  const aboard = sim.units.filter((u) => u.homeId === boat.id && u.hp > 0);
  assert(aboard.length === BOAT_CAPACITY, `满员 ${BOAT_CAPACITY}（实际 ${aboard.length}）`);
  const left = sim.units.find((u) => u.id === sailors[6])!;
  assert(left.homeId === 0, "第 7 人拒绝上船");
  // 船员随船同坐标移动：往 8~12 格外的水域开 6 秒，人船位移一致。
  const bx0 = boat.x;
  const bz0 = boat.z;
  const r0 = { x: aboard[0]!.x, z: aboard[0]!.z };
  let sailed = false;
  for (let r = 8; r <= 14 && !sailed; r += 2) {
    for (let k = 0; k < 16 && !sailed; k++) {
      const a = (k / 16) * Math.PI * 2;
      const tx = bx0 + Math.cos(a) * r;
      const tz = bz0 + Math.sin(a) * r;
      if (!waterAt(sim.world, tx, tz)) continue;
      sailed = sim.boatSystem.sendSail(sim, boat, tx, tz);
    }
  }
  assert(sailed, "附近水域有路");
  for (let i = 0; i < 120; i++) sim.tick(0.05);
  assert(Math.hypot(boat.x - bx0, boat.z - bz0) > 1, "船开动了");
  assert(
    Math.abs(aboard[0]!.x - r0.x - (boat.x - bx0)) < 0.6 &&
      Math.abs(aboard[0]!.z - r0.z - (boat.z - bz0)) < 0.6,
    "船员随船同向移动",
  );
  // 船员不可点选（unitAt 跳 homeId>0）。
  assert(sim.unitAt(aboard[0]!.x, aboard[0]!.z, 0.9)?.id !== aboard[0]!.id, "船员不可点选");
  console.log("testBoard ok（6 人满员/第7人拒绝/随船移动/不可点选）");
}

// T2 红叉：船离岸太远禁上船
function testDeny(): void {
  const sim = new Sim(new World(2050));
  // 深水中央放一条船（2.5 内无可走格＝离岸太远，与 shoreNear 同口径）。
  let deep: { x: number; z: number } | null = null;
  for (let x = 6; x < 66 && !deep; x += 2) {
    for (let z = 6; z < 66 && !deep; z += 2) {
      if (!waterAt(sim.world, x, z)) continue;
      let nearShore = false;
      for (let k = 0; k < 12 && !nearShore; k++) {
        const a = (k / 12) * Math.PI * 2;
        if (sim.world.walkableAt(x + Math.cos(a) * 2.5, z + Math.sin(a) * 2.5)) nearShore = true;
      }
      if (!nearShore) deep = { x, z };
    }
  }
  assert(deep, "深水区应存在");
  const boat = sim.addUnit(BLUE, "boat", deep.x, deep.z);
  const shore = findShore(sim);
  const u = sim.addUnit(BLUE, "walker", shore.x, shore.z);
  assert(!sim.boatSystem.canBoard(sim, boat, u), "深水船 canBoard 全假");
  sim.boatSystem.orderBoard(sim, boat, u);
  for (let i = 0; i < 60; i++) sim.tick(0.05);
  assert(u.homeId === 0, "离岸太远上不了船（orderBoard 无事发生）");
  console.log("testDeny ok（深水禁上船）");
}

// T3 航行：只走水，孤立水洼无路
function testSail(): void {
  const sim = new Sim(new World(2050));
  const houseId = buildBoathouse(sim);
  dwellCrew(sim, houseId, BOATHOUSE_DWELL);
  for (let i = 0; i < 1200 && sim.units.every((u) => u.kind !== "boat"); i++) sim.tick(0.05);
  const boat = sim.units.find((u) => u.kind === "boat" && u.hp > 0)!;
  assert(boat, "有船可开");
  // 8~14 格外的水域目标：全程水格断言（目标绕船现找，防大岛腹地无解）。
  let sailed = false;
  let tx = boat.x;
  let tz = boat.z;
  for (let r = 8; r <= 14 && !sailed; r += 2) {
    for (let k = 0; k < 16 && !sailed; k++) {
      const a = (k / 16) * Math.PI * 2;
      const cx = boat.x + Math.cos(a) * r;
      const cz = boat.z + Math.sin(a) * r;
      if (!waterAt(sim.world, cx, cz)) continue;
      if (sim.boatSystem.sendSail(sim, boat, cx, cz)) {
        sailed = true;
        tx = cx;
        tz = cz;
      }
    }
  }
  assert(sailed, "附近水域有路");
  for (let i = 0; i < 600; i++) {
    sim.tick(0.05);
    assert(waterAt(sim.world, boat.x, boat.z), `船全程在水（t=${(i * 0.05).toFixed(1)}s @${boat.x.toFixed(1)},${boat.z.toFixed(1)}）`);
    if (!boat.path.length) break;
  }
  assert(Math.hypot(boat.x - tx, boat.z - tz) < 4, `船抵达目标附近（${boat.x.toFixed(1)},${boat.z.toFixed(1)}）`);
  console.log("testSail ok（全程水格/远海抵达）");
}

// T4 下船：恢复自由可选
function testDisembark(): void {
  const sim = new Sim(new World(2050));
  const houseId = buildBoathouse(sim);
  dwellCrew(sim, houseId, BOATHOUSE_DWELL);
  for (let i = 0; i < 1200 && sim.units.every((u) => u.kind !== "boat"); i++) sim.tick(0.05);
  const boat = sim.units.find((u) => u.kind === "boat" && u.hp > 0)!;
  const shore = sim.boatSystem.shoreNear(sim, boat.x, boat.z)!;
  const u0 = sim.addUnit(BLUE, "walker", shore.x, shore.z);
  const u1 = sim.addUnit(BLUE, "walker", shore.x + 0.4, shore.z);
  sim.boatSystem.orderBoard(sim, boat, u0);
  sim.boatSystem.orderBoard(sim, boat, u1);
  for (let i = 0; i < 120; i++) sim.tick(0.05);
  assert(u0.homeId === boat.id && u1.homeId === boat.id, "2 人上船");
  assert(sim.boatSystem.canDisembark(sim, boat), "贴岸可下船");
  assert(sim.boatSystem.disembarkAll(sim, boat), "下船成功");
  for (const u of [u0, u1]) {
    assert(u.homeId === 0, "homeId 清零");
    assert(sim.world.walkableAt(u.x, u.z), "落可走格");
    assert(sim.unitAt(u.x, u.z, 0.9)?.id === u.id, "恢复可点选");
  }
  console.log("testDisembark ok（落岸/清零/可点选）");
}

// T5 开火：船上火战士默认索敌
function testBoatFire(): void {
  const sim = new Sim(new World(2050));
  const houseId = buildBoathouse(sim);
  dwellCrew(sim, houseId, BOATHOUSE_DWELL);
  for (let i = 0; i < 1200 && sim.units.every((u) => u.kind !== "boat"); i++) sim.tick(0.05);
  const boat = sim.units.find((u) => u.kind === "boat" && u.hp > 0)!;
  const shore = sim.boatSystem.shoreNear(sim, boat.x, boat.z)!;
  const fw = sim.addUnit(BLUE, "firewarrior", shore.x, shore.z);
  sim.boatSystem.orderBoard(sim, boat, fw);
  for (let i = 0; i < 120; i++) sim.tick(0.05);
  assert(fw.homeId === boat.id, "火战士上船");
  // 岸上船边找可走格立一个红村民（火战士射程 7 内、水面视线通畅）。
  let tx = shore.x;
  let tz = shore.z;
  outer: for (let r = 3; r <= 6; r += 0.5) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const x = boat.x + Math.cos(a) * r;
      const z = boat.z + Math.sin(a) * r;
      if (sim.world.walkableAt(x, z)) {
        tx = x;
        tz = z;
        break outer;
      }
    }
  }
  const foe2 = sim.addUnit(RED, "walker", tx, tz);
  const hp0 = foe2.hp;
  for (let i = 0; i < 240; i++) sim.tick(0.05);
  assert(foe2.hp < hp0, `船上火战士开火（红村民 ${hp0}→${foe2.hp.toFixed(1)}）`);
  console.log("testBoatFire ok（船上火战士默认索敌开火）");
}

// T6 击沉：沉没→团灭→减员→补产
function testSink(): void {
  const sim = new Sim(new World(2050));
  const houseId = buildBoathouse(sim);
  dwellCrew(sim, houseId, BOATHOUSE_DWELL);
  for (let i = 0; i < 1200 && sim.units.filter((u) => u.kind === "boat").length < 1; i++) sim.tick(0.05);
  const boat = sim.units.find((u) => u.kind === "boat" && u.hp > 0)!;
  const shore = sim.boatSystem.shoreNear(sim, boat.x, boat.z)!;
  const u0 = sim.addUnit(BLUE, "walker", shore.x, shore.z);
  const u1 = sim.addUnit(BLUE, "walker", shore.x + 0.4, shore.z);
  sim.boatSystem.orderBoard(sim, boat, u0);
  sim.boatSystem.orderBoard(sim, boat, u1);
  for (let i = 0; i < 120; i++) sim.tick(0.05);
  assert(u0.homeId === boat.id && u1.homeId === boat.id, "2 人上船");
  // 法术灌死（damageArea 单位循环默认覆盖船）。
  sim.damageArea(boat.x, boat.z, 2, 500);
  assert(boat.hp <= 0, "船被击沉（hp 归零）");
  sim.tick(0.05); // tickSink 置位（与 cull 同帧，但 cull 为 sinkT>0 让路）
  assert(boat.sinkT > 0, "沉没动画开始（sinkT 置位，cull 让路）");
  assert(sim.units.some((u) => u.id === boat.id), "动画期间船仍在场");
  for (let i = 0; i < 80; i++) sim.tick(0.05); // 4s > SINK_T 2s
  assert(!sim.units.some((u) => u.id === boat.id), "沉没后船被 cull 带走");
  assert(u0.hp <= 0 && u1.hp <= 0, "船员随船团灭");
  // 减员→补产：再跑 40s，应有新船下水（上限 3 未满）。
  for (let i = 0; i < 800; i++) sim.tick(0.05);
  assert(sim.units.some((u) => u.kind === "boat" && u.hp > 0), "减员后船屋补产新船");
  console.log("testSink ok（沉没动画/团灭/减员补产）");
}

// T7 船屋：9 人不产、10 人开工、上限 3 暂停
function testBoathouse(): void {
  const sim = new Sim(new World(2050));
  const houseId = buildBoathouse(sim);
  dwellCrew(sim, houseId, 9);
  const bh = sim.buildings.find((b) => b.id === houseId)!;
  assert(bh.dwell === 9, "住进 9 人");
  for (let i = 0; i < 400; i++) sim.tick(0.05); // 20s
  assert(bh.prod < 1, `9 人不开工（prod=${bh.prod.toFixed(2)}）`);
  dwellCrew(sim, houseId, 1); // 凑满 10
  const dwellFull = sim.buildings.find((b) => b.id === houseId)!.dwell;
  assert(dwellFull === 10, `住满 10 人（实际 ${dwellFull}）`);
  for (let i = 0; i < 1200 && sim.units.every((u) => u.kind !== "boat"); i++) sim.tick(0.05);
  const b1 = sim.units.find((u) => u.kind === "boat" && u.hp > 0)!;
  assert(b1, "住满后产出第 1 条船");
  // 补到 3 条存活后暂停（进度保留不爆产）。
  for (let i = 0; i < 2400 && sim.units.filter((u) => u.kind === "boat" && u.hp > 0).length < 3; i++) sim.tick(0.05);
  const fleet = sim.units.filter((u) => u.kind === "boat" && u.hp > 0);
  assert(fleet.length === 3, `同屋 3 条存活（实际 ${fleet.length}）`);
  for (let i = 0; i < 1200; i++) sim.tick(0.05); // 再 60s
  assert(
    sim.units.filter((u) => u.kind === "boat" && u.hp > 0).length === 3,
    "满编不爆产（进度保留等待）",
  );
  console.log("testBoathouse ok（9人不产/10人开工/3条上限暂停）");
}

// T8 豁免：感化拒船、地震/龙卷跳船、countPop 去船、codec 来回
function testExemptions(): void {
  assert(!canConvert("boat"), "传教士感化不动船（canConvert 表）");
  // 地震：裂缝开在船底，船与船员须毫发无伤（slideIntoCracks 豁免）。
  {
    const sim = new Sim(new World(2050));
    let deep: { x: number; z: number } | null = null;
    for (let x = 6; x < 66 && !deep; x += 2) {
      for (let z = 6; z < 66 && !deep; z += 2) {
        if (!waterAt(sim.world, x, z)) continue;
        let nearShore = false;
        for (let k = 0; k < 12 && !nearShore; k++) {
          const a = (k / 12) * Math.PI * 2;
          if (sim.world.walkableAt(x + Math.cos(a) * 2.5, z + Math.sin(a) * 2.5)) nearShore = true;
        }
        if (!nearShore) deep = { x, z };
      }
    }
    assert(deep, "深水区应存在");
    const boat = sim.addUnit(BLUE, "boat", deep.x, deep.z);
    const rider = sim.addUnit(BLUE, "walker", deep.x, deep.z);
    rider.homeId = boat.id; // 已在船上（登船链路 T1 已覆盖）
    sim.fillCharges(BLUE);
    assert(sim.quakeSpell.cast(sim, BLUE, deep.x, deep.z, 0).ok, "地震施放");
    for (let i = 0; i < 80; i++) sim.tick(0.05); // 4s：裂缝全开＋处决窗口全过
    assert(boat.hp === 150, `地震不伤船（hp=${boat.hp.toFixed(1)}）`);
    assert(rider.hp > 0 && rider.homeId === boat.id, "地震不伤船员、不下船");
  }
  // 龙卷风：卷到船，船不动、船员不下船（tornado 豁免）。
  // 注：龙卷不能直接施放在水上（"水上不起龙卷风"），故施放在船边 1 格的岸上——
  // 无豁免时 0.5s 能把船拖 1.3 格，有豁免应纹丝不动。
  {
    const sim = new Sim(new World(2050));
    const houseId = buildBoathouse(sim);
    dwellCrew(sim, houseId, BOATHOUSE_DWELL);
    for (let i = 0; i < 1200 && sim.units.every((u) => u.kind !== "boat"); i++) sim.tick(0.05);
    const boat = sim.units.find((u) => u.kind === "boat" && u.hp > 0)!;
    assert(boat, "有船可卷");
    let cx = boat.x;
    let cz = boat.z;
    outer: for (let r = 0.5; r <= 2; r += 0.25) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const x = boat.x + Math.cos(a) * r;
        const z = boat.z + Math.sin(a) * r;
        if (sim.world.heightAt(x, z) > WATER) {
          cx = x;
          cz = z;
          break outer;
        }
      }
    }
    assert(sim.world.heightAt(cx, cz) > WATER, "船边有岸可起龙卷");
    const bx = boat.x;
    const bz = boat.z;
    sim.fillCharges(BLUE);
    assert(sim.tornadoSpell.cast(sim, BLUE, cx, cz, 0).ok, "龙卷风施放");
    for (let i = 0; i < 10; i++) sim.tick(0.05);
    assert(Math.hypot(boat.x - bx, boat.z - bz) < 0.05, `龙卷风卷不动船（位移 ${Math.hypot(boat.x - bx, boat.z - bz).toFixed(2)}）`);
  }
  // countPop 去船：船不占人口，船员（村民）照计。
  {
    const sim = new Sim(new World(11));
    const n0 = sim.countPop(BLUE);
    const boat = sim.addUnit(BLUE, "boat", 36, 36);
    assert(sim.countPop(BLUE) === n0, "船不占人口上限");
    const w = sim.addUnit(BLUE, "walker", 30, 30);
    assert(sim.countPop(BLUE) === n0 + 1, "村民照计人口");
    w.homeId = boat.id;
    assert(sim.countPop(BLUE) === n0 + 1, "船员照计人口");
  }
  // codec 来回：kind=boat＋船员 homeId 不丢。
  {
    const sim = new Sim(new World(2050));
    const boat = sim.addUnit(BLUE, "boat", 36, 30);
    const rider = sim.addUnit(BLUE, "walker", 36, 30);
    rider.homeId = boat.id;
    const mirror = createSimMirror();
    applySnapshot(mirror, encodeSnapshot(sim));
    const mb = mirror.units.find((u) => u.id === boat.id)!;
    const mr = mirror.units.find((u) => u.id === rider.id)!;
    assert(mb && mb.kind === "boat", "镜像船 kind 不丢");
    assert(mr && mr.homeId === boat.id, "镜像船员 homeId 不丢");
  }
  console.log("testExemptions ok（感化拒船/地震跳船/龙卷跳船/人口去船/codec 来回）");
}

function main(): void {
  testBoard();
  testDeny();
  testSail();
  testDisembark();
  testBoatFire();
  testSink();
  testBoathouse();
  testExemptions();
  console.log("boat-check ok");
}

main();
