// v0.25 阶段 2 地貌特征：峡谷 / 干谷（Canyon）。与山脉（mountain-range.ts）平级、互相独立：
// 不 import 山脉的任何东西（hasRoom/mainlandCentroid 这类小工具在本文件各留一份拷贝，
// 特征之间零依赖，删掉任何一个文件另一个照常工作——AGENTS.md 的 separable 要求）。
//
// 语义：一条**下切但不含水**的低走廊，即"两列山之间那道天然的窄通道"。它给地图提供
// "隘口"这种战术地形：谷底能走、两侧崖肩难翻，玩家会记得"那条路好守"。
// 与（未来阶段的）River 的唯一区别：谷底始终高于游戏水位 env.water，是**干谷**——
// 这也是它不登记 MASK_CHANNEL 的全部理由。
//
// 做法分两阶段、三个动作，顺序是关键，不要调换：
//   1. levelFloor（逐条谷）：把走廊内低于目标高程的**陆地**低坑填到目标高程附近
//      （走廊得是一条"平出来的路"；留一串坑会被检查脚本的沿程起伏断言抓住，
//       而且低坑贴着 water 线走迟早有人把它刻穿）；
//   2. 崖肩（逐条谷）：沿路径两侧的偏移折线用 raiseTo + domeProfile 抬出两列小穹顶，
//      登记 MASK_PEAK；
//   3. carveBed（**所有谷统一、最后**执行）下切谷底。carve 是"只降不升"的最终裁决：
//      不管崖肩穹顶往中心线里侵多少（穹顶半径 1.6~2.4 > 谷半宽，内坡必然覆进走廊），
//      最后这一刀都会把中心线切回 floorTarget，走廊永远通、谷底永远低于两壁。
//      多条谷之间的交叉不靠刻的顺序兜底，而是靠 plan 里的"谷间最小间距"直接禁止：
//      两条谷的刻盘一旦相交，后刻的会把先刻的崖肩拦腰切开（实测 seed 3：交叉处
//      崖肩 0.875、谷底 0.450，"两壁高于谷底 ≥0.6"直接被打破）——交叉谷没有
//      干净的语义，宁可让第二条谷换地方。
//
// 关键风险（本注释与 feature-canyon-check.ts 的断言是同一件事的两面，改一处必改另一处）：
// 干谷**不登记 MASK_CHANNEL**。如果哪天有人把谷底刻到 env.water 以下，管线尾部的
// 海陆形态学闭运算会把这片"没登记过的水"当成亚格水缺口处理——一条本应好走的干谷
// 就地变成一道河，表现为"刻完就消失"，查起来特别像随机 bug。所以这里有硬保护：
//   floorTarget ≥ env.water + 0.25（安全线），检查脚本断言谷底处处 > water + 0.2。
// 顺带一提 carveBed 只在 nv < env.water 时才登记 MASK_CHANNEL，而我们的目标高程
// 永远高于 water，所以这条调用天然不登记任何水系格（检查脚本断言 MASK_CHANNEL 计数为 0）。
//
// 与平滑管线的关系：崖肩抬升 ≤0.8、下切 ≤1.4，都远低于"高于平原 4 单位要半径 ≥3 格"
// 的量级（clampSlope 钳 0.40/采样 ≈ 1.6/格），footprint（崖肩半径 1.6~2.4 格）绰绰有余；
// 崖肩登记 MASK_PEAK 让 7 轮松弛轻手对待，两壁立得住，谷底是"低于邻域的走廊"
// 不会被任何只升不降/只降不升的工序单方向抹掉。

import {
  MASK_PEAK,
  carveBed,
  distToStartCells,
  domeProfile,
  isMainland,
  raiseTo,
  sidx,
  type FeatureEnv,
  type FeatureStat,
  type TerrainFeature,
} from "../terrain-features";

/** 峡谷配置。长度一律用"格"，不含采样数——采样密度改了也不用回来改这里。 */
export interface CanyonConfig {
  /** 每条图放几条干谷（低山地权模板由 canyonPlanFor 置 [0,0] 主动退场）。 */
  canyons: [number, number];
  /** 一条干谷的随机游走步数（路径点数上限）。 */
  steps: [number, number];
  /** 谷**半**宽（格）：谷宽 2~3 格 ⇒ 半宽 1.0~1.5。下界 1.0 保证整条谷 ≥2 格宽，
   *  不会被平滑管线当窄缝抹掉（对齐契约里水系"宽度不得低于 2 格"的教训）。 */
  halfWidth: [number, number];
  /** 下切量（格）：谷底相对路径沿线中位基面的下切深度，0.6~1.4。 */
  incision: [number, number];
  /** 崖肩抬升量（格）。上限有意压在 0.8 以下、且逐条封顶为 min(0.8, 下切量)——
   *  崖肩是"谷的墙"，不是又一条山脉：抬升比下切小，整条走廊才仍然读作"被挖出来的"
   *  而不是"被堆出来的"（地貌语义，也是可建地坡度断言的安全余量）。 */
  shoulderLift: [number, number];
  /** 崖肩穹顶半径（格）。抬升 ≤0.8，半径 1.6 起步，高差/半径远低于 clampSlope 限幅。 */
  shoulderRadius: [number, number];
  /** 游走步长（格）：越小谷越直越连贯，越大越蜿蜒。 */
  stride: [number, number];
  /** 干谷任何**改动过的格子**离双方出生点的最小距离（格）。
   *  路径点本身的判据还要再加崖肩触达半径（见 plan 里的 keepStart），保证
   *  连崖肩外缘都 ≥ 这条线——隘口贴着基地就不是隘口，是门口的坑。 */
  minStartDist: number;
  /** 落点四周要求这么多格半径内都是主陆，才养得起一条峡谷（格）。三档降级同山脉。 */
  room: number;
  /** 距图边的最小距离（格）。 */
  margin: number;
  /** 单条干谷最多尝试取点次数。 */
  tries: number;
}

/** 默认配置。minStartDist=7 是规格下限；room 三档降级的理由抄山脉（twinlands/lagoon）。 */
export const CANYON_DEFAULTS: CanyonConfig = {
  canyons: [1, 2],
  steps: [10, 18],
  halfWidth: [1.0, 1.5],
  incision: [0.6, 1.4],
  shoulderLift: [0.35, 0.8],
  shoulderRadius: [1.6, 2.4],
  stride: [1.4, 2.6],
  minStartDist: 7,
  room: 6,
  margin: 5,
  tries: 260,
};

/** 谷底安全线：目标高程永不低于 water+0.25，给"处处 > water+0.2"的断言留 0.05 余量。 */
const FLOOR_MARGIN = 0.25;

/**
 * 按模板的起伏参数决定"这座图放几条干谷、下切多深"。
 * 干谷的语义是"两列山之间的通道"，所以只在山地权重较高的图上出现：
 * 现有六模板里非高地模板 mw∈[0.2,0.4]、rs=1（mw×rs ≤ 0.4），高地是 1×1.35。
 * 门槛取 0.5：低于它 placed=0 是**正确的退化行为**（平原上硬挖峡谷只会得到
 * 一条和地貌无关的壕沟），也给未来落在 0.5~1 之间的中等山地模板留了档位。
 * 纯函数、不消耗随机数——保证这里的分支不会改变同 seed 的抽取顺序。
 */
export function canyonPlanFor(mw: number, rs: number): CanyonConfig {
  const weight = Math.min(1, Math.max(0, mw * rs));
  if (weight < 0.5) return { ...CANYON_DEFAULTS, canyons: [0, 0] };
  return {
    ...CANYON_DEFAULTS,
    // 高地（weight≈1）1~2 条，未来的中等山地模板固定 1 条
    canyons: [1, weight > 0.85 ? 2 : 1],
    // 山地权重越高下切越深：0.5 档 [0.6, 1.0]，高地吃满规格区间 [0.6, 1.4]
    incision: [CANYON_DEFAULTS.incision[0], 0.6 + 0.8 * weight],
  };
}

/** 崖肩印章位置（世界坐标，格）；null = 该点放弃盖章（急弯内侧推不出去，让天然地形当墙）。 */
export type ShoulderPoint = { x: number; z: number } | null;

/** 一条已落地干谷的几何明细。只供检查脚本沿路径抽样与日志，不参与 TerrainFeature 契约。 */
export interface CanyonTrace {
  /** 路径点（世界坐标，格）。 */
  pts: ReadonlyArray<{ x: number; z: number }>;
  /** 谷半宽（格）：起点端 / 出口端（出口略宽，读作"谷口敞开"）。 */
  halfW0: number;
  halfW1: number;
  /** 崖肩基准偏移（格，未含弯道外推；实际肩点见 leftShoulders/rightShoulders）。 */
  offset: number;
  /** 谷底目标高程（恒 ≥ water+0.25）。 */
  floorTarget: number;
  /** 崖肩穹顶半径（格）。 */
  shoulderR: number;
  /** 崖肩目标 = floorTarget + wallH（谷深 + 肩高，检查脚本据此验"两壁高于谷底 ≥0.6"）。 */
  wallH: number;
  /** 左侧崖肩印章位置（与 pts 等长，含弯道外推；null 处无章）。 */
  leftShoulders: ReadonlyArray<ShoulderPoint>;
  /** 右侧崖肩印章位置（与 pts 等长，含弯道外推；null 处无章）。 */
  rightShoulders: ReadonlyArray<ShoulderPoint>;
}

/** 折线各点的左法向（单位向量；右法向取负号）。端点用单侧差分。 */
export function pathNormals(pts: ReadonlyArray<{ x: number; z: number }>): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1e-6;
    out.push({ x: -(b.z - a.z) / len, z: (b.x - a.x) / len });
  }
  return out;
}

/** 点到折线的最小距离（到各线段垂距与端点距的最小值）。 */
function distToPolyline(p: { x: number; z: number }, pts: ReadonlyArray<{ x: number; z: number }>): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t)));
  }
  return best;
}

/** [0,1] 的 C1 平滑（与 terrain-features 的 smoothFalloff 同族，那边未导出，这里留一份）。 */
function smooth01(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 端部收口：与 carveBed 内置的 taper 完全一致——首 1/4 程把宽度从 0 拉满，尾 1/4 略收。
 *  levelFloor 必须与 carveBed 用同一份几何，"填的走廊"和"刻的走廊"才严格重合。 */
function endTaper(along: number): number {
  return smooth01(Math.min(1, along * 4, (1 - along) * 4 + 0.25));
}

/**
 * 第 1 步：把走廊内**低于目标高程的陆地格**抬到目标高程附近（中心满填、边缘无扰）。
 * 这是"走廊而不是一串坑"的第一半（第二半是 carveBed 把高处切下来）。
 * 海陆硬契约照抄原语：只动 h > seaH 的格子——绝不允许把海格抬成陆格。
 * 不登记掩膜：填出来的是谷底，既不是山体也不是水系。
 */
function levelFloor(
  env: FeatureEnv,
  pts: ReadonlyArray<{ x: number; z: number }>,
  w0: number,
  w1: number,
  floorTarget: number,
): number {
  let touched = 0;
  const segs = Math.max(1, pts.length - 1);
  for (let s = 0; s + 1 < pts.length; s++) {
    const a = pts[s]!;
    const b = pts[s + 1]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1e-6;
    const nx = (b.x - a.x) / len;
    const nz = (b.z - a.z) / len;
    const steps = Math.max(1, Math.ceil(len / (env.step * 0.75))); // 步进与 carveBed 一致
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const px = a.x + nx * len * t;
      const pz = a.z + nz * len * t;
      const along = (s + t) / segs;
      const halfW = (w0 + (w1 - w0) * along) * endTaper(along);
      if (halfW < env.step * 0.6) continue; // 与 carveBed 同阈：这么窄的填痕刻完也会被跳过
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
          const i = iz * env.samples + ix;
          const hv = env.h[i]!;
          // 只抬"已经是陆地且低于目标"的格子：海格（≤seaH）绝不碰（硬契约：不许海变陆），
          // 高于目标的格子留给第 3 步 carveBed 去切——填与刻各管一半，互不抢活。
          if (hv <= env.seaH || hv >= floorTarget) continue;
          const f = smooth01(u); // 中心满填、边缘无扰，与 carveBed 的剖面镜像对称
          env.h[i] = floorTarget + (hv - floorTarget) * f;
          touched++;
        }
      }
    }
  }
  return touched;
}

/** 干谷特征。实现 TerrainFeature，也可单独 new 出来做单元测试。 */
export class Canyon implements TerrainFeature {
  readonly id = "canyon";
  private readonly cfg: CanyonConfig;
  /** 最近一次 apply 的落位明细（进 FeatureStat.note）。 */
  private lastNote = "";
  /** 最近一次 apply 落地的每条干谷的几何（检查脚本沿路径抽样用；apply 开头清空）。 */
  lastTraces: CanyonTrace[] = [];

  constructor(cfg: Partial<CanyonConfig> = {}) {
    this.cfg = { ...CANYON_DEFAULTS, ...cfg };
  }

  apply(env: FeatureEnv): FeatureStat {
    const cfg = this.cfg;
    this.lastTraces = [];
    const nCanyons = env.rng.int(cfg.canyons[0], cfg.canyons[1]);
    if (nCanyons === 0) {
      return { id: this.id, placed: 0, cells: 0, note: "山地权重低于门槛，本图不放干谷" };
    }
    const centroid = mainlandCentroid(env);
    let placed = 0;
    let cells = 0;
    let gaveUp = 0;
    const notes: string[] = [];
    const plans: CanyonPlan[] = [];

    // 阶段 1（逐条）：游走 + 填谷底 + 抬崖肩。抬升类动作全部集中在下切之前。
    for (let c = 0; c < nCanyons; c++) {
      const plan = this.plan(env, centroid, plans);
      if (plan === null) {
        gaveUp++;
        continue;
      }
      plan.touched = levelFloor(env, plan.pts, plan.halfW0, plan.halfW1, plan.floorTarget);
      // 崖肩目标 = 谷底 + (谷深+肩高)×端部收口：端部肩高同步衰减，谷"敞开"进平原，
      // 而不是在平原中央竖两堵突然出现的墙。肩点由 plan 预解好（含弯道外推/放弃）。
      const shoulderSets = [plan.leftShoulders, plan.rightShoulders] as const;
      for (const shoulders of shoulderSets) {
        for (let i = 0; i < plan.pts.length; i++) {
          const sp = shoulders[i]!;
          if (sp === null) continue;
          const target = plan.floorTarget + plan.wallH * endTaper(i / (plan.pts.length - 1));
          const ix = Math.round(sp.x / env.step);
          const iz = Math.round(sp.z / env.step);
          if (ix < 0 || iz < 0 || ix >= env.samples || iz >= env.samples) continue;
          plan.touched += raiseTo(env, ix, iz, plan.shoulderR / env.step, target, domeProfile, MASK_PEAK);
        }
      }
      plans.push(plan);
      notes.push(this.lastNote);
    }

    // 阶段 2（全部谷的最后一步）：统一 carveBed 下切。为什么必须两阶段——
    // carve 是"只降不升"的最终裁决：不管本谷崖肩穹顶往中心线里侵多少（穹顶半径
    // 1.6~2.4 > 谷半宽，内坡必然覆进走廊），最后这一刀都会把中心线切回 floorTarget，
    // 走廊永远通、谷底永远低于两壁。谷与谷的交叉在 plan 里就被间距约束挡掉了，
    // 所以这一步不需要考虑"后谷切前谷"的次序问题。
    for (const plan of plans) {
      plan.touched += carveBed(env, plan.pts, plan.halfW0, plan.halfW1, plan.floorTarget);
      placed++;
      cells += plan.touched;
      this.lastTraces.push({
        pts: plan.pts,
        halfW0: plan.halfW0,
        halfW1: plan.halfW1,
        offset: plan.offset,
        floorTarget: plan.floorTarget,
        shoulderR: plan.shoulderR,
        wallH: plan.wallH,
        leftShoulders: plan.leftShoulders,
        rightShoulders: plan.rightShoulders,
      });
    }
    if (gaveUp) notes.push(`${gaveUp} 条找不到合法落点`);
    return { id: this.id, placed, cells, note: notes.join("；") };
  }

  /**
   * 规划一条干谷：抽形状参数、随机游走出路径、定谷底目标高程。
   * 不做任何雕刻；取不到合法路径返回 null。prev 是本图已规划的其他谷，
   * 新路径的中心线不许进入它们的"谷间禁入带"（见 tooCloseTo）。
   *
   * 随机游走与山脉同构：主方向锚在"指向大陆质心"附近 ±0.9 弧度，每步朝质心回拉 35%、
   * 中途一次明显转向——理由在山脉里已被实测验证（纯随机方位的游走天然向外逃、
   * 一步出海），这里照抄而不是重新发明。雕刻动作（填 → 抬 → 切）在 apply 里分两阶段执行。
   */
  private plan(
    env: FeatureEnv,
    centroid: { x: number; z: number },
    prev: ReadonlyArray<CanyonPlan>,
  ): CanyonPlan | null {
    const cfg = this.cfg;
    const lim = Math.round(cfg.margin / env.step);

    // —— 先抽完这条谷的全部形状参数（再走游走），保证 keepStart 用的是真实崖肩触达 ——
    const halfW0 = env.rng.float(cfg.halfWidth[0], cfg.halfWidth[1]);
    const halfW1 = env.rng.float(halfW0, cfg.halfWidth[1]); // 出口端不窄于起点端
    const avgHalfW = (halfW0 + halfW1) / 2;
    // 崖肩偏移"约半个谷宽"再略外扩（×1.05~1.25）：肩心落在谷缘外一点点，
    // 下切盘（半径 ≤ halfW1）够不着肩心，穹顶峰不会被自己切掉。
    const offset = avgHalfW * env.rng.float(1.05, 1.25);
    const shoulderR = env.rng.float(cfg.shoulderRadius[0], cfg.shoulderRadius[1]);
    const incision = env.rng.float(cfg.incision[0], cfg.incision[1]);
    // 崖肩抬升逐条封顶 ≤ 下切量（见 CanyonConfig.shoulderLift 注释）
    const lift = env.rng.float(cfg.shoulderLift[0], Math.min(cfg.shoulderLift[1], incision));
    const wallH = incision + lift;
    // 路径点离出生点的硬下界：minStartDist + 崖肩触达（偏移 + 穹顶半径）。
    // 只卡路径点本身的话，崖肩穹顶会伸进基地——山脉当年就栽过"峰头合法、山腰压基地"。
    const keepStart = cfg.minStartDist + offset + shoulderR;

    const nSteps = env.rng.int(cfg.steps[0], cfg.steps[1]);
    const bendAt = env.rng.int(2, Math.max(2, nSteps - 1));
    const bend = env.rng.float(-0.9, 0.9);

    // 谷间禁入带：两条谷的**刻盘**（半宽 halfW1）不许相交，另加一个最大步长的余量——
    // 判据按"路径点间距"算，点距最多比线距多出半个步长，不补这一段会出现
    // "点判据全过、刻盘仍然相交"的漏网（交叉处崖肩被拦腰切开的教训，见文件头）。
    const tooCloseTo = (x: number, z: number): boolean => {
      for (const p of prev) {
        const sep = p.halfW1 + halfW1 + cfg.stride[1];
        for (const q of p.pts) {
          if (Math.hypot(q.x - x, q.z - z) < sep) return true;
        }
      }
      return false;
    };

    // —— 取起点：腹地三档降级（room → room/2 → 0），理由同山脉：
    // twinlands/lagoon 这类图上"四周 6 格全是主陆"的点可能根本不存在，
    // 降级是"优先挑腹地充足的点"，不是放松出生点/主陆这两条硬判据。 ——
    const roomLevels = [Math.round(cfg.room / env.step), Math.round(cfg.room / 2 / env.step), 0];
    let cx = -1;
    let cz = -1;
    for (const roomS of roomLevels) {
      for (let t = 0; t < cfg.tries; t++) {
        const ix = env.rng.int(lim, env.samples - 1 - lim);
        const iz = env.rng.int(lim, env.samples - 1 - lim);
        if (!hasRoom(env, ix, iz, roomS)) continue;
        if (distToStartCells(env, ix, iz) < keepStart) continue;
        if (tooCloseTo(ix * env.step, iz * env.step)) continue;
        cx = ix;
        cz = iz;
        break;
      }
      if (cx >= 0) break;
    }
    if (cx < 0) {
      this.lastNote = "找不到合法起点";
      return null;
    }

    let dir =
      Math.atan2(centroid.z - cz * env.step, centroid.x - cx * env.step) + env.rng.float(-0.9, 0.9);

    // —— 随机游走。base[i] 在任何雕刻发生**之前**采样：后面崖肩/谷底都要以
    //    "原始基面"为参照，混入已改写的高度会让目标高程依赖游走顺序（不可复现的温床）。 ——
    const pts: { x: number; z: number }[] = [];
    const base: number[] = [];
    for (let p = 0; p < nSteps; p++) {
      if (p === bendAt) dir += bend;
      if (distToStartCells(env, cx, cz) < keepStart) break; // 逼近基地就截断，宁可谷短
      if (tooCloseTo(cx * env.step, cz * env.step)) break; // 撞上已有谷的禁入带同样截断
      pts.push({ x: cx * env.step, z: cz * env.step });
      base.push(env.h[sidx(env, cx, cz)]!);
      const toC = Math.atan2(centroid.z - cz * env.step, centroid.x - cx * env.step);
      dir = toC + (dir - toC) * 0.65 + env.rng.float(-0.42, 0.42);
      const stepCells = env.rng.float(cfg.stride[0], cfg.stride[1]);
      cx = Math.round(cx + Math.cos(dir) * (stepCells / env.step));
      cz = Math.round(cz + Math.sin(dir) * (stepCells / env.step));
      // 出陆 / 出安全边距就收尾：短一条谷，也不能把谷刻进海里
      if (
        !isMainland(env, cx, cz) ||
        cx < lim ||
        cz < lim ||
        cx >= env.samples - lim ||
        cz >= env.samples - lim
      ) {
        break;
      }
    }
    if (pts.length < 4) {
      this.lastNote = `路径仅 ${pts.length} 点，不成走廊，放弃`;
      return null;
    }

    // 谷底目标高程：沿程中位基面下切 incision，但**永不低于 water+0.25 安全线**
    //（干谷铁律，见文件头）。基面极低的图上这里会退化为"贴安全线的浅槽"——
    // 正确行为：宁可浅，不能湿。
    base.sort((a, b) => a - b);
    const median = base[base.length >> 1]!;
    const floorTarget = Math.max(env.water + FLOOR_MARGIN, median - incision);

    // —— 两侧崖肩折线。不能直接用"顶点 + 法向 × offset"：路径急弯（本图步进转向
    //    可达 ~1 弧度）时，弯**内侧**的肩点会落进自己后续线段的刻盘，最后一步
    //    carveBed 把它拦腰切平（实测 seed 3：108° 弯内侧肩被切到 0.52，谷底 0.45，
    //    "两壁高于谷底 ≥0.6"直接被打破）。所以每个肩点先对**整条折线**量距离，
    //    落在"刻盘 + 0.35"之内就沿法向外推；外推上限 2 倍基准偏移，还出不来
    //    （发卡弯，外推方向撞上另一条腿的走廊）就放弃该章，让天然地形当墙。
    const normals = pathNormals(pts);
    const shoulderLine = (side: number): ShoulderPoint[] =>
      pts.map((pt, i) => {
        const n = normals[i]!;
        const along = i / (pts.length - 1);
        const halfWLocal = halfW0 + (halfW1 - halfW0) * along;
        const need = halfWLocal + 0.35;
        let off = offset;
        for (let iter = 0; iter < 8; iter++) {
          const cand = { x: pt.x + n.x * side * off, z: pt.z + n.z * side * off };
          if (distToPolyline(cand, pts) >= need) return cand;
          off = off * 1.3;
          if (off > offset * 2) return null;
        }
        return null;
      });

    this.lastNote = `${pts.length} 点，谷宽 ${(2 * avgHalfW).toFixed(1)} 格，谷底 ${floorTarget.toFixed(2)}，下切 ${(median - floorTarget).toFixed(2)}`;
    return {
      pts,
      halfW0,
      halfW1,
      offset,
      shoulderR,
      wallH,
      floorTarget,
      leftShoulders: shoulderLine(-1),
      rightShoulders: shoulderLine(1),
      touched: 0,
    };
  }
}

/** 一条已规划待雕刻的干谷（apply 阶段 1 产出，阶段 2 消费）。 */
interface CanyonPlan {
  pts: ReadonlyArray<{ x: number; z: number }>;
  halfW0: number;
  halfW1: number;
  /** 崖肩基准偏移（格，未含弯道外推；实际肩点见 leftShoulders/rightShoulders）。 */
  offset: number;
  /** 崖肩穹顶半径（格）。 */
  shoulderR: number;
  /** 崖肩目标高程相对谷底的抬升量（格）。 */
  wallH: number;
  /** 谷底目标高程（恒 ≥ water+0.25）。 */
  floorTarget: number;
  /** 左侧崖肩印章位置（与 pts 等长；null = 该点无章）。 */
  leftShoulders: ReadonlyArray<ShoulderPoint>;
  /** 右侧崖肩印章位置（与 pts 等长；null = 该点无章）。 */
  rightShoulders: ReadonlyArray<ShoulderPoint>;
  /** 已改写的采样格数（阶段 1 累计、阶段 2 追加 carveBed 的份额）。 */
  touched: number;
}

// ========== 以下两个工具是 mountain-range.ts 同名函数的本地拷贝 ==========
// 不 import 山脉：特征之间互相独立（删掉 mountain-range.ts 本文件必须照常编译运行）。

/** 主陆最大连通域的质心（世界坐标）。空域退回图中心，调用方永远拿到有限数。 */
function mainlandCentroid(env: FeatureEnv): { x: number; z: number } {
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
function hasRoom(env: FeatureEnv, ix: number, iz: number, reach: number): boolean {
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
