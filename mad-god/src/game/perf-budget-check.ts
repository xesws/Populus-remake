/**
 * v0.29 · perf-budget · 性能预算检查——固定步长/索敌网格/寻路预算的回归门。
 *
 * 做法：固定 seed 建图（World+Sim，套路同 combat-auto-check），地图中南部开阔带（seed 4242 实测
 * 唯一能容纳 550 人的连贯可站区）摆两团相邻敌对军团（蓝 350 + 红 200，相距 18，前沿交叠进视野，
 * 混编 walker/warrior/firewarrior，全部置于 fight 谕令），
 * 连跑 1800 个 sim.tick(1/60)（= 30 秒模拟），performance.now 逐 tick 计时，输出 mean/p99/max ms。
 *
 * 断言（预算门）：
 *  a) mean ≤ 6ms / tick；
 *  b) p99 ≤ 16ms / tick；
 *  c) 30 秒内全场 hp 总量较开局下降（证明自动战斗确实在跑）。
 *
 * 预算未达标时照常输出基线数字并注明 BASELINE——门保留，性能改动（索敌网格/寻路预算）合并后应转绿。
 * 检查脚本直调 sim.tick(dt)，不经过 game.ts 的固定步长累加器。
 */
import { Sim } from "./sim";
import { BLUE, inMap, Owner, RED, UnitKind } from "./types";
import { World } from "./world";

const SEED = 4242;
const TICKS = 1800; // 1800 × 1/60s = 30 秒模拟
const WARMUP = 300; // 前 300 tick（5s）不计入统计：Node JIT 热身 + 550 单位 t=0 同时醒来的寻路风暴都是合成场景产物
const DT = 1 / 60;
const MEAN_BUDGET = 6; // ms / tick
const P99_BUDGET = 16; // ms / tick

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 以 (cx,cz) 为中心铺 count 个混编战斗单位：方阵网格按离中心距离排序，聚拢成团；返回实际落位数。 */
function spawnLegion(sim: Sim, team: Owner, cx: number, cz: number, count: number): number {
  const mix: UnitKind[] = ["walker", "warrior", "firewarrior"];
  const cand: { x: number; z: number; d: number }[] = [];
  for (let gx = -14; gx <= 14; gx++) {
    for (let gz = -14; gz <= 14; gz++) {
      const x = cx + gx * 1.1;
      const z = cz + gz * 1.1;
      if (!inMap(x, z)) continue;
      cand.push({ x, z, d: gx * gx + gz * gz });
    }
  }
  cand.sort((a, b) => a.d - b.d);
  let placed = 0;
  for (const c of cand) {
    if (placed >= count) break;
    // 盲铺可能落在水面/障碍上（move-check 的教训），只收 walkableAt 验证过的格子
    if (!sim.world.walkableAt(c.x, c.z)) continue;
    const u = sim.addUnit(team, mix[placed % mix.length], c.x, c.z);
    u.order = "fight"; // 军团固定交战谕令：保证 30 秒内必然开打
    placed++;
  }
  return placed;
}

function hpSums(sim: Sim): { blue: number; red: number; total: number } {
  let blue = 0;
  let red = 0;
  for (const u of sim.units) {
    if (u.team === BLUE) blue += u.hp;
    else if (u.team === RED) red += u.hp;
  }
  return { blue, red, total: blue + red };
}

function main(): void {
  const t0 = performance.now();
  const sim = new Sim(new World(SEED));
  const bluePlaced = spawnLegion(sim, BLUE, 28, 56, 350);
  const redPlaced = spawnLegion(sim, RED, 46, 56, 200);
  assert(bluePlaced >= 315, `spawn: 蓝军团落位 ${bluePlaced}/350（可站格子不足）`);
  assert(redPlaced >= 180, `spawn: 红军团落位 ${redPlaced}/200（可站格子不足）`);

  const before = hpSums(sim);
  const times: number[] = [];
  for (let i = 0; i < TICKS; i++) {
    const s = performance.now();
    sim.tick(DT);
    if (i >= WARMUP) times.push(performance.now() - s); // 热身段只跑不记
  }
  const after = hpSums(sim);

  const sorted = [...times].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  const max = sorted[sorted.length - 1];
  const wall = (performance.now() - t0) / 1000;

  console.log(
    `perf-budget: seed=${SEED} 军团 蓝${bluePlaced}/红${redPlaced}（walker/warrior/firewarrior 混编，fight 谕令）` +
      ` tick=${TICKS}×(1/60s)=30s 模拟 墙钟 ${wall.toFixed(1)}s`,
  );
  console.log(
    `perf-budget: tick 耗时（跳过前${WARMUP}热身）mean=${mean.toFixed(2)}ms p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms` +
      `（预算 mean≤${MEAN_BUDGET} p99≤${P99_BUDGET}）`,
  );
  console.log(
    `perf-budget: 全场 hp 开局=${before.total.toFixed(0)}（蓝${before.blue.toFixed(0)}/红${before.red.toFixed(0)}）` +
      ` → 30s 后=${after.total.toFixed(0)}（蓝${after.blue.toFixed(0)}/红${after.red.toFixed(0)}）`,
  );

  // 功能门先跑：自动战斗确认发生（最简口径：全场 hp 总量较开局下降）
  assert(
    after.total < before.total,
    `hp 门：30 秒内全场 hp 未下降（${before.total.toFixed(0)} → ${after.total.toFixed(0)}），自动战斗疑似未发生`,
  );

  if (mean > MEAN_BUDGET || p99 > P99_BUDGET) {
    // BASELINE：当前 HEAD 超预算属预期（索敌网格/寻路预算改动未落地），数字照常输出，门保留
    console.log(
      `perf-budget: BASELINE 超预算（mean=${mean.toFixed(2)}ms p99=${p99.toFixed(2)}ms）——性能改动合并后此门应转绿`,
    );
  }
  assert(mean <= MEAN_BUDGET, `mean 门：${mean.toFixed(2)}ms > ${MEAN_BUDGET}ms/tick`);
  assert(p99 <= P99_BUDGET, `p99 门：${p99.toFixed(2)}ms > ${P99_BUDGET}ms/tick`);
  console.log("perf-budget ok（性能预算内 + 自动战斗确认发生）");
}

main();
