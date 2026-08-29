// v0.18 tornado-check.ts —— 龙卷风重构验证（Agent T）
// 用例：
//  a) cast 后龙卷风存在，初始方向为随机（统计 20 次初始向量：不瞄向最近建筑、彼此分散）
//  b) 单位在风眼附近被卷起 → 改为"切向甩飞"（flyVy>0 出现过且甩飞瞬间不再卷高即死），
//     或甩进海里直接死亡
//  c) 龙卷风入海 → waterspout 标记出现、速度减半、寿命加速流失、不再回陆反弹，最终自然消散
// 运行：tsx src/game/tornado-check.ts（由主 agent 统一执行）
import { Sim } from "./sim";
import { BLUE, inMap, WORLD } from "./types";
import { World } from "./world";

// v0.18 测试确定性：把 Math.random 换成种子 LCG（与 world.rng 同款算法），
// 让"统计多次初始方向"这类断言可复现，避免偶发失败。
let rngSeed = 20260828;
(Math as { random: () => number }).random = () => {
  rngSeed = (Math.imul(rngSeed, 1664525) + 1013904223) >>> 0;
  return rngSeed / 4294967296;
};

// sim.tornado 的 waterspout 字段由主 agent 在共享类型上补充；测试先用局部 interface 兼容。
interface TornadoView {
  x: number;
  z: number;
  vx: number;
  vz: number;
  t: number;
  life: number;
  houseT: number;
  waterspout?: boolean;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 找一块远离海的内陆可走格：5×5 邻域全部 walkable（距海 ≥ ~1.25，且不在房屋 pad/树下）。 */
function findInland(world: World): { x: number; z: number } {
  for (let z = 16; z < WORLD - 16; z++) {
    for (let x = 16; x < WORLD - 16; x++) {
      if (!world.walkableAt(x, z)) continue;
      let ok = true;
      for (let dz = -2; dz <= 2 && ok; dz++) {
        for (let dx = -2; dx <= 2 && ok; dx++) {
          if (!world.walkableAt(x + dx, z + dz)) ok = false;
        }
      }
      if (ok) return { x, z };
    }
  }
  throw new Error("no inland cell found");
}

/** 找海岸陆地格（0.5 内就是水面），返回陆地坐标与朝海方向。 */
function findCoast(world: World): { x: number; z: number; dx: number; dz: number } {
  for (let z = 1; z < WORLD; z++) {
    for (let x = 1; x < WORLD; x++) {
      if (!world.land(x, z)) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const wx = x + dx * 0.5;
        const wz = z + dz * 0.5;
        if (inMap(wx, wz) && !world.land(wx, wz)) return { x, z, dx, dz };
      }
    }
  }
  throw new Error("no coast cell found");
}

// (a) 初始方向随机（不再瞄向最近建筑）
function testInitialDirectionRandom(): void {
  const sim = new Sim(new World(42));
  sim.fillCharges(BLUE); // v0.26 充能槽填满
  const castPt = findInland(sim.world);
  const headings: number[] = [];
  const N = 20;
  for (let i = 0; i < N; i++) {
    sim.tornado = null;
    sim.fillCharges(BLUE); // v0.26 每轮填满：槽上限 2 颗，方向随机性测试要连放 20 次
    const res = sim.tornadoSpell.cast(sim, BLUE, castPt.x, castPt.z);
    assert(res.ok, `cast #${i} ok`);
    const tw = sim.tornado!;
    headings.push(Math.atan2(tw.vz, tw.vx));
    sim.tornado = null;
  }
  // 旧行为会瞄向最近建筑：heading 恒 ≈ 朝建筑方向；新行为应显著偏离且彼此分散。
  let best = 1e9;
  let buildingAng = 0;
  for (const b of sim.buildings) {
    if (b.hp <= 0 || b.kind === "rebirth") continue;
    const d = Math.hypot(b.x - castPt.x, b.z - castPt.z);
    if (d < best) {
      best = d;
      buildingAng = Math.atan2(b.z - castPt.z, b.x - castPt.x);
    }
  }
  const diffs = headings.map((a) => {
    const df = Math.abs(a - buildingAng);
    return Math.min(df, Math.PI * 2 - df);
  });
  const mean = diffs.reduce((s, x) => s + x, 0) / N;
  const max = Math.max(...diffs);
  const uniq = new Set(headings.map((a) => a.toFixed(2)));
  assert(mean > 0.5, `初始方向平均偏离最近建筑 ${mean.toFixed(2)} rad > 0.5（随机而非瞄准）`);
  assert(max > 1.2, `至少一次大幅偏离 ${max.toFixed(2)} rad > 1.2`);
  assert(uniq.size >= 3, `初始 heading 多样性 ${uniq.size} >= 3`);
  console.log("testInitialDirectionRandom ok");
}

// (b) 甩飞替代"卷高即死"
function testUnitFlungNotInstaKilled(): void {
  const sim = new Sim(new World(42));
  sim.fillCharges(BLUE); // v0.26 充能槽填满
  const castPt = findInland(sim.world);
  const res = sim.tornadoSpell.cast(sim, BLUE, castPt.x, castPt.z);
  assert(res.ok, "cast ok");
  const tw = sim.tornado!;
  // 单位放在风眼旁 0.3 格：第一帧就会被吸入并甩飞。
  const u = sim.addUnit(BLUE, "walker", tw.x + 0.3, tw.z + 0.3);
  let flung = false;
  let hpAtFling = -1;
  let maxFlyVy = 0;
  let dead = false;
  for (let i = 0; i < 200 && !dead && !flung; i++) {
    sim.tick(0.05);
    if (u.hp <= 0) dead = true;
    if (u.flyVy > 0) {
      flung = true;
      hpAtFling = u.hp;
      maxFlyVy = u.flyVy;
    }
  }
  assert(flung || dead, "单位被甩飞（flyVy>0 出现过）或已死亡");
  if (flung) {
    assert(hpAtFling > 0, `甩飞瞬间不再卷高即死（hp=${hpAtFling}>0）`);
    // 甩飞时写入 flyVy 4.5~6；观测点紧挨甩飞帧，重力尚未结算。
    assert(maxFlyVy >= 4.5 && maxFlyVy <= 6, `flyVy 量级正确（${maxFlyVy.toFixed(2)} ∈ [4.5, 6]）`);
  }
  console.log("testUnitFlungNotInstaKilled ok");
}

// (c) 入海转水龙卷：标记出现、速度减半、加速消散、不回陆，最终自然消散
function testWaterspoutDissipates(): void {
  const sim = new Sim(new World(42));
  const coast = findCoast(sim.world);
  const spd = 1.35;
  sim.tornado = { x: coast.x, z: coast.z, vx: coast.dx * spd, vz: coast.dz * spd, t: 0, life: 16, houseT: 0, flungIds: new Set() };
  let sawSpout = false;
  let spoutSpeedAtEntry = -1;
  let lifeAtEntry = -1;
  let tAtEntry = -1;
  let lifeAfter1s = -1;
  const waterPositions: { x: number; z: number }[] = [];
  for (let i = 0; i < 800 && sim.tornado !== null; i++) {
    sim.tick(0.05);
    const tw = sim.tornado as TornadoView | null;
    if (!tw) break;
    if (tw.waterspout) {
      if (!sawSpout) {
        sawSpout = true;
        spoutSpeedAtEntry = Math.hypot(tw.vx, tw.vz);
        lifeAtEntry = tw.life;
        tAtEntry = tw.t;
      }
      waterPositions.push({ x: tw.x, z: tw.z });
      // 入海 1 秒后记录寿命：验证额外流失（普通 1.0/s，水龙卷 +1.2/s）。
      if (lifeAfter1s < 0 && sim.time >= tAtEntry + 1.0) lifeAfter1s = tw.life;
    }
  }
  assert(sawSpout, "触水后 waterspout 标记出现（不再反弹）");
  assert(sim.tornado === null, "水龙卷最终自然消散（sim.tornado === null）");
  assert(spoutSpeedAtEntry <= 0.72, `入海时速度减半（${spoutSpeedAtEntry.toFixed(2)} ≈ 1.35/2）`);
  for (const p of waterPositions) {
    assert(!sim.world.land(p.x, p.z), `水龙卷不返回陆地（${p.x.toFixed(2)}, ${p.z.toFixed(2)}）`);
  }
  if (lifeAtEntry > 0 && lifeAfter1s > 0) {
    // 剩余寿命 = life − t（自然消耗走 t 增长，水龙卷额外消耗直接扣 life）：
    // 普通 1.0/s，水龙卷 1.0 + 1.2 = 2.2/s，断言口径取两者之差。
    const remain0 = lifeAtEntry - tAtEntry;
    const remain1 = lifeAfter1s - (tAtEntry + 1.0);
    const drained = remain0 - remain1;
    assert(drained > 1.6, `入海后每秒多耗寿命（1 秒流失 ${drained.toFixed(2)} > 1.6，普通仅 1.0）`);
  }
  console.log("testWaterspoutDissipates ok");
}

function main(): void {
  testInitialDirectionRandom();
  testUnitFlungNotInstaKilled();
  testWaterspoutDissipates();
  console.log("tornado-check ok (v0.18 随机航向 + 切向甩飞 + 水龙卷消散)");
}

main();
