// v0.27h 检查：建筑进出机制对等——茅屋住户上屋顶可点选拉出、哨塔驻军绝不自动下塔。
// 测试文件命名：v0.27h / feature=dwell-exit。

import { Sim } from "./sim";
import { BLUE, RED } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function landSpotNear(sim: Sim, ox: number, oz: number): { x: number; z: number } | null {
  for (let r = 2; r <= 10; r += 1) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const x = Math.round((ox + Math.cos(ang) * r) * 2) / 2;
      const z = Math.round((oz + Math.sin(ang) * r) * 2) / 2;
      if (sim.world.walkableAt(x, z) && sim.world.heightAt(x, z) > 0.5) return { x, z };
    }
  }
  return null;
}

/**
 * a. 茅屋住户上屋顶（可见/可点），选中其一右键 = 只拉出他，其余不动；
 *    全部拉出后 dwell 归零、名额可复用（进多少人就能出多少人）。
 */
function testHutDwellersOnRoofAndEject(): void {
  const sim = new Sim(new World(42));
  const bw = sim.units.find((u) => u.team === BLUE && u.kind === "walker")!;
  const spot = landSpotNear(sim, bw.x, bw.z);
  assert(!!spot, "roof: 找到落屋点");
  const hut = sim.placeComplete(BLUE, spot!.x, spot!.z, 0, "hut", 1);
  const ground = hut.y;

  const w1 = sim.addUnit(BLUE, "walker", hut.x + 1, hut.z);
  const w2 = sim.addUnit(BLUE, "walker", hut.x - 1, hut.z);
  assert(sim.productionSystem.occupy(sim, w1, hut), "入住 1");
  assert(sim.productionSystem.occupy(sim, w2, hut), "入住 2");
  for (let i = 0; i < 20; i++) sim.tick(0.05);

  // 上屋顶：两人都在屋檐高度之上、彼此分开站位（可逐个点选）。
  assert(w1.homeId === hut.id && w2.homeId === hut.id, "两人均在屋");
  assert(w1.y > ground + 1.0 && w2.y > ground + 1.0, `住户站上屋顶（y=${w1.y.toFixed(2)}/${w2.y.toFixed(2)} > 地面+1）`);
  assert(Math.hypot(w1.x - w2.x, w1.z - w2.z) > 0.3, "屋顶站位彼此分开（可精确点选）");
  assert(hut.dwell === 2, "dwell=2");

  // 只拉出 1 号：选中他右键远处地面。
  w1.selected = true;
  sim.orderMove(BLUE, hut.x + 6, hut.z);
  assert(w1.homeId === 0, "选中者被拉出（homeId=0）");
  assert(hut.dwell === 1, "茅屋名额释放（dwell=1）");
  assert(w1.y <= ground + 0.2, "拉出者回到地面门口");
  assert(w2.homeId === hut.id && hut.dwell === 1, "未选中者照常在屋（不被牵连）");

  // 再拉出 2 号：dwell 归零。
  for (let i = 0; i < 10; i++) sim.tick(0.05);
  w2.selected = true;
  sim.orderMove(BLUE, hut.x - 6, hut.z);
  assert(w2.homeId === 0 && hut.dwell === 0, "全部拉出后 dwell=0（进出对等）");
  console.log("testHutDwellersOnRoofAndEject ok");
}

/**
 * b. 哨塔驻军绝不自动下塔：敌人从塔边路过全程在打，但 homeId 恒定；
 *    玩家选中他下令我令（右键地面）才走出来。
 */
function testTowerOccupantNeverSelfExits(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const t = sim.placeComplete(BLUE, pad.x - 3, pad.z, 0, "tower", 1);
  const f = sim.addUnit(BLUE, "firewarrior", pad.x - 3, pad.z + 2);
  f.selected = true;
  sim.orderMove(BLUE, t.x, t.z);
  for (let i = 0; i < 120; i++) {
    sim.tick(0.05);
    if (f.homeId === t.id) break;
  }
  assert(f.homeId === t.id, "stay: 牛战士已上塔");

  const foe = sim.addUnit(RED, "warrior", t.x + 4, t.z);
  foe.hp = 999;
  let fired = false;
  for (let i = 0; i < 100; i++) {
    sim.tick(0.05);
    const tx = t.x + 4 - i * 0.02; // 敌人在塔边 4 格横移骚扰 5 秒
    foe.x = Math.max(t.x + 2, tx);
    foe.z = t.z;
    foe.path = [];
    foe.pathI = 0;
    if (sim.shots.length > 0) fired = true;
    assert(f.homeId === t.id, `stay: 骚扰期间绝不自动下塔（i=${i}）`);
  }
  assert(fired, "stay: 塔上持续开火还击");

  // 玩家下令才出塔。
  f.selected = true;
  sim.orderMove(BLUE, t.x, t.z + 5);
  assert(f.homeId === 0, "stay: 玩家选中右键后才走出哨塔");
  console.log("testTowerOccupantNeverSelfExits ok");
}

/** c. 拾取入口：occupantAt 能按屋顶坐标找到驻扎者（selectAt 兜底链路）。 */
function testOccupantAtFindsRoofDweller(): void {
  const sim = new Sim(new World(42));
  const bw = sim.units.find((u) => u.team === BLUE && u.kind === "walker")!;
  const spot = landSpotNear(sim, bw.x, bw.z);
  const hut = sim.placeComplete(BLUE, spot!.x, spot!.z, 0, "hut", 1);
  const w = sim.addUnit(BLUE, "walker", hut.x + 1, hut.z);
  sim.productionSystem.occupy(sim, w, hut);
  for (let i = 0; i < 20; i++) sim.tick(0.05);

  const hit = sim.occupantAt(w.x, w.z, 0.9, BLUE);
  assert(hit === w, "pick: occupantAt 按屋顶坐标命中驻扎者");
  assert(sim.occupantAt(w.x + 5, w.z + 5, 0.9, BLUE) === null, "pick: 远处拾取不到");
  console.log("testOccupantAtFindsRoofDweller ok");
}

testHutDwellersOnRoofAndEject();
testTowerOccupantNeverSelfExits();
testOccupantAtFindsRoofDweller();
console.log("dwell-exit-check 全部通过（v0.27h 屋顶可见可拉出 / 哨塔绝不自动下塔）");
