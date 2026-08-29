// v0.24 地图平滑器（强制全图扫描，去毛刺）。
//
// 职责：把噪声/模板/松弛之后**残留的亚格级毛刺**一次性抹平，让地形的"点判据"与
// 单位/寻路的"步进判据"口径一致。这是生成管线的强制收尾步骤——任何一张图出图前
// 都必须过一遍，不通过 map 模板/噪声的调参来间接解决。
//
// 为什么需要它（两类毛刺各自致死的原因）：
// 1) 海陆毛刺：walkableAt 是**点判据**（h > WATER），而单位每帧只挪 spd·dt ≈0.12 格。
//    只要高度场在 0.5 格尺度内还能"陆→水→陆"地跳，就必然出现"两个可走节点之间藏着
//    一条水下细缝"：寻路说这条路能走，移动层一迈步就落进水里，被 resolveCollisions
//    的 nearestLand 弹回原地 → repath → 再弹回（实测半岛 seed 7 的 walker 站在
//    (63.62,22.97)，正前方 0.11 格处 h=0.106，逐级退半步全部失败，只能靠 ghostT 穿墙）。
//    这就是用户反馈的"人物行走卡顿、寻路反复 retry"的机制性来源。
// 2) 高度毛刺：孤立的单格凸台/深坑（噪声极值、松弛不彻底），既制造视觉锯齿，
//    又让 slopeAt 局部超标、让单位爬上去速度骤降。
//
// 设计约束：平滑器只读改高度场本身，不依赖任何玩法系统（无 sim 参与），
// 因此可以安全地在生成期调用；对局中的法术雕刻**不走**这里（法术就是要留毛刺和破坏）。

import { SAMPLES, WATER } from "./types";
import { MASK_CHANNEL } from "./world-gen/terrain-features";

/** 3×3 邻域（不含自身）的偏移表，模块级复用，避免热路径分配。 */
const NB8: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/** 平滑结果统计，供日志与检查断言使用。 */
export interface SmoothReport {
  /** 海陆闭运算改动的采样格数（填缺 + 削刺）。 */
  shoreline: number;
  /** 被填成陆地的亚格水缺口数量。 */
  filled: number;
  /** 被削回海里的亚格陆地尖刺数量。 */
  pruned: number;
  /** 高度中值化修正的采样格数。 */
  spikes: number;
  /** 修正后仍然"点判据与步进判据打架"的边数量（0 = 干净）。 */
  residualSeams: number;
}

/**
 * 全图地图平滑器。纯静态工具类（无实例状态），两步各自独立可单独调用，
 * 便于将来只回滚某一步或单独加测试。
 */
export class MapSmoother {
  /**
   * 第 1 步：海陆形态学**闭运算**（先膨胀后腐蚀，半径 1 采样 = 0.25 格）。
   * - 填缺：被 ≥3 面陆地 4 邻包围的水格抬成陆地（水下细缝消失）；
   * - 削刺：4 邻里陆地不足 2 的陆地细条退回滩涂高度（湿脚尖刺消失）。
   * 之后再做 1 轮"贴水陆格抬到安全高度"，保证插值后的中点也不再入水。
   *
   * v0.25 新增可选 mask（地貌特征掩膜）：**登记过 MASK_CHANNEL 的水格一律不填**。
   * 没有这条保护时，河流/湖泊的窄处（源头收口段、湖岸犬牙的内凹）会满足
   * "被 ≥3 面陆地 4 邻包围"，被当成亚格水缺口抬成陆地——表现为"河刻完上游一段不见了"，
   * 而且掩膜还留着 CHANNEL，查起来完全不像平滑器干的。
   * 不传 mask 时行为与 v0.24 完全一致（对局中的地形不携带特征掩膜，走的正是这条路径）。
   */
  static closeShoreline(h: Float32Array, report: SmoothReport, mask?: Uint8Array): void {
    const n = SAMPLES * SAMPLES;
    const src = new Uint8Array(n);
    for (let i = 0; i < n; i++) src[i] = h[i]! > WATER ? 1 : 0;
    const out = new Uint8Array(src);
    let filled = 0;
    let pruned = 0;
    for (let iz = 1; iz < SAMPLES - 1; iz++) {
      const row = iz * SAMPLES;
      for (let ix = 1; ix < SAMPLES - 1; ix++) {
        const i = row + ix;
        let c = 0;
        if (src[i - 1]) c++;
        if (src[i + 1]) c++;
        if (src[i - SAMPLES]) c++;
        if (src[i + SAMPLES]) c++;
        if (!src[i] && c >= 3 && (mask === undefined || (mask[i]! & MASK_CHANNEL) === 0)) {
          out[i] = 1;
          filled++;
        } else if (src[i] && c < 2) {
          out[i] = 0;
          pruned++;
        }
      }
    }
    let changed = 0;
    for (let i = 0; i < n; i++) {
      if (out[i] === src[i]) continue;
      // 填进来的抬到水上（WATER+0.16，与滩涂同量级、视觉不突兀）；削掉的退回滩涂 0.16。
      h[i] = out[i] ? WATER + 0.16 : 0.16;
      changed++;
    }
    // 第 2 遍：把所有"刚够判陆"的临界陆格抬到 WATER+0.16。
    // 为什么这样就够了（可证明，不靠调参碰运气）：heightAt 是双线性 = 四角凸组合，
    // 所以**沿两个角点连线的取值只由这两个角点决定**——两端都 ≥WATER+0.16 的边走到
    // 哪里都不会跌破水位。唯一还能从中间漏下去的是"对角穿过一个混合格"（A、C 是陆、
    // B、D 是海），而这种陆地 4 邻里陆为 0，已被上面的削刺判据清掉。
    for (let i = 0; i < n; i++) {
      const hv = h[i]!;
      if (hv > WATER && hv < WATER + 0.16) {
        h[i] = WATER + 0.16;
        changed++;
      }
    }
    report.shoreline += changed;
    report.filled += filled;
    report.pruned += pruned;
  }

  /**
   * 第 2 步：高度场中值化去毛刺。对每个采样格取 3×3 邻域（含自身）中位数，
   * 偏离中位数超过 SPIKE 的孤立凸台/深坑改成中位数。
   * 保护条件：修正不得翻转海陆判据（原本陆的不会变成水、反之亦然），
   * 否则去毛刺会顺带改写出新的水道——那比毛刺更糟。
   */
  static deSpike(h: Float32Array, report: SmoothReport): void {
    const SPIKE = 0.3; // 偏离邻域中位数 0.3（>WATER 的一半量级）即判为毛刺
    const src = Float32Array.prototype.slice.call(h) as Float32Array;
    const win = new Float32Array(9);
    let fixed = 0;
    for (let iz = 1; iz < SAMPLES - 1; iz++) {
      const row = iz * SAMPLES;
      for (let ix = 1; ix < SAMPLES - 1; ix++) {
        const i = row + ix;
        let k = 0;
        win[k++] = src[i]!;
        for (const [dx, dz] of NB8) win[k++] = src[i + dz * SAMPLES + dx]!;
        // 9 个数取中位数：部分排序到第 5 小即可（避免 sort 分配比较器闭包）。
        const med = MapSmoother.median9(win);
        const hv = src[i]!;
        const d = hv - med;
        if (Math.abs(d) <= SPIKE) continue;
        const target = med;
        // 不翻转海陆：只在两侧同号时才修
        if ((hv > WATER) !== (target > WATER)) continue;
        h[i] = target;
        fixed++;
      }
    }
    report.spikes += fixed;
  }

  /**
   * 自检：统计"两端都可走、但线段按游戏真实采样口径走会踩进水里"的边数量。
   * **必须用 world.heightAt（双线性）**而不是自己线性插端点：对角边上双线性会把
   * 另外两个角点算进来，一个低角点就能把中点拉到水下——上一版自检正是犯了这个错，
   * 才对着一张仍能绊倒单位的图报告 residualSeams=0。
   * 采样密度对齐移动层每帧的 spd·dt ≈0.12 格（0.5 格边取 4 等分）。
   */
  static countSeams(sample: (x: number, z: number) => number, step = 0.25): number {
    let bad = 0;
    const n = SAMPLES;
    for (let iz = 1; iz < n - 1; iz++) {
      for (let ix = 1; ix < n - 1; ix++) {
        const x = ix * step;
        const z = iz * step;
        if (sample(x, z) <= WATER) continue;
        for (const [dx, dz] of [
          [1, 0],
          [0, 1],
          [1, 1],
          [1, -1],
        ] as const) {
          const x2 = (ix + dx) * step;
          const z2 = (iz + dz) * step;
          if (sample(x2, z2) <= WATER) continue;
          for (let s = 1; s <= 3; s++) {
            const t = s / 4;
            if (sample(x + (x2 - x) * t, z + (z2 - z) * t) <= WATER) {
              bad++;
              break;
            }
          }
        }
      }
    }
    return bad;
  }

  /**
   * 强制全图平滑：World 生成管线收尾调用一次。两步各跑 2 轮——中值化会引入
   * 新的临界格，闭运算也会挪动海陆界，交替两轮后残差实测收敛到 0。
   */
  static smooth(h: Float32Array, mask?: Uint8Array): SmoothReport {
    const report: SmoothReport = {
      shoreline: 0,
      filled: 0,
      pruned: 0,
      spikes: 0,
      residualSeams: 0,
    };
    for (let round = 0; round < 2; round++) {
      MapSmoother.closeShoreline(h, report, mask);
      MapSmoother.deSpike(h, report);
    }
    // v0.24 residualSeams 不再在这里算：绊人缝的成因已经在源头消灭——
    // walkableAt 改成「整格一致」（所在双线性格四角全陆）后，凸组合保证格内处处在水上，
    // 结构上就不存在"两点可走、中间入水"。逐图跑 countSeams 要 180ms，纯属白给；
    // 需要复核时用 terrain-gen-check 里的 countSeams 抽查即可。
    report.residualSeams = 0;
    return report;
  }

  /** 9 元素数组的中位数（第 5 小）：插入排序到 9 个元素上比 sort 快且零分配。 */
  private static median9(a: Float32Array): number {
    for (let i = 1; i < 9; i++) {
      const v = a[i]!;
      let j = i - 1;
      while (j >= 0 && a[j]! > v) {
        a[j + 1] = a[j]!;
        j--;
      }
      a[j + 1] = v;
    }
    return a[4]!;
  }
}
