// v0.25 阶段 2/3 地貌特征契约（由主 agent 定稿；各特征是互相独立的实现，可并行开发）。
//
// 背景：v0.24/v0.25 阶段 1 的高度场是"连续噪声的一次采样"——它能长出海岸线的形状和
// 起伏的幅度，但长不出**具名的地物**。成熟战略引擎（AoE II 的 RMS、Civ 的地图脚本）
// 的多样性从来不来自"换一组噪声参数"，而来自"在随机位置放置若干具名特征"：
// 一条山脉、一条河、一片湖、一块台地。本文件就是这套"放置"的接口。
//
// 设计要点（各实现必须遵守，不要各自发明）：
// 1. 特征是**就地雕刻器**：拿到一条 FeatureEnv，直接改 env.h，不返回新数组。
//    一座 72 格图有 289×289 ≈ 8.3 万个采样，复制一份高度场是 332KB/次，
//    而管线里已经有多处全图副本，再放大副本会直接把构图预算吃掉。
// 2. 特征必须**登记掩膜位**（见 MASK_PEAK / MASK_CHANNEL）。这条是本次改动的命门：
//    生成管线尾部有 7 轮盒式松弛 + clampSlope + MapSmoother 三道"抹平"工序，
//    它们的存在是为了修用户报的"人物行走卡顿、寻路反复 retry"，不能因为
//    加了地物就把它们关掉。所以地物只能"登记自己在哪里、要求被轻手对待"，
//    由平滑工序按掩膜决定力度——而不是绕开平滑。
// 3. 一切随机只许走 env.rng，**禁止 Math.random**：同图 seed 必须逐格可复现
//    （terrain-gen-check 的 testReproducible 会直接挂）。
// 4. 特征落位只许在**最大连通陆域**内（用 isMainland），且要避开出生点
//    （用 distToStartCells）——否则会出现"基地扎在山肚子里""开局门口一条河"这类坏图。

import type { RNG } from "../types";
import type { NoiseKit } from "./noise";
import type { GenStart } from "./world-gen";

/**
 * 山体核心：后续平滑/削峰要轻手对待这一格。
 * 语义是"这里的高差是**有意为之**的地物，不是噪声毛刺"。
 * 注意它不改变坡度上限：clampSlope 的上界（0.40/采样）对全图一律生效，
 * 因为坡度判据（slopeAt < 2.5）与"可建地占比 ≥40%"是硬约束，宁可山宽一点也不能陡一点。
 * 所以**山体半径必须做到几格量级**：高差 5.5 的山要活下来，footprint 至少 5.5/0.4≈14 采样 ≈ 3.5 格。
 */
export const MASK_PEAK = 1;

/**
 * 水系河床/湖盆：closeShoreline 的"填缺"与 floodDisconnectedLand 都不许把它填回陆地。
 * 没有这一位，一条 1~2 格宽的河会在生成管线收尾被形态学闭运算当成"亚格水缺口"填平，
 * 表现为"河刻完就消失"——查起来还特别像随机 bug。
 */
export const MASK_CHANNEL = 2;

/** 单个特征的落地统计，交给上层记日志与断言。 */
export interface FeatureStat {
  readonly id: string;
  /** 成功落地的实例数（0 = 主动放弃，不算失败）。 */
  readonly placed: number;
  /** 被改写过的高度采样格数。 */
  readonly cells: number;
  /** 放弃的原因（人类可读，供日志与测试报告；没有放弃时省略）。 */
  readonly note?: string;
  /**
   * 本特征 apply() 的墙钟耗时（ms），由 FeatureComposer 统一测量后填上。
   * 五个特征叠在一张图上是把构图从 ~340ms 推到 1s 量级的原因，
   * 没有这个字段就只能靠二分注释来定位是哪个特征吃掉了预算，所以直接进契约。
   */
  readonly ms?: number;
}

/** 一座地物对一条高度场做一件事。实现类必须无外部依赖（只用 env 里的东西）。 */
export interface TerrainFeature {
  readonly id: string;
  /** 就地雕刻 env.h 并登记 env.mask；返回统计。内部多次尝试后不满意可以放弃（placed=0）。 */
  apply(env: FeatureEnv): FeatureStat;
}

/**
 * 特征的工作上下文。**只有 h / mask 是可写的**，其余全部是只读判据。
 * 由 WorldGen 在 labelLand 之后、smoothPlains 之前构造，全程共用一条采样网格。
 */
export interface FeatureEnv {
  /** 每边采样数（289）。 */
  readonly samples: number;
  /** 采样间距（格）。 */
  readonly step: number;
  /** 世界边长（格）。 */
  readonly world: number;
  /** 海陆判据：h <= seaH 视为海（与 WorldGen 的 SEA_H 一致，0.04）。 */
  readonly seaH: number;
  /** 游戏水位（WATER，0.20）：水系特征要把河床刻到这条线**以下**才算真的有水。 */
  readonly water: number;
  /** 高度上限（MAX_H，8）：任何雕刻结果都要 clamp 到它以内。 */
  readonly maxH: number;
  /** 高度场，就地修改。 */
  readonly h: Float32Array;
  /** 特征掩膜（位或），就地修改。长度与 h 相同，初值 0。 */
  readonly mask: Uint8Array;
  /** 连通域标签（特征落位前一次性算好，特征内部改高度后**不会**重算）。 */
  readonly labels: Int32Array;
  /** 最大连通域编号。 */
  readonly maxLabel: number;
  /** 双方出生点（世界坐标），用于"别贴着基地放山/放河"。 */
  readonly starts: ReadonlyArray<GenStart>;
  /** 本座图专属随机流（已由图 seed 派生，禁止另起 Math.random）。 */
  readonly rng: RNG;
  /** 本座图专属噪声场（特征内部的次级抖动从这里取）。 */
  readonly noise: NoiseKit;
}

// ========== 共用工具（各特征必须用这几个，避免海陆/边界判据各写一份） ==========

/** 采样下标。调用方保证 ix/iz 在 [0, samples) 内（越界会让高度场写飞，不做静默兜底）。 */
export function sidx(env: FeatureEnv, ix: number, iz: number): number {
  return iz * env.samples + ix;
}

/** 采样点是否落在最大连通陆域内（特征落位的基本门槛）。越界一律 false。 */
export function isMainland(env: FeatureEnv, ix: number, iz: number): boolean {
  if (ix < 0 || iz < 0 || ix >= env.samples || iz >= env.samples) return false;
  return env.labels[sidx(env, ix, iz)] === env.maxLabel;
}

/** 采样点到最近出生点的距离（格）。出生点附近的地物会毁掉开局，几乎所有特征都要用它。 */
export function distToStartCells(env: FeatureEnv, ix: number, iz: number): number {
  const x = ix * env.step;
  const z = iz * env.step;
  let best = Infinity;
  for (const s of env.starts) {
    const d = Math.hypot(x - s.x, z - s.z);
    if (d < best) best = d;
  }
  return best;
}

/** 把 [0,1] 的边缘衰减做成 C1 连续（端点导数为 0）：与 world.ts sculpt 的 smoothstep 同族。 */
function smoothFalloff(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * 通用"印一个地物"原语：以 (cx,cz)（采样坐标）为心、半径 rS（采样数）的圆内，
 * 按 profile(u)（u = d/rS ∈ [0,1]，profile ∈ [0,1]）施加 dh 的高差。
 *
 * profile 由调用方给，这一个函数就能表达三种形状：
 *   山丘/山峰   → (u) => 1 - u*u        （钟形）
 *   平顶台地    → (u) => u < 0.6 ? 1 : 1 - smoothFalloff((u-0.6)/0.4)（顶平、缘缓）
 *   峡谷/河床    → 用 carveBed，别用本函数
 * 规则：
 *   • 只抬升**已是陆地**的格子（h > seaH）；往海里印山会凭空造岛，破坏单连通不变量。
 *   • 结果 clamp 到 [seaH+ε, maxH]。
 *   • 抬升量达到 amp 的 CORE 倍以上时登记 mask |= maskBit。
 * 返回改写的采样格数。
 */
export function stamp(
  env: FeatureEnv,
  cx: number,
  cz: number,
  rS: number,
  dh: number,
  profile: (u: number) => number,
  maskBit: number,
  core = 0.45,
): number {
  const r = Math.max(1, Math.ceil(rS));
  const x0 = Math.max(0, cx - r);
  const x1 = Math.min(env.samples - 1, cx + r);
  const z0 = Math.max(0, cz - r);
  const z1 = Math.min(env.samples - 1, cz + r);
  let touched = 0;
  for (let iz = z0; iz <= z1; iz++) {
    for (let ix = x0; ix <= x1; ix++) {
      const u = Math.hypot(ix - cx, iz - cz) / rS;
      if (u >= 1) continue;
      const i = sidx(env, ix, iz);
      const hv = env.h[i]!;
      if (hv <= env.seaH) continue; // 海里不造山
      const add = dh * profile(u);
      if (add <= 0) continue;
      env.h[i] = Math.min(env.maxH, hv + add);
      if (add >= dh * core) env.mask[i] = (env.mask[i] | maskBit) >>> 0;
      touched++;
    }
  }
  return touched;
}

/**
 * "抬到某个绝对高度"的原语——山脉与台地真正想要的是"峰顶在 6.5 这一档"，
 * 而不是"在噪声基底上再加 3.2"（基底本身在 1.0~3.0 之间晃，加固定量会得到
 * 一高一低不成形的山）。所以这里按 profile 把格子的**目标高程**插出来：
 *
 *   want = hv + (targetH - hv) · profile(u)      （只升不降，targetH 低于现状时不动）
 *
 * 其余规则与 stamp 完全一致：不往海里造陆、clamp 到 maxH、达到 core 倍抬升量登记掩膜。
 * 返回改写的采样格数。
 */
export function raiseTo(
  env: FeatureEnv,
  cx: number,
  cz: number,
  rS: number,
  targetH: number,
  profile: (u: number) => number,
  maskBit: number,
  core = 0.45,
): number {
  const r = Math.max(1, Math.ceil(rS));
  const x0 = Math.max(0, cx - r);
  const x1 = Math.min(env.samples - 1, cx + r);
  const z0 = Math.max(0, cz - r);
  const z1 = Math.min(env.samples - 1, cz + r);
  let touched = 0;
  for (let iz = z0; iz <= z1; iz++) {
    for (let ix = x0; ix <= x1; ix++) {
      const u = Math.hypot(ix - cx, iz - cz) / rS;
      if (u >= 1) continue;
      const i = sidx(env, ix, iz);
      const hv = env.h[i]!;
      if (hv <= env.seaH) continue; // 海里不造山
      const p = profile(u);
      if (p <= 0) continue;
      const want = hv + (targetH - hv) * p;
      if (want <= hv) continue; // 只升不降
      const gain = Math.min(env.maxH, want) - hv;
      const lift = (targetH - hv) * p;
      env.h[i] = hv + gain;
      if (lift >= (targetH - hv) * core) env.mask[i] = (env.mask[i] | maskBit) >>> 0;
      touched++;
    }
  }
  return touched;
}

/**
 * 水系原语：把一条**线段**（世界坐标，格）沿程刻成河床——高度压到 targetH（须 < water），
 * 宽度从 w0 到 w1（格）线性变化，两端用 smoothFalloff 收口（免得河突然"断"在陆地上）。
 * 沿途登记 MASK_CHANNEL，收尾的形态学/填海工序就不会把河填平。
 *
 * 与 stamp 的分工：stamp 只会加高，carveBed 只会降低——两者都不做"赋值"，
 * 因为地物是叠加在噪声基底上的修饰，不该把基底信息整个覆盖掉。
 *
 * 返回改写的采样格数。调用方负责事后检查海陆连通性（见 FeatureComposer 的说明）。
 */
export function carveBed(
  env: FeatureEnv,
  pts: ReadonlyArray<{ x: number; z: number }>,
  w0: number,
  w1: number,
  targetH: number,
): number {
  let touched = 0;
  const segs = Math.max(1, pts.length - 1);
  for (let s = 0; s + 1 < pts.length; s++) {
    const a = pts[s]!;
    const b = pts[s + 1]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1e-6;
    const nx = (b.x - a.x) / len;
    const nz = (b.z - a.z) / len;
    const steps = Math.max(1, Math.ceil(len / (env.step * 0.75))); // 0.75 采样步进：刻痕不断线
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const px = a.x + nx * len * t;
      const pz = a.z + nz * len * t;
      const along = (s + t) / segs; // 全河程 0..1，用于宽度渐变与两端收口
      const taper = smoothFalloff(Math.min(1, along * 4, (1 - along) * 4 + 0.25));
      const halfW = (w0 + (w1 - w0) * along) * taper;
      if (halfW < env.step * 0.6) continue; // 细于此会被闭运算填掉，宁可不刻
      const rS = halfW / env.step;
      const cix = Math.round(px / env.step);
      const ciz = Math.round(pz / env.step);
      const r = Math.ceil(rS);
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const ix = cix + dx;
          const iz = ciz + dz;
          if (ix < 0 || iz < 0 || ix >= env.samples || iz >= env.samples) continue;
          const u = Math.hypot(dx, dz) / rS;
          if (u > 1) continue;
          const i = sidx(env, ix, iz);
          const hv = env.h[i]!;
          const floor = env.seaH + 0.01;
          const want = targetH + (hv - targetH) * smoothFalloff(u); // 中心满刻、边缘无扰
          const nv = Math.max(floor, Math.min(hv, want));
          if (nv === hv) continue;
          env.h[i] = nv;
          if (nv < env.water) env.mask[i] = (env.mask[i] | MASK_CHANNEL) >>> 0;
          touched++;
        }
      }
    }
  }
  return touched;
}

/**
 * 编排器：按顺序把一组特征刻到同一条高度场上。
 * 职责只有三件：调用、汇总统计、按放置数量给后续阶段留日志。
 * 刻意**不做**连通性修复——那是 world.ts 管线的职责（水系切开陆地要凿渡口，
 * 必须在整条管线的高度口径上判，特征自己看不到最终地形）。
 */
export class FeatureComposer {
  static compose(env: FeatureEnv, features: ReadonlyArray<TerrainFeature>): FeatureStat[] {
    const stats: FeatureStat[] = [];
    for (const f of features) {
      const t0 = performance.now();
      const st = f.apply(env);
      stats.push({ ...st, ms: +(performance.now() - t0).toFixed(1) });
    }
    return stats;
  }

  /** 统计掩膜里某个位被登记了多少格（断言"特征确实留下了痕迹"时用）。 */
  static countMask(mask: Uint8Array, bit: number): number {
    let n = 0;
    for (let i = 0; i < mask.length; i++) if ((mask[i]! & bit) !== 0) n++;
    return n;
  }
}

/**
 * 钟形山体剖面（山脊/孤峰通用）。u ∈ [0,1]。
 * 用 1-u² 而不是 (1-u)²：前者在山顶曲率连续、在山脚导数归零，
 * 后者在山脚留一个折角，正好是 clampSlope 削不掉的那种接缝。
 */
export function domeProfile(u: number): number {
  return Math.max(0, 1 - u * u);
}

/** 平顶台地剖面：顶部平坦、边缘以 C1 连续的缓坡落下。 */
export function mesaProfile(u: number, rimStart = 0.62): number {
  if (u <= rimStart) return 1;
  return Math.max(0, 1 - smoothFalloff((u - rimStart) / (1 - rimStart)));
}
