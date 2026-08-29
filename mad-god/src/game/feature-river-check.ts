/**
 * v0.25 阶段 3 地貌特征检查：河流（src/game/world-gen/features/river.ts，登记 MASK_CHANNEL）。
 *
 * 用合成的 FeatureEnv（一座带噪声纹理的锥形岛 + 两侧出生点）直接驱动 River.apply，
 * 不经过 World/WorldGen 管线——特征是就地雕刻器，给它一个确定性的环境就能全量验证。
 *
 * 覆盖点（对应任务契约 + river.ts 文件头列的坑）：
 *   a) riverPlanFor 纯且方向正确：山地图河多而短、平坦图河少而长、源头判据更低
 *   b) 同 seed 两次 apply 逐格相同（h 与 mask）；同地形不同河流 seed 结果不同
 *   c) 确实改写高度（cells>0）且登记 MASK_CHANNEL；CHANNEL 格全部落在 (seaH, water) 内
 *   d) 没有任何海格（h ≤ seaH）被抬高（含 carveBed 把纯海格抬到 floor 的副作用是否被还原）
 *   e) 高度全在 [0, maxH]、无 NaN/Infinity
 *   f) 出生点周围 2 格内高度与掩膜零污染（河不许把基地泡进水里）
 *   g) 河从高处顺坡连到海：源头 ≥ sourceH、总落差 ≥2、上坡步占比 ≤20%（"大致单调不升"）、
 *      终点 8 邻里必有海/出主陆边界（"终点落在陆域边缘/海里一侧"）
 *   h) 水面带宽沿程处处 ≥2 格：源头收口区（前 2 格）与河口垫段之外，
 *      每个测点 1 格半径内的**主陆格**全部是 CHANNEL（离中心线 ≤1 格 ⇒ 在水面带内）
 *   i) 同 seed 多条河不糊成一片：CHANNEL 占主陆比例有上限，
 *      每个测点 2.5 格盘内 CHANNEL 占比有上限（并流成湖会把盘填满）
 *
 * 运行：npx tsx src/game/feature-river-check.ts
 * （不进 package.json 的 check 链；与管线的集成由主 agent 负责。）
 */
import { RNG } from "./types";
import { FeatureComposer, MASK_CHANNEL, isMainland, type FeatureEnv, type GenStart } from "./world-gen";
import { makeNoiseKit, mixSeed } from "./world-gen";
import { River, RIVER_DEFAULTS, riverPlanFor } from "./world-gen/features/river";

const SAMPLES = 289;
const STEP = 0.25;
const WORLD = (SAMPLES - 1) * STEP; // 72 格，与真实管线同尺寸
const SEA_H = 0.04;
const WATER = 0.2;
const MAX_H = 8;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 4 邻接连通域标记（与 world-gen.labelLand 同口径：h > seaH 即陆地）。 */
function labelLand(h: Float32Array): { labels: Int32Array; maxLabel: number } {
  const n = h.length;
  const labels = new Int32Array(n).fill(-1);
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
      const cz = (cur / SAMPLES) | 0;
      const cx = cur - cz * SAMPLES;
      if (cx > 0 && labels[cur - 1]! === -1 && h[cur - 1]! > SEA_H) {
        labels[cur - 1] = label;
        queue[tail++] = cur - 1;
      }
      if (cx < SAMPLES - 1 && labels[cur + 1]! === -1 && h[cur + 1]! > SEA_H) {
        labels[cur + 1] = label;
        queue[tail++] = cur + 1;
      }
      if (cz > 0 && labels[cur - SAMPLES]! === -1 && h[cur - SAMPLES]! > SEA_H) {
        labels[cur - SAMPLES] = label;
        queue[tail++] = cur - SAMPLES;
      }
      if (cz < SAMPLES - 1 && labels[cur + SAMPLES]! === -1 && h[cur + SAMPLES]! > SEA_H) {
        labels[cur + SAMPLES] = label;
        queue[tail++] = cur + SAMPLES;
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

/**
 * 合成环境：半径 31 格的锥形岛（中心 ~6.5 高、边缘 0.5），叠 0.4 幅度的低频 fbm 纹理
 * —— 坡度按"噪声局部斜率 < 锥面斜率"控制，保证河大多能顺坡入海、又不至于没有凹坑可测。
 * terrainSeed 决定地形，riverSeed 决定河流随机流；分开传是为了能做"同地形不同河流"的对比。
 */
function makeEnv(terrainSeed: number, riverSeed: number): { env: FeatureEnv; h0: Float32Array } {
  const noise = makeNoiseKit(mixSeed(terrainSeed));
  const rng = new RNG(mixSeed(riverSeed));
  for (let i = 0; i < 8; i++) rng.next(); // 与 world-gen 同款预热：跳过 LCG 头部相关性
  const n = SAMPLES * SAMPLES;
  const h = new Float32Array(n);
  const cx = WORLD / 2;
  const cz = WORLD / 2;
  const R = 31;
  for (let iz = 0; iz < SAMPLES; iz++) {
    for (let ix = 0; ix < SAMPLES; ix++) {
      const x = ix * STEP;
      const z = iz * STEP;
      const t = 1 - Math.hypot(x - cx, z - cz) / R;
      const i = iz * SAMPLES + ix;
      if (t <= 0) {
        h[i] = SEA_H;
        continue;
      }
      const v = 0.55 + Math.pow(t, 1.15) * 5.8 + noise.fbm(x, z, 3, 0.03) * 0.45;
      // 陆地下限 0.5 对齐真实管线的 LAND_BASE 量级：陆地全部在游戏水位之上，
      // 避免合成图出现"labels 判陆但游戏判水"的滩格（真实管线不存在这种格子）。
      h[i] = Math.min(MAX_H, Math.max(0.5, v));
    }
  }
  const { labels, maxLabel } = labelLand(h);
  const starts: GenStart[] = [
    { x: 16, z: 54, yaw: 0, h: 1.1 },
    { x: 54, z: 16, yaw: 0, h: 1.1 },
  ];
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
    starts,
    rng,
    noise,
  };
  return { env, h0: h.slice() };
}

function applyFresh(terrainSeed: number, riverSeed: number): {
  env: FeatureEnv;
  h0: Float32Array;
  stat: ReturnType<River["apply"]>;
  river: River;
} {
  const { env, h0 } = makeEnv(terrainSeed, riverSeed);
  const river = new River();
  const stat = river.apply(env);
  return { env, h0, stat, river };
}

function countDiff(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

function mainlandCells(env: FeatureEnv): number {
  let n = 0;
  for (let i = 0; i < env.labels.length; i++) if (env.labels[i] === env.maxLabel) n++;
  return n;
}

/** a) planFor：纯函数、方向正确。 */
function testPlanFor(): void {
  const flat = riverPlanFor(0.2, 0.5); // mw*rs=0.1：平坦模板
  const mount = riverPlanFor(1.0, 1.35); // highlands 档
  assert(mount.rivers[0] > flat.rivers[0], `山地图河流条数应更多（${mount.rivers[0]} vs ${flat.rivers[0]}）`);
  assert(mount.maxLenCells < flat.maxLenCells, `山地图河流应更短（${mount.maxLenCells} vs ${flat.maxLenCells}）`);
  assert(mount.sourceH > flat.sourceH, `山地图源头判据应更高（${mount.sourceH} vs ${flat.sourceH}）`);
  const s = JSON.stringify(riverPlanFor(0.6, 0.6));
  assert(s === JSON.stringify(riverPlanFor(0.6, 0.6)), "riverPlanFor 必须是纯函数");
  console.log(
    `testPlanFor ok  平坦: ${flat.rivers.join("-")}条/最长${flat.maxLenCells}格/源头${flat.sourceH.toFixed(2)}  ` +
      `山地: ${mount.rivers.join("-")}条/最长${mount.maxLenCells}格/源头${mount.sourceH.toFixed(2)}`,
  );
}

/** b) 同 seed 逐格可复现；同地形不同河流 seed 结果不同。 */
function testReproducible(): void {
  const a = applyFresh(101, 77);
  const b = applyFresh(101, 77);
  assert(countDiff(a.env.h, b.env.h) === 0, "同 seed 两次 apply 的高度场必须逐格相同");
  let md = 0;
  for (let i = 0; i < a.env.mask.length; i++) if (a.env.mask[i] !== b.env.mask[i]) md++;
  assert(md === 0, "同 seed 两次 apply 的掩膜必须逐格相同");
  assert(a.stat.placed === b.stat.placed, "同 seed 放置条数必须一致");
  assert(a.river.lastPaths.length === b.river.lastPaths.length, "同 seed 流径数量必须一致");
  const c = applyFresh(101, 78); // 同地形、只换河流随机流
  const moved = countDiff(a.env.h, c.env.h);
  assert(moved > 0, `同地形不同河流 seed 必须产生不同的河（差异格数 ${moved}）`);
  console.log(`testReproducible ok  同seed零差异；换河流seed差异格数 ${moved}`);
}

/** c+i) 雕刻生效、CHANNEL 语义、宽度下限与"不糊成一片"（主断言环境）。 */
function testCarvedAndBounded(t: ReturnType<typeof applyFresh>, label: string): number {
  const { env, stat } = t;
  const chan = FeatureComposer.countMask(env.mask, MASK_CHANNEL);
  assert(stat.placed >= 1, `${label}: 至少应放置 1 条河（note=${stat.note ?? "-"}）`);
  assert(stat.cells > 0, `${label}: 必须改写高度（cells=${stat.cells}）`);
  assert(chan > 0, `${label}: 必须登记 MASK_CHANNEL`);
  for (let i = 0; i < env.h.length; i++) {
    if ((env.mask[i]! & MASK_CHANNEL) === 0) continue;
    assert(env.h[i]! < WATER, `${label}: CHANNEL 格高度必须低于游戏水位（i=${i}, h=${env.h[i]}）`);
    assert(env.h[i]! > SEA_H, `${label}: CHANNEL 格高度必须高于海基准（i=${i}, h=${env.h[i]}）`);
  }
  // 宽度下限：测点（源头收口区之后、河口垫段之前）1 格内的主陆格必须全部带 CHANNEL。
  // 离中心线 ≤1 格的格子必在水带内 ⟺ 水面带宽 ≥2 格；海/别岛格不计入。
  const begin = Math.round(2 / STEP);
  const endPad = Math.round(1.5 / STEP);
  let minDiscTotal = Infinity;
  for (const p of t.river.lastPaths) {
    const end = p.ix.length - 1 - endPad;
    assert(end > begin, `${label}: 流径太短，无法断言宽度带`);
    for (let i = begin; i <= end; i += 2) {
      let mainland = 0;
      let ch = 0;
      for (let dz = -4; dz <= 4; dz++) {
        for (let dx = -4; dx <= 4; dx++) {
          if (dx * dx + dz * dz > 16) continue; // 1 格 = 4 采样
          const jx = p.ix[i]! + dx;
          const jz = p.iz[i]! + dz;
          if (jx < 0 || jz < 0 || jx >= SAMPLES || jz >= SAMPLES) continue;
          if (!isMainland(env, jx, jz)) continue;
          mainland++;
          if ((env.mask[sidxOf(jx, jz)] & MASK_CHANNEL) !== 0) ch++;
        }
      }
      assert(mainland > 0 && ch === mainland, `${label}: 距中心线 1 格内存在未入水的主陆格（路径点 ${i}）`);
      minDiscTotal = Math.min(minDiscTotal, mainland);
    }
  }
  // 不糊成一片：两道上限——全局 CHANNEL 占主陆比例，以及从测点沿 8 个罗盘方向的
  // 连续 CHANNEL 穿程（单条 2.3~3.5 格宽的河，低海岸带上水线圆盘边缘也入水，
  // 穿程 ≤4.5 格左右；两条河并糊或并流成池，穿程会明显超过单条河宽）。
  // 注：盘内占比只做 0.97 的宽松哨兵——2.5 格盘直径才 5 格，一条 4 格宽的河口
  // 就能占掉 ~90%，它分不清"一条宽河"和"一潭糊水"，方向穿程才分得清。
  const frac = chan / mainlandCells(env);
  assert(frac <= 0.12, `${label}: CHANNEL 占主陆比例过高（${(frac * 100).toFixed(2)}%），河糊成片了`);
  let maxLocal = 0;
  let maxRun = 0;
  for (const p of t.river.lastPaths) {
    const len0 = p.ix.length;
    const end = len0 - 1 - endPad;
    for (let i = begin; i <= end; i += 4) {
      let total = 0;
      let ch = 0;
      for (let dz = -10; dz <= 10; dz++) {
        for (let dx = -10; dx <= 10; dx++) {
          if (dx * dx + dz * dz > 100) continue; // 2.5 格 = 10 采样
          const jx = p.ix[i]! + dx;
          const jz = p.iz[i]! + dz;
          if (jx < 0 || jz < 0 || jx >= SAMPLES || jz >= SAMPLES) continue;
          total++;
          if ((env.mask[sidxOf(jx, jz)] & MASK_CHANNEL) !== 0) ch++;
        }
      }
      maxLocal = Math.max(maxLocal, ch / total);
      // 垂直于当地流径的连续水带穿程（两侧各走到头再相加）：这才是"河宽"。
      // 不用 8 个罗盘方向——其中必有顺着河走的，直河段沿程穿程天然很长。
      const dirx = p.ix[Math.min(len0 - 1, i + 1)]! - p.ix[Math.max(0, i - 1)]!;
      const dirz = p.iz[Math.min(len0 - 1, i + 1)]! - p.iz[Math.max(0, i - 1)]!;
      const dl = Math.hypot(dirx, dirz) || 1;
      const px = -dirz / dl;
      const pz = dirx / dl;
      let run = 1; // 测点自身必是水
      for (let k = 1; k <= 24; k++) {
        const jx = Math.round(p.ix[i]! + px * k);
        const jz = Math.round(p.iz[i]! + pz * k);
        if (jx < 0 || jz < 0 || jx >= SAMPLES || jz >= SAMPLES) break;
        if ((env.mask[sidxOf(jx, jz)] & MASK_CHANNEL) === 0) break;
        run++;
      }
      for (let k = 1; k <= 24; k++) {
        const jx = Math.round(p.ix[i]! - px * k);
        const jz = Math.round(p.iz[i]! - pz * k);
        if (jx < 0 || jz < 0 || jx >= SAMPLES || jz >= SAMPLES) break;
        if ((env.mask[sidxOf(jx, jz)] & MASK_CHANNEL) === 0) break;
        run++;
      }
      maxRun = Math.max(maxRun, run);
    }
  }
  assert(maxLocal <= 0.97, `${label}: 单点 2.5 格盘内 CHANNEL 占比过高（${maxLocal.toFixed(2)}），河糊成池了`);
  assert(maxRun <= 19, `${label}: 垂直水带穿程 ${(maxRun * STEP).toFixed(2)} 格，远超单条河宽，河并糊了`);
  console.log(
    `${label}: placed=${stat.placed} cells=${stat.cells} channel=${chan}（主陆的 ${(frac * 100).toFixed(2)}%，` +
      `局部盘峰值 ${maxLocal.toFixed(2)}，垂直最大穿程 ${(maxRun * STEP).toFixed(2)} 格，宽度断言盘内主陆格数最小 ${minDiscTotal}）`,
  );
  return stat.placed;
}

function sidxOf(ix: number, iz: number): number {
  return iz * SAMPLES + ix;
}

/** d) 海格零抬升（含 carveBed 把纯海格抬到 floor 的副作用必须被还原）。 */
function testNoSeaToLand(t: ReturnType<typeof applyFresh>, label: string): void {
  for (let i = 0; i < t.h0.length; i++) {
    if (t.h0[i]! > SEA_H) continue;
    assert(
      t.env.h[i] === t.h0[i],
      `${label}: 海格被改动（i=${i}, ${t.h0[i]} → ${t.env.h[i]}），不许把海格抬成陆格`,
    );
  }
}

/** e) 值域与有限性。 */
function testBounds(t: ReturnType<typeof applyFresh>, label: string): void {
  for (let i = 0; i < t.env.h.length; i++) {
    const v = t.env.h[i]!;
    assert(Number.isFinite(v), `${label}: 出现 NaN/Infinity（i=${i}）`);
    assert(v >= 0 && v <= MAX_H, `${label}: 高度越界（i=${i}, h=${v}）`);
  }
}

/** f) 出生点周围 2 格内零污染（高度逐比特不变 + 无 CHANNEL）。 */
function testStartsClean(t: ReturnType<typeof applyFresh>, label: string): void {
  const rCells = 2;
  for (const s of t.env.starts) {
    for (let iz = 0; iz < SAMPLES; iz++) {
      for (let ix = 0; ix < SAMPLES; ix++) {
        const d = Math.hypot(ix * STEP - s.x, iz * STEP - s.z);
        if (d >= rCells) continue;
        const i = sidxOf(ix, iz);
        assert((t.env.mask[i]! & MASK_CHANNEL) === 0, `${label}: 出生点 ${rCells} 格内出现河床（i=${i}）`);
        assert(t.env.h[i] === t.h0[i], `${label}: 出生点 ${rCells} 格内高度被改动（i=${i}）`);
      }
    }
  }
}

/** g) 从高处顺坡连到海：单调性（带抖动与逃坑容忍）、总落差、终点在陆缘/海侧。 */
function testFlowsDownhillToSea(t: ReturnType<typeof applyFresh>, label: string): void {
  for (const p of t.river.lastPaths) {
    const len = p.ix.length;
    assert(p.srcH >= RIVER_DEFAULTS.sourceH - 1e-6, `${label}: 源头不够高（srcH=${p.srcH}）`);
    // 沿雕刻前的流径高度：上坡步（超出抖动幅度的爬升）只允许少数（逃凹坑），
    // 且整体从源头到入海点要真的下降。
    let ups = 0;
    for (let i = 1; i < len; i++) {
      const d = t.h0[sidxOf(p.ix[i]!, p.iz[i]!)]! - t.h0[sidxOf(p.ix[i - 1]!, p.iz[i - 1]!)]!;
      if (d > RIVER_DEFAULTS.jitterAmp + 1e-4) ups++;
    }
    const upFrac = ups / (len - 1);
    assert(upFrac <= 0.2, `${label}: 上坡步占比过高（${(upFrac * 100).toFixed(1)}%），不是顺坡河`);
    const drop = p.srcH - t.h0[sidxOf(p.ix[len - 1]!, p.iz[len - 1]!)]!;
    assert(drop >= 2, `${label}: 源头到入海点落差不足（${drop.toFixed(2)}）`);
    // 终点落在陆域边缘/海里一侧：8 邻里必有出界格、非主陆格或海格。
    const ex = p.ix[len - 1]!;
    const ez = p.iz[len - 1]!;
    let atEdge = false;
    for (let dz = -1; dz <= 1 && !atEdge; dz++) {
      for (let dx = -1; dx <= 1 && !atEdge; dx++) {
        if (dx === 0 && dz === 0) continue;
        const jx = ex + dx;
        const jz = ez + dz;
        if (jx < 0 || jz < 0 || jx >= SAMPLES || jz >= SAMPLES) atEdge = true;
        else if (!isMainland(t.env, jx, jz)) atEdge = true;
        else if (t.h0[sidxOf(jx, jz)]! <= SEA_H) atEdge = true;
      }
    }
    assert(atEdge, `${label}: 入海点不在陆域边缘（终点 ${ex},${ez}）`);
    // 沿途中心格雕刻后必须真的有水（游戏判据）。
    for (let i = begin0(); i < len - 1 - Math.round(1.5 / STEP); i += 4) {
      const v = t.env.h[sidxOf(p.ix[i]!, p.iz[i]!)]!;
      assert(v < WATER, `${label}: 流径中心格未入水（i=${i}, h=${v}）`);
    }
    console.log(
      `${label}: 源头h=${p.srcH.toFixed(2)} 流径${((len - 1) * STEP).toFixed(1)}格 落差${drop.toFixed(2)} 上坡步${(upFrac * 100).toFixed(1)}%`,
    );
  }
}

function begin0(): number {
  return Math.round(2 / STEP);
}

function main(): void {
  testPlanFor();
  testReproducible();
  // 单独给 apply 计时（不含合成环境构建），对齐管线里的真实开销口径。
  const { env: envA, h0: h0A } = makeEnv(101, 77);
  const riverA = new River();
  const t0 = Date.now();
  const statA = riverA.apply(envA);
  const applyMs = Date.now() - t0;
  const a = { env: envA, h0: h0A, stat: statA, river: riverA };
  testCarvedAndBounded(a, "envA");
  testNoSeaToLand(a, "envA");
  testBounds(a, "envA");
  testStartsClean(a, "envA");
  testFlowsDownhillToSea(a, "envA");
  // 多个地形/河流 seed 组合再扫一轮，确认不是单张图的巧合（只跑通用不变量）。
  let totalPlaced = a.stat.placed;
  for (const [ts, rs] of [
    [7, 1],
    [23, 42],
    [99, 5],
    [2024, 303],
  ]) {
    const t = applyFresh(ts, rs);
    testCarvedAndBounded(t, `seed(${ts},${rs})`);
    testNoSeaToLand(t, `seed(${ts},${rs})`);
    testBounds(t, `seed(${ts},${rs})`);
    testStartsClean(t, `seed(${ts},${rs})`);
    testFlowsDownhillToSea(t, `seed(${ts},${rs})`);
    totalPlaced += t.stat.placed;
  }
  assert(totalPlaced >= 6, `6 个环境合计放置 ${totalPlaced} 条河，成功率过低`);
  console.log(`feature-river-check 全部通过（主环境 apply 耗时 ${applyMs}ms，不含环境构建）`);
}

main();
