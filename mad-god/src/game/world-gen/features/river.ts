// v0.25 阶段 3 地貌特征：河流（与山脉平级的独立实现，登记 MASK_CHANNEL）。
//
// 做法仍是"放置具名地物"而不是调噪声：在主陆高地上选一个源头，做一步看 8 邻的
// 顺坡 flow-trace 一直走到海岸，再用契约的 carveBed 沿流径刻出河床。
// "一条从山脊淌到海里的河"是玩家一眼能认出的结构，连续噪声给不了。
//
// 本文件所有"看起来绕"的写法都是被实测逼出来的，改参数前先看完：
//
// 1) **水面宽度必须用几何控制，不能用趟数控制**。carveBed 的单程剖面是
//    targetH + gap·f(u)（f=smoothFalloff），u→1 处 f→1，是一条中心深的抛物线沟：
//    "离中心线 ±1 格也要压到水位以下"靠单趟需要 10 格以上半径，不可行。
//    第一版按"同折线复刻 k 趟、k 随窗内高差自适应"做——结果全糊：carveBed 沿折线
//    每 0.75 采样放一个 stamp，同一格会被**十几个 stamp 串行连乘** f(u)，
//    单趟的有效 flattening 是 f(u)^m 而不是 f(u)；复刻几趟后**整个圆盘**都被压到
//    水位以下，实测水面带宽≈圆盘全宽（源头 2.4 格半径刻出 4.5 格宽的水带，
//    中段 2.5 格盘内 99% 是水，河糊成湖）。教训：趟数对"深"是超线性杠杆，
//    对"宽"失控。现在水面宽度改由**平行水线**钉死：沿路径法向铺一排间距 0.5 格的
//    平行折线（铺到 ±bandSource→±bandMouth），每条线把它路过的格子直接带到床面高
//    （线上格子到最近 stamp 的 u≈0，一次就到 targetH），水面带宽 ≈ 2·B+1 格
//    （外线圆盘的边缘在低地上也会入水），纯几何、与地形高度无关：
//    实测源头 ~3.25 格、河口 ~3.75 格、沿程单调加宽（feature-river-check 逐点量得），
//    下限 2 格由 bandSource=1.15 ≥ 1 格直接保证。
// 2) **两端的 smoothFalloff 收口**。carveBed 每次调用都会在折线前后 1/4 收窄到 0，
//    整条河一次调用刻完 → 源头前 1/4 与河口前 1/4 全是细脖，闭运算一吃一个准。
//    解法是**分窗 + 半窗跨步重叠**：窗长 8 格、跨步 4 格，任意点都落在某扇窗的
//    [0.25, 0.8125] 满幅区间（相邻两窗给出的 along 恒差 0.5，必有一边落在满幅区）；
//    carving 只降不升，重叠窗的收口部分只会多刻不会少刻，取最小值即满幅窗的结果。
//    唯一刻不满幅的是真实源头前的 2 格（0.25×8 格）——那正好是"泉眼收细"的形态，
//    检查脚本从源头 2 格之后才开始断言宽度。
// 3) **河口会被端点收口掐细**。所以流径末端沿出流方向再垫一段进海里（seaPad，
//    默认 4.5 格，向上取整到窗跨步的倍数保持网格对齐），让真正的海岸点落进满幅区，
//    河口呈展开的喇叭口而不是漏斗。垫段会刻到海格上——见下一条。
// 4) **carveBed 会把纯海格抬离海基准**：海格 h=0.04 < floor=seaH+0.01，
//    nv=max(floor, min(hv, want)) 会把它抬到 0.05 > seaH，按生成器判据就成了"陆"。
//    "任何情况下不许把海格抬成陆格"是硬契约，所以 apply 开头做一次 h 快照
//    （山脉不需要快照：raiseTo 天生跳过海格且返回值即落点数；河床的多窗多线会让
//    返回值重复计数，快照顺便承担 cells 的去重计数），每条河刻完把海格精确还原。
// 5) **凹坑与死循环**：flow-trace 用 visited 防环；8 邻全走不了（凹坑/被已有河道
//    围死/进出生点禁区）就放弃这条河（placed 不计），绝不原地打转。
//    已有河道的格子对 trace 视为障碍——两条河并流汇进同一条谷会糊成一片，
//    "多条河不重叠成一片糊水"是本特征的验收项。
// 6) **河谷单趟**：水线只保证水面，平底水槽在高地上是一道悬崖——管线尾部的
//    clampSlope 要从床缘开始搬土把它削平，而 MASK_CHANNEL 只保护床面本身。
//    所以每窗再用宽半径（widthSource→widthMouth）单趟把两侧预先削出谷坡，
//    目标高 water+valleyAbove（高于水位，只造坡不造水；carveBed 的 min(hv,want)
//    语义保证低于目标高的格子一律不动，不会额外加宽水面）。

import {
  MASK_CHANNEL,
  carveBed,
  distToStartCells,
  isMainland,
  sidx,
  type FeatureEnv,
  type FeatureStat,
  type TerrainFeature,
} from "../terrain-features";

/** 一条已落地河流的流径明细（采样下标），apply 后留在实例上供日志与检查脚本取用。 */
export interface RiverPath {
  /** 流径采样点下标序列（含源头与入海点；不含向海垫段）。 */
  readonly ix: readonly number[];
  readonly iz: readonly number[];
  /** 源头在雕刻前的高度（断言"从高处起河"用）。 */
  readonly srcH: number;
}

/** 河流配置。长度一律用"格"，不含采样数——采样密度改了也不用回来改这里。 */
export interface RiverConfig {
  /** 每张图尝试放置的河流条数区间（放不满不算失败，见 FeatureStat.note）。 */
  rivers: [number, number];
  /** 源头最低高度：低于它的格子没资格当源头（"从高地起河"）。 */
  sourceH: number;
  /** 源头抽样次数：抽不出合规源头就少放一条。 */
  tries: number;
  /** 源头距双方出生点的最小距离（格）。 */
  minStartDist: number;
  /** 流径中心线距出生点的最小距离（格）：河可以流经基地附近，但不能把基地泡进河里。
   *  取 5 = 河床半径上限 3 + 2 格滩地余量；违反即整条放弃（河没法"跳过"基地）。 */
  keepStartDist: number;
  /** 流径最大长度（格）：走完仍入不了海就放弃（防平坦图上的无限蜿蜒）。 */
  maxLenCells: number;
  /** 流径最小长度（格）：短于此说明源头贴着海岸，不值得刻。 */
  minLenCells: number;
  /** 源头水面半宽（格）：平行水线铺到 ±bandSource，水面带宽 ≈ 2×bandSource+1
   *  （+1 来自外线圆盘边缘在低地上也入水；实测源头 3.25 格）。
   *  必须 ≥1：硬契约"水面宽 ≥2 格"的下限就由它保证（几何保证，见文件头第 1 条）。 */
  bandSource: number;
  /** 河口水面半宽（格）：下游水面更宽。 */
  bandMouth: number;
  /** 平行水线间距（格）：0.5 保证相邻水线的入水核彼此衔接不留干格。 */
  lineSpacing: number;
  /** 单条水线的刻痕半径（格）：比 lineSpacing 大一档，弯道处法向错位也不留缺口。 */
  lineW: number;
  /** 每条水线的复刻趟数：线上格子一趟即到床面高，2 趟兜住高差极大的源头。 */
  linePasses: number;
  /** 河谷半径梯度：源头半径（格）。河谷只造坡不造水（文件头第 6 条）。 */
  widthSource: number;
  /** 河谷半径梯度：河口半径（格），连同 bandMouth 一起构成"下宽上窄"。 */
  widthMouth: number;
  /** 河谷半径硬下限（格）：不能小于水面半宽，否则谷坡整个泡在水里。 */
  minWidth: number;
  /** 河谷单趟的目标高相对水位的抬升：谷坡刻到 water+0.45（默认 0.65）。 */
  valleyAbove: number;
  /** 河床目标高相对 seaH 的偏移：bedH = clamp(seaH+bedOffset, …, water−0.02)。
   *  默认 0.02 → bedH=0.06，落在 (seaH, water) 之内：游戏判水、生成器 labels 判陆。 */
  bedOffset: number;
  /** 流向噪声抖动幅度（高度单位）：纯贪心会走出笔直的台阶对角线。 */
  jitterAmp: number;
  /** 流向噪声频率（每格）：低频才叫"蜿蜒"，高频就是碎抖（且会把河引进凹坑）。 */
  jitterFreq: number;
  /** 河口向海垫段长度（格，向上取整到窗跨步倍数）。 */
  seaPadCells: number;
  /** 分窗刻河的窗长（格）：窗端收口区 = 窗长×0.25，与断言区间直接相关。 */
  windowCells: number;
}

/** 默认配置。水面宽度由 bandSource/bandMouth + lineSpacing/lineW 钉死，
 *  河谷大小由 widthSource/widthMouth 决定；两组不要混着调（见文件头第 1/6 条）。 */
export const RIVER_DEFAULTS: RiverConfig = {
  rivers: [2, 3],
  sourceH: 2.4,
  tries: 240,
  minStartDist: 7,
  keepStartDist: 5,
  maxLenCells: 38,
  minLenCells: 5,
  bandSource: 1.15,
  bandMouth: 1.5,
  lineSpacing: 0.5,
  lineW: 0.75,
  linePasses: 2,
  widthSource: 1.5,
  widthMouth: 3.0,
  minWidth: 2.0,
  valleyAbove: 0.45,
  bedOffset: 0.02,
  jitterAmp: 0.45,
  jitterFreq: 0.05,
  seaPadCells: 4.5,
  windowCells: 8,
};

/**
 * 按模板的起伏参数决定"这张图放几条河、源头多高、允许流多长"。
 * 山地图（mw×rs→1）：河**多而短**——等高线密，源头离海近，长河会在山里绕死；
 * 平坦图（→0）：河**少而长而缓**——地势平，河要流很远才到海（"缓"是高度场的涌现
 * 性质，不需要也不应该在这里硬造坡度）。平坦图的源头判据必须同步放低，
 * 否则全图够不着 sourceH，一条河都放不出来（和山脉的 room 降级是同一类教训）。
 * 纯函数、不消耗随机数——保证这里的分支不会改变同 seed 的抽取顺序。
 */
export function riverPlanFor(mw: number, rs: number): RiverConfig {
  const weight = Math.min(1, Math.max(0, mw * rs));
  const base = RIVER_DEFAULTS;
  const n = 1 + Math.round(1.6 * weight); // 1..3 条
  return {
    ...base,
    rivers: [n, Math.min(4, n + 1)],
    sourceH: 1.5 + 1.3 * weight,
    maxLenCells: Math.round(42 - 12 * weight),
  };
}

/** 8 邻方向（4 正 + 4 斜）。 */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** 顺坡 flow-trace + 分窗刻床。实现 TerrainFeature，也可单独 new 出来做单元测试。 */
export class River implements TerrainFeature {
  readonly id = "river";
  private readonly cfg: RiverConfig;
  /** 最近一次 apply 落地的流径（不做落地理由的记录，理由进 FeatureStat.note）。 */
  lastPaths: ReadonlyArray<RiverPath> = [];

  constructor(cfg: Partial<RiverConfig> = {}) {
    this.cfg = { ...RIVER_DEFAULTS, ...cfg };
  }

  apply(env: FeatureEnv): FeatureStat {
    this.lastPaths = [];
    const cfg = this.cfg;
    const nRivers = env.rng.int(cfg.rivers[0], cfg.rivers[1]);
    // 一次快照换两件事：刻后把被 carveBed 抬离海基准的海格精确还原（文件头第 4 条），
    // 以及 cells 的去重计数（多窗多线的返回值会重复计数）。
    const hSnap = env.h.slice();
    let placed = 0;
    const notes: string[] = [];
    const minLenS = Math.round(cfg.minLenCells / env.step);
    for (let r = 0; r < nRivers; r++) {
      const src = this.seekSource(env);
      if (!src) {
        notes.push(`${r + 1}:找不到合规源头`);
        continue;
      }
      const tr = this.trace(env, src);
      if (!tr.ok) {
        notes.push(`${r + 1}:${tr.why}`);
        continue;
      }
      if (tr.ix.length < minLenS + 1) {
        notes.push(`${r + 1}:源头贴海流径过短`);
        continue;
      }
      this.carve(env, tr.ix, tr.iz);
      this.restoreSea(env, hSnap);
      placed++;
      const s0 = sidx(env, tr.ix[0], tr.iz[0]);
      this.lastPaths = [
        ...this.lastPaths,
        { ix: tr.ix.slice(), iz: tr.iz.slice(), srcH: hSnap[s0] },
      ];
    }
    let cells = 0;
    for (let i = 0; i < env.h.length; i++) if (env.h[i] !== hSnap[i]) cells++;
    return { id: this.id, placed, cells, note: notes.length ? notes.join("；") : undefined };
  }

  /**
   * 选源头：随机抽样 → 主陆 + 高地 + 避出生点 + 避已有河道（半径 2 格），
   * 然后在**最高的前 1/4 候选里随机挑一个**。只挑最高会把所有河堆到同一个峰，
   * "好几条河都发源于同一座山顶"既不真也不好看；前 1/4 保证仍是高地，又留了分散度。
   */
  private seekSource(env: FeatureEnv): { ix: number; iz: number } | null {
    const cfg = this.cfg;
    const lim = Math.round(5 / env.step); // 与山脉同款 5 格图边距
    const chanR = Math.round(2 / env.step);
    const cands: { ix: number; iz: number; h: number }[] = [];
    for (let t = 0; t < cfg.tries; t++) {
      const ix = env.rng.int(lim, env.samples - 1 - lim);
      const iz = env.rng.int(lim, env.samples - 1 - lim);
      if (!isMainland(env, ix, iz)) continue;
      const i = sidx(env, ix, iz);
      if (env.h[i] < cfg.sourceH) continue;
      if (distToStartCells(env, ix, iz) < cfg.minStartDist) continue;
      if (this.nearChannel(env, ix, iz, chanR)) continue;
      cands.push({ ix, iz, h: env.h[i] });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.h - a.h);
    const pool = cands.slice(0, Math.max(1, Math.ceil(cands.length * 0.25)));
    const pick = env.rng.pick(pool);
    return { ix: pick.ix, iz: pick.iz };
  }

  /** (ix,iz) 半径 rS 采样内是否已有 CHANNEL 格（防新河源头直接落在旧河上）。 */
  private nearChannel(env: FeatureEnv, ix: number, iz: number, rS: number): boolean {
    const r = Math.ceil(rS);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const jx = ix + dx;
        const jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= env.samples || jz >= env.samples) continue;
        if ((env.mask[sidx(env, jx, jz)] & MASK_CHANNEL) !== 0) return true;
      }
    }
    return false;
  }

  /**
   * 顺坡 flow-trace：每步在 8 邻里选"高度 + 低频噪声抖动"最小者前进。
   * visited 防环；走到"当前格的 8 邻里有海/出主陆边界"即入海成功。
   * 以下情况整条放弃（不计数、不刻）：流进出生点禁区（河没法绕，只能不要这条）、
   * 8 邻全不可走（凹坑困死 / 被已有河道围死）、超出 maxLenCells 仍未入海。
   * 已有 CHANNEL 格对 trace 是障碍——并流汇谷 = 糊水。
   */
  private trace(
    env: FeatureEnv,
    src: { ix: number; iz: number },
  ): { ok: true; ix: number[]; iz: number[] } | { ok: false; why: string } {
    const cfg = this.cfg;
    const maxSteps = Math.round(cfg.maxLenCells / env.step);
    let cx = src.ix;
    let cz = src.iz;
    const px: number[] = [cx];
    const pz: number[] = [cz];
    const visited = new Set<number>([sidx(env, cx, cz)]);
    for (let step = 0; step <= maxSteps; step++) {
      if (distToStartCells(env, cx, cz) < cfg.keepStartDist) {
        return { ok: false, why: "流径进入出生点禁区" };
      }
      if (this.atCoast(env, cx, cz)) {
        return { ok: true, ix: px, iz: pz };
      }
      let bx = -1;
      let bz = -1;
      let best = Infinity;
      for (const [dx, dz] of DIRS) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= env.samples || nz >= env.samples) continue;
        if (!isMainland(env, nx, nz)) continue; // 海/别的岛：不可作为落脚点
        const j = sidx(env, nx, nz);
        if (visited.has(j)) continue;
        if ((env.mask[j] & MASK_CHANNEL) !== 0) continue; // 已有河道：并流=糊水
        const wx = nx * env.step;
        const wz = nz * env.step;
        const score = env.h[j] + env.noise.noise2D(wx * cfg.jitterFreq, wz * cfg.jitterFreq) * cfg.jitterAmp;
        if (score < best) {
          best = score;
          bx = nx;
          bz = nz;
        }
      }
      if (bx < 0) return { ok: false, why: "困于凹坑/被已有河道围死" };
      cx = bx;
      cz = bz;
      visited.add(sidx(env, cx, cz));
      px.push(cx);
      pz.push(cz);
    }
    return { ok: false, why: "超出最大流径仍未入海" };
  }

  /** 当前格是否已到主陆边缘：8 邻里有出界格或非主陆格（labels ≠ maxLabel 即海/别岛）。 */
  private atCoast(env: FeatureEnv, ix: number, iz: number): boolean {
    for (const [dx, dz] of DIRS) {
      const nx = ix + dx;
      const nz = iz + dz;
      if (nx < 0 || nz < 0 || nx >= env.samples || nz >= env.samples) return true;
      if (!isMainland(env, nx, nz)) return true;
    }
    return false;
  }

  /** 沿程水面半宽（格）：bandSource→bandMouth，平行水线铺到 ±bandAt(t)。 */
  private bandAt(t: number): number {
    const cfg = this.cfg;
    return cfg.bandSource + (cfg.bandMouth - cfg.bandSource) * Math.min(1, Math.max(0, t));
  }

  /** 沿程河谷半径（格）：名义梯度 widthSource→widthMouth，minWidth 硬下限兜底。 */
  private widthAt(t: number): number {
    const cfg = this.cfg;
    const w = cfg.widthSource + (cfg.widthMouth - cfg.widthSource) * Math.min(1, Math.max(0, t));
    return Math.max(cfg.minWidth, w);
  }

  /**
   * 刻河床：分窗，每窗先铺平行水线（水面，文件头第 1 条）再单趟河谷（谷坡，第 6 条）。
   * 水线沿逐顶点法向偏移——弯道处法向连续变化，偏移线随弯贴行；sharp 弯折时
   * 相邻水线可能局部交叉，carving 只降不升，交叉无害。
   * 返回 carveBed 的累计触碰数（含重复计数，仅作参考；apply 对外报的 cells 用快照差分去重）。
   */
  private carve(env: FeatureEnv, pix: readonly number[], piz: readonly number[]): number {
    const cfg = this.cfg;
    const L = pix.length - 1; // 流径段数（采样步）
    // 窗长取偶数采样，跨步取半窗：相邻两窗对同一点的 along 恒差 0.5 → 必有一窗满幅。
    const windowS = 2 * Math.max(4, Math.round(cfg.windowCells / env.step / 2));
    const strideS = windowS / 2;
    const seaPadS = Math.round(cfg.seaPadCells / env.step);
    // 向海垫段：长度取整到跨步倍数，保证总长 ≡ 0 (mod strideS)，窗网格两端对齐。
    const padS = strideS * Math.ceil((L + seaPadS) / strideS) - L;
    const ddx = pix[L] - pix[L - 1];
    const ddz = piz[L] - piz[L - 1];
    const ddl = Math.hypot(ddx, ddz) || 1;
    const ux = ddx / ddl;
    const uz = ddz / ddl;
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i <= L; i++) pts.push({ x: pix[i] * env.step, z: piz[i] * env.step });
    for (let k = 1; k <= padS; k++) {
      pts.push({ x: (pix[L] + ux * k) * env.step, z: (piz[L] + uz * k) * env.step });
    }
    const Lpad = L + padS;
    // 逐顶点法向（世界坐标）：中心差分，端点用相邻段方向；垫段沿用出流方向。
    const nx: number[] = [];
    const nz: number[] = [];
    for (let i = 0; i <= Lpad; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(Lpad, i + 1);
      let tx = pts[b].x - pts[a].x;
      let tz = pts[b].z - pts[a].z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      nx.push(-tz);
      nz.push(tx);
    }
    // 河床目标高：钉在 (seaH, water) 之间——游戏判水、生成器 labels 仍判陆。
    const bedH = Math.max(env.seaH + 0.01, Math.min(env.water - 0.02, env.seaH + cfg.bedOffset));
    const valleyH = env.water + cfg.valleyAbove; // 谷坡目标：高于水位，只造坡不造水
    let touched = 0;
    for (let s = 0; s + windowS <= Lpad; s += strideS) {
      const e = s + windowS;
      const t0 = Math.min(1, s / L); // 垫段 t 恒为 1：河口以满宽入海
      const t1 = Math.min(1, e / L);
      const tm = Math.min(1, (s + windowS / 2) / L);
      // 平行水线：铺到 ±bandAt(tm)，间距 lineSpacing，奇数条（永远包含中心线）。
      const band = this.bandAt(tm);
      const nLines = 2 * Math.max(1, Math.round(band / cfg.lineSpacing)) + 1;
      for (let li = 0; li < nLines; li++) {
        const off = -band + ((2 * band) / (nLines - 1)) * li;
        const line: { x: number; z: number }[] = [];
        for (let i = s; i <= e; i++) {
          line.push({ x: pts[i].x + nx[i] * off, z: pts[i].z + nz[i] * off });
        }
        for (let p = 0; p < cfg.linePasses; p++) {
          touched += carveBed(env, line, cfg.lineW, cfg.lineW, bedH);
        }
      }
      // 河谷单趟：宽半径、目标高于水位（低于目标的格子一律不动，不会加宽水面）。
      touched += carveBed(env, pts.slice(s, e + 1), this.widthAt(t0), this.widthAt(t1), valleyH);
    }
    return touched;
  }

  /**
   * 把被 carveBed 抬离海基准的纯海格还原（文件头第 4 条）。
   * 判据用快照而非"当前值恰为 seaH+0.01"：后者分不清"被抬的海格"与
   * "被深刻到 floor 的陆格"（若未来别的特征用 bedH=0.05 刻过，这里就会误还原）。
   * 还原值取快照原值而非 seaH 常量，保证逐比特一致、cells 差分不受污染。
   */
  private restoreSea(env: FeatureEnv, hSnap: Float32Array): void {
    for (let i = 0; i < env.h.length; i++) {
      if (hSnap[i] <= env.seaH && env.h[i] !== hSnap[i]) {
        env.h[i] = hSnap[i];
        env.mask[i] = (env.mask[i] & ~MASK_CHANNEL) >>> 0;
      }
    }
  }
}
