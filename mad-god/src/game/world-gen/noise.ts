// v0.24 地图生成噪声库（schema 契约 + 实现）。
// 契约段（NoiseKit 接口）由主 agent 定稿，各模板与编排器只依赖此接口——可并行开发。

/**
 * seeded 噪声工具箱：全部方法为纯函数（同一 kit 实例结果确定）。
 * 世界坐标尺度：x/z 以"格"为单位（0 ~ WORLD），频率参数含义为每格的噪声周期数。
 */
export interface NoiseKit {
  /** 单层 value noise，输出 [-1,1]：seeded hash 网格 + 双线性插值 + smoothstep 圆滑。 */
  noise2D(x: number, z: number): number;
  /**
   * 分形布朗运动（fBm），输出约 [-1,1]：octaves 层叠，每层频率 ×lacunarity(2.0)、幅度 ×gain(0.5)。
   * freq 为首层频率（如 0.06 表示 ~17 格一个宏观起伏）。
   */
  fbm(x: number, z: number, octaves?: number, freq?: number, gain?: number): number;
  /**
   * 脊线噪声（ridge），输出 [0,1]：1-|fbm| 再取幂锐化——产生有走向的山脊带而非孤立鼓包。
   * 高值（接近 1）为山脊线。
   */
  ridge(x: number, z: number, octaves?: number, freq?: number): number;
  /** 独立流：与主噪声不同相位的第二个噪声场（用于平原选区等，避免与高度场相关）。 */
  secondary(): NoiseKit;
}

/** 由 seed 构建一个噪声工具箱（不同 seed 的场彼此独立）。 */
export function makeNoiseKit(seed: number): NoiseKit {
  return new ValueNoiseKit(seed);
}

/**
 * v0.24 种子混淆（splitmix 式整数终混）：把玩家/测试传入的小整数 seed 打散到
 * 32 位空间均匀散布，再喂给 RNG / 噪声场。
 * 为什么必须要：types.ts 的 RNG 是 LCG（`s = s*1664525 + 1013904223`），其**第一次输出
 * 与 seed 线性相关**——实测 RNG(1).float(0,6)=1.419、RNG(303).float(0,6)=2.121，
 * 相邻小 seed 基本抽不到不同值，导致 pickTemplate 15 个 seed 里 14 个命中同一模板
 * （整张图的自然多样性失效，每张图看起来一样）。混淆等价于跳过 LCG 相关性最强的头部。
 */
export function mixSeed(seed: number): number {
  let s = ((seed >>> 0) + 0x9e3779b9) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x21f0aaad) >>> 0;
  s = Math.imul(s ^ (s >>> 15), 0x735a2d97) >>> 0;
  return (s ^ (s >>> 15)) >>> 0;
}

/**
 * v0.24 值噪声实现（Agent N 交付）：整数格点 hash + 双线性插值 + smoothstep 权重。
 * 全部方法为纯函数（无 Math.random、无内部可变状态）——同一 kit 的任意调用序列结果确定，可复现。
 */
class ValueNoiseKit implements NoiseKit {
  /** 归一化到 [0, 2^32) 的无符号 seed：与 RNG 类（types.ts:346）同风格，保证后续整数 hash 运算精确。 */
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  /**
   * 格点 hash：整数混淆翻转（xorshift）+ sin 混合，返回 [-1,1] 确定性值。
   * 用 Math.imul 全程在 int32 域内运算（不受双精度 2^53 精度上限影响），同输入必得同输出。
   * 为什么不用 Math.random：seeded 噪声要求同 seed 全场可复现，随机源会破坏这一点。
   */
  private hash(ix: number, iz: number): number {
    let h =
      Math.imul(Math.floor(ix), 374761393) +
      Math.imul(Math.floor(iz), 668265263) +
      Math.imul(this.seed, 1442695041);
    // 混淆翻转：异或右移打散相邻格点（ix/iz 差 1）的 hash，避免栅格化伪影
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    // sin 混合：把整数域 hash 打散到 [0,1)，再映射到 [-1,1]
    const t = Math.sin(h) * 43758.5453123;
    return (t - Math.floor(t)) * 2 - 1;
  }

  noise2D(x: number, z: number): number {
    // v0.24 自检 1：同点两次调用返回值完全相同——纯函数、无状态，可安全缓存/复算。
    // v0.24 自检 2：不同 seed 的 kit 在同一点返回值不同——seed 混入每个格点 hash，场之间互不相关。
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix; // 格内偏移，[0,1)
    const fz = z - iz;
    // smoothstep 权重 3t²-2t³：格点端点处导数为 0，相邻格之间是圆滑过渡而非线性折线
    const u = fx * fx * (3 - 2 * fx);
    const v = fz * fz * (3 - 2 * fz);
    const a = this.hash(ix, iz);
    const b = this.hash(ix + 1, iz);
    const c = this.hash(ix, iz + 1);
    const d = this.hash(ix + 1, iz + 1);
    // 双线性插值：四个角点 hash 的凸组合（权重 u/v ∈ [0,1]），输出保持在 [-1,1]
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  fbm(x: number, z: number, octaves = 4, freq = 0.06, gain = 0.5): number {
    // v0.24 自检 3：同点两次调用相等（底层 noise2D 已确定）。
    // v0.24 自检 4：不同 seed 差异明显——每层噪声场已独立，叠层不会抹掉差异。
    // v0.24 自检 5：sum/norm 是各层幅值的加权平均，输出幅度约 [-1,1]，层数增加不会发散。
    let sum = 0;
    let norm = 0; // 归一化累计：fbm 的幅度不随 octaves 增大而膨胀
    let amp = 1;
    let f = freq;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise2D(x * f, z * f) * amp;
      norm += amp;
      f *= 2; // lacunarity = 2：每层频率翻倍
      amp *= gain; // gain = 0.5：每层幅度减半，高层只贡献细节
    }
    return sum / norm;
  }

  ridge(x: number, z: number, octaves = 3, freq = 0.06): number {
    // v0.24 自检 6：fbm∈[-1,1] → base=|fbm|∈[0,1] → 1-base∈[0,1]，clamp + 幂运算后输出恒在 [0,1]。
    const base = Math.abs(this.fbm(x, z, octaves, freq)); // |fbm|≈0 处（噪声过零线）为脊线
    return Math.pow(Math.min(1, 1 - base), 1.8); // clamp(1-base,0,1) 再取 1.8 次幂锐化
  }

  secondary(): NoiseKit {
    // 独立流：seed 平移 7919（质数，与主 seed 的 32 位乘积不同）——同构但相位无关的第二个噪声场，
    // 用于平原选区等，避免与高度场产生相关性
    return new ValueNoiseKit(this.seed + 7919);
  }
}
