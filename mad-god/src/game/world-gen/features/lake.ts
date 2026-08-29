// v0.25 阶段 3 地貌特征：湖泊（契约的第二个特征实现，与山脉平级、互相独立）。
//
// 语义是"封闭洼地蓄水"：在最大连通陆域里挑**局部洼地**（中心比四周探针环低），
// 把洼地下刻成一只平底盘——床面压到 water 以下（游戏判水）、但不低于 seaH+0.01
// （生成器的 labels 仍判陆，管线中间不会错乱）。整片水面登记 MASK_CHANNEL，
// 收尾的海陆形态学闭运算才不会把它当"亚格水缺口"填平。
//
// 三个被约束逼出来的设计决定，改动前先看完：
// 1) **床面必须平底（rimStart≈0.62），不能照抄 carveBed 的单一 smoothFalloff 碗**。
//    smoothFalloff 从中心就开始回弹，湖面（h<water）半径只有满刻半径的 ~30%
//    （hv≈1.0、bed≈0.13 时，水面在 u≈0.30 处就出水上岸）：一座半径 3 格的"湖"
//    实际水面宽不到 2 格，正好踩进"水系宽度 ≥2 格"的红线，闭运算一跑就没了。
//    平底盘把水面半径顶到 ~0.7R——最小半径 2.8 格的湖水面直径也有 ~3.3 格，余量足。
// 2) **只挑内陆洼地，不贴海岸**。落点要求以（最大湖半径 + coastClear）为半径的一圈
//    16 方向全是主陆：湖整只装进大陆肚子里，外圈原地形（fillHeights 保证陆格 ≥0.49
//    > water）就是天然湖岸——"湖不连海、不切碎陆地"由构造保证，不需要事后修复。
// 3) **一切下刻、只降不升**：海格（h≤seaH）与非主陆格一概不碰。"不把海抬成陆"
//    与"不造新岛"两条硬不变量因此没有违反路径，不靠断言兜底。
//
// 与 clampSlope 的关系：湖床 ~0.1 对周围 1~2 的原地形，缓坡带宽度
// (1-rimStart)·R ≈ 0.9~1.7 格，坡度与全图 1.6/格的上限同量级——最陡的组合
// （高地深洼）会被削掉一点湖缘，表现为岸线外推半格，湖不会消失：
// 平底带宽 ≥0.62·R ≈ 1.5 格，clamp 的侵蚀深度 ≤ ~1.2 格吃不完平底。

import {
  MASK_CHANNEL,
  distToStartCells,
  isMainland,
  mesaProfile,
  sidx,
  type FeatureEnv,
  type FeatureStat,
  type TerrainFeature,
} from "../terrain-features";

/** 湖泊配置。长度一律用"格"，不含采样数——采样密度改了不用回来改这里。 */
export interface LakeConfig {
  /** 每张图的湖数区间（规格允许 2~5；lakePlanFor 按模板收窄）。 */
  count: [number, number];
  /** 湖盆半径（格）：满刻平底盘的半径，水面约为它的 0.7 倍。 */
  radius: [number, number];
  /** 湖床高程区间（绝对高度），必须 ∈ (seaH, water)；apply 内还会按 env 再夹一次。 */
  bed: [number, number];
  /** 距双方出生点的最小距离（格）。山脉是 8；湖面不可通行、比山更挡路，给 9。 */
  minStartDist: number;
  /** 距图边的最小距离（格）。 */
  margin: number;
  /** 湖缘到海的净空（格）：叠加在最大湖半径之上，落点四周这一圈必须全是主陆。 */
  coastClear: number;
  /** 平底占比：u ≤ rimStart 为满刻床面，之外以 C1 缓坡升回原地形（与台地同一条剖面）。 */
  rimStart: number;
  /** 岸线半径扰动幅度（比例）：R(θ) = r·(1 + wobble·(0.65n₁+0.35n₂))。 */
  wobble: number;
  /** 两湖中心最小间距 = rA + rB + gap（格），保证彼此分离、不成"糊的大水塘"。 */
  gap: number;
  /** 洼地探针半径（格）：中心比这一圈的均值低才算洼地（与湖半径同量级）。 */
  probe: number;
  /** 严格洼地判据：环均值 − 中心 ≥ 该值。第二档放宽扫描见 apply。 */
  minBowl: number;
  /** 候选池大小：扫描阶段空间去薄后的上限——池内任意两点都能同时成湖。 */
  pool: number;
}

/** 默认配置。值的来历逐条写在 lakePlanFor 与各使用处注释里。 */
export const LAKE_DEFAULTS: LakeConfig = {
  count: [2, 5],
  radius: [2.8, 4.6],
  bed: [0.1, 0.15],
  minStartDist: 9,
  margin: 5,
  coastClear: 2.0,
  rimStart: 0.62,
  wobble: 0.15,
  gap: 2.5,
  probe: 4.2,
  minBowl: 0.03,
  pool: 96,
};

/**
 * 按模板的起伏参数决定"这张图放几个湖、放多大"。
 * 与山脉的语义正好相反：山是起伏大才多，湖是**平地才多**——
 * 平坦/环礁模板（mw·rs≈0）给到 4~5 个，highlands（mw·rs≈1）收到 2 个：
 * 高地图的洼地本身又少又深，再撒 5 个湖会把本就紧张的可建地吃得更狠。
 * 纯函数、不消耗随机数——保证这里的分支不会改变同 seed 的抽取顺序。
 */
export function lakePlanFor(mw: number, rs: number): LakeConfig {
  const weight = Math.min(1, Math.max(0, mw * rs));
  const base = LAKE_DEFAULTS;
  const n = 2 + Math.round((1 - weight) * 3); // 2..5
  return {
    ...base,
    count: [Math.max(base.count[0], n - 1), Math.min(base.count[1], n)],
    // 高地图的湖收窄一号：深山里的大湖视觉突兀，也更容易切掉山脚的可建地
    radius: [
      base.radius[0],
      base.radius[0] + (base.radius[1] - base.radius[0]) * (1 - 0.4 * weight),
    ],
  };
}

/** 洼地候选：位置 + "环均值比中心低多少"的得分。 */
interface Depression {
  ix: number;
  iz: number;
  score: number;
}

/** 内陆净空环的 16 个方向（每 22.5° 一个）：面积型地物比山脉的 8 向更严一圈。 */
const RING16: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0.9239, 0.3827],
  [0.7071, 0.7071],
  [0.3827, 0.9239],
  [0, 1],
  [-0.3827, 0.9239],
  [-0.7071, 0.7071],
  [-0.9239, 0.3827],
  [-1, 0],
  [-0.9239, -0.3827],
  [-0.7071, -0.7071],
  [-0.3827, -0.9239],
  [0, -1],
  [0.3827, -0.9239],
  [0.7071, -0.7071],
  [0.9239, -0.3827],
];

/** 洼地探针环的 8 个罗盘方向。 */
const PROBE8: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.7071, 0.7071],
  [0.7071, -0.7071],
  [-0.7071, 0.7071],
  [-0.7071, -0.7071],
];

/**
 * 全图扫一遍洼地候选：主陆 + 距出生点够远 + 内陆净空环全主陆 + 得分 ≥ minBowl。
 * 不消耗随机数（洗牌在 apply 里做），按得分降序取前 cfg.pool 个。
 * 稳定排序 + 固定扫描序：同 seed 必得同一批候选，确定性不受排序实现影响。
 */
function scanDepressions(env: FeatureEnv, cfg: LakeConfig, minBowl: number): Depression[] {
  const marginS = Math.round(cfg.margin / env.step);
  const probeS = Math.max(1, Math.round(cfg.probe / env.step));
  // 净空半径按"最大湖半径（含岸线扰动上限）+ 海岸净空"算，湖整只装进大陆肚子里
  const clearS = (cfg.radius[1] * (1 + cfg.wobble) + cfg.coastClear) / env.step;
  const out: Depression[] = [];
  for (let iz = marginS; iz < env.samples - marginS; iz++) {
    for (let ix = marginS; ix < env.samples - marginS; ix++) {
      if (!isMainland(env, ix, iz)) continue;
      if (distToStartCells(env, ix, iz) < cfg.minStartDist) continue;
      let inland = true;
      for (const [dx, dz] of RING16) {
        if (!isMainland(env, Math.round(ix + dx * clearS), Math.round(iz + dz * clearS))) {
          inland = false;
          break;
        }
      }
      if (!inland) continue;
      // 洼地得分：探针环均值 − 中心。环上出现非主陆格直接弃——那种"洼地"多半是海向斜坡
      let sum = 0;
      let cnt = 0;
      let ringOk = true;
      for (const [dx, dz] of PROBE8) {
        const jx = Math.round(ix + dx * probeS);
        const jz = Math.round(iz + dz * probeS);
        if (!isMainland(env, jx, jz)) {
          ringOk = false;
          break;
        }
        sum += env.h[sidx(env, jx, jz)]!;
        cnt++;
      }
      if (!ringOk || cnt === 0) continue;
      const score = sum / cnt - env.h[sidx(env, ix, iz)]!;
      if (score < minBowl) continue;
      out.push({ ix, iz, score });
    }
  }
  out.sort((a, b) => b.score - a.score);
  // 空间去薄：按得分从高到低，只保留互相离得足够远（≥ 最小可能湖间距）的候选。
  // 不去薄的话 top-N 会全挤在同一个最深盆里——实测合成图上 96 个候选缩在 3 处
  // 显式洼地内，apply 的间距判据筛掉一大半，flat 模板想要 4~5 个湖只放下 1~2 个。
  // 去薄距离取 2·rMin + gap（贪心间距判据的最小可能值）：池内任意两点都有机会同时成湖。
  const thinS = (2 * cfg.radius[0] + cfg.gap) / env.step;
  const kept: Depression[] = [];
  for (const c of out) {
    let ok = true;
    for (const k of kept) {
      if (Math.hypot(c.ix - k.ix, c.iz - k.iz) < thinS) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    kept.push(c);
    if (kept.length >= cfg.pool) break;
  }
  return kept;
}

/**
 * 刻一只湖：平底床面（u ≤ rimStart 满刻到 bed）+ C1 缓坡缘（升回原地形）。
 * 岸线有机化的做法：在单位圆上采两条不同角频率的噪声（θ=0 与 2π 是同一个采样点，
 * 曲线自然闭合），1.9 给大弯、3.7 给犬牙——比一个噪声圆更不像尺规图。
 * 只降不升；床面下限 seaH+0.01；非主陆格与海格一概不碰；水面（<water）登记 MASK_CHANNEL。
 * 返回改写的采样格数。
 */
function carveLake(
  env: FeatureEnv,
  cx: number,
  cz: number,
  rS: number,
  bed: number,
  rimStart: number,
  wobble: number,
): number {
  const phA = env.rng.float(0, 128);
  const phB = env.rng.float(0, 128);
  const phC = env.rng.float(0, 128);
  const phD = env.rng.float(0, 128);
  const maxRS = rS * (1 + wobble); // 扰动只会放大半径（下限见 R 的另一侧），包围盒按上限取
  const r = Math.ceil(maxRS) + 1;
  const x0 = Math.max(0, cx - r);
  const x1 = Math.min(env.samples - 1, cx + r);
  const z0 = Math.max(0, cz - r);
  const z1 = Math.min(env.samples - 1, cz + r);
  let touched = 0;
  for (let iz = z0; iz <= z1; iz++) {
    for (let ix = x0; ix <= x1; ix++) {
      const dx = ix - cx;
      const dz = iz - cz;
      const d = Math.hypot(dx, dz);
      if (d > maxRS) continue;
      const th = Math.atan2(dz, dx);
      const n1 = env.noise.noise2D(Math.cos(th) * 1.9 + phA, Math.sin(th) * 1.9 + phB);
      const n2 = env.noise.noise2D(Math.cos(th) * 3.7 + phC, Math.sin(th) * 3.7 + phD);
      const R = rS * (1 + wobble * (0.65 * n1 + 0.35 * n2));
      if (d >= R) continue;
      if (!isMainland(env, ix, iz)) continue; // 不碰海、不碰卫星岛：湖只长在主陆上
      const i = sidx(env, ix, iz);
      const hv = env.h[i]!;
      const u = d / R;
      const inv = 1 - mesaProfile(u, rimStart); // 0（平底）→ 1（缘外原地形）
      const want = bed + (hv - bed) * inv;
      const nv = Math.max(env.seaH + 0.01, Math.min(hv, want)); // 只降不升，床面 ≥ seaH+0.01
      if (nv === hv) continue;
      env.h[i] = nv;
      if (nv < env.water) env.mask[i] = (env.mask[i] | MASK_CHANNEL) >>> 0;
      touched++;
    }
  }
  return touched;
}

/** 在洼地里蓄湖。实现 TerrainFeature，也可单独 new 出来做单元测试。 */
export class Lake implements TerrainFeature {
  readonly id = "lake";
  private readonly cfg: LakeConfig;

  constructor(cfg: Partial<LakeConfig> = {}) {
    this.cfg = { ...LAKE_DEFAULTS, ...cfg };
  }

  apply(env: FeatureEnv): FeatureStat {
    const cfg = this.cfg;
    const want = env.rng.int(cfg.count[0], cfg.count[1]);
    let cands = scanDepressions(env, cfg, cfg.minBowl);
    // 放宽档：全图凑不齐 8 处"严格洼地"（极平的模板可能出现）时退而求其次，
    // 接受"不比周围高太多"的点——宁可湖落在缓坡上，也不让特征整场空转。
    if (cands.length < 8) cands = scanDepressions(env, cfg, -0.3);
    if (cands.length === 0) return { id: this.id, placed: 0, cells: 0, note: "无合格洼地" };
    // Fisher-Yates 洗牌只走 env.rng：同候选池同 seed 必得同序
    for (let i = cands.length - 1; i > 0; i--) {
      const j = env.rng.int(0, i);
      const t = cands[i]!;
      cands[i] = cands[j]!;
      cands[j] = t;
    }
    const gapS = cfg.gap / env.step;
    const lakes: { cx: number; cz: number; rS: number }[] = [];
    let placed = 0;
    let cells = 0;
    for (const c of cands) {
      if (placed >= want) break;
      const rCells = env.rng.float(cfg.radius[0], cfg.radius[1]);
      const rS = rCells / env.step;
      // 间距判据用"两湖满刻半径之和 + gap"：扰动只会放大半径，最多再吃掉
      // 0.15·(rA+rB) ≈ 1.4 格，两湖之间仍留 ≥1 格的陆地——4 邻接必然分离
      let fits = true;
      for (const L of lakes) {
        if (Math.hypot(c.ix - L.cx, c.iz - L.cz) < L.rS + rS + gapS) {
          fits = false;
          break;
        }
      }
      if (!fits) continue;
      // 床面按 env 的实际水位再夹一次：配置写的是绝对高程，防的是判据常量改动后失配
      const bed = Math.min(
        env.water - 0.02,
        Math.max(env.seaH + 0.02, env.rng.float(cfg.bed[0], cfg.bed[1])),
      );
      cells += carveLake(env, c.ix, c.iz, rS, bed, cfg.rimStart, cfg.wobble);
      lakes.push({ cx: c.ix, cz: c.iz, rS });
      placed++;
    }
    const note =
      placed < want ? `${placed}/${want}，合格洼地不足或被间距筛掉` : `${placed} 处洼地`;
    return { id: this.id, placed, cells, note };
  }
}
