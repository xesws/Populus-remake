// v0.25 阶段 2 地貌特征：山脉（契约的首个参考实现，由主 agent 交付以证明契约可用）。
//
// 做法是 AoE II / Civ V 那条路子的 "ridge walk"：随机游走撒一条**有走向**的山脊，
// 而不是再堆一层噪声。区别很关键——连续噪声给的是一堆各向同性的鼓包，
// 而"一条从西北贯到东南的山脉"这种有方向、有主次、有隘口的结构，
// 才是玩家嘴里"这张图有山"的意思。
//
// 与平滑管线的关系（务必看完再改参数）：管线尾部的 clampSlope 把全图高差钳到
// 0.40/采样 ≈ 1.6/格，这是"坡度 <2.5"与"可建地占比 ≥40%"两条硬断言的来源，不能为了山而破。
// 于是一座 5 格高的山，footprint 半径至少 5/1.6 ≈ 3.1 格才不会被削平——
// 所以默认半径下界给到 2.6 格，山是"大块"而不是"尖钉"。

import {
  MASK_PEAK,
  distToStartCells,
  domeProfile,
  isMainland,
  raiseTo,
  type FeatureEnv,
  type FeatureStat,
  type TerrainFeature,
} from "../terrain-features";

/** 山脉配置。长度一律用"格"，不含采样数——采样密度改了也不用回来改这里。 */
export interface MountainRangeConfig {
  /** 每条图的子山脉条数区间。 */
  ranges: [number, number];
  /** 每条子山脉计划撒的峰头数（随机游走步数）。 */
  peaks: [number, number];
  /** 峰头半径（格）。 */
  radius: [number, number];
  /** 主峰目标高程区间（绝对高度；render.ts 的岩带 2.6 起、雪线 4.2 起）。 */
  crest: [number, number];
  /** 游走步长（格）：越小山脊越连贯，越大越松散。 */
  stride: [number, number];
  /** 距双方出生点的最小距离（格）。 */
  minStartDist: number;
  /** 落点四周要求这么多格半径内都是主陆，才有"够走完整条山脉"的腹地（格）。 */
  room: number;
  /** 距图边的最小距离（格）。 */
  margin: number;
  /** 单条子山脉最多尝试取点次数（取不到合法起点就放弃这一条）。 */
  tries: number;
}

/** 默认配置。room=6 的来历见 walk() 里"出陆断"那条教训。 */
export const MOUNTAIN_DEFAULTS: MountainRangeConfig = {
  ranges: [2, 3],
  peaks: [6, 12],
  radius: [2.6, 5.2],
  crest: [4.4, 7.2],
  stride: [1.4, 2.6],
  minStartDist: 8,
  room: 6,
  margin: 5,
  tries: 260,
};

/**
 * 按模板的起伏参数决定"这座图放几条山脉、放多高"。
 * mountainWeight/reliefScale 原本只作用于噪声振幅，v0.25 起同时是**地物密度**的语义来源：
 * highlands（mw×rs≈1）给三到四条，平坦模板给一到两条。
 * 纯函数、不消耗随机数——便于单测，也保证这里的分支不会改变同 seed 的抽取顺序。
 */
export function mountainPlanFor(mw: number, rs: number): MountainRangeConfig {
  const weight = Math.min(1, Math.max(0, mw * rs));
  const base = MOUNTAIN_DEFAULTS;
  const n = 1 + Math.round(weight * 2.4); // 1..3 条
  return {
    ...base,
    ranges: [n, Math.min(4, n + (weight > 0.7 ? 1 : 0))],
    // 平坦图的山矮一截：crest 上限从 7.2 收到约 5.9，避免出现"平原中央一根雪柱"
    crest: [
      base.crest[0],
      base.crest[0] + (base.crest[1] - base.crest[0]) * (0.55 + 0.45 * weight),
    ],
  };
}

/** 随机游走撒山脉。实现 TerrainFeature，也可单独 new 出来做单元测试。 */
export class MountainRange implements TerrainFeature {
  readonly id = "mountainRange";
  private readonly cfg: MountainRangeConfig;
  /** 最近一次 apply 的落位明细（进 FeatureStat.note，日志与测试都能看到"山为什么没放上"）。 */
  private lastNote = "";

  constructor(cfg: Partial<MountainRangeConfig> = {}) {
    this.cfg = { ...MOUNTAIN_DEFAULTS, ...cfg };
  }

  apply(env: FeatureEnv): FeatureStat {
    const cfg = this.cfg;
    const nRanges = env.rng.int(cfg.ranges[0], cfg.ranges[1]);
    const centroid = mainlandCentroid(env);
    let placed = 0;
    let cells = 0;
    let gaveUp = 0;
    const notes: string[] = [];
    for (let r = 0; r < nRanges; r++) {
      const head = this.walk(env, centroid);
      if (head === null) {
        gaveUp++;
        continue;
      }
      placed++;
      cells += head;
      notes.push(this.lastNote);
    }
    if (gaveUp) notes.push(`${gaveUp} 条找不到合法落点`);
    return { id: this.id, placed, cells, note: notes.join("；") };
  }

  /**
   * 撒一条子山脉。返回改写的采样格数；取不到合法起点返回 null。
   *
   * 两个关键设计，都是被实测逼出来的，不要当成可有可无的细节：
   *
   * 1) **落点要有腹地（cfg.room）**。第一版只要求"起点本身是主陆"，于是随机抽样
   *    大量落在海岸半径上，游走第一步就出海 → break。实测每条山脉只印出 1~2 个峰
   *    （seed 11 全图仅 119 个采样格被改写、峰高 2.16），山脉特征形同虚设。
   *    现在要求起点四周 room 格内八个方向都是主陆才有资格当落点。
   * 2) **主方向朝大陆质心收**。纯随机方位的游走天然"向外逃"——从任意一点出发，
   *    朝海的方向总比朝陆的方向多。现在把主方向锚在"指向质心"附近（±0.9 弧度），
   *    且每走一步都把航向往质心回拉 35%，山脊因此**贯穿陆地**而不是斜插进海里。
   *
   * 峰高沿程变化：主峰落在中段偏前的随机位置，两端按 0.42+0.58·near² 收矮，
   * 玩家读到的是"这列山哪里最高"，而不是一排等高的馒头。
   */
  private walk(env: FeatureEnv, centroid: { x: number; z: number }): number | null {
    const cfg = this.cfg;
    const lim = Math.round(cfg.margin / env.step);
    // 腹地要求从严到宽逐档放宽（room → room/2 → 0）。
    // 为什么必须降级而不是卡死一档：twinlands 是两个瓣加一条蜂腰、lagoon 是一圈环礁，
    // "四周 6 格全是主陆"的点在这类图上可能根本不存在——实测 seed 5(twinlands)
    // 用硬 room=6 时**一条山脉都放不下**（placed=0，整个特征空转）。
    // 降级仍然优先挑腹地充足的点，只是不让"完美落点不存在"变成"一个落点都没有"。
    const roomLevels = [Math.round(cfg.room / env.step), Math.round(cfg.room / 2 / env.step), 0];
    let cx = -1;
    let cz = -1;
    for (const roomS of roomLevels) {
      for (let t = 0; t < cfg.tries; t++) {
        const ix = env.rng.int(lim, env.samples - 1 - lim);
        const iz = env.rng.int(lim, env.samples - 1 - lim);
        if (!hasRoom(env, ix, iz, roomS)) continue;
        if (distToStartCells(env, ix, iz) < cfg.minStartDist) continue;
        cx = ix;
        cz = iz;
        break;
      }
      if (cx >= 0) break;
    }
    if (cx < 0) return null;

    let stamped = 0;
    let skipStart = 0;
    let cutShort = 0;
    const nPeaks = env.rng.int(cfg.peaks[0], cfg.peaks[1]);
    // 主峰落在第几座峰头：中段偏前，两端收矮
    const crestAt = env.rng.int(Math.floor(nPeaks * 0.25), Math.max(1, Math.floor(nPeaks * 0.75)));
    const crestH = env.rng.float(cfg.crest[0], cfg.crest[1]);
    let dir =
      Math.atan2(centroid.z - cz * env.step, centroid.x - cx * env.step) + env.rng.float(-0.9, 0.9);
    // 中途一次明显转向，让山脊"有走向但不直"
    const bendAt = env.rng.int(2, Math.max(2, nPeaks - 1));
    const bend = env.rng.float(-0.9, 0.9);

    let touched = 0;
    for (let p = 0; p < nPeaks; p++) {
      if (p === bendAt) dir += bend;
      // 距主峰越远越矮（0.42 倍保底，保证整条山脉连绵而不是单点）
      const near = 1 - Math.min(1, Math.abs(p - crestAt) / Math.max(1, nPeaks * 0.7));
      const target = crestH * (0.42 + 0.58 * near * near);
      const rCells = env.rng.float(cfg.radius[0], cfg.radius[1]) * (0.65 + 0.35 * near);
      const rS = rCells / env.step;
      // 每个峰头单独过出生点判据。只校验起点是不够的：山脉会一路走回基地门口，
      // 而 findStarts 在特征之前就跑完了，它挑好的低地会被后来的山压掉
      //（实测 seed 11 / seed 99 的红方基地旁边 3 格被印上 6+ 高的雪峰）。
      // 处理方式：跳过这一峰但**继续往前走**，让山脊绕出一条走廊，而不是整条山脉作废。
      if (distToStartCells(env, cx, cz) >= cfg.minStartDist) {
        stamped++;
        touched += raiseTo(env, cx, cz, rS, target, domeProfile, MASK_PEAK);
        if (p === crestAt) {
          // 主峰再压一块"山顶岩芯"，让岩/雪带成块而不是一个点
          touched += raiseTo(env, cx, cz, rS * 0.42, crestH * 0.96, domeProfile, MASK_PEAK);
        }
      } else {
        skipStart++;
      }
      // 前进一步：航向往质心回拉 35%，再叠一点抖动
      const toC = Math.atan2(centroid.z - cz * env.step, centroid.x - cx * env.step);
      dir = toC + (dir - toC) * 0.65 + env.rng.float(-0.42, 0.42);
      const stepCells = env.rng.float(cfg.stride[0], cfg.stride[1]);
      cx = Math.round(cx + Math.cos(dir) * (stepCells / env.step));
      cz = Math.round(cz + Math.sin(dir) * (stepCells / env.step));
      // 出陆 / 出安全边距就收尾：宁可短一条山脉，也不能把山印进海里
      if (
        !isMainland(env, cx, cz) ||
        cx < lim ||
        cz < lim ||
        cx >= env.samples - lim ||
        cz >= env.samples - lim
      ) {
        cutShort++;
        break;
      }
    }
    this.lastNote = `峰 ${stamped}/${nPeaks}，避基地跳 ${skipStart}${cutShort ? "，触边收尾" : ""}`;
    return touched;
  }
}

/**
 * 主陆最大连通域的质心（返回世界坐标）。一次 O(n) 扫描，每条图在 apply 里算一次。
 * 空域（理论不出现）退回到图中心，保证调用方永远拿到有限数。
 */
export function mainlandCentroid(env: FeatureEnv): { x: number; z: number } {
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (let i = 0; i < env.labels.length; i++) {
    if (env.labels[i] !== env.maxLabel) continue;
    const iz = (i / env.samples) | 0;
    sx += i - iz * env.samples;
    sz += iz;
    n++;
  }
  if (!n) return { x: env.world * 0.5, z: env.world * 0.5 };
  return { x: (sx / n) * env.step, z: (sz / n) * env.step };
}

/** 以 (ix,iz) 为心：圆心与 8 个罗盘方向 reach 采样处都必须是主陆（"有腹地"判据）。 */
export function hasRoom(env: FeatureEnv, ix: number, iz: number, reach: number): boolean {
  if (!isMainland(env, ix, iz)) return false;
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [0.7071, 0.7071],
    [0.7071, -0.7071],
    [-0.7071, 0.7071],
    [-0.7071, -0.7071],
  ] as const) {
    if (!isMainland(env, Math.round(ix + dx * reach), Math.round(iz + dz * reach))) return false;
  }
  return true;
}

/** 统计高度场里"登记为山体且 ≥fromH"的格数（断言与日志共用）。 */
export function countPeakCells(mask: Uint8Array, h: Float32Array, fromH: number): number {
  let n = 0;
  for (let i = 0; i < h.length; i++) {
    if ((mask[i]! & MASK_PEAK) !== 0 && h[i]! >= fromH) n++;
  }
  return n;
}

/** 高度场里局部极大值的个数（8 邻域内严格最高且 ≥fromH）——"有几个尖峰"的粗口径。 */
export function countSummits(h: Float32Array, samples: number, fromH: number): number {
  let n = 0;
  for (let iz = 1; iz < samples - 1; iz++) {
    for (let ix = 1; ix < samples - 1; ix++) {
      const i = iz * samples + ix;
      const v = h[i]!;
      if (v < fromH) continue;
      let isMax = true;
      for (let dz = -1; dz <= 1 && isMax; dz++) {
        for (let dx = -1; dx <= 1 && isMax; dx++) {
          if (dx === 0 && dz === 0) continue;
          if (h[(iz + dz) * samples + ix + dx]! > v) isMax = false;
        }
      }
      if (isMax) n++;
    }
  }
  return n;
}
