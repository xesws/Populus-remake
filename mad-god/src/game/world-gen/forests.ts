// v0.25 阶段 4：森林成片（生态装饰按高度/坡度分布）。
//
// 为什么改这个：v0.24 及以前的 seedTrees 是"全图均匀随机撒 28~40 棵、彼此至少 2.2 格"。
// 均匀散布 + 硬最小间距的结果是"稀疏随机树"，玩家读不出"这里有一片林子"，
// 而森林在 AoE / 强这类游戏里是**成片的地物**（有边界、有内部密度、有"那堆木头在那边"）。
// 另外 v0.25 把高度动态范围拉开之后，均匀散布会在雪顶和岩坡上也留树 —— 观感直接穿帮，
// 所以这次同时把"按高度带与坡度决定能不能长树"做进来。
//
// 复用而非新增管线：本文件只**产出树的位置**，实体仍由 Sim.trees / render.syncTrees 走
// 原来那条可砍伐的路（AGENTS.md：separable，但不重复造一套渲染/交互）。
// 岩石这类纯装饰项目前没有现成管线，硬加要新开实体与遮挡口径，本轮不做。

import type { Pad } from "../world"; // 纯类型导入：编译期擦除，不因此把 world.ts 拖进运行时
import { RNG } from "../types";

/** 世界侧只提供三个采样函数，不依赖 World 类本体（便于用合成地形单测）。 */
export interface ForestGround {
  heightAt(x: number, z: number): number;
  slopeAt(x: number, z: number): number;
  walkableAt(x: number, z: number): boolean;
}

export interface ForestPlan {
  /** 林子（簇）数量区间。 */
  clusters: [number, number];
  /** 每片林子的树数区间。 */
  perCluster: [number, number];
  /** 簇的半径（格）：决定"一片林子"有多大。 */
  clusterRadius: [number, number];
  /** 树之间的最小间距（格）。成片就要允许比原来近，但太近会撞成一体。 */
  minSpacing: number;
  /** **林线**：高度超过这条线不长树（render.ts 的岩带下沿 2.6 是自然选择）。 */
  treelineH: number;
  /** 坡度上限：超过不长树（与 sim.ts 原来那条 0.55 一致，兼顾野人/树木落点判据统一）。 */
  maxSlope: number;
  /** 距双方出生点的最小距离（格）——开局不能开门就是林子，但也不能远到砍不到木头。 */
  minStartDist: number;
  /** 距出生点的最大距离（格）：**至少一片林子要在这个范围内**，否则村民早期没木头可砍。 */
  maxNearestTreeDist: number;
  /** 距图边留白（格）。 */
  margin: number;
  /** 单个位置最多重试次数（防死循环）。 */
  tries: number;
}

export const FOREST_DEFAULTS: ForestPlan = {
  clusters: [5, 8],
  perCluster: [6, 14],
  clusterRadius: [2.2, 4.5],
  minSpacing: 1.05,
  treelineH: 2.6,
  maxSlope: 0.55,
  minStartDist: 4.5,
  maxNearestTreeDist: 16,
  margin: 3,
  tries: 90,
};

/** 一棵树的位置。 */
export interface TreeSpot {
  x: number;
  z: number;
}

/**
 * 森林撒点器：吃"三个采样函数 + 一条随机流 + 需要避开的建筑地基"，吐一组树位。
 * 纯静态调用、无内部状态，因此可以在没接 World 的情况下单测（给它一条合成高度场即可）。
 */
export class ForestSeeder {
  /**
   * 主入口。pads 是"不许长树"的矩形（已建成建筑 + 双方出生平台），
   * starts 是出生点，用于"至少一片林子离基地不太远"这条硬要求（见 maxNearestTreeDist）。
   */
  static place(
    ground: ForestGround,
    rng: RNG,
    world: number,
    pads: ReadonlyArray<Pad>,
    starts: ReadonlyArray<{ x: number; z: number }>,
    plan: ForestPlan = FOREST_DEFAULTS,
  ): TreeSpot[] {
    const spots: TreeSpot[] = [];
    const nClusters = rng.int(plan.clusters[0], plan.clusters[1]);
    for (let c = 0; c < nClusters; c++) {
      // 前 starts.length 片林子**逐个强制**贴着一个出生点（每方基地各保底一片）：
      // 不这么做的话，随机可能让某一方基地周围全是空地，村民早期没木头可砍
      //（玩法级 bug，不是观感问题）。只保底 starts[0] 是不够的——实测红方基地
      // 到最近树 18.3 格，蓝方有保底所以看不出问题。
      const near = c < starts.length ? starts[c]! : null;
      const center = ForestSeeder.findCenter(ground, rng, world, plan, pads, starts, near);
      if (!center) continue;
      const n = rng.int(plan.perCluster[0], plan.perCluster[1]);
      const r = rng.float(plan.clusterRadius[0], plan.clusterRadius[1]);
      for (let k = 0; k < n; k++) {
        // 簇内用 sqrt(u) 分布：中心密、边缘疏，看起来像自然林缘而不是一个圆盘
        const ang = rng.float(0, Math.PI * 2);
        const rad = r * Math.sqrt(rng.next());
        const x = center.x + Math.cos(ang) * rad;
        const z = center.z + Math.sin(ang) * rad;
        if (!ForestSeeder.ok(ground, plan, pads, starts, spots, x, z, world)) continue;
        spots.push({ x, z });
      }
    }
    return spots;
  }

  /** 找一个合法的簇中心；near 给定时优先在它附近（保证有一片林子够得着基地）。 */
  private static findCenter(
    ground: ForestGround,
    rng: RNG,
    world: number,
    plan: ForestPlan,
    pads: ReadonlyArray<Pad>,
    starts: ReadonlyArray<{ x: number; z: number }>,
    near: { x: number; z: number } | null,
  ): TreeSpot | null {
    for (let t = 0; t < plan.tries; t++) {
      let x: number;
      let z: number;
      if (near) {
        const d = rng.float(plan.minStartDist + 1, plan.maxNearestTreeDist);
        const a = rng.float(0, Math.PI * 2);
        x = near.x + Math.cos(a) * d;
        z = near.z + Math.sin(a) * d;
      } else {
        x = rng.float(plan.margin, world - plan.margin);
        z = rng.float(plan.margin, world - plan.margin);
      }
      if (x < plan.margin || z < plan.margin || x > world - plan.margin || z > world - plan.margin) {
        continue;
      }
      // 簇中心只查地形本身；与已有树的间距在成员层面查（中心之间可以靠近，林子会连成片）
      if (!ForestSeeder.terrainOk(ground, plan, pads, x, z)) continue;
      if (starts.some((s) => Math.hypot(x - s.x, z - s.z) < plan.minStartDist)) continue;
      return { x, z };
    }
    return null;
  }

  /** 单个成员格的完整判据：地形 + 避开出生点 + 与已有树的最小间距。 */
  private static ok(
    ground: ForestGround,
    plan: ForestPlan,
    pads: ReadonlyArray<Pad>,
    starts: ReadonlyArray<{ x: number; z: number }>,
    spots: ReadonlyArray<TreeSpot>,
    x: number,
    z: number,
    world: number,
  ): boolean {
    if (x < plan.margin || z < plan.margin || x > world - plan.margin || z > world - plan.margin) {
      return false;
    }
    if (!ForestSeeder.terrainOk(ground, plan, pads, x, z)) return false;
    if (starts.some((s) => Math.hypot(x - s.x, z - s.z) < plan.minStartDist)) return false;
    const m2 = plan.minSpacing * plan.minSpacing;
    for (const t of spots) {
      const dx = t.x - x;
      const dz = t.z - z;
      if (dx * dx + dz * dz < m2) return false;
    }
    return true;
  }

  /** 地形判据：可走（不在水/沼泽）、不在建筑地基里、低于林线、坡度够缓。 */
  private static terrainOk(
    ground: ForestGround,
    plan: ForestPlan,
    pads: ReadonlyArray<Pad>,
    x: number,
    z: number,
  ): boolean {
    if (!ground.walkableAt(x, z)) return false;
    const h = ground.heightAt(x, z);
    if (h >= plan.treelineH) return false; // 岩带与雪顶不长树
    if (ground.slopeAt(x, z) > plan.maxSlope) return false;
    for (const p of pads) {
      if (inPadLocal(x, z, p, 0.9)) return false;
    }
    return true;
  }
}

/**
 * 与 world.ts 的 inPad 同语义的本地实现（点是否落在旋转矩形的 expand 内）。
 * 刻意不 import world.ts：那是运行时更重的模块，且这个判据只有 6 行，
 * 复制一份换来"森林撒点可以完全脱离 World 单测"，值得。
 */
function inPadLocal(x: number, z: number, p: Pad, expand: number): boolean {
  const dx = x - p.x;
  const dz = z - p.z;
  const c = Math.cos(-p.yaw);
  const s = Math.sin(-p.yaw);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= p.w / 2 + expand && Math.abs(lz) <= p.d / 2 + expand;
}
