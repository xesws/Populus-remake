/**
 * v0.25 阶段 2 地貌特征检查：Canyon（峡谷 / 干谷，features/canyon.ts）。
 * 不入 check 链（集成由主 agent 做）；单独跑 `npx tsx src/game/feature-canyon-check.ts`。
 *
 * 用**合成 FeatureEnv**（自造高度场/掩膜/labels/出生点，不 new World——
 * 那会把特征测试和整条管线耦合，管线一动测试就跟着挂）。覆盖点：
 *   a) 可复现    —— 同 rng seed 两次 apply 逐格相同（h 与 mask）；不同 seed 结果不同
 *   b) 留痕      —— placed ≥ 1 的运行 cells > 0、MASK_PEAK > 0；MASK_CHANNEL 恒为 0
 *                   （干谷铁律：谷底永远高于 water，登记了 CHANNEL 就说明有人把它刻成了河）
 *   c) 不造陆    —— 任何 h ≤ seaH 的海格零改动（不许海变陆，单连通不变量）
 *   d) 值域      —— 全图 h ∈ [0, maxH]、无 NaN/Infinity
 *   e) 避基地    —— 双方出生点周围 6.8 格内零改动（规格 ≥7 格，留 0.2 格舍入余量；
 *                   实现里路径点判据 = minStartDist + 崖肩触达，崖肩外缘也够不到 7 格线）
 *   f) 干谷      —— 谷底沿程处处 > water + 0.2（规格的硬保护：安全线 water+0.25）
 *   g) 走廊      —— 谷底沿程相邻采样点高差 ≤ 0.5（是走廊，不是一串坑）
 *   h) 两壁      —— 沿程抽样，左右崖肩（中心线 ±offset 处）都 ≥ 谷底 + 0.6
 *   i) 退化      —— canyonPlanFor 低山地权（0.1×1.0）→ placed=0 且高度零改动
 *   j) 安全线    —— 每条已落地干谷的 floorTarget ≥ water + 0.25
 */
import { RNG } from "./types";
import type { GenStart } from "./world-gen";
import { makeNoiseKit, mixSeed } from "./world-gen/noise";
import { MASK_CHANNEL, MASK_PEAK, type FeatureEnv } from "./world-gen/terrain-features";
import { Canyon, canyonPlanFor } from "./world-gen/features/canyon";

// 与真实管线同尺度（world-gen.ts：SAMPLES=289、STEP=0.25、WORLD=72、SEA_H=0.04、WATER=0.20、MAX_H=8）
const S = 289;
const STEP = 0.25;
const WORLD = 72;
const SEA_H = 0.04;
const WATER = 0.20;
const MAX_H = 8;
/** 基底噪声 seed 固定：两次运行只差 rng 流，把"特征的随机性"和"基底的随机性"隔离开。 */
const BASE_SEED = 4242;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/**
 * 合成环境：四周 4.5 格海环（给"不许海变陆"断言供料、也让 isMainland 有真判据），
 * 内陆是一块连通"大陆"，高度 = 1.45 ± 0.75 的低频 fbm，clamp 到 [0.7, 2.3]——
* 够峡谷下切出真高差，也远高于 water，谷底安全线才有被检验的意义。
 */
function makeEnv(rngSeed: number): { env: FeatureEnv; h0: Float32Array } {
  const noise = makeNoiseKit(mixSeed(BASE_SEED));
  const h = new Float32Array(S * S);
  const labels = new Int32Array(S * S);
  const ring = 18; // 18 采样 = 4.5 格海环
  for (let iz = 0; iz < S; iz++) {
    for (let ix = 0; ix < S; ix++) {
      const i = iz * S + ix;
      if (ix < ring || iz < ring || ix >= S - ring || iz >= S - ring) {
        h[i] = 0.02;
        labels[i] = 0;
      } else {
        const v = 1.45 + 0.75 * noise.fbm(ix * STEP, iz * STEP, 4, 0.045);
        h[i] = Math.min(2.3, Math.max(0.7, v));
        labels[i] = 1;
      }
    }
  }
  const starts: GenStart[] = [
    { x: 20, z: 20, yaw: 0, h: 1 },
    { x: 52, z: 52, yaw: 0, h: 1 },
  ];
  const env: FeatureEnv = {
    samples: S,
    step: STEP,
    world: WORLD,
    seaH: SEA_H,
    water: WATER,
    maxH: MAX_H,
    h,
    mask: new Uint8Array(S * S),
    labels,
    maxLabel: 1,
    starts,
    rng: new RNG(mixSeed(rngSeed)),
    noise,
  };
  return { env, h0: h.slice() };
}

/** 世界坐标 → 最近采样格高度（越界钳回图内，抽样点都由 trace 保证在图内）。 */
function sampleH(env: FeatureEnv, x: number, z: number): number {
  const ix = Math.min(S - 1, Math.max(0, Math.round(x / STEP)));
  const iz = Math.min(S - 1, Math.max(0, Math.round(z / STEP)));
  return env.h[iz * S + ix]!;
}

/** 折线按弧长参数取点：t ∈ [0,1] → 线上坐标（与 carveBed 的线性插值同几何）。 */
function polylineAt(pts: ReadonlyArray<{ x: number; z: number }>, t: number): { x: number; z: number } {
  const segLens: number[] = [];
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.z - pts[i]!.z);
    segLens.push(l);
    total += l;
  }
  let want = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i + 1 < pts.length; i++) {
    if (want <= segLens[i]!) {
      const u = segLens[i]! > 0 ? want / segLens[i]! : 0;
      return {
        x: pts[i]!.x + (pts[i + 1]!.x - pts[i]!.x) * u,
        z: pts[i]!.z + (pts[i + 1]!.z - pts[i]!.z) * u,
      };
    }
    want -= segLens[i]!;
  }
  return { x: pts[pts.length - 1]!.x, z: pts[pts.length - 1]!.z };
}

/** 折线总弧长（格）。 */
function polylineLen(pts: ReadonlyArray<{ x: number; z: number }>): number {
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    total += Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.z - pts[i]!.z);
  }
  return total;
}

function countMask(mask: Uint8Array, bit: number): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if ((mask[i]! & bit) !== 0) n++;
  return n;
}

/** 通用不变量（每次 apply 后都过一遍）：海格零改动、值域、避基地、无水系位。 */
function checkInvariants(env: FeatureEnv, h0: Float32Array, label: string): void {
  let seaRaised = 0;
  let outOfRange = 0;
  let startDirty = 0;
  for (let iz = 0; iz < S; iz++) {
    for (let ix = 0; ix < S; ix++) {
      const i = iz * S + ix;
      const v = env.h[i]!;
      if (!Number.isFinite(v)) throw new Error(`${label}: 第 ${i} 格高度非有限值 ${v}`);
      if (v < 0 || v > MAX_H) outOfRange++;
      if (h0[i]! <= SEA_H && v !== h0[i]!) seaRaised++;
      if (v !== h0[i]!) {
        const x = ix * STEP;
        const z = iz * STEP;
        for (const s of env.starts) {
          if (Math.hypot(x - s.x, z - s.z) < 6.8) {
            startDirty++;
            break;
          }
        }
      }
    }
  }
  assert(seaRaised === 0, `${label}: ${seaRaised} 个海格被改动（不许海变陆）`);
  assert(outOfRange === 0, `${label}: ${outOfRange} 格超出 [0, maxH]`);
  assert(startDirty === 0, `${label}: 出生点 6.8 格内有 ${startDirty} 格被改动`);
  assert(countMask(env.mask, MASK_CHANNEL) === 0, `${label}: 干谷登记了 MASK_CHANNEL（谷底被刻到水下）`);
}

/** 沿程语义断言（f/g/h/j）：干谷、走廊、两壁。 */
function checkTraceSemantics(feat: Canyon, env: FeatureEnv, label: string): void {
  for (let c = 0; c < feat.lastTraces.length; c++) {
    const tr = feat.lastTraces[c]!;
    assert(
      tr.floorTarget >= WATER + 0.25 - 1e-9,
      `${label}: 第 ${c} 条 floorTarget=${tr.floorTarget} 低于安全线 water+0.25`,
    );
    // f+g：谷底沿程抽样（两端 12% 是设计上的"敞开缓坡"，从 12% 起验走廊本体）
    const len = polylineLen(tr.pts);
    const nSamples = Math.max(8, Math.round((len * 0.76) / 0.5));
    let prev = NaN;
    for (let k = 0; k <= nSamples; k++) {
      const t = 0.12 + (0.76 * k) / nSamples;
      const p = polylineAt(tr.pts, t);
      const hv = sampleH(env, p.x, p.z);
      assert(
        hv > WATER + 0.2,
        `${label}: 第 ${c} 条谷底在 (${p.x.toFixed(1)},${p.z.toFixed(1)}) 高度 ${hv.toFixed(3)} ≤ water+0.2（干谷变河）`,
      );
      if (Number.isFinite(prev)) {
        assert(
          Math.abs(hv - prev) <= 0.5,
          `${label}: 第 ${c} 条谷底沿程高差 ${Math.abs(hv - prev).toFixed(3)} > 0.5（走廊断成坑）`,
        );
      }
      prev = hv;
    }
    // h：两壁抽样——内段（25%~75%）壁高吃满端部收口，避开首尾的敞开段。
    //    肩点由 trace 直接携带（生成端已做弯道外推；null = 发卡弯内侧放弃盖章的点位，
    //    那里以天然地形为墙，不参与本断言）。两侧合计的非空样本必须足够多，
    //    否则"外推失败全跳过"会让这条断言空转。
    const i0 = Math.max(1, Math.ceil(tr.pts.length * 0.25));
    const i1 = Math.min(tr.pts.length - 2, Math.floor(tr.pts.length * 0.75));
    let shoulderSamples = 0;
    for (const side of [tr.leftShoulders, tr.rightShoulders] as const) {
      for (let i = i0; i <= i1; i++) {
        const sp = side[i]!;
        if (sp === null) continue;
        shoulderSamples++;
        const floor = sampleH(env, tr.pts[i]!.x, tr.pts[i]!.z);
        const shoulder = sampleH(env, sp.x, sp.z);
        assert(
          shoulder >= floor + 0.6,
          `${label}: 第 ${c} 条在 (${sp.x.toFixed(1)},${sp.z.toFixed(1)}) 崖肩 ${shoulder.toFixed(3)} 不足谷底 ${floor.toFixed(3)} + 0.6`,
        );
      }
    }
    assert(
      shoulderSamples >= 3,
      `${label}: 第 ${c} 条内段可用肩点仅 ${shoulderSamples} 个，两壁断言覆盖不足`,
    );
  }
}

// ========== 主流程 ==========

// 0) canyonPlanFor：纯函数口径（不消耗随机数由签名保证——它根本拿不到 rng）
{
  const low = canyonPlanFor(0.1, 1.0);
  assert(low.canyons[0] === 0 && low.canyons[1] === 0, "低山地权（0.1）应 placed=0");
  const mid = canyonPlanFor(0.6, 1.0);
  assert(mid.canyons[0] === 1 && mid.canyons[1] === 1, "中等山地权（0.6）应恰好 1 条");
  const high = canyonPlanFor(1, 1.35);
  assert(high.canyons[0] === 1 && high.canyons[1] === 2, "高地（mw×rs=1.35）应 1~2 条");
  console.log("[canyon-check] planFor 档位：低=0 / 中=1 / 高地=1~2 ✓");
}

// 1) i) 低山地权：placed=0 且零改动
{
  const { env, h0 } = makeEnv(7);
  const feat = new Canyon(canyonPlanFor(0.1, 1.0));
  const st = feat.apply(env);
  assert(st.placed === 0 && st.cells === 0, `低山地权应零落地，实际 placed=${st.placed} cells=${st.cells}`);
  for (let i = 0; i < env.h.length; i++) {
    assert(env.h[i] === h0[i], `低山地权不应改高度：第 ${i} 格 ${h0[i]} → ${env.h[i]}`);
    assert(env.mask[i] === 0, "低山地权不应登记掩膜");
  }
  console.log("[canyon-check] 退化：低山地权 placed=0、全图零改动 ✓");
}

// 2) 主循环：多 seed 跑高地配置，逐条过不变量 + 沿程语义
const SEEDS = [3, 7, 11, 21, 42];
let totalPlaced = 0;
let totalCells = 0;
for (const seed of SEEDS) {
  const { env, h0 } = makeEnv(seed);
  const feat = new Canyon(canyonPlanFor(1, 1.35));
  const st = feat.apply(env);
  assert(st.placed === feat.lastTraces.length, `seed ${seed}: placed(${st.placed}) 与 trace 数(${feat.lastTraces.length})不一致`);
  checkInvariants(env, h0, `seed ${seed}`);
  checkTraceSemantics(feat, env, `seed ${seed}`);
  if (st.placed > 0) {
    assert(st.cells > 0, `seed ${seed}: 落地但 cells=0`);
    assert(countMask(env.mask, MASK_PEAK) > 0, `seed ${seed}: 崖肩未登记 MASK_PEAK`);
  }
  totalPlaced += st.placed;
  totalCells += st.cells;
  console.log(
    `[canyon-check] seed ${seed}: placed=${st.placed} cells=${st.cells} peak=${countMask(env.mask, MASK_PEAK)} —— ${st.note}`,
  );
}
assert(totalPlaced >= 2, `五个 seed 总落地仅 ${totalPlaced} 条，落位逻辑可疑`);
assert(totalCells > 0, "总改写格数为 0");

// 3) a) 可复现：同 seed 两次 apply 逐格相同；不同 seed（同基底）结果不同
{
  const a = makeEnv(7);
  const fa = new Canyon(canyonPlanFor(1, 1.35));
  const sa = fa.apply(a.env);
  const b = makeEnv(7);
  const fb = new Canyon(canyonPlanFor(1, 1.35));
  const sb = fb.apply(b.env);
  assert(sa.placed === sb.placed && sa.cells === sb.cells, "同 seed 统计不一致");
  for (let i = 0; i < a.env.h.length; i++) {
    assert(a.env.h[i] === b.env.h[i], `同 seed 第 ${i} 格高度不同：${a.env.h[i]} vs ${b.env.h[i]}`);
    assert(a.env.mask[i] === b.env.mask[i], `同 seed 第 ${i} 格掩膜不同`);
  }
  const c = makeEnv(9);
  const fc = new Canyon(canyonPlanFor(1, 1.35));
  fc.apply(c.env);
  let diff = 0;
  for (let i = 0; i < a.env.h.length; i++) if (a.env.h[i] !== c.env.h[i]) diff++;
  assert(diff > 0, "不同 rng seed（同基底）结果完全相同，随机性失效");
  console.log(`[canyon-check] 可复现：同 seed 逐格相同；异 seed 差异格数 ${diff} ✓`);
}

console.log(
  `[canyon-check] 全部通过：${SEEDS.length} seeds / 共落地 ${totalPlaced} 条干谷 / 改写 ${totalCells} 格`,
);
