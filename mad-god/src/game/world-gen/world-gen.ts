// v0.24 地图生成编排器（Agent G）。
// 职责：把「六模板之一 × seeded 噪声」编排成一张完整高度场与双方出生点，
// 替代 v0.23 及更早的固定 sin 叠加 + 固定圆轮廓 + 写死山脊生成器——同 seed 必复现同图。
// 只依赖 noise.ts / map-template.ts 的契约段与 types.ts 的 RNG（模板、噪声实现可独立替换）。
// 性能：SAMPLES≈209（WORLD 放大后 ≈289）时要求单遍生成毫秒级，
// 因此除结果与少量工具数组外，热路径（每格循环）不做任何对象分配。

import { clamp, MAX_H, RNG, WATER } from "../types";
import { makeNoiseKit, mixSeed, type NoiseKit } from "./noise";
import { pickTemplate, type MapTemplate } from "./map-template";
import { FeatureComposer, MASK_PEAK, type FeatureEnv, type FeatureStat } from "./terrain-features";
import { MountainRange, mountainPlanFor } from "./features/mountain-range";

/**
 * 出生点开阔度判据（v0.24）：从候选点沿 8 个罗盘方向各伸出 OPEN_REACH 格，
 * 统计仍落在最大连通陆域内的方向数；少于 OPEN_MIN 个方向即判为"狭长地"。
 * 为什么需要：原判据只有「3.2 格半径内同域覆盖 ≥80%」——蜂腰、尖嘴上也能满足，
 * 结果出生平台 + 3 座初始房的地基把开局区围成一个封死的口袋
 *（实测半岛图 seed 7 蓝方 walker 的可达域仅 57 格，寻路只能返回截断的部分路径，
 * 单位走半路就 idle 停下）。6 格 × 6 方向的要求正好覆盖开局铺开的尺寸。
 */
/**
 * v0.25 出生地偏好高程与其惩罚系数（见 attachToAnchor 注释）。
 * 2.0 这个值落在 render.ts 的"丘带(1.4~2.6)"里：基地可以在丘上，但不该在岩带与雪线上。
 */
const START_PREFER_H = 2.0;
const START_HIGH_PENALTY = 12;
/**
 * v0.25 出生地**硬**上限：3.2 格半径内出现高于此值的格即判为"山顶基地"，直接排除该候选。
 * 5.2 是实测定的：偏好高程只挡住"平均高"的台地，挡不住"旁边一根尖峰"——
 * 均值对单点尖峰不敏感（seed 99 红方基地周边均值不高、中心却坐在 7.34 的雪顶上）。
 * 留出 5.2 而不是 4.2：highlands 这类图本来就全图是高台，卡太紧会一个候选都不剩，
 * 那时宁可降级用高台，也不能让 findStarts 退化成"对角线硬编码点"（可能落进海里）。
 */
const START_MAX_H = 5.2;
const OPEN_REACH = 6;
const OPEN_MIN = 6;
/** 8 个罗盘方向（4 正 + 4 斜），单位向量。 */
const OPEN_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.7071, 0.7071],
  [0.7071, -0.7071],
  [-0.7071, 0.7071],
  [-0.7071, -0.7071],
];

/** 浅海基准高度：稳定海洋格固定 0.04——陆海判据唯一（h>SEA_H 即陆地）。 */
const SEA_H = 0.04;
/**
 * v0.24 集成修正：陆地最低基线。游戏的通行/水位判据是 WATER=0.20。
 * 原值 0.24 只比水位高 0.04——于是**全图绝大多数内陆格都贴着水位线**（0.24~0.35），
 * 任意两处可走节点之间的插值中点、或一次 3×3 松弛的抖动，都能把脚下判成水：
 * 单位走到这种"临界薄地"就下沉→被 nearestLand 弹回→重规划→再下沉（实测原地抖 9 秒）。
 * 抬到 0.40（水位 +0.20 安全余量）后，只有真正的海岸带一圈贴近水位，内陆全部稳在陆上；
 * 海陆上限仍远低于 MAX_H=8（最内陆 ≈4.6），坡度与海岸缓坡由 world.ts 管线负责。
 */
const LAND_BASE = 0.4;

/**
 * v0.25 域扭曲振幅（格）：采样坐标被低频位移场推开的最大距离。
 * 取 6 格 ≈ 世界边长的 8%——足够让海岸线、山脊走向弯折成有机形状，
 * 又不会把模板的宏观海陆格局（landFactor 的概率场）搅掉。
 */
const WARP_AMP = 6;
/**
 * v0.25 起伏幂曲线的指数：>1 意味着"低地压得更平、高地拉得更高"。
 * 这是"一片平原"变成"平原 + 明显高山"所必需的非线性——线性缩放无论乘多大，
 * 平原和山会一起涨，相对坡度不变，观感仍是一个丘。
 * 具体值拿实测定的（scripts/probe-templates.ts，40 个 seed 按模板平均）：
 * SPAN=6.5 下 POW=2.2 太"胖"——连 archipelago 都长出 21.8% 雪盖、全图陆地均值冲到 2.87，
 * 可建房的平地被吃掉太多；POW=3.2 把中间档压下去、只留强山脊冲高，
 * 实测均值 2.2 上下、雪盖 3~12%、岩带 17~30%，平原和雪峰同时存在，才是要的对比度。
 */
const RELIEF_POW = 3.2;
/** v0.25 起伏满量程：shaped=1 时相对 LAND_BASE 的高差，配合 MAX_H=8 留足余量。 */
const RELIEF_SPAN = 6.5;

/** 单方出生点：世界坐标（格）、朝向地图中心的 yaw、平台高度 h。 */
export interface GenStart {
  x: number;
  z: number;
  yaw: number;
  h: number;
}

/**
 * 一次完整生成的产物：高度场 + 特征掩膜 + 模板信息 + 双方出生点 + 特征统计。
 * heights 不做松弛/滩涂/pad——这些由 world.ts 既有管线在接入后统一处理。
 * mask 必须与 heights 一起交给 world.ts：它是"特征感知平滑"的输入
 *（见 terrain-features.ts 里 MASK_PEAK / MASK_CHANNEL 的说明）。
 */
export interface WorldGenResult {
  heights: Float32Array;
  /** 与 heights 等长的特征掩膜（MASK_PEAK / MASK_CHANNEL 位或）。 */
  mask: Uint8Array;
  templateId: string;
  templateName: string;
  starts: [GenStart, GenStart];
  /** 各地物落地统计，供日志与检查脚本断言。 */
  features: FeatureStat[];
}

/**
 * v0.24 世界生成编排器。
 * 纯静态工具类：无实例状态，同 seed 是纯函数（可复现、可缓存）；
 * 各阶段拆为私有静态方法，职责互不耦合，便于单独替换与调试。
 */
export class WorldGen {
  static generate(seed: number, samples: number, step: number): WorldGenResult {
    const world = (samples - 1) * step; // 世界边长（格）
    // v0.24 两条独立随机流：模板抽取（含模板参数）消费 RNG，地形起伏噪声另建一条流——
    // 两者都由图 seed 派生（不再用 Math.random），故同 seed 下各自确定、整图跨进程可复现。
    // seed 必须先 mixSeed 混淆再预热 8 拍：LCG 的首次输出与 seed 线性相关，
    // 不混淆时 RNG(1..303) 几乎抽不出不同模板（实测 15 个 seed 里 14 个同一模板）。
    const rng = new RNG(mixSeed(seed));
    for (let i = 0; i < 8; i++) rng.next();
    const tpl = pickTemplate(rng);
    const noise = makeNoiseKit(mixSeed(seed ^ 0x5bf03635));
    const heights = new Float32Array(samples * samples);
    const mask = new Uint8Array(samples * samples);
    this.fillHeights(heights, samples, step, world, tpl, noise);
    // v0.25 阶段2 顺序调整：连通域与出生点必须在**特征之前**算好——地物要拿"最大陆域"
    // 和"出生点位置"当落位判据（山不能压在基地门口、不能印进海里）。
    // 山脉只抬升、不造新水格，所以 labels 在特征之后依然有效；River/Lake 会改变海陆格局，
    // 那时必须重算 labels（契约里已注明这一条）。
    const { labels, maxLabel } = this.labelLand(heights, samples);
    const starts = this.findStarts(heights, labels, maxLabel, samples, step, world, tpl);
    const features = this.composeFeatures(
      {
        samples,
        step,
        world,
        seaH: SEA_H,
        water: WATER,
        maxH: MAX_H,
        h: heights,
        mask,
        labels,
        maxLabel,
        starts,
        rng,
        noise,
      },
      tpl,
    );
    // 平原修饰挪到特征**之后**，且必须特征感知：它原本把选区内每格往邻域均值拉近 60%，
    // 不排除山体的话刚撒好的山脉会被它抹掉大半。
    this.smoothPlains(heights, samples, step, noise, mask);
    return { heights, mask, templateId: tpl.id, templateName: tpl.name, starts, features };
  }

  /**
   * v0.25 阶段2 「这座图放哪些地物」的唯一决定点。
   * 目前只有山脉；阶段 3/4 的 River / Lake / Plateau 从这里追加。
   * 各特征实现在 features/ 下互相独立，加一个不影响另一个（AGENTS.md 的 separable 要求）。
   */
  private static composeFeatures(env: FeatureEnv, tpl: MapTemplate): FeatureStat[] {
    return FeatureComposer.compose(env, [
      new MountainRange(mountainPlanFor(tpl.mountainWeight(), tpl.reliefScale())),
    ]);
  }

  /**
   * v0.25 高度场：域扭曲后的「内陆度 ×（缓丘 + 幂曲线起伏）」，clamp 到 [0, MAX_H]。
   *
   * 三处相对 v0.24 的改动，逐条对应"只是生成一个平原"的病因：
   * 1) **域扭曲**：landFactor / fbm / ridge 一律在位移场偏移后的坐标上采样。
   *    v0.24 直采 (x,z)，等值线贴着噪声格点对齐，海岸线是规整的圆角多边形、
   *    山脊是横平竖直的带；扭曲后同一张场的走势自然弯折（成熟引擎的标准做法）。
   *    位移场只由低频噪声给出（见 noise.warp），不引入新的高频细节——
   *    这一点对本项目是硬要求：高频才是 smoothField/clampSlope 压不平的东西。
   * 2) **幂曲线起伏**（RELIEF_POW>1）：把归一化起伏量整体压向两端，
   *    平原只涨一点点、只有山脊带能吃满量程。线性放大做不到这件事
   *    （平原和山一起涨，相对坡度不变，观感仍是丘）。
   * 3) **内陆度 inland**：用 smoothstep 把"离海多远"做成一条 0→1 的权重，
   *    近岸自然低缓成滩、只有腹地才够得着岩带与雪线——替代 v0.24 那个
   *    `land *` 的一次乘（land=0.6 就已经给出接近满幅的起伏，山都堆在海岸上）。
   *
   * 硬约束不变：陆地最低点仍 ≥LAND_BASE（=WATER+0.20 安全余量，见 LAND_BASE 注释），
   * 海陆判据仍只看 `land <= 0.35`（扭曲后的值），故 v0.24 的"单连通大陆 + 零绊人缝"
   * 两条不变量的成立前提没有被这次改动引入新的破坏路径。
   */
  private static fillHeights(
    heights: Float32Array,
    samples: number,
    step: number,
    world: number,
    tpl: MapTemplate,
    noise: NoiseKit,
  ): void {
    const mw = tpl.mountainWeight(); // 山脊权重/起伏增益与位置无关，提层循环外避免重复调用
    const rs = tpl.reliefScale();
    for (let iz = 0; iz < samples; iz++) {
      const row = iz * samples;
      for (let ix = 0; ix < samples; ix++) {
        const x = ix * step;
        const z = iz * step;
        // v0.25 位移场：x/z 两个分量各取一条独立噪声流（同流会让扭曲退化成整体平移）
        const wx = x + noise.warp(x, z, 0) * WARP_AMP;
        const wz = z + noise.warp(x, z, 1) * WARP_AMP;
        const land = tpl.landFactor(wx, wz, world);
        let h: number;
        // 陆海分界阈值 0.35：模板 landFactor 是"概率场"——disk 过渡带外半段与卫星岛
        // 高斯尾部都会给出 0.02~0.5 的"准海"值，按小阈值判陆会把大片浅滩铺成陆地
        // （曾致群岛模板 86% 陆地）；<35% 陆地概率视为海。
        if (land <= 0.35) {
          h = SEA_H; // 稳定海洋：统一浅海基准，滩涂抬升交给 world.ts 既有管线
        } else {
          const e = (land - 0.35) / 0.65; // 内陆度 0..1（阈值 0.35 → 满陆 1.0）
          const inland = e * e * (3 - 2 * e); // smoothstep：近岸低缓、腹地才够高
          // v0.25 频率整体比 v0.24 降一档——这是"坡度爆炸"的对症药，调振幅替代不了它：
          // 斜率 ≈ 振幅 / 水平尺度，既然要把山峰抬到 6 高、又要让绝大多数陆格的坡度留在
          // 0.55 这条线以下（sim.ts:222/242 的野人与树木落点判据、world.ts:751 的建筑选地
          // 判据都卡在它上面），山体就必须宽到"几格"的量级。v0.25 第一版沿用
          // fbm(5 层 @0.075) + ridge(3 层 @0.05)，最高一层周期不到 1 格，等于往高度场里
          // 塞逐格抖动——实测 30~53% 的陆格超标，跨山行军时间也跟着爆炸。
          // 现在缓丘 4 层 @0.055（最高层周期 ~3.6 格）、山脊 3 层 @0.032（基周期 ~31 格），
          // 山是"大块"而不是"碎褶"。
          const roll = noise.fbm(wx, wz, 4, 0.055) * 0.5 + 0.5; // [-1,1] → [0,1]，宏观缓丘
          const ridge = noise.ridge(wx, wz, 3, 0.032); // [0,1]，高值即宽体山脊带
          // 归一化起伏量：缓丘给底子、山脊给尖峰；ridge 取平方让山峰成"带"而非"面"，
          // 否则全域普涨成高台，又回到"一整块高原"的单调。
          // v0.25 山脊振幅：给**所有**模板一个不小的底子，再按 mw*rs 温和加成。
          // 不这么做的后果实测过：v0.25 第一版让 mw 与 rs 直接相乘，普通模板（mw 0.2~0.4）
          // 与 highlands（mw1×rs1.35）差到 3~7 倍，于是"要么全图没山、要么 58% 是雪盖"，
          // 中间档根本没有图。加成后比值 1.5 倍，highlands 仍是mountain图但不再是冰球。
          const ridgeAmp = 0.62 + 0.55 * Math.min(1, mw * rs);
          const q = Math.min(1, roll * 0.34 + ridge * ridge * ridgeAmp);
          const shaped = Math.pow(q, RELIEF_POW) * RELIEF_SPAN;
          // 内陆度做"下限不为零的乘子"而非直接乘：细长地（半岛）内陆度天然上不去，
          // 直接乘会把整条半岛压成平原；留 0.25 底让它仍有丘与岩，只是不够到雪线。
          h = LAND_BASE + (0.25 + 0.75 * inland) * (0.35 + roll * 0.6 + shaped);
        }
        heights[row + ix] = clamp(h, 0, MAX_H);
      }
    }
  }

  /**
   * v0.24 平原修饰：secondary 独立流选出的 2~4 片区域（fbm>0.45），
   * 单遍 3×3 盒均值把 h 向邻域均值拉近 60%。
   * 只修饰陆地格——浅海若参与混合会被抬成陆地，破坏海陆格局；
   * 均值取自混合前快照，否则混合会随扫描顺序单向传播（单遍语义）。
   */
  private static smoothPlains(
    heights: Float32Array,
    samples: number,
    step: number,
    noise: NoiseKit,
    featMask?: Uint8Array,
  ): void {
    const n = samples * samples;
    const mask = new Uint8Array(n);
    const base = heights.slice(); // 混合前快照：3×3 均值必须来自快照
    const sec = noise.secondary(); // 与主高度场不同相位：平原选区不跟着山脊/盆地走
    for (let iz = 0; iz < samples; iz++) {
      const row = iz * samples;
      for (let ix = 0; ix < samples; ix++) {
        if (sec.fbm(ix * step, iz * step, 2, 0.045) > 0.45) mask[row + ix] = 1;
      }
    }
    for (let iz = 0; iz < samples; iz++) {
      const row = iz * samples;
      for (let ix = 0; ix < samples; ix++) {
        const i = row + ix;
        if (mask[i] !== 1 || base[i]! <= SEA_H) continue;
        // v0.25 山体不参与平原拉近：这条选区的本职是"把缓丘压平"，
        // 不排除山体就会把刚撒好的山脉抹掉大半（山体自己会走后面的特征感知松弛）。
        if (featMask && (featMask[i]! & MASK_PEAK) !== 0) continue;
        let sum = 0;
        let cnt = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const jx = ix + dx;
            const jz = iz + dz;
            if (jx < 0 || jx >= samples || jz < 0 || jz >= samples) continue;
            sum += base[jz * samples + jx]!;
            cnt++;
          }
        }
        if (cnt > 0) {
          const mean = sum / cnt;
          // 拉近 60%：凸组合，结果必在 [min,max] 内，不会越界也不会把陆地拉成海
          heights[i] = heights[i]! + (mean - heights[i]!) * 0.6;
        }
      }
    }
  }

  /**
   * v0.24 连通域标记：4 邻接 BFS，h>SEA_H 即陆地（本生成器只产 0.04 海格与 ≥0.06 陆格，
   * 故该判据与「h>0」等价，但不会把浅海误算成陆地）。
   * 返回每格 label 与最大连通域编号（出生点只落在最大陆地上，保证双方可达同一片大陆）。
   */
  private static labelLand(
    heights: Float32Array,
    samples: number,
  ): { labels: Int32Array; maxLabel: number } {
    const n = samples * samples;
    const labels = new Int32Array(n);
    labels.fill(-1);
    const queue = new Int32Array(n); // 一次性预分配：BFS 队列入队总次数 ≤ 格数
    let maxLabel = -1;
    let maxCount = 0;
    let label = 0;
    for (let i = 0; i < n; i++) {
      if (heights[i]! <= SEA_H || labels[i]! !== -1) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = i;
      labels[i] = label;
      while (head < tail) {
        const cur = queue[head++]!;
        const iz = (cur / samples) | 0;
        const ix = cur - iz * samples;
        if (ix > 0) {
          const nb = cur - 1;
          if (labels[nb]! === -1 && heights[nb]! > SEA_H) {
            labels[nb] = label;
            queue[tail++] = nb;
          }
        }
        if (ix < samples - 1) {
          const nb = cur + 1;
          if (labels[nb]! === -1 && heights[nb]! > SEA_H) {
            labels[nb] = label;
            queue[tail++] = nb;
          }
        }
        if (iz > 0) {
          const nb = cur - samples;
          if (labels[nb]! === -1 && heights[nb]! > SEA_H) {
            labels[nb] = label;
            queue[tail++] = nb;
          }
        }
        if (iz < samples - 1) {
          const nb = cur + samples;
          if (labels[nb]! === -1 && heights[nb]! > SEA_H) {
            labels[nb] = label;
            queue[tail++] = nb;
          }
        }
      }
      if (tail > maxCount) {
        maxCount = tail;
        maxLabel = label;
      }
      label++;
    }
    return { labels, maxLabel };
  }

  /**
   * v0.24 出生点搜索：向模板锚点吸附（保证开局格局遵循模板的对称设计）。
   * 先取最大连通域内每 4 采样（=1 格）的候选，逐个预计算 3.2 格半径圆内的
   * 连通域覆盖率与局部平均高度；两起点过近（<world*0.45）或锚点吸附失败时，
   * 回退为连通域内相距最远的两点（扫描步 8），保证开局分隔公平。
   */
  private static findStarts(
    heights: Float32Array,
    labels: Int32Array,
    maxLabel: number,
    samples: number,
    step: number,
    world: number,
    tpl: MapTemplate,
  ): [GenStart, GenStart] {
    const stride = 4;
    const cap = Math.ceil(samples / stride) ** 2;
    const candX = new Int32Array(cap);
    const candZ = new Int32Array(cap);
    const cov = new Float32Array(cap); // 3.2 格半径内最大连通域覆盖率
    const meanH = new Float32Array(cap); // 3.2 格半径内高度场均值（出生平台高度参考）
    const maxHc = new Float32Array(cap); // 3.2 格半径内最高格（"山顶基地"硬判据，见 START_MAX_H）
    const open = new Uint8Array(cap); // 8 向 × 6 格开阔度（0~8），见 OPEN_REACH 注释
    let candN = 0;
    // v0.24 集成修正：出生点候选必须距图边 ≥4 格（16 采样）——贴边出生会让
    // world 管线的 flattenPad/松弛邻域越界（曾致半岛模板 8 格 NaN 传播）。
    const margin = Math.round(4 / step);
    for (let iz = margin; iz < samples - margin; iz += stride) {
      const row = iz * samples;
      for (let ix = margin; ix < samples - margin; ix += stride) {
        if (labels[row + ix]! !== maxLabel) continue;
        candX[candN] = ix;
        candZ[candN] = iz;
        candN++;
      }
    }
    const r = 3.2 / step; // 覆盖半径（采样数）
    const rS = Math.ceil(r); // 包围盒半径
    const r2 = r * r;
    for (let c = 0; c < candN; c++) {
      const cx = candX[c]!;
      const cz = candZ[c]!;
      const x0 = Math.max(0, cx - rS);
      const x1 = Math.min(samples - 1, cx + rS);
      const z0 = Math.max(0, cz - rS);
      const z1 = Math.min(samples - 1, cz + rS);
      let inComp = 0;
      let tot = 0;
      let sum = 0;
      let mx = 0;
      for (let jz = z0; jz <= z1; jz++) {
        const dz = jz - cz;
        const rowJ = jz * samples;
        for (let jx = x0; jx <= x1; jx++) {
          const dx = jx - cx;
          if (dx * dx + dz * dz > r2) continue;
          tot++;
          const hv = heights[rowJ + jx]!;
          sum += hv;
          if (hv > mx) mx = hv;
          if (labels[rowJ + jx]! === maxLabel) inComp++;
        }
      }
      cov[c] = tot > 0 ? inComp / tot : 0;
      meanH[c] = tot > 0 ? sum / tot : 0;
      maxHc[c] = mx;
      open[c] = this.openness(labels, maxLabel, cx, cz, samples, Math.round(OPEN_REACH / step));
    }
    const anchors = tpl.anchors(world);
    let startA: GenStart | null = null;
    let startB: GenStart | null = null;
    const ca = this.attachToAnchor(anchors[0].x, anchors[0].z, candX, candZ, cov, meanH, maxHc, open, candN, step);
    const cb = this.attachToAnchor(anchors[1].x, anchors[1].z, candX, candZ, cov, meanH, maxHc, open, candN, step);
    if (ca >= 0 && cb >= 0) {
      const d = Math.hypot((candX[ca]! - candX[cb]!) * step, (candZ[ca]! - candZ[cb]!) * step);
      if (d >= world * 0.45) {
        startA = this.makeStart(candX[ca]!, candZ[ca]!, meanH[ca]!, step, world);
        startB = this.makeStart(candX[cb]!, candZ[cb]!, meanH[cb]!, step, world);
      }
    }
    if (!startA || !startB) {
      // 锚点吸附失败或两起点过近：改取最大连通域内最远两点对，保证双方开局分隔公平
      const far = this.farthestPair(heights, labels, maxLabel, samples, step, world);
      if (far) return far;
      // 兜底：全图无可用陆地（模板退化，理论不出现）——四分之一对角点落位，保证结构永远有效
      const q = world * 0.25;
      const yawA = Math.atan2(world * 0.5 - q, world * 0.5 - q);
      const yawB = Math.atan2(q - world * 0.5, q - world * 0.5);
      const h = 0.8 + 0.25;
      return [
        { x: q, z: q, yaw: yawA, h },
        { x: world - q, z: world - q, yaw: yawB, h },
      ];
    }
    return [startA, startB];
  }

  /**
   * 在候选中找「代价最小，且同时满足 3.2 格半径内最大连通域覆盖 ≥80% 与 8 向开阔度 ≥OPEN_MIN」
   * 的点；无满足者返回 -1。开阔度这条专门用来否掉蜂腰/尖嘴上的"看着开阔其实一戳就穿"的地。
   *
   * v0.25 阶段2 加入**低地偏好**：代价不再只是"离锚点多远"，还要加上"高出偏好线多少"的
   * 二次惩罚。原因是 v0.25 把动态范围拉开以后，锚点附近完全可能只剩高台上的候选点，
   * 实测 continent seed 11 的基地落在 h≈6.0 的雪带平台上（开局三座房盖在雪山顶，
   * 既难看又让首批单位的爬坡速度吃满惩罚）。惩罚系数的量纲是"格²"，
   * 所以 START_HIGH_PENALTY=12 的含义是：比偏好高程高 1 个单位，等价于多偏离锚点 3.5 格
   *——足以把基地从山顶拽回山脚，又不至于破坏模板的对称落位。
   */
  private static attachToAnchor(
    ax: number,
    az: number,
    candX: Int32Array,
    candZ: Int32Array,
    cov: Float32Array,
    meanH: Float32Array,
    maxHc: Float32Array,
    open: Uint8Array,
    candN: number,
    step: number,
  ): number {
    // 两轮：第一轮带"山顶基地"硬排除；一个候选都不剩时第二轮放弃这条
    //（全图皆山的模板——highlands——确实会出现），退化到"至少别再往上挑高的"。
    for (let strict = 1; strict >= 0; strict--) {
      let best = -1;
      let bestCost = Infinity;
      for (let c = 0; c < candN; c++) {
        if (cov[c]! < 0.8 || open[c]! < OPEN_MIN) continue;
        if (strict === 1 && maxHc[c]! > START_MAX_H) continue;
        const dx = candX[c]! * step - ax;
        const dz = candZ[c]! * step - az;
        const high = Math.max(0, meanH[c]! - START_PREFER_H);
        const cost = dx * dx + dz * dz + START_HIGH_PENALTY * high * high;
        if (cost < bestCost) {
          bestCost = cost;
          best = c;
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * 8 向开阔度（0~8）：从 (ix,iz) 沿 8 个罗盘方向各伸出 reach 采样，落在最大连通域内的方向数。
   * 纯查表（labels），不做高度判断——连通域标签已经隐含"是陆地且与主陆同域"。
   */
  private static openness(
    labels: Int32Array,
    maxLabel: number,
    ix: number,
    iz: number,
    samples: number,
    reach: number,
  ): number {
    let n = 0;
    for (const [dx, dz] of OPEN_DIRS) {
      const jx = Math.round(ix + dx * reach);
      const jz = Math.round(iz + dz * reach);
      if (jx < 0 || jz < 0 || jx >= samples || jz >= samples) continue;
      if (labels[jz * samples + jx] === maxLabel) n++;
    }
    return n;
  }

  /**
   * 最大连通域内（扫描步 8）取"相距最远、且都不是山顶"的两点对；格数不足 2 时返回 null。
   *
   * v0.25 阶段2 修正：这条兜底路径其实是**主路径**——实测 8 个 seed 里有 7 个走这里
   *（双方锚点吸附成功的图，两点距离常常到不了 world*0.45 的分隔要求）。
   * 而它原来纯粹"取最远两点"，一点高度偏好都没有：v0.25 拉开动态范围后，
   * 最远的两点往往正好是大陆两端的**山脊**（实测 seed 99 红方基地坐在 h=7.34 的雪顶上，
   * seed 11 红方 4.51、seed 23 蓝方 5.25）。所以在保留"分隔公平"这个本职的前提下，
   * 把高度惩罚算进点对得分，并先用 START_MAX_H 硬筛一轮、无解再放宽。
   */
  private static farthestPair(
    heights: Float32Array,
    labels: Int32Array,
    maxLabel: number,
    samples: number,
    step: number,
    world: number,
  ): [GenStart, GenStart] | null {
    const stride = 8;
    const cap = Math.ceil(samples / stride) ** 2;
    const fx = new Int32Array(cap);
    const fz = new Int32Array(cap);
    const fMean = new Float32Array(cap);
    const fMax = new Float32Array(cap);
    let fn = 0;
    const margin = Math.round(4 / step); // 同 findStarts：距图边 ≥4 格，防 pad 管线越界
    const r = 3.2 / step;
    const rS = Math.ceil(r);
    const r2 = r * r;
    for (let iz = margin; iz < samples - margin; iz += stride) {
      const row = iz * samples;
      for (let ix = margin; ix < samples - margin; ix += stride) {
        if (labels[row + ix]! !== maxLabel) continue;
        // 兜底路径同样要过开阔度判据，否则"最远两点"会挑回蜂腰/尖嘴上（同 attachToAnchor）。
        if (
          this.openness(labels, maxLabel, ix, iz, samples, Math.round(OPEN_REACH / step)) < OPEN_MIN
        ) {
          continue;
        }
        const st = this.circleStats(heights, labels, maxLabel, ix, iz, samples, rS, r2);
        fx[fn] = ix;
        fz[fn] = iz;
        fMean[fn] = st.mean;
        fMax[fn] = st.maxH;
        fn++;
      }
    }
    if (fn < 2) return null;
    let ba = -1;
    let bb = -1;
    let bestScore = -Infinity;
    // strict=1：先只允许"3.2 格内没有山顶"的候选；全图都找不到一对合规的（highlands）
    // 就退到 strict=0，此时仍靠高度惩罚尽量挑低处，而不是干脆放弃判据。
    for (let strict = 1; strict >= 0; strict--) {
      bestScore = -Infinity;
      for (let i = 0; i < fn; i++) {
        if (strict === 1 && fMax[i]! > START_MAX_H) continue;
        for (let j = i + 1; j < fn; j++) {
          if (strict === 1 && fMax[j]! > START_MAX_H) continue;
          const dx = (fx[i]! - fx[j]!) * step;
          const dz = (fz[i]! - fz[j]!) * step;
          const hi = Math.max(0, fMean[i]! - START_PREFER_H);
          const hj = Math.max(0, fMean[j]! - START_PREFER_H);
          // 分隔是目标（取正向），高度是代价（取负向）：系数与 attachToAnchor 同一条口径
          const score = dx * dx + dz * dz - START_HIGH_PENALTY * (hi * hi + hj * hj);
          if (score > bestScore) {
            bestScore = score;
            ba = i;
            bb = j;
          }
        }
      }
      if (ba >= 0) break;
    }
    if (ba < 0) return null;
    return [
      this.makeStart(fx[ba]!, fz[ba]!, fMean[ba]!, step, world),
      this.makeStart(fx[bb]!, fz[bb]!, fMean[bb]!, step, world),
    ];
  }

  /**
   * 3.2 格圆内的连通域覆盖率、高度场均值（含海格）与最高格。
   * 均值含海格是刻意的：出生平台高度参考「脚下整块地」，海岸边的起点自然更低缓。
   * maxH 用于「山顶基地」硬判据（见 START_MAX_H）：均值对单点尖峰不敏感，挡不住山顶基地。
   */
  private static circleStats(
    heights: Float32Array,
    labels: Int32Array,
    maxLabel: number,
    cx: number,
    cz: number,
    samples: number,
    rS: number,
    r2: number,
  ): { cov: number; mean: number; maxH: number } {
    const x0 = Math.max(0, cx - rS);
    const x1 = Math.min(samples - 1, cx + rS);
    const z0 = Math.max(0, cz - rS);
    const z1 = Math.min(samples - 1, cz + rS);
    let inComp = 0;
    let tot = 0;
    let sum = 0;
    let mx = 0;
    for (let jz = z0; jz <= z1; jz++) {
      const dz = jz - cz;
      const rowJ = jz * samples;
      for (let jx = x0; jx <= x1; jx++) {
        const dx = jx - cx;
        if (dx * dx + dz * dz > r2) continue;
        tot++;
        const hv = heights[rowJ + jx]!;
        sum += hv;
        if (hv > mx) mx = hv;
        if (labels[rowJ + jx]! === maxLabel) inComp++;
      }
    }
    return tot > 0 ? { cov: inComp / tot, mean: sum / tot, maxH: mx } : { cov: 0, mean: 0, maxH: 0 };
  }

  /**
   * 组装出生点：yaw 朝地图中心（与全局 atan2(dx,dz) 朝向约定一致，神像正面朝内）；
   * h = max(局部均值, 0.8)+0.25——与 world.ts 旧出生平台逻辑同源，近岸低地也有 1.05 起步。
   */
  private static makeStart(
    ix: number,
    iz: number,
    mean: number,
    step: number,
    world: number,
  ): GenStart {
    const x = ix * step;
    const z = iz * step;
    const yaw = Math.atan2(world * 0.5 - x, world * 0.5 - z);
    return { x, z, yaw, h: Math.max(mean, 0.8) + 0.25 };
  }
}
