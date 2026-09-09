/**
 * v0.36 出生点/岛屿解耦回归：
 * T1 IslandAnalyzer 只由高度场产出权威岛表；
 * T2 SpawnPlanner 在终局双岛上必分岛，且完整三建筑开局布局仍留在各自岛内；
 * T3 第二岛不可玩时返回失败原因，交外层重生成，绝不生成同岛方案；
 * T4 WorldGen 纯地形结果不再暴露 starts，安全模板稳定给出两座保留岛与两块保护区。
 */
import { ISLE_BASE_MIN, SAMPLES, STEP, WATER } from "./types";
import { World } from "./world";
import { IslandAnalyzer, SpawnPlanner, WorldGen, initialBaseLayout } from "./world-gen";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function syntheticWorld(rects: ReadonlyArray<readonly [number, number, number, number]>): World {
  const w = new World(42);
  w.h.fill(0.04);
  w.fmask.fill(0);
  w.lava.fill(0);
  w.scorch.fill(0);
  w.swamp.fill(0);
  w.setPads([]);
  w.setTrees([]);
  for (const [x0, z0, x1, z1] of rects) {
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) w.h[iz * SAMPLES + ix] = 1.1;
    }
  }
  w.refreshIslands();
  return w;
}

function testIslandAnalyzer(): void {
  const h = new Float32Array(20 * 20).fill(0.04);
  for (let z = 2; z <= 7; z++) for (let x = 2; x <= 7; x++) h[z * 20 + x] = 1;
  for (let z = 11; z <= 17; z++) for (let x = 12; x <= 18; x++) h[z * 20 + x] = 1;
  const t = IslandAnalyzer.analyze(h, 20, 0.25, WATER);
  assert(t.islands.length === 2, `合成高度场须分析出 2 岛（实际 ${t.islands.length}）`);
  assert(t.islands[0]!.cells === 49 && t.islands[1]!.cells === 36, "岛屿面积与排序须稳定");
  assert(t.grid[3 * 20 + 3] !== t.grid[12 * 20 + 13], "两块陆地标签必须不同");
  console.log("testIslandAnalyzer ok");
}

function testStrictSplitPlan(): void {
  // 每块 96×96 采样（576 格²），远大于 ISLE_BASE_MIN，且全为低坡林地。
  const w = syntheticWorld([[12, 92, 107, 187], [181, 92, 276, 187]]);
  const result = SpawnPlanner.plan(w, true, "split-islands");
  assert(result.ok, `健康双岛必须能规划出生点（${result.ok ? "ok" : result.reason}）`);
  const [a, b] = result.plan.starts;
  const la = w.islandAt(a.x, a.z);
  const lb = w.islandAt(b.x, b.z);
  assert(la !== lb, "分裂方案双方必须属于不同岛");
  for (const [start, label] of [[a, la], [b, lb]] as const) {
    for (const pad of initialBaseLayout(start)) {
      assert(w.islandAt(pad.x, pad.z) === label, `${pad.role} 中心必须留在本方岛`);
    }
  }
  assert(SpawnPlanner.validate(w, result.plan, true), "健康双岛方案须通过终局复验");
  console.log("testStrictSplitPlan ok");
}

function testRejectsUnplayableSecondIsland(): void {
  const w = syntheticWorld([
    [12, 72, 127, 207],
    [225, 120, 244, 139], // 400 格，小于 ISLE_BASE_MIN
  ]);
  assert(w.islands[0]!.cells >= ISLE_BASE_MIN, "主岛须可玩");
  const result = SpawnPlanner.plan(w, true, "split-islands");
  assert(!result.ok && result.reason === "island-too-small", "小型第二岛必须拒绝整图，不得同岛回退");
  console.log("testRejectsUnplayableSecondIsland ok");
}

function testTerrainContractAndSafeTemplate(): void {
  const seed = WorldGen.attemptSeed(2026, 4);
  const a = WorldGen.generate(seed, SAMPLES, STEP, { split: true, safeSplit: true });
  const b = WorldGen.generate(seed, SAMPLES, STEP, { split: true, safeSplit: true });
  assert(!("starts" in a), "WorldGenResult 不得再携带玩家出生点");
  assert(a.templateId === "duel-islands" && a.safeSplit, "兜底必须使用双岛安全模板");
  assert(a.keepSeeds.length === 2 && a.protectedZones.length === 2, "安全模板必须给出两岛与两块通用保护区");
  assert(
    a.keepSeeds.every((s, i) => s.ix === b.keepSeeds[i]!.ix && s.iz === b.keepSeeds[i]!.iz) &&
      a.protectedZones.every((s, i) => s.x === b.protectedZones[i]!.x && s.z === b.protectedZones[i]!.z),
    "安全模板同 seed 必须复现",
  );
  console.log("testTerrainContractAndSafeTemplate ok");
}

function main(): void {
  testIslandAnalyzer();
  testStrictSplitPlan();
  testRejectsUnplayableSecondIsland();
  testTerrainContractAndSafeTemplate();
  console.log("spawn-planner-check ok (v0.36 先岛后出生：权威岛表 / 严格分岛 / 无同岛回退 / 安全模板)");
}

main();
