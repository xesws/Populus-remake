/**
 * v0.25 阶段 2/3 地貌特征检查：台地/高原（world-gen/features/plateau.ts，登记 MASK_PEAK）。
 *
 * feature 级**独立**局部测试：自造合成 FeatureEnv（52 格圆岛 + 可选"假山脉"带），
 * 不走 World/WorldGen 整条管线——台地逻辑只依赖契约的 FeatureEnv，单独构造才能把
 * "特征写错了"与"管线别处改错了"分开（AGENTS.md 的 separable 要求）。
 * 合成图尺寸（209 采样 / 0.25 步长）小于正式图的 289，但特征全部从 env 读参数，
 * 结论对正式图同样成立。
 *
 * 覆盖点：
 *   a) 纯函数  —— plateauPlanFor 不消耗随机数、同参同果；highlands 档比基础档多且更高；
 *                 基础模板档（mw×rs ≤ 0.4）顶面上限压在雪线 4.2 之下
 *   b) 可复现  —— 同 seed 两次 apply 逐格相同（h 与 mask 都比），不同 rng seed 结果不同
 *   c) 有痕迹  —— stat.cells > 0、placed ≥ 1、MASK_PEAK 有登记、MASK_CHANNEL 零登记
 *   d) 海陆    —— 任何 h ≤ seaH 的海格高度一字不动（台地最致命项：抬海成陆 = 造新岛）
 *   e) 值域    —— 全部 h ∈ [0, MAX_H]、无 NaN/Infinity
 *   f) 避基地  —— 双方出生点 8 格半径内 Δh === 0
 *   g) 平顶    —— 块中心 2 格半径内高度极差 ≤ 0.5（"台地"区别于"山包"的唯一可测口径）
 *   h) 顶面    —— 顶面面积 ≥ 6 格²、中心高 ≈ block.top、顶面高程 ≥ 3.0（岩带 2.6 之上）
 *   i) 边坡    —— 中心与边缘外 2 格环带中位高差 ≥ 1.0（"边缘是坡"）
 *   j) 高原群  —— 叠块顶面高差 ≤ topJitter；群外缘 +2 格仍有 ≥1.0 落差
 *   k) 避山    —— 假山带（MASK_PEAK + 高于任何可能顶面）一格未动，且台地在别处照常落地
 *
 * 运行：npx tsx src/game/feature-plateau-check.ts（独立脚本，不入 npm run check 链）
 */
import { MAX_H, RNG } from "./types";
import { makeNoiseKit, mixSeed } from "./world-gen/noise";
import {
  FeatureComposer,
  MASK_CHANNEL,
  MASK_PEAK,
  sidx,
  type FeatureEnv,
} from "./world-gen/terrain-features";
import { Plateau, plateauPlanFor, type PlateauBlock } from "./world-gen/features/plateau";
import type { GenStart } from "./world-gen/world-gen";

/** 合成图参数：52 格世界、圆岛半径 20 格、两个对置出生点。SEA_H 与 WorldGen.SEA_H 同值。 */
const SAMPLES_T = 209;
const STEP_T = 0.25;
const WORLD_T = (SAMPLES_T - 1) * STEP_T;
const SEA_H_T = 0.04;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/**
 * 合成高度场：中心 (26,26)、半径 20 格的圆岛，基底 1.55±0.45 的 fbm 起伏，
 * 四周海 0.02（< seaH 0.04）。withBand 时再叠一道贯穿岛左侧的"假山脉"
 * （h=7.0 + MASK_PEAK，高于任何可能的台地顶面 + 余量），专门喂给"避山"断言。
 */
function buildField(noiseSeed: number, withBand: boolean): { h: Float32Array; mask: Uint8Array } {
  const noise = makeNoiseKit(mixSeed(noiseSeed));
  const h = new Float32Array(SAMPLES_T * SAMPLES_T);
  const mask = new Uint8Array(SAMPLES_T * SAMPLES_T);
  const c = (SAMPLES_T - 1) / 2;
  const R = 20 / STEP_T;
  for (let iz = 0; iz < SAMPLES_T; iz++) {
    for (let ix = 0; ix < SAMPLES_T; ix++) {
      const d = Math.hypot(ix - c, iz - c);
      const t = Math.max(0, Math.min(1, (R - d) / (3 / STEP_T))); // 3 格滩宽
      const s = t * t * (3 - 2 * t);
      h[iz * SAMPLES_T + ix] = 0.02 + s * (1.55 + 0.45 * noise.fbm(ix * 0.09, iz * 0.09, 3));
    }
  }
  if (withBand) {
    // 假山带：世界 x ∈ [10,14]、z ∈ [14,38]（格），台地足迹碰它就必须换落点
    for (let iz = Math.round(14 / STEP_T); iz <= Math.round(38 / STEP_T); iz++) {
      for (let ix = Math.round(10 / STEP_T); ix <= Math.round(14 / STEP_T); ix++) {
        const i = iz * SAMPLES_T + ix;
        h[i] = 7.0;
        mask[i] = (mask[i]! | MASK_PEAK) >>> 0;
      }
    }
  }
  return { h, mask };
}

/** 4 邻接连通域标记（判据 h > seaH，与 WorldGen.labelLand 同口径），返回最大域编号。 */
function labelLand(h: Float32Array): { labels: Int32Array; maxLabel: number } {
  const labels = new Int32Array(h.length).fill(-1);
  const queue = new Int32Array(h.length);
  let bestLabel = -1;
  let bestSize = 0;
  let label = 0;
  for (let i = 0; i < h.length; i++) {
    if (labels[i] !== -1 || h[i]! <= SEA_H_T) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    labels[i] = label;
    while (head < tail) {
      const cur = queue[head++]!;
      const cz = (cur / SAMPLES_T) | 0;
      const cx = cur - cz * SAMPLES_T;
      if (cx > 0 && labels[cur - 1] === -1 && h[cur - 1]! > SEA_H_T) {
        labels[cur - 1] = label;
        queue[tail++] = cur - 1;
      }
      if (cx < SAMPLES_T - 1 && labels[cur + 1] === -1 && h[cur + 1]! > SEA_H_T) {
        labels[cur + 1] = label;
        queue[tail++] = cur + 1;
      }
      if (cz > 0 && labels[cur - SAMPLES_T] === -1 && h[cur - SAMPLES_T]! > SEA_H_T) {
        labels[cur - SAMPLES_T] = label;
        queue[tail++] = cur - SAMPLES_T;
      }
      if (cz < SAMPLES_T - 1 && labels[cur + SAMPLES_T] === -1 && h[cur + SAMPLES_T]! > SEA_H_T) {
        labels[cur + SAMPLES_T] = label;
        queue[tail++] = cur + SAMPLES_T;
      }
    }
    if (tail > bestSize) {
      bestSize = tail;
      bestLabel = label;
    }
    label++;
  }
  return { labels, maxLabel: bestLabel };
}

/** 造一个合成 FeatureEnv：高度场由 noiseSeed 决定，随机流由 rngSeed 决定（两者独立，
 *  "同高度场不同 rng"与"同 rng 不同高度场"两类对照都做得出来）。 */
function makeEnv(rngSeed: number, noiseSeed: number, withBand = false): FeatureEnv {
  const { h, mask } = buildField(noiseSeed, withBand);
  const { labels, maxLabel } = labelLand(h);
  const starts: GenStart[] = [
    { x: 10, z: 26, yaw: 0, h: 1.5 },
    { x: 42, z: 26, yaw: Math.PI, h: 1.5 },
  ];
  return {
    samples: SAMPLES_T,
    step: STEP_T,
    world: WORLD_T,
    seaH: SEA_H_T,
    water: 0.2,
    maxH: MAX_H,
    h,
    mask,
    labels,
    maxLabel,
    starts,
    rng: new RNG(mixSeed(rngSeed)),
    noise: makeNoiseKit(mixSeed(noiseSeed)),
  };
}

/** 圆盘内高度极差（采样坐标 + 格半径）。 */
function discRange(env: FeatureEnv, cx: number, cz: number, rCells: number): { lo: number; hi: number } {
  const rS = rCells / env.step;
  const r = Math.ceil(rS);
  let lo = Infinity;
  let hi = -Infinity;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (Math.hypot(dx, dz) > rS) continue;
      const v = env.h[sidx(env, cx + dx, cz + dz)]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return { lo, hi };
}

/** 环带（半径 rCells 格、宽 ±1.5 采样）内高度中位数——用中位数而不是均值：
 *  相邻块的足迹可能盖住环带的一小段，中位数不被局部抬升带偏。 */
function ringMedian(env: FeatureEnv, cx: number, cz: number, rCells: number): number {
  const ringS = (rCells / env.step);
  const r = Math.ceil(ringS + 2);
  const vals: number[] = [];
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dz);
      if (Math.abs(d - ringS) > 1.5) continue;
      const x = cx + dx;
      const z = cz + dz;
      if (x < 0 || z < 0 || x >= env.samples || z >= env.samples) continue;
      vals.push(env.h[sidx(env, x, z)]!);
    }
  }
  assert(vals.length > 0, "环带采样不许为空");
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1]!;
}

/** a) plateauPlanFor 是纯函数：不碰随机流、同参同果，且档位语义正确。 */
function testPlanPure(): void {
  const rng = new RNG(7);
  const s0 = rng.s;
  const a = plateauPlanFor(1, 1.35); // highlands：mw=1, rs=1.35
  const b = plateauPlanFor(1, 1.35);
  assert(rng.s === s0, "plateauPlanFor 不许消耗随机数");
  assert(JSON.stringify(a) === JSON.stringify(b), "plateauPlanFor 同参必须同果");
  const low = plateauPlanFor(0.3, 1); // 基础模板档：mw∈[0.2,0.4]
  assert(a.clusters[0] > low.clusters[0], `highlands 档群数必须多于基础档（${a.clusters[0]} vs ${low.clusters[0]}）`);
  assert(a.top[1] === 5.5, `highlands 档顶面上限 5.5（实际 ${a.top[1]}）`);
  assert(low.top[1] < 4.2, `基础档顶面上限必须压在雪线 4.2 下（实际 ${low.top[1]}）`);
  assert(low.top[0] > 2.6, `顶面下限必须在岩带 2.6 之上（实际 ${low.top[0]}）`);
  console.log(`testPlanPure ok（基础档 top=[${low.top}] clusters=[${low.clusters}]；highlands 档 top=[${a.top}] clusters=[${a.clusters}]）`);
}

/** b) 同 seed 逐格可复现；不同 rng seed 的落位不同。 */
function testReproducible(): void {
  const a = makeEnv(42, 500);
  const b = makeEnv(42, 500);
  const sa = FeatureComposer.compose(a, [new Plateau()])[0]!;
  const sb = FeatureComposer.compose(b, [new Plateau()])[0]!;
  let diff = 0;
  for (let i = 0; i < a.h.length; i++) if (a.h[i] !== b.h[i] || a.mask[i] !== b.mask[i]) diff++;
  assert(diff === 0, `同 seed 两次 apply 必须逐格相同（${diff} 格不一致）`);
  assert(sa.cells === sb.cells && sa.placed === sb.placed, "同 seed 统计必须一致");
  // 不同 rng 流、同一张高度场：落位必须真的会变（否则"多样性"名存实亡）
  const c = makeEnv(43, 500);
  FeatureComposer.compose(c, [new Plateau()]);
  let diff2 = 0;
  for (let i = 0; i < a.h.length; i++) if (a.h[i] !== c.h[i]) diff2++;
  assert(diff2 > 0, "不同 rng seed 必须刻出不同的台地");
  console.log(`testReproducible ok（placed=${sa.placed} cells=${sa.cells}，异 seed 相异格 ${diff2}）`);
}

/** c)~f) 通用契约：有痕迹、不抬海、值域、避基地。 */
function testCommonContract(): void {
  const env = makeEnv(42, 500);
  const before = Float32Array.from(env.h);
  const st = FeatureComposer.compose(env, [new Plateau()])[0]!;
  assert(st.placed >= 1 && st.cells > 0, `台地必须落地（placed=${st.placed} cells=${st.cells}）`);
  assert(FeatureComposer.countMask(env.mask, MASK_PEAK) > 0, "台地必须登记 MASK_PEAK");
  assert(FeatureComposer.countMask(env.mask, MASK_CHANNEL) === 0, "台地与水系无关，MASK_CHANNEL 必须为零");
  // d) 海格一字不动：raiseTo 内置保护，任何绕过都会在这里现形
  let sea = 0;
  for (let i = 0; i < env.h.length; i++) {
    if (before[i]! <= SEA_H_T) {
      sea++;
      assert(env.h[i] === before[i], `海格不许被改动（#${i} ${before[i]} → ${env.h[i]}）`);
    }
  }
  assert(sea > 1000, `合成图必须有成片海（实际 ${sea} 格）`);
  // e) 值域与有限性
  for (let i = 0; i < env.h.length; i++) {
    const v = env.h[i]!;
    assert(Number.isFinite(v) && v >= 0 && v <= MAX_H, `高度越界/非有限（#${i} ${v}）`);
  }
  // f) 出生点 8 格内零改动（特征保证中心距 ≥ 8+半径，rim 不会探进保护圈）
  for (const s of env.starts) {
    const cx = Math.round(s.x / env.step);
    const cz = Math.round(s.z / env.step);
    const r = Math.round(8 / env.step);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.hypot(dx, dz) > r) continue;
        const i = sidx(env, cx + dx, cz + dz);
        assert(env.h[i] === before[i], `出生点 8 格内不许改动（@${s.x},${s.z} 偏移 ${dx},${dz}）`);
      }
    }
  }
  console.log(`testCommonContract ok（cells=${st.cells}，海格 ${sea} 全部原样，note="${st.note}"）`);
}

/** g)~i) 单块语义：平顶、顶面面积、边缘是坡（强制 1 群 1 块，排除叠块干扰）。 */
function testMesaShape(): void {
  const env = makeEnv(7, 900);
  const p = new Plateau({ clusters: [1, 1], blocks: [1, 1] });
  const st = p.apply(env);
  assert(st.placed === 1 && p.lastBlocks.length === 1, `单块模式必须恰好落一块（${st.note}）`);
  const b = p.lastBlocks[0]!;
  const ci = sidx(env, b.cx, b.cz);
  assert(Math.abs(env.h[ci]! - b.top) <= 1e-4, `中心必须是精确顶面（${env.h[ci]} vs top=${b.top}）`);
  assert(b.top >= 3.0, `顶面必须在岩带之上（top=${b.top}）`);
  // g) 平顶：中心 2 格半径内极差 ≤ 0.5
  const { lo, hi } = discRange(env, b.cx, b.cz, 2);
  assert(hi - lo <= 0.5, `中心 2 格内必须是平顶（极差 ${hi - lo}）`);
  // h) 顶面面积 ≥ 6 格²
  const rS = (b.rimStart * b.rCells) / env.step;
  const r = Math.ceil(rS);
  let n = 0;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (Math.hypot(dx, dz) > rS) continue;
      if (env.h[sidx(env, b.cx + dx, b.cz + dz)]! >= b.top - 0.4) n++;
    }
  }
  const area = n * env.step * env.step;
  assert(area >= 6, `顶面面积 ≥6 格²（实际 ${area.toFixed(1)}）`);
  // i) 边缘是坡：中心与边缘外 2 格环带中位高差 ≥ 1.0
  const med = ringMedian(env, b.cx, b.cz, b.rCells + 2);
  assert(env.h[ci]! - med >= 1.0, `中心与边缘外 2 格落差 ≥1.0（${env.h[ci]} vs 环带中位 ${med}）`);
  console.log(
    `testMesaShape ok（R=${b.rCells.toFixed(1)}格 rim=${b.rimStart.toFixed(2)} top=${b.top.toFixed(2)}，顶面极差 ${(hi - lo).toFixed(3)}，面积 ${area.toFixed(1)}格²，边坡落差 ${(env.h[ci]! - med).toFixed(2)}）`,
  );
}

/** j) 高原群：叠块顶面高差受控、群外缘仍是坡。 */
function testClusterGroup(): void {
  const env = makeEnv(11, 900);
  const p = new Plateau({ clusters: [1, 1], blocks: [2, 2] });
  const st = p.apply(env);
  assert(st.placed === 1, `必须落一群（${st.note}）`);
  const blocks = p.lastBlocks;
  assert(blocks.length >= 1, "至少要有主块");
  if (blocks.length < 2) {
    console.log(`testClusterGroup ok（本 seed 叠块未成，仅主块——避让判据生效，note="${st.note}"）`);
    return;
  }
  const [a, b] = [blocks[0]!, blocks[1]!];
  assert(Math.abs(a.top - b.top) <= 0.3 + 1e-6, `群内顶面高差 ≤ topJitter（${a.top} vs ${b.top}）`);
  for (const blk of blocks) {
    const { lo, hi } = discRange(env, blk.cx, blk.cz, 2);
    assert(hi - lo <= 0.5, `群内每块中心 2 格仍须是平顶（极差 ${hi - lo}）`);
  }
  // 群整体外缘 = 各块最远边界；外缘 +2 格处的环带对群顶仍有 ≥1.0 落差
  let extent = a.rCells;
  for (const blk of blocks) {
    extent = Math.max(extent, Math.hypot(blk.cx - a.cx, blk.cz - a.cz) * env.step + blk.rCells);
  }
  const med = ringMedian(env, a.cx, a.cz, extent + 2);
  const centerH = env.h[sidx(env, a.cx, a.cz)]!;
  assert(centerH - med >= 1.0, `群外缘 +2 格落差 ≥1.0（${centerH} vs ${med}）`);
  console.log(
    `testClusterGroup ok（${blocks.length} 块，顶面 ${a.top.toFixed(2)}/${b.top.toFixed(2)}，群外缘落差 ${(centerH - med).toFixed(2)}）`,
  );
}

/** k) 避山：假山带一格不动，台地在带外照常落地。 */
function testAvoidsMaskedPeaks(): void {
  const env = makeEnv(33, 777, true);
  const before = Float32Array.from(env.h);
  const p = new Plateau();
  const st = p.apply(env);
  assert(st.placed >= 1 && st.cells > 0, `有山带的图上台地也必须能落地（${st.note}）`);
  let bandCells = 0;
  for (let i = 0; i < env.h.length; i++) {
    // 山带格 = 预先登记 MASK_PEAK 且高于"任何可能顶面 + 抖动余量"（7.0 > 4.1+0.5）
    if ((env.mask[i]! & MASK_PEAK) !== 0 && before[i]! > 4.6) {
      bandCells++;
      assert(env.h[i] === before[i], `山体格不许被台地削平（#${i} ${before[i]} → ${env.h[i]}）`);
    }
  }
  assert(bandCells > 500, `假山带必须成规模（实际 ${bandCells} 格）`);
  console.log(`testAvoidsMaskedPeaks ok（山带 ${bandCells} 格原样，placed=${st.placed} cells=${st.cells}）`);
}

function main(): void {
  testPlanPure();
  testReproducible();
  testCommonContract();
  testMesaShape();
  testClusterGroup();
  testAvoidsMaskedPeaks();
  console.log("feature-plateau-check 全部通过");
}

main();
