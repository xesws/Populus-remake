// v0.25 阶段 2/3 地貌特征：台地/高原（与山脉平级、互相独立的第二个具名地物）。
//
// 语义是"顶面平、四边是坡"的高地：顶面是一块能跑兵、能盖楼的平地，边缘是
// 爬上去很费劲的长坡。它和山脉（mountain-range.ts 的连贯山脊 + 雪峰）的分工是
// **层次**而不是"更高"——顶面目标落在 render.ts 的岩带（2.6 起）到雪线（4.2）之间，
// 雪顶留给山脉，台地永远矮山脉一头，这样两张特征叠加才读得出"山—台—原"的三级台阶。
//
// 实现要点（每条都有契约依据或实测教训，改参数前先读完）：
//
// 1) 用 raiseTo（抬到**绝对高程**）而不是 stamp（加固定量）：噪声基底在 1.0~3.0
//    之间晃，加固定量会得到一高一低两只"鼓包"，"平顶"语义直接丢失（契约 raiseTo
//    注释里写明的教训，山脉同源）。mesaProfile 在 u ≤ rimStart 处 p=1，raiseTo 会把
//    每格精确写到 targetH——平顶是**精确**的，不是"差不多平"。
// 2) 边缘坡必须给 clampSlope 留水平距离：管线尾部把高差钳到 0.40/采样 ≈ 1.6/格，
//    全图生效、不会为台地开特例。台地的下降全部发生在 rim（rimStart→1 的环形带）里；
//    若顶面高差 ΔH 需要的爬坡距离 ΔH/1.6 超过 rim 宽度 (1-rimStart)·R，clampSlope
//    会把削坡"吃"进平顶——顶不再平，还往外摊一圈裙边。所以每块台地落位时**实测
//    本地基底高度**，把顶面压进 baseH + slopeSurvive·(1-rimStart)·R
//    （slopeSurvive = 1.36 = 0.85×1.6，留 15% 余量给基底自身的起伏）。
//    只裁"本块目标"，不裁配置区间——同一张图上大台地可以比小台地高，是自然的层次。
// 3) rimStart 限制在 0.55~0.70：太大（如 0.85）rim 太窄成陡坎，被 clampSlope 削成
//    "溜边"；太小则平顶只剩小圆盖，"上面能跑兵"没了。R=4~8 格时平顶半径有
//    2.2~5.6 格（顶面面积 ≥6 格² 的验收口径由此而来）。
// 4) 台地不压山：足迹内已有 MASK_PEAK 且高出"本台地顶面 + 群内抖动余量"的山体格
//    → 放弃该落点。台地叠在山顶上会把山削成"平顶山"，破坏山脉特征的层次。
//    反过来，已有的台地/矮于本块的山可以叠——这正是"高原群"的来源。
// 5) 群（cluster）：一块主台地，rng 再决定是否叠一块邻居块，中心距 0.5~0.8×(r1+r2)、
//    顶面挂在主块 ±topJitter。两块近等高的平顶连成一片，玩家读到的是"一片高原"；
//    若不锁顶面高差，叠出来就是随机山包，失去"平顶"语义（规格明确要求）。
// 6) 落点与山脉同源的两条教训：腹地判据**逐档降级**（room → room/2 → 0，twinlands
//    这类图"四周 7 格全是主陆"的点可能不存在，卡死一档会让整个特征空转）；
//    避出生点比山脉更严——台地半径可达 8 格，只查中心距 8 格的话平顶会直接盖到
//    基地头上（山脉峰头半径 ≤5.2 只查中心距也留了 2.7 格余量），所以这里要求
//    **中心距 ≥ minStartDist + 本块半径**，保证整个 rim 都在基地保护圈之外。
// 7) 出海保护由 raiseTo 内置（h ≤ seaH 的格直接跳过）：贴岸台地会被削成临海陡崖，
//    这比"往海里造陆"（凭空造岛、破坏单连通）安全得多；但足迹陆地占比 < 0.6 时
//    干脆不落——多半悬在海岸上，削出来不是台地是一段残月。

import {
  MASK_PEAK,
  distToStartCells,
  isMainland,
  mesaProfile,
  raiseTo,
  sidx,
  type FeatureEnv,
  type FeatureStat,
  type TerrainFeature,
} from "../terrain-features";

/** 台地配置。长度单位一律"格"（不含采样数）——采样密度改了不用回来改这里。 */
export interface PlateauConfig {
  /** 每张图的台地群数区间（一群 = 1~2 块可叠的台地）。 */
  clusters: [number, number];
  /** 每群的块数区间（抽到 2 = 叠一块邻居，构成"高原群"）。 */
  blocks: [number, number];
  /** 单块半径（格）。下界 4：clampSlope 1.6/格 下再小的圆装不下 ≥1.6 的爬坡量。 */
  radius: [number, number];
  /** 顶面目标高程区间（绝对高度）。默认上限 4.1 压在雪线 4.2 之下——雪顶是山脉的层次。 */
  top: [number, number];
  /** mesaProfile 的 rimStart 抽样区间（顶面半径占比）。上界 0.70 防陡坎，见文件头 3。 */
  rimStart: [number, number];
  /** 群内叠块的顶面高差上限：再大就不是"一片高原"而是两只山包。 */
  topJitter: number;
  /** 顶面比本地基底至少高这么多，否则不成"台"（也是"边缘是坡"验收的下界来源）。 */
  minLift: number;
  /** 爬坡预算系数：0.85 × clampSlope 的 1.6/格，见文件头 2。 */
  slopeSurvive: number;
  /** 台地**中心**距双方出生点的最小距离（格）；实际要求再叠加本块半径。 */
  minStartDist: number;
  /** 落点四周要求这么多格半径内都是主陆（"有腹地"），从严到宽逐档降级用。 */
  room: number;
  /** 距图边的最小距离（格），另加本块半径。 */
  margin: number;
  /** 每档腹地要求下的取点尝试次数（取不到合法落点就降档/放弃这一群）。 */
  tries: number;
}

/** 默认配置。各值的来历见文件头 1~7 与各字段注释。 */
export const PLATEAU_DEFAULTS: PlateauConfig = {
  clusters: [1, 3],
  blocks: [1, 2],
  radius: [4, 8],
  top: [3.0, 4.1],
  rimStart: [0.55, 0.7],
  topJitter: 0.3,
  minLift: 1.6,
  slopeSurvive: 1.36,
  minStartDist: 8,
  room: 7,
  margin: 5,
  tries: 240,
};

/**
 * 按模板的起伏参数决定"这张图放几群台地、顶面放到多高"。
 * 与 mountainPlanFor 同一套语义：mountainWeight×reliefScale 是地物密度的来源——
 * highlands（mw×rs = 1.35 → weight 1）给 3~4 群、顶面最高 5.5；
 * 基础模板（mw ∈ 0.2~0.4、rs = 1 → weight ≤ 0.4）给 1~2 群、顶面上限压在雪线下。
 * 纯函数、不消耗随机数——保证这里的分支不会改变同 seed 的抽取顺序。
 *
 * 已知边界：mw×rs 区分不开 continent 与 archipelago（两模板同在 0.2~0.4），
 * "群岛图更少"这层语义需要上层把模板 id（或陆地占比）传进来才能做，契约目前只有两个标量。
 */
export function plateauPlanFor(mw: number, rs: number): PlateauConfig {
  const weight = Math.min(1, Math.max(0, mw * rs));
  const base = PLATEAU_DEFAULTS;
  const n = 1 + Math.round(weight * 1.6); // 1..3 群
  return {
    ...base,
    clusters: [n, Math.min(4, n + (weight > 0.6 ? 1 : 0))],
    // 顶面上限：weight ≤ 0.45（全部基础模板）保持默认 4.1（雪线 4.2 之下）；
    // weight ≥ 0.45 线性放到 5.5（目前只有 highlands 到 1），仍矮于山脉雪峰的 7.2。
    top: [base.top[0], base.top[1] + 1.4 * Math.max(0, (weight - 0.45) / 0.55)],
  };
}

/** 一块落地台地的明细（cx/cz 为采样坐标），apply 后留在 lastBlocks 供日志与测试断言。 */
export interface PlateauBlock {
  readonly cx: number;
  readonly cz: number;
  /** 半径（格）。 */
  readonly rCells: number;
  /** 本块的 rimStart。 */
  readonly rimStart: number;
  /** 实际顶面高程（已过爬坡预算与基底下限的裁剪）。 */
  readonly top: number;
}

/** 台地/高原。实现 TerrainFeature，也可单独 new 出来做单元测试。 */
export class Plateau implements TerrainFeature {
  readonly id = "plateau";
  private readonly cfg: PlateauConfig;
  /** 最近一次 apply 的落位摘要（进 FeatureStat.note，日志与测试都能看到"为什么没放上"）。 */
  private lastNote = "";
  /** 最近一次 apply 落地的块（每群 1~2 块，含主块与叠块）。 */
  readonly lastBlocks: PlateauBlock[] = [];

  constructor(cfg: Partial<PlateauConfig> = {}) {
    this.cfg = { ...PLATEAU_DEFAULTS, ...cfg };
  }

  apply(env: FeatureEnv): FeatureStat {
    const cfg = this.cfg;
    this.lastBlocks.length = 0;
    const nClusters = env.rng.int(cfg.clusters[0], cfg.clusters[1]);
    let placed = 0;
    let cells = 0;
    let gaveUp = 0;
    let neighbors = 0;
    for (let c = 0; c < nClusters; c++) {
      const main = this.pickCenter(env);
      if (main === null) {
        gaveUp++;
        continue;
      }
      placed++;
      this.lastBlocks.push(main);
      cells += this.carve(env, main);
      // 叠块与否每群独立抽一次：同 seed 下抽取次数固定，可复现不受落点成败影响
      if (env.rng.int(cfg.blocks[0], cfg.blocks[1]) > 1) {
        const nb = this.pickNeighbor(env, main);
        if (nb !== null) {
          neighbors++;
          this.lastBlocks.push(nb);
          cells += this.carve(env, nb);
        }
      }
    }
    this.lastNote = `群 ${placed}/${nClusters}（叠块 ${neighbors}）${gaveUp ? `，${gaveUp} 群无合法落点` : ""}`;
    return { id: this.id, placed, cells, note: this.lastNote };
  }

  /** 找一块主台地：几何判据（图边/腹地/避基地）→ 足迹判据（避山/基底/爬坡预算）。 */
  private pickCenter(env: FeatureEnv): PlateauBlock | null {
    const cfg = this.cfg;
    // 腹地从严到宽逐档放宽（room → room/2 → 0），与山脉 walk() 同一条教训：
    // 卡死最严一档时，蜂腰/环礁图可能一个落点都找不到，整个特征空转。
    const roomLevels = [
      Math.round(cfg.room / env.step),
      Math.round(cfg.room / 2 / env.step),
      0,
    ];
    for (const roomS of roomLevels) {
      for (let t = 0; t < cfg.tries; t++) {
        // 半径/rim/目标高程**每次尝试都重抽**：R=4 且 rimStart 靠上限时爬坡预算可能
        // 只有 (1.36·0.30·4)−1.6 ≈ 0.03 格的顶面窗口，一组参数抽死的块不该连累整个特征。
        const rCells = env.rng.float(cfg.radius[0], cfg.radius[1]);
        const rimStart = env.rng.float(cfg.rimStart[0], cfg.rimStart[1]);
        const target = env.rng.float(cfg.top[0], cfg.top[1]);
        const lim = Math.round((cfg.margin + rCells) / env.step);
        const ix = env.rng.int(lim, env.samples - 1 - lim);
        const iz = env.rng.int(lim, env.samples - 1 - lim);
        if (!hasRoomForPlateau(env, ix, iz, roomS)) continue;
        if (distToStartCells(env, ix, iz) < cfg.minStartDist + rCells) continue;
        const fit = this.footprintFit(env, ix, iz, rCells / env.step, rimStart, target, false);
        if (fit !== null) return fit;
      }
    }
    return null;
  }

  /**
   * 群内叠块：中心落在主块外 0.5~0.8×(r1+r2) 处（两块平顶部分重叠，连成一片高原），
   * 顶面挂在主块 ±topJitter。落点判据与主块一致（图边/主陆/避基地/足迹），
   * 但**免 minLift**：叠块的使命就是压在已有的顶面上，它的"基底"里天然混着主块顶面。
   */
  private pickNeighbor(env: FeatureEnv, main: PlateauBlock): PlateauBlock | null {
    const cfg = this.cfg;
    for (let t = 0; t < cfg.tries; t++) {
      const rCells = env.rng.float(cfg.radius[0], cfg.radius[1]) * 0.85; // 叠块略小，主次分明
      const rimStart = env.rng.float(cfg.rimStart[0], cfg.rimStart[1]);
      const target = Math.min(
        cfg.top[1],
        Math.max(cfg.top[0], main.top + env.rng.float(-cfg.topJitter, cfg.topJitter)),
      );
      const dir = env.rng.float(0, Math.PI * 2);
      const dist = env.rng.float(0.5, 0.8) * (main.rCells + rCells);
      const lim = Math.round((cfg.margin + rCells) / env.step);
      const ix = Math.round(main.cx + Math.cos(dir) * (dist / env.step));
      const iz = Math.round(main.cz + Math.sin(dir) * (dist / env.step));
      if (ix < lim || iz < lim || ix >= env.samples - lim || iz >= env.samples - lim) continue;
      if (!isMainland(env, ix, iz)) continue;
      if (distToStartCells(env, ix, iz) < cfg.minStartDist + rCells) continue;
      const fit = this.footprintFit(env, ix, iz, rCells / env.step, rimStart, target, true);
      // 爬坡预算可能把叠块顶面裁到主块顶面 ±topJitter 之外——那种"一大一小两只台阶"
      // 不是高原群，是随机山包，宁可不叠（规格第 5 条）。
      if (fit !== null && Math.abs(fit.top - main.top) <= cfg.topJitter + 1e-6) return fit;
    }
    return null;
  }

  /**
   * 足迹判据（一次圆扫描同时算三件事，避免同足迹扫多遍）：
   *  a) 本地基底 baseH = 足迹内**主陆格**的平均高度（海格不算，贴岸台地不被低估）；
   *     陆地占比 < 0.6 直接拒——悬在海岸上的台地会被 raiseTo 削成残月（见文件头 7）。
   *  b) 爬坡预算：top ≤ baseH + slopeSurvive·(1-rimStart)·R，且 lift ≥ minLift（主块）。
   *  c) 避山：足迹内最高的 MASK_PEAK 格若高出"本块顶面 + 群内抖动余量"，不落这里
   *     （余量 = topJitter + 0.2：允许踩上自家的旧顶面，不允许踩山脉的雪峰）。
   */
  private footprintFit(
    env: FeatureEnv,
    ix: number,
    iz: number,
    rS: number,
    rimStart: number,
    target: number,
    isNeighbor: boolean,
  ): PlateauBlock | null {
    const cfg = this.cfg;
    const r = Math.max(1, Math.ceil(rS));
    let sum = 0;
    let land = 0;
    let circle = 0;
    let maxPeak = 0;
    for (let dz = -r; dz <= r; dz++) {
      const z = iz + dz;
      if (z < 0 || z >= env.samples) continue;
      for (let dx = -r; dx <= r; dx++) {
        const x = ix + dx;
        if (x < 0 || x >= env.samples) continue;
        if (Math.hypot(dx, dz) / rS >= 1) continue;
        circle++;
        const i = sidx(env, x, z);
        const hv = env.h[i]!;
        if (hv <= env.seaH) continue;
        sum += hv;
        land++;
        if ((env.mask[i]! & MASK_PEAK) !== 0 && hv > maxPeak) maxPeak = hv;
      }
    }
    if (land === 0 || land / circle < 0.6) return null;
    const baseH = sum / land;
    const top = Math.min(target, baseH + cfg.slopeSurvive * (1 - rimStart) * (rS * env.step));
    if (top < cfg.top[0]) return null; // 爬坡预算裁完连岩带 2.6 之上的目标都够不着
    if (!isNeighbor && top - baseH < cfg.minLift) return null; // 太矮不成"台"
    if (maxPeak > top + cfg.topJitter + 0.2) return null; // 会把更高的山削平
    return { cx: ix, cz: iz, rCells: rS * env.step, rimStart, top };
  }

  /** 落一块台地：mesaProfile + raiseTo（绝对高程），登记 MASK_PEAK。 */
  private carve(env: FeatureEnv, b: PlateauBlock): number {
    return raiseTo(
      env,
      b.cx,
      b.cz,
      b.rCells / env.step,
      b.top,
      (u) => mesaProfile(u, b.rimStart),
      MASK_PEAK,
    );
  }
}

/**
 * 与山脉同款的"有腹地"判据（本地实现而非 import：特征文件之间互相独立、可单独集成，
 * 这也是 AGENTS.md separable 要求的落点）。圆心与 8 个罗盘方向 reach 采样处都必须是主陆。
 */
export function hasRoomForPlateau(env: FeatureEnv, ix: number, iz: number, reach: number): boolean {
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
