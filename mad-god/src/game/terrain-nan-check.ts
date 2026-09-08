/**
 * v0.31.2 地形 NaN 污染回归锁（案发 seed=2050 群岛图）：
 * 旧 `World.flattenPad` 环形带平滑遍邻居采样未钳制，贴边整地时读到 Float32Array
 * 越界 → undefined → NaN 写进高度场，再经 3×3 平均/插值扩散（实测 14 格→2878 格）：
 * 地形透洞露出深蓝水面（"蓝洞"）+ walkableAt 全假（AI 卡死、红方被灭）。
 *   T1 边缘整地横扫：六地貌 × 四边四角 × 多种占地/朝向 flattenPad → 全场零 NaN/Inf/负数，
 *      且正常调用一次不触发 setSample 熔断；
 *   T2 案发复现：seed=2050 + 红方 AIDirector + 边缘预整地 + 火山砸红出生点 + 90s 对局
 *      → 全场零非有限、零负数；
 *   T3 setSample 熔断：NaN/±Inf 直接丢弃（数组不变、不抛异常）+ 落一条带堆栈的 error，
 *      正常写入不受影响。
 */
import { Sim } from "./sim";
import { BLUE, RED, SAMPLES, WORLD } from "./types";
import { World } from "./world";
import { AIDirector, AIProfile } from "./ai";
import { logger } from "./logger";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function countBad(w: World): { nan: number; neg: number; inf: number } {
  let nan = 0;
  let neg = 0;
  let inf = 0;
  for (let i = 0; i < w.h.length; i++) {
    const v = w.h[i]!;
    if (Number.isNaN(v)) nan++;
    else if (!Number.isFinite(v)) inf++;
    else if (v < 0) neg++;
  }
  return { nan, neg, inf };
}

function assertClean(w: World, tag: string): void {
  const bad = countBad(w);
  assert(bad.nan === 0 && bad.neg === 0 && bad.inf === 0, `${tag} 高度场被污染: ${JSON.stringify(bad)}`);
}

function terrainErrorsSince(n0: number): number {
  return logger.entries().slice(n0).filter((e) => e.cat === "terrain").length;
}

// T1：边缘整地横扫
function testEdgeFlatten(): void {
  // 六地貌各一 seed（大陆/群岛/半岛/双半岛/环礁/高地）。
  const seeds = [11, 17, 24, 3, 6, 2];
  const edge = [0.6, 1.5, 2.5, WORLD - 3, WORLD - 2, WORLD - 1];
  const pads: Array<[number, number]> = [
    [1.3, 1.3], // 茅屋
    [2.6, 2.6], // 训练营
    [2.75, 2.75], // 训练营预整地（案发尺寸）
    [0.6, 0.6], // 哨塔
    [3.2, 3.2], // 出生点/导演
    [5.2, 5.2], // 导演大 pad
  ];
  const yaws = [0, 0.5, 2.36];
  const n0 = logger.entries().length;
  for (const seed of seeds) {
    const w = new World(seed);
    for (const e of edge) {
      for (const [pw, pd] of pads) {
        for (const yaw of yaws) {
          w.flattenPad(e, 36, pw, pd, yaw, 1.5); // 西边缘带
          w.flattenPad(WORLD - e, 36, pw, pd, yaw, 1.5); // 东边缘带
          w.flattenPad(36, e, pw, pd, yaw, 1.5); // 北边缘带
          w.flattenPad(36, WORLD - e, pw, pd, yaw, 1.5); // 南边缘带
        }
      }
      // 四角
      w.flattenPad(e, e, 2.75, 2.75, 0.7, 1.5);
      w.flattenPad(WORLD - e, WORLD - e, 2.75, 2.75, 0.7, 1.5);
      w.flattenPad(e, WORLD - e, 2.75, 2.75, 0.7, 1.5);
      w.flattenPad(WORLD - e, e, 2.75, 2.75, 0.7, 1.5);
    }
    assertClean(w, `seed=${seed} 边缘整地后`);
  }
  assert(terrainErrorsSince(n0) === 0, "正常贴边整地不应触发 setSample 熔断");
  console.log("testEdgeFlatten ok（六地貌×四边四角×6 占地×3 朝向零污染）");
}

// T2：案发复现（seed=2050 群岛）
function testSeed2050(): void {
  const sim = new Sim(new World(2050));
  const dir = new AIDirector([[RED, AIProfile.normal()]]);
  dir.attach(sim);
  const bs = sim.world.startPad(BLUE);
  const rs = sim.world.startPad(RED);
  // 确定性复现案发调用：红营地预整地落在南边缘（案发坐标 9.93,69.00 附近）。
  sim.tryPrepFound(9.93, 69.0, bs.yaw, "warriorHut");
  sim.tryPrepFound(bs.x + 5, 69.0, bs.yaw, "hut");
  assertClean(sim.world, "案发预整地后");
  sim.fillCharges(BLUE);
  const res = sim.volcanoSpell.cast(sim, BLUE, rs.x, rs.z, 0);
  assert(res.ok, "火山 cast 成功");
  for (let t = 0; t < 90; t += 0.05) {
    sim.tick(0.05);
    dir.update(sim, 0.05);
    if (Math.round(t / 0.05) % 300 === 0) assertClean(sim.world, `t=${t.toFixed(0)}s`);
  }
  assertClean(sim.world, "90s 对局后");
  console.log("testSeed2050 ok（边缘预整地+火山+红 AI 90s 零污染）");
}

// T3：setSample 熔断
function testSetSampleFuse(): void {
  const w = new World(11);
  // 找一块陆地格做阳性对照。
  let ix = 100;
  let iz = 100;
  if (w.h[w.idx(ix, iz)]! <= 1 || w.h[w.idx(ix, iz)]! > 7) {
    let found = false;
    for (let z = 40; z < 200 && !found; z++) {
      for (let x = 40; x < 200 && !found; x++) {
        const v = w.h[w.idx(x, z)]!;
        if (v > 1 && v <= 7) {
          ix = x;
          iz = z;
          found = true;
        }
      }
    }
    assert(found, "测试地图里应有可写陆地格");
  }
  const h0 = w.h[w.idx(ix, iz)]!;
  const n0 = logger.entries().length;
  w.setSample(ix, iz, NaN); // 不抛异常
  w.setSample(ix, iz, Infinity);
  w.setSample(ix, iz, -Infinity);
  assert(w.h[w.idx(ix, iz)] === h0, "熔断：非法值不得写入高度场");
  const errs = logger.entries().slice(n0).filter((e) => e.cat === "terrain");
  assert(errs.length === 3, `熔断应落 3 条 terrain error（实际 ${errs.length}）`);
  assert(
    errs.every((e) => typeof e.data?.["stack"] === "string" && (e.data["stack"] as string).length > 0),
    "熔断日志必须带堆栈",
  );
  // 阳性对照：正常写入不受影响。
  w.setSample(ix, iz, h0 + 0.5);
  assert(w.h[w.idx(ix, iz)] === h0 + 0.5, "正常高度写入不受熔断影响");
  console.log("testSetSampleFuse ok（NaN/±Inf 丢弃+堆栈落盘+正常写入如常）");
}

function main(): void {
  testEdgeFlatten();
  testSeed2050();
  testSetSampleFuse();
  console.log("terrain-nan-check ok");
}

main();
