// v0.25 阶段 3 特征检查：湖泊（features/lake.ts 的 Lake，登记 MASK_CHANNEL）。
// 独立局部测试：自造合成 FeatureEnv（大陆圆盘 + fbm 起伏 + 3 处显式洼地），
// 不 new World、不走生成管线——只验证 Lake 这一个特征的契约语义。
//
// 覆盖点：
//  1. 同 seed 两次 apply 逐格一致（h 与 mask）；不同 seed 结果不同
//  2. lakePlanFor 是纯函数（不消耗随机数），且平坦图湖数多于 highlands、范围在 2~5 内
//  3. apply 确实改写高度（cells>0）且所有湖面格登记 MASK_CHANNEL
//  4. 湖面高度处处 ∈ (seaH, water)；全图无 NaN/Infinity、都在 [0, maxH]；
//     海格（h≤seaH）一格都没被抬高（"不把海抬成陆"硬不变量）
//  5. 出生点 3.5 格半径内 h/mask 完全未动（minStartDist 9 − 最大湖半径 5.3 ≈ 3.7 格余量）
//  6. 湖是封闭的：从湖面出发的 BFS（h≤water 的 4 邻接）触不到图边（不会连到海），
//     且湖面格的 4 邻域要么是湖面、要么是 h>water 的陆——这是"湖不是河"的关键区别
//  7. 每片湖面 ≥4 格²（太小会被管线吃掉）；湖片数 === placed；各湖彼此 4 邻接分离

import { RNG } from "./types";
import { makeNoiseKit } from "./world-gen/noise";
import type { GenStart } from "./world-gen/world-gen";
import { MASK_CHANNEL, type FeatureEnv } from "./world-gen/terrain-features";
import { Lake, LAKE_DEFAULTS, lakePlanFor } from "./world-gen/features/lake";

const SAMPLES = 289;
const STEP = 0.25;
const WORLD = (SAMPLES - 1) * STEP; // 72 格，与真实管线同尺寸
const SEA_H = 0.04;
const WATER = 0.2;
const MAX_H = 8;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 与 WorldGen.labelLand 同口径的 4 邻接连通域（测试本地实现，避免耦合生成器）。 */
function labelLand(h: Float32Array): { labels: Int32Array; maxLabel: number } {
  const n = h.length;
  const labels = new Int32Array(n);
  labels.fill(-1);
  const queue = new Int32Array(n);
  let maxLabel = -1;
  let maxCount = 0;
  let label = 0;
  for (let i = 0; i < n; i++) {
    if (h[i]! <= SEA_H || labels[i]! !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    labels[i] = label;
    while (head < tail) {
      const cur = queue[head++]!;
      const iz = (cur / SAMPLES) | 0;
      const ix = cur - iz * SAMPLES;
      const nbs: number[] = [];
      if (ix > 0) nbs.push(cur - 1);
      if (ix < SAMPLES - 1) nbs.push(cur + 1);
      if (iz > 0) nbs.push(cur - SAMPLES);
      if (iz < SAMPLES - 1) nbs.push(cur + SAMPLES);
      for (const nb of nbs) {
        if (labels[nb]! === -1 && h[nb]! > SEA_H) {
          labels[nb] = label;
          queue[tail++] = nb;
        }
      }
    }
    if (tail > maxCount) {
      maxCount = tail;
      maxLabel = label;
    }
    label++;
  }
  return { labels, maxLabel };
}

const STARTS: GenStart[] = [
  { x: 14, z: 14, yaw: 0, h: 1.2 },
  { x: 58, z: 58, yaw: Math.PI, h: 1.2 },
];
/** 三处显式洼地（抛物线碟盘）：保证"局部洼地"一定存在，不依赖 fbm 的运气。 */
const DIPS: ReadonlyArray<readonly [number, number]> = [
  [30, 22],
  [50, 34],
  [34, 50],
];

/** 合成 FeatureEnv：半径 33 格的大陆圆盘（陆格 ≥0.55 > water）+ 环海外海。 */
function makeEnv(seed: number): { env: FeatureEnv; h0: Float32Array } {
  const n = SAMPLES * SAMPLES;
  const noise = makeNoiseKit((seed ^ 0x51ab3c7) >>> 0);
  const h = new Float32Array(n);
  for (let iz = 0; iz < SAMPLES; iz++) {
    for (let ix = 0; ix < SAMPLES; ix++) {
      const x = ix * STEP;
      const z = iz * STEP;
      const i = iz * SAMPLES + ix;
      if (Math.hypot(x - 36, z - 36) <= 33) {
        let v = 1.05 + 1.15 * noise.fbm(x, z, 4, 0.05);
        for (const [dx, dz] of DIPS) {
          const q = Math.hypot(x - dx, z - dz) / 6.5;
          v -= 0.85 * Math.max(0, 1 - q * q);
        }
        h[i] = Math.min(MAX_H, Math.max(0.55, v));
      } else {
        h[i] = SEA_H;
      }
    }
  }
  const { labels, maxLabel } = labelLand(h);
  const env: FeatureEnv = {
    samples: SAMPLES,
    step: STEP,
    world: WORLD,
    seaH: SEA_H,
    water: WATER,
    maxH: MAX_H,
    h,
    mask: new Uint8Array(n),
    labels,
    maxLabel,
    starts: STARTS,
    rng: new RNG((seed * 2654435761) >>> 0),
    noise,
  };
  return { env, h0: h.slice() };
}

/** 一片水面的连通域（4 邻接，h≤water）。 */
interface WaterComp {
  cells: number[];
  touchesBorder: boolean;
}

function waterComponents(h: Float32Array): WaterComp[] {
  const n = h.length;
  const seen = new Uint8Array(n);
  const comps: WaterComp[] = [];
  const queue = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (seen[i] !== 0 || h[i]! > WATER) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    seen[i] = 1;
    const cells: number[] = [];
    let border = false;
    while (head < tail) {
      const cur = queue[head++]!;
      cells.push(cur);
      const iz = (cur / SAMPLES) | 0;
      const ix = cur - iz * SAMPLES;
      if (ix === 0 || iz === 0 || ix === SAMPLES - 1 || iz === SAMPLES - 1) border = true;
      const nbs: number[] = [];
      if (ix > 0) nbs.push(cur - 1);
      if (ix < SAMPLES - 1) nbs.push(cur + 1);
      if (iz > 0) nbs.push(cur - SAMPLES);
      if (iz < SAMPLES - 1) nbs.push(cur + SAMPLES);
      for (const nb of nbs) {
        if (seen[nb] === 0 && h[nb]! <= WATER) {
          seen[nb] = 1;
          queue[tail++] = nb;
        }
      }
    }
    comps.push({ cells, touchesBorder: border });
  }
  return comps;
}

interface RunResult {
  env: FeatureEnv;
  h0: Float32Array;
  placed: number;
  cells: number;
  lakes: { area: number; minH: number; maxH: number }[];
}

/** 跑一次 Lake 并做本 seed 全部语义断言，返回观测值供汇总打印。 */
function runAndCheck(seed: number): RunResult {
  const { env, h0 } = makeEnv(seed);
  const stat = new Lake().apply(env);
  const h = env.h;
  const n = h.length;

  // —— 全图硬不变量：无 NaN/Infinity、范围、海格不许被抬 ——
  for (let i = 0; i < n; i++) {
    const v = h[i]!;
    assert(Number.isFinite(v), `seed=${seed} 第 ${i} 格高度非有限值`);
    assert(v >= 0 && v <= MAX_H, `seed=${seed} 高度越界：${v}`);
    if (h0[i]! <= SEA_H) {
      assert(v === h0[i]!, `seed=${seed} 海格（${i}）被改写：${h0[i]} → ${v}`);
    }
  }

  // —— 出生点 3.5 格内一尘不染 ——
  for (let iz = 0; iz < SAMPLES; iz++) {
    for (let ix = 0; ix < SAMPLES; ix++) {
      const x = ix * STEP;
      const z = iz * STEP;
      let d = Infinity;
      for (const s of STARTS) d = Math.min(d, Math.hypot(x - s.x, z - s.z));
      if (d > 3.5) continue;
      const i = iz * SAMPLES + ix;
      assert(h[i] === h0[i] && env.mask[i] === 0, `seed=${seed} 出生点 ${d.toFixed(2)} 格内被污染`);
    }
  }

  // —— 湖面 = 非 border 的水面连通域 ——
  const comps = waterComponents(h);
  const lakes = comps.filter((c) => !c.touchesBorder);
  if (stat.placed === 0) {
    assert(lakes.length === 0, `seed=${seed} placed=0 却出现了 ${lakes.length} 片内水`);
    assert(stat.cells === 0, `seed=${seed} placed=0 却改写了 ${stat.cells} 格`);
    return { env, h0, placed: 0, cells: 0, lakes: [] };
  }
  assert(stat.cells > 0, `seed=${seed} 放了湖却没改写任何格`);
  assert(lakes.length === stat.placed, `seed=${seed} 湖片数 ${lakes.length} ≠ placed ${stat.placed}`);

  const lakeStats = lakes.map(({ cells }) => {
    const inComp = new Set(cells);
    let minH = Infinity;
    let maxH = -Infinity;
    for (const i of cells) {
      const v = h[i]!;
      minH = Math.min(minH, v);
      maxH = Math.max(maxH, v);
      assert(v > SEA_H, `seed=${seed} 湖面格 ${i} 高度 ${v} ≤ seaH（labels 会把它判成海）`);
      assert(v < WATER, `seed=${seed} 湖面格 ${i} 高度 ${v} ≥ water（游戏不判水）`);
      assert((env.mask[i]! & MASK_CHANNEL) !== 0, `seed=${seed} 湖面格 ${i} 未登记 MASK_CHANNEL`);
      // 湖面格 4 邻域：要么同片湖面，要么是 h>water 的陆（封闭性 + 不是河）
      const iz = (i / SAMPLES) | 0;
      const ix = i - iz * SAMPLES;
      const nbs: number[] = [];
      if (ix > 0) nbs.push(i - 1);
      if (ix < SAMPLES - 1) nbs.push(i + 1);
      if (iz > 0) nbs.push(i - SAMPLES);
      if (iz < SAMPLES - 1) nbs.push(i + SAMPLES);
      for (const nb of nbs) {
        assert(
          inComp.has(nb) || h[nb]! > WATER,
          `seed=${seed} 湖面格 ${i} 的邻格 ${nb} 是外部水面（湖不封闭/连海）`,
        );
      }
    }
    const area = cells.length * STEP * STEP; // 格²
    assert(area >= 4, `seed=${seed} 湖面仅 ${area.toFixed(2)} 格²（<4，会被管线吃掉）`);
    return { area, minH, maxH };
  });
  return { env, h0, placed: stat.placed, cells: stat.cells, lakes: lakeStats };
}

function testReproducible(): void {
  for (const seed of [3, 17, 101]) {
    const a = makeEnv(seed);
    const statA = new Lake().apply(a.env);
    const b = makeEnv(seed);
    const statB = new Lake().apply(b.env);
    assert(statA.placed === statB.placed, `seed=${seed} 两次 placed 不同`);
    for (let i = 0; i < a.env.h.length; i++) {
      assert(
        a.env.h[i] === b.env.h[i] && a.env.mask[i] === b.env.mask[i],
        `seed=${seed} 第 ${i} 格两次 apply 不一致`,
      );
    }
  }
  console.log("testReproducible ok（同 seed 逐格一致）");
}

function testDifferentSeeds(): void {
  const seeds = [11, 12, 13, 14, 15, 16];
  const runs = seeds.map((s) => {
    const { env } = makeEnv(s);
    const stat = new Lake().apply(env);
    return { env, stat };
  });
  assert(runs.some((r) => r.stat.placed > 0), "6 个 seed 至少一个放下湖");
  let found = false;
  for (let i = 0; i < runs.length && !found; i++) {
    for (let j = i + 1; j < runs.length && !found; j++) {
      if (runs[i].stat.placed === 0 || runs[j].stat.placed === 0) continue;
      for (let k = 0; k < runs[i].env.h.length; k++) {
        if (runs[i].env.h[k] !== runs[j].env.h[k]) {
          found = true;
          break;
        }
      }
    }
  }
  assert(found, "不同 seed 的湖应不同（高度场存在差异）");
  console.log("testDifferentSeeds ok（不同 seed 结果不同）");
}

function testPlanFor(): void {
  // 纯函数：不消耗随机数（分支再多也不改同 seed 的抽取顺序）
  const r1 = new RNG(77);
  lakePlanFor(0.3, 0.8);
  const a = r1.next();
  const r2 = new RNG(77);
  const b = r2.next();
  assert(a === b, "lakePlanFor 消耗了随机数");
  // 平坦/环礁图湖多，highlands 少；范围守住规格的 2~5
  const flat = lakePlanFor(0.05, 0.5);
  const high = lakePlanFor(1.0, 1.35);
  assert(flat.count[1] > high.count[1], `平坦图湖数应多于 highlands（${flat.count[1]} vs ${high.count[1]}）`);
  assert(flat.count[0] >= 2 && flat.count[1] <= 5, "平坦图湖数越出 [2,5]");
  assert(high.count[0] >= 2 && high.count[1] <= 5, "highlands 湖数越出 [2,5]");
  assert(LAKE_DEFAULTS.count[0] === 2 && LAKE_DEFAULTS.count[1] === 5, "默认湖数应为 [2,5]");
  console.log(`testPlanFor ok（平坦 [${flat.count}] / highlands [${high.count}]）`);
}

function testSemantics(): void {
  const seeds = [1, 2, 4, 5, 6, 7, 8, 9];
  const results = seeds.map(runAndCheck);
  const placedTotal = results.reduce((s, r) => s + r.placed, 0);
  assert(placedTotal >= 8, `8 个 seed 共只放下 ${placedTotal} 个湖（洼地扫描疑似失效）`);
  const minArea = Math.min(...results.flatMap((r) => r.lakes.map((l) => l.area)));
  const allBedMin = Math.min(...results.flatMap((r) => r.lakes.map((l) => l.minH)));
  const allBedMax = Math.max(...results.flatMap((r) => r.lakes.map((l) => l.maxH)));
  console.log(
    `testSemantics ok（8 seed 共 ${placedTotal} 湖；最小湖面 ${minArea.toFixed(1)} 格²；` +
      `湖面高程区间 [${allBedMin.toFixed(3)}, ${allBedMax.toFixed(3)}] ⊂ (seaH, water)）`,
  );
}

function main(): void {
  testPlanFor();
  testReproducible();
  testDifferentSeeds();
  testSemantics();
  console.log("feature-lake-check ok (v0.25 阶段 3 湖泊特征)");
}

main();
