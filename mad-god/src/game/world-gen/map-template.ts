// v0.24 地貌模板（schema 契约 + 六模板实现）。
// 契约段（MapTemplate 接口 / 工厂注册表 / pickTemplate 签名）由主 agent 定稿——
// 编排器（world-gen.ts）只依赖此契约，可并行开发。
//
// v0.24 实现段（Agent T 交付，主 agent 收尾）：六个模板各为独立 class，构造器收一条
// `rng: RNG` 并从中一次性抽完本座图的全部随机参数（模板实例只活一座图的生命周期），
// 构造后 landFactor/anchors 均为纯函数——同一条 rng 流（同图 seed）必得同一套参数。
// 关键修正：原实现用 Math.random 抽参 + 模块加载期建静态数组，导致**同 seed 跨进程是两张
// 不同的图**（测试随机 flaky 的根源）；现改为工厂注册表 + pickTemplate(rng) 现场构造。

import { makeNoiseKit } from "./noise";
import type { NoiseKit } from "./noise";
import type { RNG } from "../types";

/** 出生/结构锚点（世界坐标，格）。 */
export interface Anchor {
  x: number;
  z: number;
}

/**
 * 地貌模板：决定一张图的宏观海陆格局（陆地概率场）与起伏增益。
 * - landFactor 返回 0~1：1 = 稳定陆地、0 = 稳定海洋；与 fBm 起伏在编排器里组合成高度场。
 * - anchors 是出生点搜索的建议位（编排器在最大陆地连通域内向锚点吸附，保证公平对称）。
 */
export interface MapTemplate {
  readonly id: string;
  readonly name: string;
  /** 陆地概率场 0~1。x/z 为世界坐标（格）；world 为边长（格），便于相对定位。 */
  landFactor(x: number, z: number, world: number): number;
  /** 起伏增益：乘到 fBm/ridge 起伏上（highlands 等山地模板 > 1）。 */
  reliefScale(): number;
  /** 山脊权重：乘到 ridge 分量上（0 = 无山脉带，~1 = 纵贯山脊）。 */
  mountainWeight(): number;
  /** 双方出生锚点（大致对称、在模板的稳定陆地区内）。 */
  anchors(world: number): [Anchor, Anchor];
}

// ========== 纯函数工具（无状态，供各模板共用） ==========

/** 夹取到 [0,1]：landFactor 的输出契约。 */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** smoothstep：x ≤ a → 0，x ≥ b → 1（调用方保证 a < b；b ≤ a 时退化为硬阈值防除零）。 */
function smoothstep(a: number, b: number, x: number): number {
  const w = b - a;
  const t = clamp01((x - a) / (w > 0 ? w : 1e-9));
  return t * t * (3 - 2 * t);
}

/** 圆盘概率场：d ≤ r−soft 恒为 1，d ≥ r+soft 恒为 0，中间平滑过渡（高斯形圆滑边缘）。 */
function diskFactor(d: number, r: number, soft: number): number {
  return 1 - smoothstep(r - soft, r + soft, d);
}

/**
 * 高斯凸起：半值半径 = r（d=r 处 ≈0.5）——用于孤立卫星岛。
 * 用纯高斯而非圆盘：卫星岛漂浮在外海，尾部自然衰减即可，不需要硬边界。
 * v0.24 集成修正：d > 2.2r 硬截断为 0——高斯尾部渐近 0 但恒 >0，
 * 会让整张图处处 land>阈值而被铺成陆地（曾致群岛模板 93% 陆地）。
 */
function gaussFactor(d: number, r: number): number {
  if (d > 2.2 * r) return 0;
  const sigma = 0.85 * r;
  return Math.exp(-(d * d) / (2 * sigma * sigma));
}

// ========== 公共底盘 ==========

/**
 * 模板公共底盘：噪声工具箱 + 山脊/起伏默认参数。
 * 所有随机参数（含噪声 seed）都在构造器从**传入的 rng** 一次性抽完——实例只服务一座图，
 * 且同一条 rng 流（同图 seed）必得同一套参数：地图完全可复现。
 */
abstract class BaseTemplate implements MapTemplate {
  readonly id: string;
  readonly name: string;
  /** 本座图专属噪声场（构造时从 rng 派生 seed；实例存活期内不变，保证 landFactor 是纯函数）。 */
  protected readonly noise: NoiseKit;
  /** 山脊权重：非山地模板随机 0.2~0.4（规格默认 0.3）。 */
  protected readonly mountainWeight_: number;

  constructor(id: string, name: string, rng: RNG) {
    this.id = id;
    this.name = name;
    this.mountainWeight_ = 0.2 + rng.next() * 0.2;
    // 噪声 seed 从同一条 rng 流派生（整数化）：不再 Math.random，保证跨进程可复现。
    this.noise = makeNoiseKit(Math.floor(rng.next() * 0x7fffffff));
  }

  /** 起伏增益：默认 1.0（highlands 覆盖为 1.35）。 */
  reliefScale(): number {
    return 1.0;
  }
  /** 山脊权重：默认随机 0.2~0.4（highlands 覆盖为 1）。 */
  mountainWeight(): number {
    return this.mountainWeight_;
  }
  abstract landFactor(x: number, z: number, world: number): number;
  abstract anchors(world: number): [Anchor, Anchor];
}

// ========== 六模板 ==========

/**
 * 大陆：中心高斯形陆地（半径 ~0.38world、随机偏心 ≤0.08world）
 * + fBm(0.05) 半径扰动海岸；边缘严格为 0（陆地绝不越界）。
 */
export class ContinentTemplate extends BaseTemplate {
  /** 大陆中心（单位空间 0~1）；protected：群岛/高地等子类直接复用底盘几何。 */
  protected readonly cx: number;
  protected readonly cz: number;
  /** 基础半径 0.33~0.43 world（均值 ~0.38）。 */
  protected readonly radius: number;
  /** 海岸噪声振幅 0.025~0.045 world；海岸过渡带 0.03 world。 */
  private readonly coastAmp: number;
  private readonly coastSoft: number;
  /** 锚点主轴（构造时抽定，anchors 保持纯函数）。 */
  private readonly anchorAxis: number;

  constructor(rng: RNG, id = "continent", name = "大陆") {
    super(id, name, rng);
    this.radius = 0.33 + rng.next() * 0.1;
    this.coastAmp = 0.025 + rng.next() * 0.02;
    this.coastSoft = 0.03;
    // 大陆最远可达点 = 偏心 + 半径 + 噪声振幅 + 过渡带，必须 < 0.5world（"边缘为 0"）。
    // 半径抽大时自动压低偏心——保证大陆完整落进图内，而不是被图边裁掉一块。
    const reach = this.radius + this.coastAmp + this.coastSoft;
    const ecc = Math.min(0.08, Math.max(0, 0.49 - reach));
    const theta = rng.next() * Math.PI * 2;
    this.cx = 0.5 + Math.cos(theta) * ecc;
    this.cz = 0.5 + Math.sin(theta) * ecc;
    this.anchorAxis = rng.next() * Math.PI * 2;
  }

  landFactor(x: number, z: number, world: number): number {
    // 半径扰动式海岸：用采样点自身的噪声值微调当地半径，海岸线随 fBm 蜿蜒；
    // 同时陆地被锁死在"最大可达半径"内——边缘恒为 0。
    const r = this.radius + this.coastAmp * this.noise.fbm(x, z, 4, 0.05);
    const d = Math.hypot(x / world - this.cx, z / world - this.cz);
    return clamp01(diskFactor(d, r, this.coastSoft));
  }

  anchors(world: number): [Anchor, Anchor] {
    // 沿随机主轴 ±0.2world 对称两点：距中心 0.2 恒小于半径下界（0.285），稳居腹地。
    const ax = Math.cos(this.anchorAxis) * 0.2 * world;
    const az = Math.sin(this.anchorAxis) * 0.2 * world;
    return [
      { x: this.cx * world + ax, z: this.cz * world + az },
      { x: this.cx * world - ax, z: this.cz * world - az },
    ];
  }
}

/**
 * 群岛：同大陆底盘 + 3~5 个卫星岛（高斯凸起，半径 0.06~0.12world，随机分布）。
 * 卫星岛在构造期用拒绝采样摆放：离主陆 ≥0.1world（目标）、岛间不重叠、半值入图。
 */
export class ArchipelagoTemplate extends ContinentTemplate {
  /** 卫星岛：单位空间坐标 + 半径。 */
  private readonly islands: ReadonlyArray<readonly [number, number, number]>;

  constructor(rng: RNG) {
    super(rng, "archipelago", "群岛");
    const count = 3 + Math.floor(rng.next() * 3);
    const islands: [number, number, number][] = [];
    for (let i = 0; i < count; i++) {
      const radius = 0.06 + rng.next() * 0.06;
      // 离岸采样区间随主陆半径自适应：半径大 → 环带外推，保证至少 0.05world 水道。
      let best: [number, number, number] | null = null;
      let bestGap = -1;
      for (let t = 0; t < 90; t++) {
        const angle = rng.next() * Math.PI * 2;
        const d = this.radius + radius + 0.05 + rng.next() * 0.12;
        const ix = this.cx + Math.cos(angle) * d;
        const iz = this.cz + Math.sin(angle) * d;
        // 岛心须把半值半径完整留在图内（边缘只许浅滩触界，主体不能裁掉）。
        const m = 0.02 + radius;
        if (ix < m || ix > 1 - m || iz < m || iz > 1 - m) continue;
        // 岛间留 ≥0.02world 水道，避免卫星岛粘连成团。
        let ok = true;
        for (const [ox, oz, or] of islands) {
          if (Math.hypot(ix - ox, iz - oz) < radius + or + 0.02) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const gap = d - this.radius - radius;
        if (gap >= 0.1) {
          best = [ix, iz, radius];
          break;
        }
        if (gap > bestGap) {
          bestGap = gap;
          best = [ix, iz, radius];
        }
      }
      // 兜底：主陆极大/岛太大时 90 次采样也可能无解，退化为固定方位 + 夹取入图。
      islands.push(best ?? this.fallbackIsland(i, count, radius));
    }
    this.islands = islands;
  }

  landFactor(x: number, z: number, world: number): number {
    // 主陆继承大陆模板；卫星岛是纯高斯凸起（无海岸噪声），与主陆形成视觉对比。
    let f = super.landFactor(x, z, world);
    const u = x / world;
    const v = z / world;
    for (const [ix, iz, r] of this.islands) {
      f += gaussFactor(Math.hypot(u - ix, v - iz), r);
    }
    return clamp01(f);
  }

  /** 兜底摆放：按序号错开角度、夹取到地图可容纳的最大距离（构造期调用，非随机）。 */
  private fallbackIsland(i: number, count: number, radius: number): [number, number, number] {
    const angle = (i * Math.PI * 2) / count + 0.7;
    const d = Math.min(0.62, 0.96 - radius * 1.5);
    const x = Math.min(0.96 - radius, Math.max(0.04 + radius, this.cx + Math.cos(angle) * d));
    const z = Math.min(0.96 - radius, Math.max(0.04 + radius, this.cz + Math.sin(angle) * d));
    return [x, z, radius];
  }
}

/** 四条边缘的（基点, 伸入方向, 横截方向），单位空间坐标；0=南 1=东 2=北 3=西。 */
const PENINSULA_SIDES: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [0.5, 0, 0, 1, 1, 0],
  [1, 0.5, -1, 0, 0, 1],
  [0.5, 1, 0, -1, -1, 0],
  [0, 0.5, 1, 0, 0, -1],
];

/**
 * 半岛：从随机一侧边缘伸入的楔形陆地（基部全宽 0.35~0.5world，
 * 向对侧渐窄至尖端 ~0.6world 深）+ 噪声海岸。
 * 楔形基底贴图边（图外视为相连大陆），其余三边为海。
 */
export class PeninsulaTemplate extends BaseTemplate {
  private readonly bx: number;
  private readonly bz: number;
  private readonly dx: number;
  private readonly dz: number;
  private readonly lx: number;
  private readonly lz: number;
  /** 基部半宽 0.175~0.25 world（全宽 0.35~0.5）。 */
  private readonly baseHalf: number;
  /** 尖端深度 0.55~0.65 world。 */
  private readonly depth: number;
  private readonly coastAmp: number;
  private readonly coastSoft: number;

  constructor(rng: RNG) {
    super("peninsula", "半岛", rng);
    const [bx, bz, dx, dz, lx, lz] = PENINSULA_SIDES[Math.floor(rng.next() * 4)];
    this.bx = bx;
    this.bz = bz;
    this.dx = dx;
    this.dz = dz;
    this.lx = lx;
    this.lz = lz;
    this.baseHalf = 0.175 + rng.next() * 0.075;
    this.depth = 0.55 + rng.next() * 0.1;
    this.coastAmp = 0.025;
    this.coastSoft = 0.03;
  }

  landFactor(x: number, z: number, world: number): number {
    // 局部坐标系：lat = 横截距离、dep = 伸入深度（单位空间）。
    const u = x / world - this.bx;
    const v = z / world - this.bz;
    const lat = Math.abs(u * this.lx + v * this.lz);
    const dep = u * this.dx + v * this.dz;
    // 半宽随深度线性收窄至尖端归零；噪声扰动弹性的半宽 → 海岸线蜿蜒。
    const half =
      this.baseHalf * Math.max(0, 1 - dep / this.depth) +
      this.coastAmp * this.noise.fbm(x, z, 4, 0.05);
    // 尖端收口：超过尖端后强制归海——否则噪声项会在对侧图边沿中线造出陆地。
    const tipFade = 1 - smoothstep(this.depth - 0.05, this.depth + 0.02, dep);
    return clamp01((1 - smoothstep(half - this.coastSoft, half + this.coastSoft, lat)) * tipFade);
  }

  anchors(world: number): [Anchor, Anchor] {
    // 半岛无严格对称位：取中线"基部 0.3 / 尖端 0.6"两处，均深于噪声与过渡带，稳定在陆。
    return [this.pointAt(0.3, world), this.pointAt(0.6, world)];
  }

  /** 中线某深度比处的锚点（f 为 depth 的比例）。 */
  private pointAt(f: number, world: number): Anchor {
    return {
      x: (this.bx + this.dx * this.depth * f) * world,
      z: (this.bz + this.dz * this.depth * f) * world,
    };
  }
}

/**
 * 双半岛：两个对称大陆块（各占 ~0.3world）对角分布，中间一条 0.1~0.15world 宽
 * 的走廊相连——保证两陆互达。大陆块海岸与走廊边缘都带噪声。
 */
export class TwinlandsTemplate extends BaseTemplate {
  private readonly c1x: number;
  private readonly c1z: number;
  private readonly c2x: number;
  private readonly c2z: number;
  /** 球心到地图中心距离 0.26~0.30 world。 */
  private readonly dc: number;
  /** 对角方向与横截方向（单位向量）。 */
  private readonly sx: number;
  private readonly sz: number;
  private readonly ux: number;
  private readonly uz: number;
  /** 大陆块半径 0.14~0.17 world（直径 ~0.3）。 */
  private readonly blobR: number;
  private readonly blobAmp: number;
  private readonly blobSoft: number;
  /** 走廊半宽 0.045~0.06 world（全宽 0.09~0.12，含过渡带与噪声波动 ≈ 0.1~0.15）。 */
  private readonly corHalf: number;
  private readonly corSoft: number;
  /** 走廊纵向收口半宽：超出球心 0.06world 后走廊淡出（防沿对角线直通地图角落）。 */
  private readonly corCap: number;

  constructor(rng: RNG) {
    super("twinlands", "双半岛", rng);
    // 随机主/反对角线之一，两球互为对角镜像。
    const anti = rng.next() < 0.5;
    this.dc = 0.26 + rng.next() * 0.04;
    this.sx = Math.SQRT1_2;
    this.sz = anti ? -Math.SQRT1_2 : Math.SQRT1_2;
    this.ux = anti ? Math.SQRT1_2 : -Math.SQRT1_2;
    this.uz = anti ? Math.SQRT1_2 : Math.SQRT1_2;
    this.c1x = 0.5 + this.sx * this.dc;
    this.c1z = 0.5 + this.sz * this.dc;
    this.c2x = 0.5 - this.sx * this.dc;
    this.c2z = 0.5 - this.sz * this.dc;
    this.blobR = 0.14 + rng.next() * 0.03;
    this.blobAmp = 0.035;
    this.blobSoft = 0.03;
    this.corHalf = 0.045 + rng.next() * 0.015;
    this.corSoft = 0.025;
    this.corCap = 0.06;
  }

  landFactor(x: number, z: number, world: number): number {
    const u = x / world;
    const v = z / world;
    // 两球共用一条噪声流按各自球心采样（相距 ~0.5world，场已互不相关）。
    const rb = this.blobR + this.blobAmp * this.noise.fbm(x, z, 4, 0.05);
    const d1 = Math.hypot(u - this.c1x, v - this.c1z);
    const d2 = Math.hypot(u - this.c2x, v - this.c2z);
    // 走廊 = 横截带（噪声微扰半宽）× 纵向窗口（仅存在于两球心之间）。
    const lat = Math.abs((u - 0.5) * this.ux + (v - 0.5) * this.uz);
    const s = (u - 0.5) * this.sx + (v - 0.5) * this.sz;
    const half = this.corHalf * (1 + 0.3 * this.noise.fbm(x, z, 3, 0.08));
    const win =
      smoothstep(-this.dc - this.corCap, -this.dc, s) *
      (1 - smoothstep(this.dc, this.dc + this.corCap, s));
    const corridor = (1 - smoothstep(half - this.corSoft, half + this.corSoft, lat)) * win;
    return clamp01(
      diskFactor(d1, rb, this.blobSoft) + diskFactor(d2, rb, this.blobSoft) + corridor,
    );
  }

  anchors(world: number): [Anchor, Anchor] {
    // 各大陆块球心即最深陆点，对角镜像对称。
    return [
      { x: this.c1x * world, z: this.c1z * world },
      { x: this.c2x * world, z: this.c2z * world },
    ];
  }
}

/**
 * 环礁：环带陆地（外半径 ~0.4world、内半径 ~0.28world，各带噪声变形与整体椭圆化），
 * 中心湖与外围海 landFactor 严格为 0。锚点取环带中线的对径两点。
 */
export class LagoonTemplate extends BaseTemplate {
  /** 椭圆变形（面积守恒 ex·ez = 1），±4%。 */
  private readonly ex: number;
  private readonly ez: number;
  /** 内环独立噪声流：与外壳不同相位，避免同相位收缩把环带挤断。 */
  private readonly inner: NoiseKit;
  private readonly anchorAxis: number;

  constructor(rng: RNG) {
    super("lagoon", "环礁", rng);
    const e = 0.04 * (rng.next() * 2 - 1);
    this.ex = 1 + e;
    this.ez = 1 / (1 + e);
    this.inner = this.noise.secondary();
    this.anchorAxis = rng.next() * Math.PI * 2;
  }

  landFactor(x: number, z: number, world: number): number {
    const u = (x / world - 0.5) * this.ex;
    const v = (z / world - 0.5) * this.ez;
    const d = Math.hypot(u, v);
    // 内外半径各带 ±4.5% 的 fBm 变形（不同相位）；最坏情况下环带仍有 ~0.09world 宽。
    const outer = 0.4 * (1 + 0.045 * this.noise.fbm(x, z, 4, 0.05));
    const inner = 0.28 * (1 + 0.045 * this.inner.fbm(x, z, 4, 0.05));
    // 环带 = 外盘 − 内盘：中心湖 / 外围海严格为 0，只有环带为 1。
    return clamp01(diskFactor(d, outer, 0.03) - diskFactor(d, inner, 0.03));
  }

  anchors(world: number): [Anchor, Anchor] {
    // 环带中线半径 0.34world 的对径两点：无论椭圆与噪声变形（0.32~0.36），都稳落环带。
    const ax = Math.cos(this.anchorAxis) * 0.34 * world;
    const az = Math.sin(this.anchorAxis) * 0.34 * world;
    return [
      { x: 0.5 * world + ax, z: 0.5 * world + az },
      { x: 0.5 * world - ax, z: 0.5 * world - az },
    ];
  }
}

/**
 * 高地：完全复用大陆底盘，仅把山脊权重拉满（1）与起伏增益调高（1.35）——
 * 同样的海陆格局、更高的山（"高地"是起伏风格，不是另一种海陆形状）。
 */
export class HighlandsTemplate extends ContinentTemplate {
  constructor(rng: RNG) {
    super(rng, "highlands", "高地");
  }
  mountainWeight(): number {
    return 1;
  }
  reliefScale(): number {
    return 1.35;
  }
}

// ========== 工厂注册表与抽取 ==========

/**
 * 模板工厂：注册表只存「身份 + 构造方式」，实例在 pickTemplate 里用图自己的 rng 现场构造。
 * 这样同 seed 必得同图（跨进程一致），且不再有"模块加载期抽参"的全局隐状态。
 */
export interface TemplateFactory {
  readonly id: string;
  readonly name: string;
  create(rng: RNG): MapTemplate;
}

/** 六模板注册表（continent / archipelago / peninsula / twinlands / lagoon / highlands）。 */
export const MAP_TEMPLATE_FACTORIES: ReadonlyArray<TemplateFactory> = [
  { id: "continent", name: "大陆", create: (rng) => new ContinentTemplate(rng) },
  { id: "archipelago", name: "群岛", create: (rng) => new ArchipelagoTemplate(rng) },
  { id: "peninsula", name: "半岛", create: (rng) => new PeninsulaTemplate(rng) },
  { id: "twinlands", name: "双半岛", create: (rng) => new TwinlandsTemplate(rng) },
  { id: "lagoon", name: "环礁", create: (rng) => new LagoonTemplate(rng) },
  { id: "highlands", name: "高地", create: (rng) => new HighlandsTemplate(rng) },
];

/**
 * 由 rng 等权抽一个模板并**构造**它（抽一次模板序号，再把同一条 rng 交给构造函数抽参数）。
 * 注意：调用方须传入已混淆 + 预热的 rng——LCG 首次输出与 seed 线性相关，
 * 直接用 RNG(seed) 会让相邻 seed 抽到同一模板（见 noise.ts 的 mixSeed 注释）。
 */
export function pickTemplate(rng: RNG): MapTemplate {
  const f = MAP_TEMPLATE_FACTORIES[Math.floor(rng.next() * MAP_TEMPLATE_FACTORIES.length)]!;
  return f.create(rng);
}
